/* @vitest-environment jsdom */
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { LoginGateProps } from "../components/login-gate.ts";
import "../components/login-gate.ts";
import { i18n } from "../i18n/index.ts";
import { storeDeviceAuthToken } from "../lib/nodes/index.ts";
import { requestApplicationContext } from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createLegacyFocusEscape } from "./app-root-lit.ts";
import { mountOpenClawApp } from "./app-root.tsx";
import type { BootRecord } from "./boot-record.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
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
  disposeApp();
  runtime?.stop();
  runtime = undefined;
  host?.remove();
  host = undefined;
  window.history.replaceState({}, "", previousUrl);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function disposeApp() {
  dispose?.();
  dispose = undefined;
}

async function settleRootContent(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

async function settleImports() {
  await vi.dynamicImportSettled();
  await settleRootContent();
}

function expectSurface(present: string[], absent: string[] = []) {
  expect(present.map((selector) => host!.querySelector(selector))).not.toContain(null);
  expect(absent.map((selector) => host!.querySelector(selector))).toEqual(absent.map(() => null));
}

async function createWarmSurface(warm = true, startup?: Promise<void>, authMethod = "token") {
  if (warm) {
    const scope = gatewayCredentialScope(loadSettings().gatewayUrl);
    const record: BootRecord = {
      version: 2,
      authMethod,
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
  const publish = () => {
    for (const listener of listeners) {
      listener(snapshot);
    }
  };
  const draw = async (patch: Partial<typeof snapshot> = {}) => {
    Object.assign(snapshot, patch);
    publish();
    await settleRootContent();
  };
  await settleRootContent();
  return { snapshot, container: host, publish, draw, start, rosterSubscriptions };
}

type LoginGateElement = HTMLElement & { props: LoginGateProps };

function loginGate(container: HTMLElement) {
  return expectDefined(
    container.querySelector<LoginGateElement>("openclaw-login-gate"),
    "login gate",
  );
}

async function createOfflineSurface(warm = false) {
  const surface = await createWarmSurface(warm);
  await surface.draw({ phase: "offline", lastError: "Connect to continue" });
  return surface;
}

describe("warm boot app root", () => {
  it("pins embedded ingress to its serving Gateway and never offers a shared-credential login", async () => {
    document.documentElement.dataset.openclawRemoteIngress = "true";
    vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", {
      gatewayUrl: "wss://dev-gateway.example",
      proxyPath: "/dev-gateway",
    });
    window.history.replaceState(
      {},
      "",
      "/chat/main#gatewayUrl=wss%3A%2F%2Fother.example&token=synthetic-token&bootstrapToken=synthetic-bootstrap&nativeControlAuth=wss%3A%2F%2Fother.example",
    );
    window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
      gatewayUrl: "wss://other.example",
      token: "synthetic-native-token",
    };
    try {
      localStorage.setItem(
        "openclaw-device-identity-v1",
        JSON.stringify({
          version: 1,
          deviceId: "previous-visitor",
          publicKey: "AA",
          privateKey: "AA",
          createdAtMs: 1,
        }),
      );
      storeDeviceAuthToken({
        deviceId: "previous-visitor",
        role: "operator",
        gatewayUrl: `ws://${window.location.host}`,
        token: "test-token",
        scopes: ["operator.admin", "operator.read"],
      });
      const { container, draw } = await createWarmSurface(true, undefined, "device-token");
      expect(runtime!.warmBoot).toBe(false);
      expect(runtime!.context.gateway.hasStoredDeviceToken?.()).toBe(false);
      expect(runtime!.context.gateway.forgetDeviceToken?.()).toBe(false);
      expect(runtime!.context.gateway.connection).toMatchObject({
        gatewayUrl: `ws://${window.location.host}`,
        token: "",
        bootstrapToken: "",
      });
      expect(runtime!.pendingGatewayConnection).toBeNull();
      await draw();
      expect(container.querySelector("openclaw-login-gate")).toBeNull();
      await draw({
        phase: "offline",
        lastError: "Ingress unavailable",
        lastErrorCode: "AUTH_DEVICE_TOKEN_MISMATCH",
      });
      expect(container.querySelector("openclaw-login-gate")).toBeNull();
      await settleImports();
      expect(container.querySelector("openclaw-app-shell")).not.toBeNull();
    } finally {
      delete document.documentElement.dataset.openclawRemoteIngress;
      delete window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
    }
  });

  it("preserves browser escape focus when the document rerenders its label", () => {
    host = document.createElement("div");
    document.body.append(host);
    const close = vi.fn();
    const renderEscape = createLegacyFocusEscape(close);
    const [label, setLabel] = createSignal("Back");
    dispose = mountSolid(() => <>{renderEscape(label())}</>, { container: host }).unmount;
    flush();
    const button = expectDefined(host.querySelector("button"), "escape button");
    button.focus();

    setLabel("Close");
    flush();
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe("Close");
    button.click();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the login gate out of the first render while application startup is pending", async () => {
    const starting = Promise.withResolvers<void>();
    const { container, start } = await createWarmSurface(false, starting.promise);
    expect(start).toHaveBeenCalledOnce();
    expectSurface([".connect-splash"], ["openclaw-login-gate"]);
    starting.resolve();
    await starting.promise;
    await settleRootContent();
    expect(container.querySelector("openclaw-login-gate")).not.toBeNull();
  });

  it("keeps the credential-scoped warm shell after an unreachable connection retries", async () => {
    const { container, draw } = await createWarmSurface();
    await settleImports();
    const shell = container.querySelector("openclaw-app-shell");
    expect(shell).not.toBeNull();
    expectSurface([], [".connect-splash", "openclaw-login-gate"]);
    await draw({ lastError: "Connection interrupted; retrying", lastErrorCode: null });
    expect(container.querySelector("openclaw-app-shell")).toBe(shell);
    expect(container.querySelector("openclaw-login-gate")).toBeNull();
    vi.spyOn(runtime!.context.gateway, "connectionRevision", "get").mockReturnValue(1);
    await draw();
    expect(container.querySelector("openclaw-app-shell")).toBeNull();
  });

  it("keeps saved-sign-in recovery reachable after auth fails without admitting other routes", async () => {
    const { container, draw } = await createWarmSurface();
    await settleImports();
    expect(container.querySelector("openclaw-app-shell")).not.toBeNull();
    const gateway = runtime!.context.gateway;
    let stored = true;
    gateway.hasStoredDeviceToken = () => stored;
    await draw({
      phase: "offline",
      lastError: "Authentication rejected",
      lastErrorCode: "AUTH_TOKEN_MISMATCH",
    });
    const gate = loginGate(container);
    expect(container.querySelector("openclaw-app-shell")).toBeNull();
    const navigation = vi.spyOn(runtime!.router, "navigate");
    gate.props.onOpenGatewaySettings?.();
    await expectDefined(navigation.mock.results[0], "Gateway settings navigation").value;
    navigation.mockRestore();
    expect(runtime!.context.router.getState().matches[0]?.routeId).toBe("connection");
    await draw();
    expectSurface(["openclaw-app-shell"], ["openclaw-login-gate"]);
    stored = false;
    await draw();
    expect(container.querySelector("openclaw-login-gate")).not.toBeNull();
  });

  it.each([
    ["cold connection", false, null, null, ".connect-splash"],
    ["pairing rejection", true, "Pairing required", "PAIRING_REQUIRED", "openclaw-login-gate"],
  ] as const)("keeps %s outside the warm shell", async (_name, warm, error, code, surface) => {
    const { draw } = await createWarmSurface(warm);
    await draw({ lastError: error, lastErrorCode: code });
    expectSurface([surface], ["openclaw-app-shell"]);
  });

  it("pins a manual login attempt and releases it only after connection admission", async () => {
    const { snapshot, container, publish, draw } = await createOfflineSurface(true);
    const connect = vi.spyOn(runtime!.context.gateway, "connect").mockImplementation(() => {
      void draw({ phase: "connecting", lastError: null });
    });
    loginGate(container).props.onConnect();
    await settleRootContent();
    expect(connect).toHaveBeenCalledOnce();
    expectSurface(["openclaw-login-gate"], ["openclaw-app-shell"]);
    await draw({ phase: "starting" });
    expect(container.querySelector(".connect-splash")).not.toBeNull();
    snapshot.phase = "connected";
    publish();
    const nested = document.createElement("div");
    container.append(nested);
    let disposeNested: (() => void) | undefined;
    try {
      // A descendant can mount another Solid root while Gateway admission is queued.
      disposeNested = mountSolid(() => <span />, { container: nested }).unmount;
      await settleRootContent();
    } finally {
      disposeNested?.();
      nested.remove();
    }
    await settleImports();
    expect(container.querySelector("openclaw-app-shell")).not.toBeNull();
  });

  it("hides revealed login credentials when the application epoch is replaced", async () => {
    const first = await createOfflineSurface();
    loginGate(first.container).props.onToggleGatewaySecret();
    await settleRootContent();
    expect(loginGate(first.container).props.showGatewaySecret).toBe(true);
    disposeApp();
    first.container.remove();
    const second = await createOfflineSurface();
    expect(loginGate(second.container).props.showGatewaySecret).toBe(false);
  });

  it("keeps credential drafts until the Gateway client changes", async () => {
    const { snapshot, container, draw } = await createOfflineSurface();
    const gate = loginGate(container);
    gate.props.onGatewayUrlChange("wss://draft.example");
    gate.props.onSecretChange("draft-secret");
    gate.props.onToggleGatewaySecret();
    await draw();
    expect(gate.props).toMatchObject({
      gatewayUrl: "wss://draft.example",
      secret: "draft-secret",
      showGatewaySecret: true,
    });
    const connection = runtime!.context.gateway.connection;
    connection.gatewayUrl = "wss://replacement.example";
    connection.token = "replacement-token";
    connection.password = "";
    // SAFETY: The offline root observes client identity; it never calls this transport.
    snapshot.client = {} as GatewayBrowserClient;
    await draw();
    expect(gate.props).toMatchObject({
      gatewayUrl: "wss://replacement.example",
      secret: "replacement-token",
      showGatewaySecret: false,
    });
  });

  it("provides the same ApplicationContext to native descendants and retires it on disposal", async () => {
    const { container } = await createWarmSurface();
    await settleImports();
    const descendant = document.createElement("span");
    container.querySelector("openclaw-app-shell")!.append(descendant);
    const received = vi.fn();
    requestApplicationContext(descendant, received, true);
    expect(received.mock.calls[0]?.[0]).toBe(runtime!.context);
    disposeApp();
    received.mockClear();
    container.append(descendant);
    requestApplicationContext(descendant, received, true);
    expect(received).not.toHaveBeenCalled();
  });

  it("loads readiness only on its first read and catches up without remounting login", async () => {
    const { container, start, rosterSubscriptions } = await createOfflineSurface();
    const gate = loginGate(container);
    expect(rosterSubscriptions).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(window, "openclawControlUi")).toMatchObject({
      get: expect.any(Function),
    });
    expect(container.hasAttribute("data-openclaw-ready")).toBe(false);

    expect(window.openclawControlUi).toBeUndefined();
    await settleImports();
    const hook = window.openclawControlUi;
    expect(hook?.snapshot()).toMatchObject({ booted: true, ready: true, gatewayPhase: "offline" });
    expect(rosterSubscriptions).toHaveBeenCalledOnce();
    expect(window.openclawControlUi).toBe(hook);
    expect(loginGate(container)).toBe(gate);
    expect(start).toHaveBeenCalledOnce();
    expect(Object.getOwnPropertyDescriptor(window, "openclawControlUi")).toMatchObject({
      value: hook,
    });

    disposeApp();
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
      disposeApp();
      expect(style.getPropertyValue("--shell-viewport-height")).toBe("");
      expect(style.getPropertyValue("--shell-safe-area-bottom")).toBe("");
    } finally {
      input.remove();
    }
  });
});
