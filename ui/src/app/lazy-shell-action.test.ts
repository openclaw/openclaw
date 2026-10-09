/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { COMMAND_PALETTE_OPEN_EVENT } from "../components/command-palette-contract.ts";
import {
  DEBUG_OVERLAY_REQUEST_EVENT,
  KEYBOARD_SHORTCUTS_REQUEST_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  createLazyElementSpec,
  resetAppHostTestGlobals,
  type ShellKeyboardState,
  type TestOptionalCustomElement,
  stubRenderedWhenDefined,
} from "./app-host.test-support.ts";
import type { ShellChromeOwner } from "./app-shell-chrome.ts";
import type { CommandPaletteLoadingState } from "./app-shell-command-palette-loading.ts";
import type { ApplicationGatewaySnapshot } from "./context.ts";
import "./app-host.ts";
import {
  DEBUG_OVERLAY_ELEMENT,
  KEYBOARD_SHORTCUTS_ELEMENT,
  type LazyCustomElementRequestController,
  type OptionalCustomElement,
} from "./lazy-custom-element.ts";
import {
  persistLazyShellAction,
  readLazyShellAction,
  SHELL_APPROVALS_OPEN_EVENT,
} from "./lazy-shell-action.ts";

const recovery = vi.hoisted(() => ({ reload: vi.fn(), pending: new Array<Promise<boolean>>() }));
vi.mock("./stale-chunk-reload.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stale-chunk-reload.ts")>();
  return {
    ...actual,
    retryStaleChunkReloadWhenReachable: (
      deps: Parameters<typeof actual.retryStaleChunkReloadWhenReachable>[0],
    ) => {
      const pending = actual.retryStaleChunkReloadWhenReachable({
        ...deps,
        reload: recovery.reload,
      });
      recovery.pending.push(pending);
      return pending;
    },
  };
});

const storageKey = "openclaw:lazy-event";

type ShellLifecycle = {
  connectedCallback(): void;
  disconnectedCallback(): void;
};

async function withConnectedShell(shell: ShellLifecycle, run: () => void | Promise<void>) {
  shell.connectedCallback();
  try {
    await run();
  } finally {
    shell.disconnectedCallback();
  }
}

afterEach(async () => {
  await vi.dynamicImportSettled();
  resetAppHostTestGlobals();
  vi.restoreAllMocks();
  recovery.reload.mockClear();
  recovery.pending.length = 0;
});

type PaletteShell = HTMLElement &
  ShellLifecycle & {
    commandPaletteElement: TestOptionalCustomElement;
    lazyCustomElements: LazyCustomElementRequestController;
    openPalette(): void;
    restorePendingLazyAction(): void;
    resetForContextEpoch(): void;
    commandPaletteLoading: CommandPaletteLoadingState;
    shellChrome: ShellChromeOwner;
  };

function paletteShell(element: TestOptionalCustomElement, open: () => void): PaletteShell {
  const shell = document.createElement("openclaw-app-shell") as PaletteShell;
  shell.commandPaletteElement = element;
  Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
  Object.defineProperty(shell, "commandPalette", {
    get: () =>
      customElements.get(element.tagName)
        ? { isOpen: false, openPalette: open, togglePalette: open }
        : undefined,
  });
  stubRenderedWhenDefined(shell);
  return shell;
}

function stalePalette() {
  return createLazyElementSpec("command palette", {
    firstError: new Error("Failed to fetch dynamically imported module: palette-old.js"),
  });
}

describe("lazy shell action storage", () => {
  it.each([
    "{",
    JSON.stringify({ eventType: COMMAND_PALETTE_OPEN_EVENT, extra: true }),
    JSON.stringify({ eventType: "openclaw:unknown", detail: {} }),
    JSON.stringify({ eventType: TERMINAL_PANEL_TOGGLE_EVENT, detail: [] }),
  ])("discards malformed state: %s", (raw) => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    storage.setItem(storageKey, raw);

    expect(readLazyShellAction()).toBeNull();
    expect(storage.getItem(storageKey)).toBeNull();
  });
});

