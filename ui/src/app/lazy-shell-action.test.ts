/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { COMMAND_PALETTE_OPEN_EVENT } from "../components/command-palette-contract.ts";
import {
  DEBUG_OVERLAY_REQUEST_EVENT,
  KEYBOARD_SHORTCUTS_REQUEST_EVENT,
} from "../components/panel-toggle-contract.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createShellOwner } from "./app-host-solid.test-support.ts";
import {
  createLazyElementSpec,
  resetAppHostTestGlobals,
  type TestOptionalCustomElement,
  stubRenderedWhenDefined,
} from "./app-host.test-support.ts";
import type { ShellChromeOwner } from "./app-shell-chrome.ts";
import type { CommandPaletteLoadingState } from "./app-shell-command-palette-loading.ts";
import type { ApplicationGatewaySnapshot } from "./context.ts";
import {
  DEBUG_OVERLAY_ELEMENT,
  KEYBOARD_SHORTCUTS_ELEMENT,
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
  connect(): void;
  disconnect(): void;
};

async function withConnectedShell(shell: ShellLifecycle, run: () => void | Promise<void>) {
  shell.connect();
  try {
    await run();
  } finally {
    shell.disconnect();
  }
}

afterEach(async () => {
  await vi.dynamicImportSettled();
  resetAppHostTestGlobals();
  vi.restoreAllMocks();
  recovery.reload.mockClear();
  recovery.pending.length = 0;
});

type PaletteShell = Omit<
  ReturnType<typeof createShellOwner>,
  "commandPaletteElement" | "execApprovalElement"
> & {
  commandPaletteElement: TestOptionalCustomElement;
  execApprovalElement: TestOptionalCustomElement;
  shellChrome: ShellChromeOwner;
};
function shellFixture(): PaletteShell {
  const shell = createShellOwner() as unknown as PaletteShell;
  Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
  onTestFinished(() => shell.element.remove());
  return shell;
}
beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
const emit = (event: string) => window.dispatchEvent(new CustomEvent(event));

