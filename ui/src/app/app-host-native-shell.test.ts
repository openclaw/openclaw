/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import "../components/modal-dialog.tsx";
import "../components/sidebar-update-card.tsx";
import { createTooltip, settleTooltip } from "../components/tooltip.test-support.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  createConnectedShellOwner as createShellOwner,
  createShellOwner as createDisconnectedShellOwner,
} from "./app-host-solid.test-support.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import { handleNavDrawerKeydown } from "./navigation-surface.ts";

let navigate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  navigate = vi.fn();
});

function nativeSessionContext(
  selectedId: string,
  options: { methods?: string[]; scopes?: string[] } = {},
): ApplicationContext {
  return {
    navigate,
    agentSelection: { state: { selectedId } },
    gateway: {
      snapshot: {
        client: {},
        phase: "connected",
        hello: {
          auth: { role: "operator", scopes: options.scopes ?? ["operator.write"] },
          features: { methods: options.methods ?? ["sessions.create"] },
        },
      },
    },
  } as unknown as ApplicationContext;
}

function navigationShell(context: Partial<ApplicationContext> = {}) {
  const shell = createShellOwner();
  shell.runtime = { context: { navigate, ...context } } as ApplicationRuntime;
  return shell;
}

function settingsShell() {
  const shell = navigationShell({
    overlays: { snapshot: { devicePairSetupOpen: false } },
  } as unknown as ApplicationContext);
  shell.lastWorkspaceLocation = { routeId: "usage", pathname: "/usage", search: "", hash: "" };
  shell.navDrawerOpen = false;
  shell.routeState = { routeId: "appearance" };
  return shell;
}

function keydown(init: KeyboardEventInit) {
  return new KeyboardEvent("keydown", { cancelable: true, ...init });
}

function platformIs(platform: string) {
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  onTestFinished(() => spy.mockRestore());
}

function append<T extends HTMLElement>(element: T): T {
  document.body.append(element);
  onTestFinished(() => element.remove());
  return element;
}

function nativeNavigate(detail: { path: string; search?: string }) {
  const event = new CustomEvent("openclaw:native-navigate", { cancelable: true, detail });
  window.dispatchEvent(event);
  return event;
}

afterEach(resetAppHostTestGlobals);

it("focuses the navigation drawer without a tooltip claiming Escape", async () => {
  vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: true }));
  const runtime = bootstrapApplication();
  onTestFinished(() => runtime.stop());
  const shell = createShellOwner();
  shell.runtime = runtime;
  const drawer = document.createElement("nav");
  drawer.className = "shell-nav";
  shell.navDrawerElement = drawer;
  const { tooltip, trigger } = createTooltip("Workspace options");
  Object.defineProperty(trigger, "checkVisibility", { value: () => true });
  drawer.append(tooltip);
  shell.element.append(drawer);
  append(shell.element);
  await settleTooltip(tooltip);
  shell.toggleNavigationSurface();
  shell.afterCommit();
  await shell.updateComplete;
  await settleTooltip(tooltip);
  expect(document.activeElement).toBe(trigger);
  expect(tooltip.hasAttribute("open")).toBe(false);
});

it.each(["MacIntel", "Win32"])(
  "uses only the platform sidebar modifier on %s without consuming text navigation",
  (platform) => {
    platformIs(platform);
    const snapshot = { navCollapsed: false };
    const update = vi.fn((next: { navCollapsed: boolean }) => Object.assign(snapshot, next));
    navigationShell({ navigation: { snapshot, update } } as unknown as ApplicationContext);
    const drawer = Object.assign(document.createElement("div"), { closeNavDrawer: vi.fn() });
    const editor = append(document.createElement("textarea"));
    for (const modifiers of [
      { metaKey: true },
      { ctrlKey: true },
      { metaKey: true, ctrlKey: true },
      { ctrlKey: true, altKey: true },
    ]) {
      update.mockClear();
      drawer.closeNavDrawer.mockClear();
      const expected =
        platform === "MacIntel"
          ? Object.keys(modifiers).length === 1 && "metaKey" in modifiers
          : Object.keys(modifiers).length === 1 && "ctrlKey" in modifiers;
      const init = { key: "b", code: "KeyB", bubbles: true, cancelable: true, ...modifiers };
      const event = keydown(init);
      editor.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(expected);
      expect(update).toHaveBeenCalledTimes(Number(expected));
      const drawerEvent = keydown(init);
      handleNavDrawerKeydown(drawer, drawerEvent);
      expect(drawerEvent.defaultPrevented).toBe(expected);
      expect(drawer.closeNavDrawer).toHaveBeenCalledTimes(Number(expected));
    }
  },
);

