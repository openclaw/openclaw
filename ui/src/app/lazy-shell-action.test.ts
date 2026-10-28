/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  type CommandPaletteInputHandoff,
} from "../components/command-palette-contract.ts";
import {
  DEBUG_OVERLAY_REQUEST_EVENT,
  KEYBOARD_SHORTCUTS_REQUEST_EVENT,
} from "../components/panel-toggle-contract.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createShellOwner } from "./app-host-solid.test-support.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import type { ShellChromeOwner } from "./app-shell-chrome.ts";
import type { CommandPaletteLoadingState } from "./app-shell-command-palette-loading.ts";
import { SHELL_COMPONENT_TAGS } from "./app-shell-components.ts";
import type { ApplicationGatewaySnapshot } from "./context.ts";
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
type PaletteShell = Omit<ReturnType<typeof createShellOwner>, never> & {
  shellChrome: ShellChromeOwner;
};
function shellFixture(): PaletteShell {
  // SAFETY: The fixture retains the real private event owner for direct lifecycle assertions.
  const shell = createShellOwner() as unknown as PaletteShell;
  Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
  document.body.append(shell.element);
  onTestFinished(() => shell.element.remove());
  return shell;
}
async function withConnectedShell(shell: PaletteShell, run: () => void | Promise<void>) {
  shell.connect();
  try {
    await run();
  } finally {
    shell.disconnect();
    vi.useRealTimers();
  }
}
function mountOverlay<T extends object>(
  shell: PaletteShell,
  property: string,
  tag: string,
  props: T,
) {
  const element = Object.assign(document.createElement(tag), props);
  Object.assign(shell.elements, { [property]: element });
  shell.element.append(element);
  return element;
}
function captureInput(state: CommandPaletteLoadingState, value: string) {
  const input = document.createElement("textarea");
  state.inputRef(input);
  input.value = value;
  state.captureInput();
  return input;
}
function keydown(key: string, code: string, bubbles = false) {
  return new KeyboardEvent("keydown", {
    key,
    code,
    ctrlKey: true,
    shiftKey: true,
    bubbles,
    cancelable: true,
  });
}

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(async () => {
  await vi.dynamicImportSettled();
  resetAppHostTestGlobals();
  vi.restoreAllMocks();
  recovery.reload.mockClear();
  recovery.pending.length = 0;
});

describe("lazy shell action storage", () => {
  it.each(["{", JSON.stringify({ eventType: COMMAND_PALETTE_OPEN_EVENT, extra: true })])(
    "discards malformed state: %s",
    (raw) => {
      const storage = createStorageMock();
      vi.stubGlobal("sessionStorage", storage);
      storage.setItem(storageKey, raw);
      expect(readLazyShellAction()).toBeNull();
      expect(storage.getItem(storageKey)).toBeNull();
    },
  );
});

