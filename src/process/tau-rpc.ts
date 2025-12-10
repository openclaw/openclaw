import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";

type TauRpcOptions = {
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  onEvent?: (line: string) => void;
};

type TauRpcResult = {
  stdout: string;
  stderr: string;
  code: number;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
};

class TauRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private stderr = "";
  private buffer: string[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private resolveTimer: NodeJS.Timeout | null = null;
  private compactionRunning = false;
  private pendingRetryCount = 0;
  private seenAgentEnd = false;
  private pending:
    | {
        resolve: (r: TauRpcResult) => void;
        reject: (err: unknown) => void;
        timer: NodeJS.Timeout;
        onEvent?: (line: string) => void;
        capMs: number;
      }
    | undefined;

  constructor(
    private readonly argv: string[],
    private readonly cwd: string | undefined,
  ) {}

  private resetRunState() {
    this.buffer = [];
    this.compactionRunning = false;
    this.pendingRetryCount = 0;
    this.seenAgentEnd = false;
    this.clearResolveTimer();
  }

  private ensureChild() {
    if (this.child) return;
    this.child = spawn(this.argv[0], this.argv.slice(1), {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (d) => {
      this.stderr += d.toString();
    });
    this.child.on("exit", (code, signal) => {
      this.clearResolveTimer();
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.pending) {
        const pending = this.pending;
        this.pending = undefined;
        const out = this.buffer.join("\n");
        clearTimeout(pending.timer);
        // Treat process exit as completion with whatever output we captured.
        pending.resolve({
          stdout: out,
          stderr: this.stderr,
          code: code ?? 0,
          signal,
        });
      }
      this.resetRunState();
      this.dispose();
    });
  }

  private handleLine(line: string) {
    // Any line = activity; refresh timeout watchdog.
    if (this.pending) {
      this.resetTimeout();
    }
    if (!this.pending) return;
    this.buffer.push(line);
    this.pending?.onEvent?.(line);

    // Parse the line once to track agent lifecycle signals.
    try {
      const evt = JSON.parse(line) as {
        type?: string;
        command?: string;
        success?: boolean;
        error?: string;
        message?: unknown;
        willRetry?: boolean;
        id?: string;
        method?: string;
      };

      if (evt.type === "response" && evt.command === "prompt") {
        if (evt.success === false) {
          const pending = this.pending;
          this.pending = undefined;
          this.buffer = [];
          this.clearResolveTimer();
          this.resetRunState();
          if (pending) {
            clearTimeout(pending.timer);
            pending.reject(
              new Error(evt.error ?? "tau rpc prompt failed (response=false)"),
            );
          }
          this.child?.kill("SIGKILL");
          return;
        }
      }

      if (evt.type === "auto_compaction_start") {
        this.compactionRunning = true;
        this.clearResolveTimer();
        return;
      }

      if (evt.type === "auto_compaction_end") {
        this.compactionRunning = false;
        if (evt.willRetry) this.pendingRetryCount += 1;
        this.scheduleMaybeResolve();
        return;
      }

      if (evt?.type === "agent_end") {
        this.seenAgentEnd = true;
        if (this.pendingRetryCount > 0) {
          this.pendingRetryCount -= 1;
        }
        this.scheduleMaybeResolve();
        return;
      }

      // Handle hook UI requests by auto-cancelling (non-interactive surfaces like WhatsApp)
      if (evt.type === "hook_ui_request" && evt.id) {
        // Fire-and-forget response to unblock hook runner
        this.child?.stdin.write(
          `${JSON.stringify({
            type: "hook_ui_response",
            id: evt.id,
            cancelled: true,
          })}\n`,
        );
        return;
      }
    } catch {
      // ignore malformed/non-JSON lines
    }
  }

  private scheduleMaybeResolve() {
    if (!this.pending) return;
    this.clearResolveTimer();
    // Allow a short window for auto-compaction events to arrive after agent_end.
    this.resolveTimer = setTimeout(() => {
      this.resolveTimer = null;
      this.maybeResolve();
    }, 150);
  }

  private maybeResolve() {
    if (!this.pending) return;
    if (!this.seenAgentEnd) return;
    if (this.compactionRunning) return;
    if (this.pendingRetryCount > 0) return;

    const pending = this.pending;
    this.pending = undefined;
    const out = this.buffer.join("\n");
    this.buffer = [];
    clearTimeout(pending.timer);
    pending.resolve({ stdout: out, stderr: this.stderr, code: 0 });
  }

  private clearResolveTimer() {
    if (this.resolveTimer) {
      clearTimeout(this.resolveTimer);
      this.resolveTimer = null;
    }
  }

  private resetTimeout() {
    if (!this.pending) return;
    const capMs = this.pending.capMs;
    if (this.pending.timer) clearTimeout(this.pending.timer);
    this.pending.timer = setTimeout(() => {
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(
        new Error(`tau rpc timed out after ${Math.round(capMs / 1000)}s`),
      );
      this.child?.kill("SIGKILL");
    }, capMs);
  }

  async prompt(
    prompt: string,
    timeoutMs: number,
    onEvent?: (line: string) => void,
  ): Promise<TauRpcResult> {
    this.ensureChild();
    if (this.pending) {
      throw new Error("tau rpc already handling a request");
    }
    const child = this.child;
    if (!child) throw new Error("tau rpc child not initialized");
    this.resetRunState();
    await new Promise<void>((resolve, reject) => {
      const ok = child.stdin.write(
        `${JSON.stringify({
          type: "prompt",
          // RPC v0.17+ accepts raw string prompts and normalizes internally.
          message: prompt,
        })}\n`,
        (err) => (err ? reject(err) : resolve()),
      );
      if (!ok) child.stdin.once("drain", () => resolve());
    });
    return await new Promise<TauRpcResult>((resolve, reject) => {
      // Hard cap to avoid stuck gateways; resets on every line received.
      const capMs = Math.min(timeoutMs, 5 * 60 * 1000);
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(
          new Error(`tau rpc timed out after ${Math.round(capMs / 1000)}s`),
        );
        child.kill("SIGKILL");
      }, capMs);
      this.pending = { resolve, reject, timer, onEvent, capMs };
    });
  }

  dispose() {
    this.clearResolveTimer();
    this.rl?.close();
    this.rl = null;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGKILL");
    }
    this.child = null;
    this.buffer = [];
    this.stderr = "";
  }
}

let singleton: { key: string; client: TauRpcClient } | undefined;

export async function runPiRpc(
  opts: TauRpcOptions & { prompt: string },
): Promise<TauRpcResult> {
  const key = `${opts.cwd ?? ""}|${opts.argv.join(" ")}`;
  if (!singleton || singleton.key !== key) {
    singleton?.client.dispose();
    singleton = { key, client: new TauRpcClient(opts.argv, opts.cwd) };
  }
  return singleton.client.prompt(opts.prompt, opts.timeoutMs, opts.onEvent);
}

export function resetPiRpc() {
  singleton?.client.dispose();
  singleton = undefined;
}