describe("shell lazy events", () => {
  it("persists only open intent, never a cold prompt or event payload", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const gate = createDeferred();
    const element = createLazyElementSpec("private cold palette");
    const load = element.loadModule;
    element.loadModule = async () => {
      await gate.promise;
      await load();
    };
    const shell = paletteShell(element, vi.fn());
    await withConnectedShell(shell, async () => {
      window.dispatchEvent(
        new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, {
          detail: { value: "private payload" },
        }),
      );
      const input = document.createElement("textarea");
      shell.commandPaletteLoading.inputRef(input);
      input.value = "private cold prompt";
      shell.commandPaletteLoading.captureInput();
      expect(readLazyShellAction()).toEqual({ eventType: COMMAND_PALETTE_OPEN_EVENT });
      expect(storage.getItem(storageKey)).not.toContain("private");
      shell.lazyCustomElements.close();
      gate.resolve();
    });
  });

  it.each(["connection", "account", "reconnect"] as const)(
    "respects the canonical %s boundary while a cold palette is composing",
    async (change) => {
      vi.stubGlobal("sessionStorage", createStorageMock());
      const gate = createDeferred();
      const element = createLazyElementSpec("owned cold palette");
      const load = element.loadModule;
      element.loadModule = async () => {
        await gate.promise;
        await load();
      };
      const open = vi.fn();
      const shell = paletteShell(element, open);
      let snapshot: ApplicationGatewaySnapshot = {
        client: null,
        phase: "connected",
        offlineStable: false,
        canvasPluginSurfaceUrl: null,
        hello: null,
        assistantAgentId: "main",
        sessionKey: "main",
        lastError: null,
        lastErrorCode: null,
        selfUser: { id: "first-user" },
      };
      const gateway = {
        connectionRevision: 0,
        get snapshot() {
          return snapshot;
        },
      };
      Object.defineProperty(shell, "context", { value: { gateway }, configurable: true });
      shell.openPalette();
      const state = shell.commandPaletteLoading;
      const input = document.createElement("textarea");
      state.inputRef(input);
      input.value = "old-owner prompt";
      state.captureInput();
      state.handleCompositionStart();
      state.handoff(open);
      const take = state.captureHandoff();
      if (change === "connection") {
        gateway.connectionRevision += 1;
      } else if (change === "account") {
        snapshot = { ...snapshot, selfUser: { id: "second-user" } };
      } else {
        snapshot = { ...snapshot, phase: "reconnecting", selfUser: null };
      }
      shell.shellChrome.synchronizeCommandPaletteScope();
      if (change === "reconnect") {
        expect(state.value).toBe("old-owner prompt");
        expect(state.active).toBe(true);
        snapshot = {
          ...snapshot,
          phase: "connected",
          selfUser: { id: "first-user" },
        };
        shell.shellChrome.synchronizeCommandPaletteScope();
        expect(take()?.value).toBe("old-owner prompt");
        shell.lazyCustomElements.close();
      } else {
        expect(state.active).toBe(false);
        expect(state.value).toBe("");
        expect(take()).toBeUndefined();
        expect(readLazyShellAction()).toBeNull();
      }
      state.handleCompositionEnd();
      gate.resolve();
      await vi.dynamicImportSettled();
      expect(open).not.toHaveBeenCalled();
    },
  );

  it.each(["unavailable", "denied", "replacement-write-failed"] as const)(
    "retries in place without replaying an older action when storage is %s",
    async (mode) => {
      const storage = createStorageMock();
      if (mode === "replacement-write-failed") {
        storage.setItem(storageKey, JSON.stringify({ eventType: SHELL_APPROVALS_OPEN_EVENT }));
      }
      vi.stubGlobal("sessionStorage", mode === "unavailable" ? null : storage);
      if (mode === "denied") {
        Object.defineProperty(globalThis, "sessionStorage", {
          configurable: true,
          get() {
            throw new DOMException("Storage blocked", "SecurityError");
          },
        });
      }
      const head = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", head);
      const open = vi.fn();
      const shell = paletteShell(stalePalette(), open);
      if (mode === "replacement-write-failed") {
        vi.spyOn(storage, "setItem").mockImplementation(() => {
          throw new DOMException("Storage full", "QuotaExceededError");
        });
      }

      await withConnectedShell(shell, async () => {
        shell.openPalette();
        await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
        shell.lazyCustomElements.retry();
        await Promise.all(recovery.pending);

        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        expect(recovery.reload).not.toHaveBeenCalled();
        expect(head).not.toHaveBeenCalled();
        expect(readLazyShellAction()).toBeNull();
      });
    },
  );

  it.each(["close", "context-replaced", "disconnected", "new-request"] as const)(
    "does not reload a retired retry after %s while the document probe is pending",
    async (retirement) => {
      vi.stubGlobal("sessionStorage", createStorageMock());
      let resolveHead = (_response: Response): void => {
        throw new Error("Document probe not started");
      };
      const head = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveHead = resolve;
          }),
      );
      vi.stubGlobal("fetch", head);
      const open = vi.fn();
      const shell = paletteShell(stalePalette(), open);

      await withConnectedShell(shell, async () => {
        shell.openPalette();
        await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
        shell.lazyCustomElements.retry();
        await vi.waitFor(() => expect(head).toHaveBeenCalledOnce());

        if (retirement === "close") {
          shell.lazyCustomElements.close();
        } else if (retirement === "context-replaced") {
          shell.resetForContextEpoch();
        } else if (retirement === "disconnected") {
          shell.disconnectedCallback();
        } else {
          shell.lazyCustomElements.request(createLazyElementSpec("new request"));
        }
        resolveHead(new Response(null, { status: 200 }));
        await expect(Promise.all(recovery.pending)).resolves.toEqual([false]);

        expect(recovery.reload).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
      });
    },
  );

  it("repairs stale stored intent before reloading and replays the current action once", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const element = stalePalette();
    const open = vi.fn();
    const shell = paletteShell(element, open);

    shell.openPalette();
    await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
    storage.setItem(storageKey, "{}");
    shell.lazyCustomElements.retry();
    await expect(Promise.all(recovery.pending)).resolves.toEqual([true]);
    expect(recovery.reload).toHaveBeenCalledOnce();
    expect(readLazyShellAction()).toEqual({ eventType: COMMAND_PALETTE_OPEN_EVENT });

    const replacement = paletteShell(element, open);
    await withConnectedShell(replacement, async () => {
      replacement.restorePendingLazyAction();
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      replacement.restorePendingLazyAction();
      expect(open).toHaveBeenCalledOnce();
      expect(readLazyShellAction()).toBeNull();
    });
  });

  it("requests the keyboard shortcuts dialog even from a focused text input", async () => {
    const requested = vi.fn();
    const toggled = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState &
      ShellLifecycle &
      HTMLElement;
    const dialog = document.createElement(KEYBOARD_SHORTCUTS_ELEMENT.tagName) as HTMLElement & {
      toggle: () => void;
    };
    dialog.toggle = toggled;
    shell.append(dialog);
    Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
    const input = document.body.appendChild(document.createElement("input"));
    const shortcut = new KeyboardEvent("keydown", {
      key: "/",
      code: "Slash",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.addEventListener(KEYBOARD_SHORTCUTS_REQUEST_EVENT, requested);

    try {
      await withConnectedShell(shell, async () => {
        input.focus();
        expect(document.activeElement).toBe(input);
        input.dispatchEvent(shortcut);

        expect(shortcut.defaultPrevented).toBe(true);
        expect(requested).toHaveBeenCalledOnce();
        await vi.dynamicImportSettled();
        await vi.waitFor(() => expect(toggled).toHaveBeenCalledOnce());

        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "/",
            code: "Slash",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        expect(toggled).toHaveBeenCalledTimes(2);
      });
    } finally {
      input.remove();
      window.removeEventListener(KEYBOARD_SHORTCUTS_REQUEST_EVENT, requested);
    }
  });

  it("loads the debug overlay shortcut and ignores editable targets", async () => {
    const toggled = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState &
      ShellLifecycle &
      HTMLElement;
    const overlay = document.createElement("openclaw-debug-overlay") as HTMLElement & {
      toggle: () => void;
      open: () => void;
    };
    overlay.toggle = toggled;
    overlay.open = toggled;
    shell.append(overlay);
    Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
    const shortcut = new KeyboardEvent("keydown", {
      key: "d",
      code: "KeyD",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });

    await withConnectedShell(shell, async () => {
      shell.handleDocumentKeydown(shortcut);
      expect(shortcut.defaultPrevented).toBe(true);
      await vi.dynamicImportSettled();
      await vi.waitFor(() => expect(toggled).toHaveBeenCalledOnce());

      const input = document.body.appendChild(document.createElement("input"));
      input.addEventListener("keydown", (event) => shell.handleDocumentKeydown(event));
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "d",
          code: "KeyD",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(toggled).toHaveBeenCalledOnce();
    });
  });

  it.each(["minimized", "close", "context", "replacement", "unmounted"] as const)(
    "keeps the pending debug frame intent owned through %s",
    async (outcome) => {
      vi.stubGlobal("sessionStorage", createStorageMock());
      const element: OptionalCustomElement = DEBUG_OVERLAY_ELEMENT;
      const originalTag = element.tagName;
      const tagName = createLazyElementSpec("debug frame").tagName;
      element.tagName = tagName;
      const opened = vi.fn((_mode: string) => {
        // The loaded overlay records a separate inner-content reload action.
        persistLazyShellAction({ eventType: DEBUG_OVERLAY_REQUEST_EVENT });
      });
      const ready = createDeferred();
      const shell = document.createElement("openclaw-app-shell") as PaletteShell & {
        readonly pendingDebugOverlayMode: "expanded" | "minimized";
        togglePendingDebugOverlayMode(): void;
      };
      Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
      Object.defineProperty(shell, "queryRenderedElement", {
        value: (tag: string) => shell.querySelector(tag),
      });
      vi.spyOn(element, "loadModule").mockImplementation(async () => {
        await ready.promise;
        customElements.define(
          tagName,
          class extends HTMLElement {
            open = opened;
            toggle = () => opened("expanded");
          },
        );
        if (outcome !== "unmounted") {
          shell.append(document.createElement(tagName));
        }
      });
      try {
        await withConnectedShell(shell, async () => {
          window.dispatchEvent(new CustomEvent(DEBUG_OVERLAY_REQUEST_EVENT));
          expect(shell.lazyCustomElements.visibleState?.status).toBe("loading");
          shell.togglePendingDebugOverlayMode();
          expect(shell.pendingDebugOverlayMode).toBe("minimized");
          expect(readLazyShellAction()).toEqual({
            eventType: DEBUG_OVERLAY_REQUEST_EVENT,
            detail: { mode: "minimized" },
          });
          if (outcome === "close") {
            shell.lazyCustomElements.close();
          } else if (outcome === "context") {
            shell.resetForContextEpoch();
          } else if (outcome === "replacement") {
            shell.commandPaletteElement = createLazyElementSpec("replacement palette");
            shell.openPalette();
          }
          ready.resolve();
          await vi.dynamicImportSettled();
          await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState).toBeUndefined());
          if (outcome === "unmounted") {
            expect(opened).not.toHaveBeenCalled();
            shell.append(document.createElement(tagName));
            shell.restorePendingLazyAction();
          }
          if (outcome === "minimized" || outcome === "unmounted") {
            expect(opened).toHaveBeenCalledExactlyOnceWith("minimized");
            expect(readLazyShellAction()).toEqual({ eventType: DEBUG_OVERLAY_REQUEST_EVENT });
            shell.restorePendingLazyAction();
            expect(opened).toHaveBeenCalledOnce();
          } else {
            expect(opened).not.toHaveBeenCalled();
            expect(readLazyShellAction()?.eventType).not.toBe(DEBUG_OVERLAY_REQUEST_EVENT);
          }
        });
      } finally {
        ready.resolve();
        await vi.dynamicImportSettled();
        element.tagName = originalTag;
      }
    },
  );

  it("opens approvals after the modal module loads", async () => {
    const element = createLazyElementSpec("exec approval modal");
    const show = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellLifecycle & {
      approvalOverlay?: { show(): void };
      execApprovalElement: TestOptionalCustomElement;
    };
    shell.execApprovalElement = element;
    Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
    Object.defineProperty(shell, "approvalOverlay", {
      get: () => (customElements.get(element.tagName) ? { show } : undefined),
    });
    stubRenderedWhenDefined(shell);

    await withConnectedShell(shell, async () => {
      window.dispatchEvent(new CustomEvent(SHELL_APPROVALS_OPEN_EVENT));
      await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    });
  });
});