it("reports readiness only while the native command listener owner is connected", () => {
  const shell = createDisconnectedShellOwner();
  const nativeWindow = window as Window & { __OPENCLAW_NATIVE_COMMANDS_READY__?: boolean };
  const states: boolean[] = [];
  const recordState = () =>
    states.push(nativeWindow["__OPENCLAW_NATIVE_COMMANDS_READY__"] === true);
  window.addEventListener("openclaw:native-commands-state", recordState);
  onTestFinished(() => {
    shell.disconnect();
    window.removeEventListener("openclaw:native-commands-state", recordState);
    Reflect.deleteProperty(nativeWindow, "__OPENCLAW_NATIVE_COMMANDS_READY__");
  });
  shell.connect();
  expect(states).toEqual([true]);

  shell.disconnect();
  expect(states).toEqual([true, false]);
});

it.each([false, true])("handles Command-Comma only with Shift: %s", (shiftKey) => {
  navigationShell();
  const event = keydown({ key: shiftKey ? "<" : ",", code: "Comma", metaKey: true, shiftKey });
  document.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(shiftKey);
  if (shiftKey) {
    expect(navigate).toHaveBeenCalledWith("appearance", undefined);
  } else {
    expect(navigate).not.toHaveBeenCalled();
  }
});

it.each(["none", "keyboardShortcuts", "approvalOverlay"] as const)(
  "restores the complete prior workspace URL when Escape leaves Settings after %s detaches",
  (surface) => {
    const shell = settingsShell();
    shell.lastWorkspaceLocation = {
      routeId: "usage",
      pathname: "/usage",
      search: "?agent=main",
      hash: "#queue",
    };

    if (surface !== "none") {
      const overlay = Object.assign(document.createElement("div"), {
        isOpen: true,
        dialogOpen: true,
      });
      Object.assign(shell.elements, { [surface]: overlay });
      shell.element.append(overlay);
      append(shell.element);
      document.dispatchEvent(keydown({ key: "Escape" }));
      expect(navigate).not.toHaveBeenCalled();
      overlay.remove();
    }

    document.dispatchEvent(keydown({ key: "Escape" }));

    expect(navigate).toHaveBeenCalledWith("usage", {
      pathname: "/usage",
      search: "?agent=main",
      hash: "#queue",
    });
  },
);