function paletteShell(element: TestOptionalCustomElement, open: () => void): PaletteShell {
  const shell = shellFixture();
  shell.commandPaletteElement = element;
  Object.defineProperty(shell.elements, "commandPalette", {
    get: () =>
      customElements.get(element.tagName)
        ? { isConnected: true, isOpen: false, openPalette: open, togglePalette: open }
        : undefined,
  });
  stubRenderedWhenDefined(shell);
  return shell;
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

function coldPalette() {
  const gate = createDeferred();
  const element = createLazyElementSpec("cold palette");
  const load = element.loadModule;
  element.loadModule = async () => {
    await gate.promise;
    await load();
  };
  return { element, gate };
}

function captureInput(state: CommandPaletteLoadingState, value: string) {
  const input = document.createElement("textarea");
  state.inputRef(input);
  input.value = value;
  state.captureInput();
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

function stalePalette() {
  return createLazyElementSpec("command palette", {
    firstError: new Error("Failed to fetch dynamically imported module: palette-old.js"),
  });
}

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
    const { gate, element } = coldPalette();
    const shell = paletteShell(element, vi.fn());
    await withConnectedShell(shell, async () => {
      window.dispatchEvent(
        new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, {
          detail: { value: "private payload" },
        }),
      );
      captureInput(shell.commandPaletteLoading, "private cold prompt");
      expect(readLazyShellAction()).toEqual({ eventType: COMMAND_PALETTE_OPEN_EVENT });
      expect(storage.getItem(storageKey)).not.toContain("private");
      shell.lazyCustomElements.close();
      gate.resolve();
    });
  });

  it("retires a composing palette on disconnect while the shell owner remains reusable", async () => {
    vi.useFakeTimers();
    const { gate, element } = coldPalette();
    const shell = paletteShell(element, vi.fn());
    try {
      shell.connect();
      shell.openPalette();
      const state = shell.commandPaletteLoading;
      captureInput(state, "retired prompt");
      const file = new File(["image"], "retired.png", { type: "image/png" });
      const paste = new Event("paste", { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(paste, "clipboardData", {
        value: { items: [{ getAsFile: () => file }] },
      });
      state.handlePaste(paste);
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
    } finally {
      shell.disconnect();
      vi.useRealTimers();
      gate.resolve();
      await vi.dynamicImportSettled();
    }
  });

  it.each(["connection", "account", "reconnect"] as const)(
    "respects the canonical %s boundary while a cold palette is composing",
    async (change) => {
      const { gate, element } = coldPalette();
      const open = vi.fn();
      const shell = paletteShell(element, open);
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
        snapshot = {
          ...snapshot,
          phase: "connected",
          selfUser: { id: "first-user" },
        };
        shell.shellChrome.synchronizeCommandPaletteScope();
        expect(take()?.value).toBe("old-owner prompt");
        shell.lazyCustomElements.close();
      } else {
        expect(state.active()).toBe(false);
        expect(state.value()).toBe("");
        expect(take()).toBeUndefined();
        expect(readLazyShellAction()).toBeNull();
      }
      state.handleCompositionEnd();
      gate.resolve();
      await vi.dynamicImportSettled();
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
  ] as const)("owns a stale palette retry through %s", async (mode) => {
    const storage = createStorageMock();
    const inPlace = ["unavailable", "denied", "replacement-write-failed"].includes(mode);
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
    const probe = createDeferred<Response>();
    const head = vi.fn(() =>
      inPlace ? Promise.resolve(new Response(null, { status: 200 })) : probe.promise,
    );
    vi.stubGlobal("fetch", head);
    const element = stalePalette();
    const open = vi.fn();
    const shell = paletteShell(element, open);
    if (mode === "replacement-write-failed") {
      vi.spyOn(storage, "setItem").mockImplementation(() => {
        throw new DOMException("Storage full", "QuotaExceededError");
      });
    }
    try {
      if (mode !== "reload") {
        shell.connect();
      }
      shell.openPalette();
      await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
      if (mode === "reload") {
        storage.setItem(storageKey, "{}");
      }
      shell.lazyCustomElements.retry();
      if (inPlace) {
        await Promise.all(recovery.pending);
        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        expect(recovery.reload).not.toHaveBeenCalled();
        expect(head).not.toHaveBeenCalled();
        expect(readLazyShellAction()).toBeNull();
      } else {
        await vi.waitFor(() => expect(head).toHaveBeenCalledOnce());
        switch (mode) {
          case "close":
            shell.lazyCustomElements.close();
            break;
          case "context-replaced":
            shell.shellChrome.abandonPendingLazyActionForContext();
            break;
          case "disconnected":
            shell.disconnect();
            break;
          case "new-request":
            shell.lazyCustomElements.request(createLazyElementSpec("new request"));
            break;
          case "denied":
          case "reload":
          case "replacement-write-failed":
          case "unavailable":
            break;
        }
        probe.resolve(new Response(null, { status: 200 }));
        await expect(Promise.all(recovery.pending)).resolves.toEqual([mode === "reload"]);
        if (mode === "reload") {
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
        } else {
          expect(recovery.reload).not.toHaveBeenCalled();
          expect(open).not.toHaveBeenCalled();
        }
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
      const spec = createLazyElementSpec(surface);
      await spec.loadModule();
      const shell = shellFixture();
      const element =
        surface === "shortcuts" ? KEYBOARD_SHORTCUTS_ELEMENT : shell.execApprovalElement;
      const originalTag = element.tagName;
      element.tagName = spec.tagName;
      const eventType =
        surface === "shortcuts" ? KEYBOARD_SHORTCUTS_REQUEST_EVENT : SHELL_APPROVALS_OPEN_EVENT;
      const property = surface === "shortcuts" ? "keyboardShortcuts" : "approvalOverlay";
      const opened = vi.fn();
      const createOverlay = () =>
        mountOverlay(shell, property, spec.tagName, { toggle: opened, show: opened });
      const detached = createOverlay();
      document.body.append(shell.element);
      detached.remove();
      try {
        await withConnectedShell(shell, async () => {
          emit(eventType);
          expect(opened).not.toHaveBeenCalled();
          expect(shell.lazyCustomElements.visibleState?.status).toBe("loading");
          await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState).toBeUndefined());
          expect(readLazyShellAction()).toEqual({ eventType });

          createOverlay();
          shell.restorePendingLazyAction();
          expect(opened).toHaveBeenCalledOnce();
          expect(readLazyShellAction()).toBeNull();
        });
      } finally {
        element.tagName = originalTag;
        shell.element.remove();
      }
    },
  );

  it.each(["shortcuts", "debug"] as const)(
    "handles the %s shortcut and its editable-target policy",
    async (surface) => {
      const requested = vi.fn();
      const toggled = vi.fn();
      const shell = shellFixture();
      const isDebug = surface === "debug";
      const overlay = mountOverlay(
        shell,
        isDebug ? "debugOverlay" : "keyboardShortcuts",
        isDebug ? "openclaw-debug-overlay" : KEYBOARD_SHORTCUTS_ELEMENT.tagName,
        isDebug ? { toggle: toggled, open: toggled } : {},
      );
      const input = document.body.appendChild(document.createElement("input"));
      document.body.append(shell.element);
      const shortcut = isDebug ? keydown("d", "KeyD") : keydown("/", "Slash", true);
      if (!isDebug) {
        window.addEventListener(KEYBOARD_SHORTCUTS_REQUEST_EVENT, requested);
      }
      try {
        await withConnectedShell(shell, async () => {
          if (isDebug) {
            document.dispatchEvent(shortcut);
          } else {
            input.focus();
            expect(document.activeElement).toBe(input);
            input.dispatchEvent(shortcut);
          }
          expect(shortcut.defaultPrevented).toBe(true);
          if (!isDebug) {
            expect(requested).toHaveBeenCalledOnce();
          }
          await vi.dynamicImportSettled();
          if (isDebug) {
            await vi.waitFor(() => expect(toggled).toHaveBeenCalledOnce());
            input.dispatchEvent(keydown("d", "KeyD", true));
            expect(toggled).toHaveBeenCalledOnce();
          } else {
            await vi.waitFor(() => expect(overlay).toMatchObject({ isOpen: true }));
          }
        });
      } finally {
        shell.element.remove();
        input.remove();
        window.removeEventListener(KEYBOARD_SHORTCUTS_REQUEST_EVENT, requested);
      }
    },
  );

  it.each(["close", "context", "replacement", "unmounted", "detached"] as const)(
    "keeps the pending debug frame intent owned through %s",
    async (outcome) => {
      const element: OptionalCustomElement = DEBUG_OVERLAY_ELEMENT;
      const originalTag = element.tagName;
      const tagName = createLazyElementSpec("debug frame").tagName;
      element.tagName = tagName;
      const opened = vi.fn((_mode: string) => {
        // The loaded overlay records a separate inner-content reload action.
        persistLazyShellAction({ eventType: DEBUG_OVERLAY_REQUEST_EVENT });
      });
      const ready = createDeferred();
      const shell = shellFixture();
      Object.defineProperty(shell, "queryRenderedElement", {
        value: (tag: string) => shell.element.querySelector(tag),
      });
      document.body.append(shell.element);
      if (outcome === "detached") {
        const detached = mountOverlay(shell, "debugOverlay", tagName, {
          open: opened,
          toggle: () => opened("expanded"),
        });
        detached.remove();
      }
      vi.spyOn(element, "loadModule").mockImplementation(async () => {
        await ready.promise;
        customElements.define(
          tagName,
          class extends HTMLElement {
            open = opened;
            toggle = () => opened("expanded");
          },
        );
        if (outcome !== "unmounted" && outcome !== "detached") {
          mountOverlay(shell, "debugOverlay", tagName, {});
        }
      });
      try {
        await withConnectedShell(shell, async () => {
          emit(DEBUG_OVERLAY_REQUEST_EVENT);
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
            shell.shellChrome.abandonPendingLazyActionForContext();
          } else if (outcome === "replacement") {
            shell.commandPaletteElement = createLazyElementSpec("replacement palette");
            shell.openPalette();
          }
          ready.resolve();
          await vi.dynamicImportSettled();
          await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState).toBeUndefined());
          if (outcome === "unmounted" || outcome === "detached") {
            expect(opened).not.toHaveBeenCalled();
            mountOverlay(shell, "debugOverlay", tagName, {});
            shell.restorePendingLazyAction();
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
        shell.element.remove();
      }
    },
  );

  it("opens approvals after the modal module loads", async () => {
    const element = createLazyElementSpec("exec approval modal");
    const show = vi.fn();
    const shell = shellFixture();
    shell.execApprovalElement = element;
    Object.defineProperty(shell.elements, "approvalOverlay", {
      get: () => (customElements.get(element.tagName) ? { isConnected: true, show } : undefined),
    });
    stubRenderedWhenDefined(shell);

    await withConnectedShell(shell, async () => {
      emit(SHELL_APPROVALS_OPEN_EVENT);
      await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    });
  });
});