describe("shell lazy events", () => {
  it("persists only open intent, never a cold prompt or event payload", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const shell = shellFixture();
    await withConnectedShell(shell, () => {
      window.dispatchEvent(
        new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, { detail: { value: "private payload" } }),
      );
      captureInput(shell.commandPaletteLoading, "private cold prompt");
      expect(readLazyShellAction()).toEqual({ eventType: COMMAND_PALETTE_OPEN_EVENT });
      expect(storage.getItem(storageKey)).not.toContain("private");
      shell.closePendingPalette();
    });
  });

  it("keeps composition custody until the mounted palette accepts the final input", async () => {
    vi.useFakeTimers();
    const shell = shellFixture();
    await withConnectedShell(shell, async () => {
      shell.openPalette();
      const state = shell.commandPaletteLoading;
      const input = captureInput(state, "composing");
      state.handleCompositionStart();
      const accepted = vi.fn();
      mountOverlay(shell, "commandPalette", SHELL_COMPONENT_TAGS.palette, {
        openPalette: (take?: CommandPaletteInputHandoff) => accepted(take?.()),
      });
      shell.restorePendingLazyAction();
      expect(accepted).not.toHaveBeenCalled();
      expect(readLazyShellAction()).toEqual({ eventType: COMMAND_PALETTE_OPEN_EVENT });
      input.value = "composition finished";
      input.setSelectionRange(4, 10, "backward");
      state.handleCompositionEnd();
      await vi.advanceTimersByTimeAsync(20);
      expect(accepted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          value: "composition finished",
          selectionStart: 4,
          selectionEnd: 10,
          selectionDirection: "backward",
        }),
      );
      expect(readLazyShellAction()).toBeNull();
    });
  });

  it("retires a composing palette on disconnect while the shell owner remains reusable", async () => {
    vi.useFakeTimers();
    const shell = shellFixture();
    await withConnectedShell(shell, async () => {
      shell.openPalette();
      const state = shell.commandPaletteLoading;
      captureInput(state, "retired prompt");
      const file = new File(["image"], "retired.png", { type: "image/png" });
      const paste = new Event("paste", { cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { items: [{ getAsFile: () => file }] },
      });
      // SAFETY: This synthetic paste carries the ClipboardEvent data contract above.
      state.handlePaste(paste as ClipboardEvent);
      expect(paste.defaultPrevented).toBe(true);
      state.handleCompositionStart();
      const retired = vi.fn();
      state.handoff(retired);
      const take = state.captureHandoff();
      state.handleCompositionEnd();
      shell.disconnect();
      expect({ active: state.active(), value: state.value() }).toEqual({
        active: false,
        value: "",
      });
      expect(take()).toBeUndefined();
      shell.connect();
      shell.openPalette();
      expect(shell.commandPaletteLoading).toBe(state);
      const fresh = state.captureHandoff()();
      expect(fresh).toMatchObject({ value: "" });
      expect(fresh?.attachmentFiles).toBeUndefined();
      expect(fresh?.submitRequested).toBeUndefined();
      expect(take()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(20);
      expect(retired).not.toHaveBeenCalled();
    });
  });

  it.each(["connection", "account", "reconnect"] as const)(
    "respects the canonical %s boundary while a cold palette is composing",
    async (change) => {
      const shell = shellFixture();
      const open = vi.fn();
      let snapshot: Pick<ApplicationGatewaySnapshot, "client" | "phase" | "hello" | "selfUser"> = {
        client: null,
        phase: "connected",
        hello: null,
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
      captureInput(state, "old-owner prompt");
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
        expect({ active: state.active(), value: state.value() }).toEqual({
          active: true,
          value: "old-owner prompt",
        });
        snapshot = { ...snapshot, phase: "connected", selfUser: { id: "first-user" } };
        shell.shellChrome.synchronizeCommandPaletteScope();
        expect(take()?.value).toBe("old-owner prompt");
        shell.closePendingPalette();
      } else {
        expect(state.active()).toBe(false);
        expect(state.value()).toBe("");
        expect(take()).toBeUndefined();
        expect(readLazyShellAction()).toBeNull();
      }
      state.handleCompositionEnd();
      await Promise.resolve();
      expect(open).not.toHaveBeenCalled();
    },
  );

  it.each([
    "unavailable",
    "denied",
    "replacement-write-failed",
    "close",
    "context-replaced",
    "disconnected",
    "new-request",
    "reload",
  ] as const)("owns a stale palette reload through %s", async (mode) => {
    const storage = createStorageMock();
    const denied = ["unavailable", "denied", "replacement-write-failed"].includes(mode);
    vi.stubGlobal("sessionStorage", mode === "unavailable" ? null : storage);
    if (mode === "denied") {
      Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        get() {
          throw new DOMException("Storage blocked", "SecurityError");
        },
      });
    }
    const probe = createDeferred<Response>();
    const head = vi.fn(() => probe.promise);
    vi.stubGlobal("fetch", head);
    const shell = shellFixture();
    shell.connect();
    shell.openPalette();
    if (mode === "replacement-write-failed") {
      vi.spyOn(storage, "setItem").mockImplementation(() => {
        throw new DOMException("Storage full", "QuotaExceededError");
      });
    }
    try {
      const retry = shell.retryPendingLazyAction(() => true);
      if (denied) {
        await expect(retry).resolves.toBe(false);
        expect(head).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(head).toHaveBeenCalledOnce());
        if (mode === "close") {
          shell.closePendingPalette();
        } else if (mode === "context-replaced") {
          shell.shellChrome.abandonPendingLazyActionForContext();
        } else if (mode === "disconnected") {
          shell.disconnect();
        } else if (mode === "new-request") {
          shell.shellChrome.requestShellComponent("shortcuts", {
            eventType: KEYBOARD_SHORTCUTS_REQUEST_EVENT,
          });
        }
        probe.resolve(new Response(null, { status: 200 }));
        await expect(retry).resolves.toBe(mode === "reload");
      }
      expect(recovery.reload).toHaveBeenCalledTimes(mode === "reload" ? 1 : 0);
      if (mode === "reload") {
        expect(readLazyShellAction()).toEqual({ eventType: COMMAND_PALETTE_OPEN_EVENT });
      }
    } finally {
      shell.disconnect();
      probe.resolve(new Response(null, { status: 503 }));
      await Promise.all(recovery.pending);
    }
  });

  it.each(["shortcuts", "approvals"] as const)(
    "replays %s after the retained loaded overlay is detached",
    async (surface) => {
      const shell = shellFixture();
      const component = surface === "shortcuts" ? "shortcuts" : "approvals";
      const eventType =
        surface === "shortcuts" ? KEYBOARD_SHORTCUTS_REQUEST_EVENT : SHELL_APPROVALS_OPEN_EVENT;
      const property = surface === "shortcuts" ? "keyboardShortcuts" : "approvalOverlay";
      const opened = vi.fn();
      const createOverlay = () =>
        mountOverlay(shell, property, SHELL_COMPONENT_TAGS[component], {
          toggle: opened,
          show: opened,
        });
      createOverlay().remove();
      await withConnectedShell(shell, () => {
        window.dispatchEvent(new CustomEvent(eventType));
        expect(opened).not.toHaveBeenCalled();
        expect(shell.isShellComponentRequested(component)).toBe(true);
        expect(readLazyShellAction()).toEqual({ eventType });
        shell.restorePendingLazyAction();
        expect(opened).not.toHaveBeenCalled();
        createOverlay();
        shell.restorePendingLazyAction();
        expect(opened).toHaveBeenCalledOnce();
        expect(readLazyShellAction()).toBeNull();
      });
    },
  );

  it.each(["shortcuts", "debug"] as const)(
    "handles the %s shortcut and its editable-target policy",
    async (surface) => {
      const shell = shellFixture();
      const toggled = vi.fn();
      mountOverlay(
        shell,
        surface === "debug" ? "debugOverlay" : "keyboardShortcuts",
        SHELL_COMPONENT_TAGS[surface],
        { toggle: toggled, open: toggled },
      );
      const input = document.body.appendChild(document.createElement("input"));
      onTestFinished(() => input.remove());
      await withConnectedShell(shell, () => {
        if (surface === "debug") {
          document.dispatchEvent(keydown("d", "KeyD"));
          expect(toggled).toHaveBeenCalledOnce();
          input.dispatchEvent(keydown("d", "KeyD", true));
          expect(toggled).toHaveBeenCalledOnce();
        } else {
          const event = keydown("/", "Slash", true);
          input.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(true);
          expect(toggled).toHaveBeenCalledOnce();
        }
      });
    },
  );

  it.each(["close", "context", "replacement", "unmounted", "detached"] as const)(
    "keeps the pending debug frame intent owned through %s",
    async (outcome) => {
      const shell = shellFixture();
      const opened = vi.fn(() =>
        persistLazyShellAction({ eventType: DEBUG_OVERLAY_REQUEST_EVENT }),
      );
      const mount = () =>
        mountOverlay(shell, "debugOverlay", SHELL_COMPONENT_TAGS.debug, {
          open: opened,
          toggle: opened,
        });
      if (outcome === "detached") {
        mount().remove();
      }
      await withConnectedShell(shell, () => {
        window.dispatchEvent(new CustomEvent(DEBUG_OVERLAY_REQUEST_EVENT));
        shell.togglePendingDebugOverlayMode();
        expect(shell.pendingDebugOverlayMode).toBe("minimized");
        expect(readLazyShellAction()).toEqual({
          eventType: DEBUG_OVERLAY_REQUEST_EVENT,
          detail: { mode: "minimized" },
        });
        if (outcome === "close") {
          shell.cancelShellComponentRequest("debug");
        } else if (outcome === "context") {
          shell.shellChrome.abandonPendingLazyActionForContext();
        } else if (outcome === "replacement") {
          shell.openPalette();
        }
        shell.restorePendingLazyAction();
        expect(opened).not.toHaveBeenCalled();
        mount();
        shell.restorePendingLazyAction();
        if (outcome === "unmounted" || outcome === "detached") {
          expect(opened).toHaveBeenCalledExactlyOnceWith("minimized");
          expect(readLazyShellAction()).toEqual({ eventType: DEBUG_OVERLAY_REQUEST_EVENT });
          shell.restorePendingLazyAction();
          expect(opened).toHaveBeenCalledOnce();
        } else {
          expect(opened).not.toHaveBeenCalled();
          expect(readLazyShellAction()?.eventType).not.toBe(DEBUG_OVERLAY_REQUEST_EVENT);
        }
      });
    },
  );
});