it("keeps the raw config editor unchanged when Escape is pressed", () => {
  settingsShell();
  const rawField = append(document.createElement("label"));
  rawField.className = "config-raw-field";
  const rawEditor = rawField.appendChild(document.createElement("textarea"));
  rawEditor.value = '{ "gateway": { "port": 18789 } }';
  rawEditor.focus();
  const onInput = vi.fn();
  rawEditor.addEventListener("input", onInput);

  const event = keydown({ key: "Escape", bubbles: true });
  rawEditor.dispatchEvent(event);

  expect(rawEditor.value).toBe('{ "gateway": { "port": 18789 } }');
  expect(onInput).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

it("lets a shadow-root confirmation own Escape without leaving Settings", async () => {
  const restoreDialogPolyfill = installDialogPolyfill();
  settingsShell();
  const container = append(document.createElement("div"));
  const shadow = container.attachShadow({ mode: "open" });
  const modal = shadow.appendChild(document.createElement("openclaw-modal-dialog"));
  const cancel = modal.appendChild(document.createElement("button"));

  onTestFinished(restoreDialogPolyfill);
  const { dialog } = await getRenderedModalDialog(shadow);
  expect(dialog.open).toBe(true);
  expect(dialog.getRootNode()).toBe(shadow);
  expect(document.querySelector("dialog[open]")).toBeNull();
  const event = keydown({ key: "Escape", bubbles: true, composed: true });

  cancel.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});

it("toggles the navigation sidebar when the native macOS titlebar button fires", () => {
  const snapshot = { navCollapsed: false };
  const update = vi.fn((next: { navCollapsed: boolean }) => {
    snapshot.navCollapsed = next.navCollapsed;
  });
  navigationShell({ navigation: { snapshot, update } } as unknown as ApplicationContext);

  window.dispatchEvent(new Event("openclaw:native-toggle-sidebar"));
  expect(update).toHaveBeenLastCalledWith({ navCollapsed: true });

  window.dispatchEvent(new Event("openclaw:native-toggle-sidebar"));
  expect(update).toHaveBeenLastCalledWith({ navCollapsed: false });
});

it.each(["operator.write", "operator.sessions.write"])(
  "opens search and starts a session from native titlebar events with %s",
  async (scope) => {
    const openPalette = vi.fn();
    const togglePalette = vi.fn();
    const shell = navigationShell(nativeSessionContext("agent/a", { scopes: [scope] }));
    shell.elements.commandPalette = Object.assign(
      document.createElement("openclaw-command-palette"),
      {
        custodianAvailable: false,
        desktopAvailable: false,
        isOpen: false,
        openPalette,
        togglePalette,
      },
    );
    append(shell.elements.commandPalette);
    window.dispatchEvent(new Event("openclaw:native-open-search"));
    const toggleEvent = new CustomEvent("openclaw:native-toggle-search", { cancelable: true });
    window.dispatchEvent(toggleEvent);
    shell.handleNativeNewSession();

    expect(openPalette).toHaveBeenCalledOnce();
    expect(togglePalette).toHaveBeenCalledOnce();
    // preventDefault is the handled signal for the native legacy fallback.
    expect(toggleEvent.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("new-session", { search: "?agent=agent%2Fa" });

    platformIs("MacIntel");
    shell.elements.commandPalette.remove();
    const shortcut = keydown({ key: "k", metaKey: true });
    document.dispatchEvent(shortcut);
    // Join the cold import before the shared runner retires this module graph.
    await vi.dynamicImportSettled();
    expect(shortcut.defaultPrevented).toBe(true);
    expect(togglePalette).toHaveBeenCalledOnce();
  },
);

it.each(
  ["MacIntel", "Win32", "Linux x86_64"].flatMap((platform) =>
    [false, true].map((native) => ({ platform, native })),
  ),
)("opens a draft from the composer on $platform (native=$native)", ({ platform, native }) => {
  vi.stubGlobal("__OPENCLAW_NATIVE_WEB_CHROME__", native);
  platformIs(platform);
  navigationShell(nativeSessionContext("research", { scopes: ["operator.sessions.write"] }));
  const textarea = append(document.createElement("textarea"));
  textarea.value = "Keep this foreground draft";
  const modifier = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
  // Receiver semantics only; synthetic DOM events cannot prove OS delivery.
  const chord = native
    ? { key: "n", code: "KeyN", shiftKey: false }
    : { key: "O", code: "KeyO", shiftKey: true };
  const event = keydown({ ...chord, bubbles: true, ...modifier });
  textarea.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(navigate).toHaveBeenCalledExactlyOnceWith("new-session", {
    search: "?agent=research",
  });
  expect(textarea.value).toBe("Keep this foreground draft");
  for (const init of [
    native ? { key: "O", code: "KeyO", shiftKey: true } : { key: "n", code: "KeyN" },
    { key: "Enter", code: "Enter" },
    { ...chord, repeat: true },
    { ...chord, isComposing: true },
    { ...chord, keyCode: 229 },
  ]) {
    const ignored = keydown({ ...modifier, ...init, bubbles: true });
    textarea.dispatchEvent(ignored);
    expect(ignored.defaultPrevented).toBe(false);
  }
  expect(navigate).toHaveBeenCalledOnce();
});

it.each(["modal", "onboarding", "read-only", "unavailable", "offline"])(
  "leaves the New Session shortcut unhandled during %s",
  (guard) => {
    platformIs("MacIntel");
    const shell = createShellOwner();
    const context = nativeSessionContext("main", {
      ...(guard === "read-only" ? { scopes: ["operator.read"] } : {}),
      ...(guard === "unavailable" ? { methods: [] } : {}),
    });
    shell.runtime = { context } as ApplicationRuntime;
    shell.onboarding = guard === "onboarding";
    if (guard === "offline") {
      context.gateway.snapshot.phase = "offline";
    }
    const modal = document.createElement("div");
    if (guard === "modal") {
      (document.openClawModalLayers ??= new Set()).add(modal);
    }
    onTestFinished(() => {
      document.openClawModalLayers?.delete(modal);
    });
    const key = keydown({ key: "O", code: "KeyO", metaKey: true, shiftKey: true });
    document.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  },
);

it("leaves a rendered modal navigation drawer in control of the New Session chord", () => {
  platformIs("MacIntel");
  const shell = navigationShell(nativeSessionContext("main"));
  const drawer = append(document.createElement("nav"));
  drawer.className = "shell-nav";
  drawer.setAttribute("aria-modal", "true");
  Object.assign(shell, { navDrawerElement: drawer });
  document.dispatchEvent(keydown({ key: "O", code: "KeyO", metaKey: true, shiftKey: true }));
  expect(navigate).not.toHaveBeenCalled();
});

it("retains a native new-session request until a context exists", () => {
  const shell = createShellOwner();

  shell.handleNativeNewSession();

  shell.runtime = { context: nativeSessionContext("main") } as ApplicationRuntime;
  shell.handleNativeNewSession();

  expect(navigate).toHaveBeenCalledExactlyOnceWith("new-session", { search: "?agent=main" });
});

it("does not start a native session without exact sessions.create access", () => {
  for (const options of [
    { methods: ["sessions.list"], scopes: ["operator.write"] },
    { methods: ["sessions.create"], scopes: ["operator.read"] },
    { methods: ["sessions.create"], scopes: ["operator.sessions.read"] },
  ]) {
    const shell = navigationShell(nativeSessionContext("main", options));

    shell.handleNativeNewSession();

    expect(navigate).not.toHaveBeenCalled();
  }
});

it.each([
  ["/settings/appearance", "appearance", "", undefined],
  ["/settings/appearance", "appearance", "/gateway", undefined],
  ["/settings/channels", "channels", "", undefined],
  ["/chat/main/dashboard/12345678-90ab-cdef-1234-567890abcdef", "chat", "/gateway", "?view=chat"],
] as const)(
  "preserves native destination %s and acknowledges it",
  (path, routeId, basePath, search) => {
    navigationShell({ basePath });
    const event = nativeNavigate({ path, search });
    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(routeId, {
      pathname: `${basePath}${path}`,
      ...(search ? { search } : {}),
    });
  },
);

it.each(["onboarding=1", "?onboarding=1#x"])(
  "ignores malformed native search %s and keeps the plain route",
  (search) => {
    navigationShell({ basePath: "" });
    const event = nativeNavigate({ path: "/custodian", search });
    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("custodian", { pathname: "/custodian" });
  },
);

it.each(["https://example.com", "//example.com", "/https://example.com", "/unknown"])(
  "leaves invalid native Dashboard path %s unhandled",
  (path) => {
    navigationShell();
    const event = nativeNavigate({ path });
    expect(event.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  },
);

it("does not start a native session during onboarding", () => {
  const shell = navigationShell({
    navigate,
    agentSelection: { state: { selectedId: "main" } },
  } as unknown as ApplicationContext);
  shell.onboarding = true;

  shell.handleNativeNewSession();

  expect(navigate).not.toHaveBeenCalled();
});

it("deduplicates native nav state reports", () => {
  const postMessage = vi.fn();
  Object.assign(window, { webkit: { messageHandlers: { openclawNav: { postMessage } } } });
  const runtime = bootstrapApplication();
  onTestFinished(() => runtime.stop());
  runtime.context.navigation.update({ navCollapsed: false, navWidth: 280 });
  const shell = createShellOwner();
  shell.runtime = runtime;

  shell.afterCommit();
  shell.afterCommit();
  runtime.context.navigation.update({ navCollapsed: true });
  shell.afterCommit();

  expect(postMessage.mock.calls).toEqual([
    [{ type: "nav-state", collapsed: false, width: 280 }],
    [{ type: "nav-state", collapsed: true, width: 280 }],
  ]);
});
