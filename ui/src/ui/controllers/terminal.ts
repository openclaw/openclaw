import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway.ts";

export type PtyState = {
  spawned: boolean;
  error: string | null;
};

/**
 * Manages an xterm.js terminal backed by a server-side PTY session.
 *
 * Lifecycle:
 *   1. `mount(container)` – creates the xterm.js Terminal and attaches it to the DOM.
 *   2. `spawn(client)` – asks the gateway to create a PTY and wires data flow.
 *   3. `handleEvent(evt)` – called for every gateway event; routes pty.data/pty.exit.
 *   4. `kill()` / `dispose()` – tears down the PTY and/or the Terminal instance.
 */
export class PtyController {
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private client: GatewayBrowserClient | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /**
   * Persistent inner element that xterm.js renders into.
   * Created once and moved between parent containers so xterm never
   * gets destroyed/re-opened (which it does not support).
   */
  private xtermHost: HTMLElement | null = null;
  private currentParent: HTMLElement | null = null;
  private _spawned = false;
  private _error: string | null = null;
  private _spawnInFlight = false;
  /** Set when the user explicitly kills the session; prevents auto-respawn. */
  private _userKilled = false;

  get spawned(): boolean {
    return this._spawned;
  }

  get error(): string | null {
    return this._error;
  }

  get userKilled(): boolean {
    return this._userKilled;
  }

  get state(): PtyState {
    return { spawned: this._spawned, error: this._error };
  }

  /**
   * Create the xterm.js Terminal and attach it to a DOM container.
   * Safe to call multiple times — the xterm host element is created once
   * and simply re-parented into the given container on subsequent calls.
   */
  mount(container: HTMLElement): void {
    // Fast path: already parented in the right place
    if (
      this.term &&
      this.xtermHost &&
      this.currentParent === container &&
      container.contains(this.xtermHost)
    ) {
      return;
    }

    // Re-parent existing xterm host into a new container
    if (this.term && this.xtermHost) {
      if (!container.contains(this.xtermHost)) {
        container.appendChild(this.xtermHost);
      }
      this.currentParent = container;
      this.observeResize(container);
      // Refit after moving – the new container may have different dimensions
      requestAnimationFrame(() => {
        try {
          this.fitAddon?.fit();
        } catch {
          /* ignore if disposed */
        }
        this.term?.focus();
      });
      return;
    }

    // First-time setup: create a persistent host element + Terminal
    const xtermHost = document.createElement("div");
    xtermHost.style.width = "100%";
    xtermHost.style.height = "100%";
    container.appendChild(xtermHost);

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", "JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.3,
      scrollback: 5000,
      theme: {
        background: "#1a1a2e",
        foreground: "#e0e0e0",
        cursor: "#e0e0e0",
        selectionBackground: "rgba(255, 255, 255, 0.2)",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(xtermHost);
    this.xtermHost = xtermHost;
    this.currentParent = container;
    fitAddon.fit();

    // Send user keystrokes to the server-side PTY
    term.onData((data) => {
      if (this.client && this._spawned) {
        this.client.request("pty.input", { data }).catch(() => {
          // write failed – PTY likely dead
        });
      }
    });

    // Auto-fit on container resize
    this.observeResize(container);

    // Notify server of terminal size changes
    term.onResize(({ cols, rows }) => {
      if (this.client && this._spawned) {
        this.client.request("pty.resize", { cols, rows }).catch(() => {});
      }
    });

    this.term = term;
    this.fitAddon = fitAddon;
  }

  /** (Re-)observe the given container for resize events. */
  private observeResize(container: HTMLElement): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      try {
        this.fitAddon?.fit();
      } catch {
        /* ignore if disposed */
      }
    });
    this.resizeObserver.observe(container);
  }

  /**
   * Spawn a PTY session on the server and begin streaming.
   */
  async spawn(client: GatewayBrowserClient): Promise<void> {
    if (this._spawnInFlight) {
      return;
    }
    this.client = client;
    this._error = null;
    this._userKilled = false;
    this._spawnInFlight = true;

    if (!this.term) {
      this._error = "Terminal not mounted";
      this._spawnInFlight = false;
      return;
    }

    const cols = this.term.cols;
    const rows = this.term.rows;

    try {
      await client.request("pty.spawn", { cols, rows });
      this._spawned = true;
      this._spawnInFlight = false;
      this.term.focus();
    } catch (err) {
      this._error = `PTY spawn failed: ${String(err instanceof Error ? err.message : err)}`;
      this._spawned = false;
      this._spawnInFlight = false;
    }
  }

  /**
   * Handle a gateway event. Call this for every event from the gateway.
   * Returns true if the event was consumed.
   */
  handleEvent(evt: GatewayEventFrame): boolean {
    if (evt.event === "pty.data") {
      const payload = evt.payload as { data?: string } | undefined;
      if (payload?.data && this.term) {
        this.term.write(payload.data);
      }
      return true;
    }

    if (evt.event === "pty.exit") {
      const payload = evt.payload as { exitCode?: number; signal?: number } | undefined;
      this._spawned = false;
      if (this.term) {
        this.term.writeln("");
        this.term.writeln(
          `\x1b[33m[PTY exited: code=${payload?.exitCode ?? "?"}, signal=${payload?.signal ?? "none"}]\x1b[0m`,
        );
      }
      return true;
    }

    return false;
  }

  /**
   * Reset spawn-related state without killing xterm.  Called when the
   * gateway websocket closes (the server already destroyed the PTY).
   */
  resetSpawnState(): void {
    this._spawned = false;
    this._spawnInFlight = false;
    this._userKilled = false;
    this._error = null;
  }

  /**
   * Fit the terminal to its container. Call after visibility changes.
   */
  fit(): void {
    this.fitAddon?.fit();
  }

  /**
   * Kill the server-side PTY without disposing the terminal UI.
   */
  async kill(): Promise<void> {
    if (this.client && this._spawned) {
      try {
        await this.client.request("pty.kill");
      } catch {
        /* ignore */
      }
    }
    this._spawned = false;
    this._userKilled = true;
  }

  /**
   * Full teardown: kill PTY + dispose xterm.
   */
  dispose(): void {
    void this.kill();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.xtermHost?.remove();
    this.xtermHost = null;
    this.term?.dispose();
    this.term = null;
    this.fitAddon = null;
    this.client = null;
    this.currentParent = null;
    this._spawned = false;
    this._spawnInFlight = false;
    this._userKilled = false;
    this._error = null;
  }
}
