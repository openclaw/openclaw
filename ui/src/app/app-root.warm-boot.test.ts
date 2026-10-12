/* @vitest-environment jsdom */
import { ContextEvent } from "@lit/context";
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { render as renderLit } from "lit";
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../components/login-gate.ts";
import { i18n } from "../i18n/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createLegacyFocusEscape } from "./app-root-lit.ts";
import { mountOpenClawApp } from "./app-root.tsx";
import type { BootRecord } from "./boot-record.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { applicationContext } from "./context.ts";
import { loadSettings, persistSessionToken } from "./settings.ts";

// mock-isolation: root admission tests isolate shell rendering while exercising the real bootstrap owner.
vi.mock("./app-host.tsx", () => ({
  OpenClawShell: () => document.createElement("openclaw-app-shell"),
}));

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";
let runtime: ApplicationRuntime | undefined;
let dispose: (() => void) | undefined;
let host: HTMLElement | undefined;
let previousUrl: string;

beforeEach(async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  persistSessionToken(loadSettings().gatewayUrl, "test-token");
  previousUrl = window.location.href;
  window.history.replaceState({}, "", "/chat/main");
  await i18n.setLocale("en");
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  runtime?.stop();
  runtime = undefined;
  host?.remove();
  host = undefined;
  window.history.replaceState({}, "", previousUrl);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settleRootContent(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

async function createWarmSurface(warm = true, startup?: Promise<void>) {
  if (warm) {
    const scope = gatewayCredentialScope(loadSettings().gatewayUrl);
    const record: BootRecord = {
      version: 2,
      authMethod: "token",
      credential: "9d17676d",
      savedAt: Date.now(),
      scope,
      profileId: null,
      agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
      groups: [],
      sectionOrder: [],
    };
    localStorage.setItem(BOOT_RECORD_PREFIX + scope, JSON.stringify(record));
  }
  runtime = bootstrapApplication();
  const start = vi.spyOn(runtime, "start").mockReturnValue(startup ?? Promise.resolve());
  const rosterSubscriptions = vi.spyOn(runtime.context.sessions, "subscribe");
  const snapshot = runtime.context.gateway.snapshot;
  snapshot.phase = startup ? "stopped" : "connecting";
  snapshot.lastError = null;
  const listeners = new Set<(current: typeof snapshot) => void>();
  vi.spyOn(runtime.context.gateway, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  host = document.createElement("openclaw-app");
  document.body.append(host);
  dispose = mountOpenClawApp(host, runtime);
  const draw = async () => {
    for (const listener of listeners) {
      listener(snapshot);
    }
    await settleRootContent();
  };
  await settleRootContent();
  return { snapshot, container: host, draw, start, rosterSubscriptions };
}

type LoginGateElement = HTMLElement & {
  props: {
    onConnect: () => void;
    onOpenGatewaySettings?: () => void;
    onToggleGatewaySecret: () => void;
    showGatewaySecret: boolean;
  };
};

function loginGate(container: HTMLElement) {
  return expectDefined(
    container.querySelector<LoginGateElement>("openclaw-login-gate"),
    "login gate",
  );
}

describe("warm boot app root", () => {
  it("preserves browser escape focus when the document rerenders its label", () => {
    host = document.createElement("div");
    document.body.append(host);
    const close = vi.fn();
    const renderEscape = createLegacyFocusEscape(close);
    renderLit(renderEscape("Back"), host);
    const button = expectDefined(host.querySelector("button"), "escape button");
    button.focus();

    renderLit(renderEscape("Close"), host);
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe("Close");
    button.click();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the login gate out of the first render while application startup is pending", async () => {
    const starting = Promise.withResolvers<void>();
    const { container, start } = await createWarmSurface(false, starting.promise);
    expect(start).toHaveBeenCalledOnce();
    expect(container.querySelector("openclaw-login-gate")).toBeNull();
    expect(container.querySelector(".connect-splash")).not.toBeNull();
    starting.resolve();
    await starting.promise;
    await settleRootContent();
    expect(container.querySelector("openclaw-login-gate")).not.toBeNull();
  });

  it("keeps the credential-scoped warm shell after an unreachable connection retries", async () => {
    const { snapshot, container, draw } = await createWarmSurface();
    await vi.dynamicImportSettled();
    await settleRootContent();
    const shell = container.querySelector("openclaw-app-shell");
    expect(shell).not.toBeNull();
    expect(container.querySelector(".connect-splash")).toBeNull();
    expect(container.querySelector("openclaw-login-gate")).toBeNull();
    snapshot.lastError = "Connection interrupted; retrying";
    snapshot.lastErrorCode = null;
    await draw();
    expect(container.querySelector("openclaw-app-shell")).toBe(shell);
    expect(container.querySelector("openclaw-login-gate")).toBeNull();
    vi.spyOn(runtime!.context.gateway, "connectionRevision", "get").mockReturnValue(1);
    await draw();
    expect(container.querySelector("openclaw-app-shell")).toBeNull();
  });

  it("keeps saved-sign-in recovery reachable after auth fails without admitting other routes", async () => {
    const { snapshot, container, draw } = await createWarmSurface();
    await vi.dynamicImportSettled();
    await settleRootContent();
    expect(container.querySelector("openclaw-app-shell")).not.toBeNull();
    const gateway = runtime!.context.gateway;
    let stored = true;
    gateway.hasStoredDeviceToken = () => stored;
    snapshot.phase = "offline";
    snapshot.lastError = "Authentication rejected";
    snapshot.lastErrorCode = "AUTH_TOKEN_MISMATCH";
    await draw();
    const gate = loginGate(container);
    expect(container.querySelector("openclaw-app-shell")).toBeNull();
    const navigation = vi.spyOn(runtime!.router, "navigate");
    gate.props.onOpenGatewaySettings?.();
    await expectDefined(navigation.mock.results[0], "Gateway settings navigation").value;
    navigation.mockRestore();
    expect(runtime!.context.router.getState().matches[0]?.routeId).toBe("connection");
    await draw();
    expect(container.querySelector("openclaw-app-shell")).not.toBeNull();
    expect(container.querySelector("openclaw-login-gate")).toBeNull();
    stored = false;
    await draw();
    expect(container.querySelector("openclaw-login-gate")).not.toBeNull();
  });

  it.each([
    { name: "cold connection", warm: false, error: null, code: null, surface: ".connect-splash" },
    {
      name: "pairing rejection",
      warm: true,
      error: "Pairing required",
      code: "PAIRING_REQUIRED",
      surface: "openclaw-login-gate",
    },
  ])("keeps $name outside the warm shell", async ({ warm, error, code, surface }) => {
    const { snapshot, container, draw } = await createWarmSurface(warm);
    snapshot.lastError = error;
    snapshot.lastErrorCode = code;
    await draw();
    expect(container.querySelector("openclaw-app-shell")).toBeNull();
    expect(container.querySelector(surface)).not.toBeNull();
  });

  it("pins a manual login attempt and releases it only after connection admission", async () => {
    const { snapshot, container, draw } = await createWarmSurface();
    snapshot.phase = "offline";
    snapshot.lastError = "Connect to continue";
    await draw();
    const connect = vi.spyOn(runtime!.context.gateway, "connect").mockImplementation(() => {
      snapshot.phase = "connecting";
      snapshot.lastError = null;
      void draw();
    });
    loginGate(container).props.onConnect();
    await settleRootContent();
    expect(connect).toHaveBeenCalledOnce();
    expect(container.querySelector("openclaw-app-shell")).toBeNull();
    expect(container.querySelector("openclaw-login-gate")).not.toBeNull();
    snapshot.phase = "starting";
    await draw();
    expect(container.querySelector(".connect-splash")).not.toBeNull();
    snapshot.phase = "connected";
    await draw();
    await vi.dynamicImportSettled();
    await settleRootContent();
    expect(container.querySelector("openclaw-app-shell")).not.toBeNull();
  });

  it("hides revealed login credentials when the application epoch is replaced", async () => {
    const first = await createWarmSurface(false);
    first.snapshot.phase = "offline";
    first.snapshot.lastError = "Connect to continue";
    await first.draw();
    loginGate(first.container).props.onToggleGatewaySecret();
    await settleRootContent();
    expect(loginGate(first.container).props.showGatewaySecret).toBe(true);
    dispose?.();
    first.container.remove();
    const second = await createWarmSurface(false);
    second.snapshot.phase = "offline";
    second.snapshot.lastError = "Connect to continue";
    await second.draw();
    expect(loginGate(second.container).props.showGatewaySecret).toBe(false);
  });

  it("provides the same ApplicationContext to Lit descendants and retires it on disposal", async () => {
    const { container } = await createWarmSurface();
    await vi.dynamicImportSettled();
    await settleRootContent();
    const descendant = document.createElement("span");
    container.querySelector("openclaw-app-shell")!.append(descendant);
    const received = vi.fn();
    descendant.dispatchEvent(new ContextEvent(applicationContext, descendant, received, true));
    expect(received.mock.calls[0]?.[0]).toBe(runtime!.context);
    dispose?.();
    dispose = undefined;
    received.mockClear();
    container.append(descendant);
    descendant.dispatchEvent(new ContextEvent(applicationContext, descendant, received, true));
    expect(received).not.toHaveBeenCalled();
  });

  it("loads readiness only on its first read and catches up without remounting login", async () => {
    const { snapshot, container, draw, start, rosterSubscriptions } =
      await createWarmSurface(false);
    snapshot.phase = "offline";
    snapshot.lastError = "Connect to continue";
    await draw();
    const gate = loginGate(container);
    expect(rosterSubscriptions).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(window, "openclawControlUi")).toMatchObject({
      get: expect.any(Function),
    });
    expect(container.hasAttribute("data-openclaw-ready")).toBe(false);

    expect(window.openclawControlUi).toBeUndefined();
    await vi.dynamicImportSettled();
    await settleRootContent();
    const hook = window.openclawControlUi;
    expect(hook?.snapshot()).toMatchObject({ booted: true, ready: true, gatewayPhase: "offline" });
    expect(rosterSubscriptions).toHaveBeenCalledOnce();
    expect(window.openclawControlUi).toBe(hook);
    expect(loginGate(container)).toBe(gate);
    expect(start).toHaveBeenCalledOnce();
    expect(Object.getOwnPropertyDescriptor(window, "openclawControlUi")).toMatchObject({
      value: hook,
    });

    dispose?.();
    dispose = undefined;
    expect(Object.getOwnPropertyDescriptor(window, "openclawControlUi")).toBeUndefined();
  });

  it("releases the keyboard viewport when the mounted application is disposed", async () => {
    vi.stubGlobal(
      "visualViewport",
      Object.assign(new EventTarget(), { height: 300, offsetTop: 0, scale: 1 }),
    );
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    try {
      await createWarmSurface();
      const style = document.documentElement.style;
      expect(style.getPropertyValue("--shell-viewport-height")).toBe("300px");
      expect(style.getPropertyValue("--shell-safe-area-bottom")).toBe("0px");
      dispose?.();
      dispose = undefined;
      expect(style.getPropertyValue("--shell-viewport-height")).toBe("");
      expect(style.getPropertyValue("--shell-safe-area-bottom")).toBe("");
    } finally {
      input.remove();
    }
  });
});
