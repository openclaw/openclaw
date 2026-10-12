/* @vitest-environment jsdom */
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../components/login-gate.ts";
import { i18n } from "../i18n/index.ts";
import { storeDeviceAuthToken } from "../lib/nodes/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./app-host.ts";
import type { OpenClawApp } from "./app-root.ts";
import type { BootRecord } from "./boot-record.ts";
import * as applicationBootstrap from "./bootstrap.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { loadSettings, persistSessionToken } from "./settings.ts";

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";

let runtime: ApplicationRuntime | undefined;
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
  runtime?.stop();
  runtime = undefined;
  window.history.replaceState({}, "", previousUrl);
  vi.unstubAllGlobals();
});

function createWarmSurface(warm = true, authMethod = "token") {
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
  const app = document.createElement("openclaw-app") as OpenClawApp;
  Object.assign(app, { runtime });
  const snapshot = runtime.context.gateway.snapshot;
  snapshot.phase = "connecting";
  snapshot.lastError = null;
  const container = document.createElement("div");
  const draw = () => render(app.render(), container);
  return { app, snapshot, container, draw };
}

describe("warm boot app root", () => {
  it("pins embedded ingress to its serving Gateway and never offers a shared-credential login", () => {
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
      const { snapshot, container, draw } = createWarmSurface(true, "device-token");
      expect(runtime!.warmBoot).toBe(false);
      expect(runtime!.context.gateway.hasStoredDeviceToken?.()).toBe(false);
      expect(runtime!.context.gateway.forgetDeviceToken?.()).toBe(false);
      expect(runtime!.context.gateway.connection.gatewayUrl).toBe(`ws://${window.location.host}`);
      expect(runtime!.context.gateway.connection.token).toBe("");
      expect(runtime!.context.gateway.connection.bootstrapToken).toBe("");
      expect(runtime!.pendingGatewayConnection).toBeNull();
      draw();
      expect(container.querySelector("openclaw-login-gate")).toBeNull();
      snapshot.phase = "offline";
      snapshot.lastError = "Ingress unavailable";
      snapshot.lastErrorCode = "AUTH_DEVICE_TOKEN_MISMATCH";
      draw();
      expect(container.querySelector("openclaw-login-gate")).toBeNull();
      expect(container.querySelector("openclaw-app-shell")).not.toBeNull();
    } finally {
      delete document.documentElement.dataset.openclawRemoteIngress;
      delete window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
    }
  });

  it("keeps the login gate out of the first render while application startup is pending", async () => {
    runtime = bootstrapApplication();
    const starting = Promise.withResolvers<void>();
    const start = vi.spyOn(runtime, "start").mockReturnValue(starting.promise);
    const bootstrap = vi
      .spyOn(applicationBootstrap, "bootstrapApplication")
      .mockReturnValue(runtime);
    const app = document.createElement("openclaw-app") as OpenClawApp;
    try {
      document.body.append(app);
      await app.updateComplete;
      expect(start).toHaveBeenCalledOnce();
      expect(app.querySelector("openclaw-login-gate")).toBeNull();
      expect(app.querySelector(".connect-splash")).not.toBeNull();

      starting.resolve();
      await starting.promise;
      await app.updateComplete;
      expect(app.querySelector("openclaw-login-gate")).not.toBeNull();
    } finally {
      app.remove();
      starting.resolve();
      bootstrap.mockRestore();
      start.mockRestore();
    }
  });

  it("keeps the credential-scoped warm shell after an unreachable connection retries", () => {
    const { snapshot, container, draw } = createWarmSurface();
    draw();
    expect(container.querySelector("openclaw-app-shell")).not.toBeNull();
    expect(container.querySelector(".connect-splash")).toBeNull();
    expect(container.querySelector("openclaw-login-gate")).toBeNull();
    snapshot.lastError = "Connection interrupted; retrying";
    snapshot.lastErrorCode = null;
    draw();
    expect(container.querySelector("openclaw-app-shell")).not.toBeNull();
    expect(container.querySelector("openclaw-login-gate")).toBeNull();
    vi.spyOn(runtime!.context.gateway, "connectionRevision", "get").mockReturnValue(1);
    draw();
    expect(container.querySelector("openclaw-app-shell")).toBeNull();
  });

  it("keeps saved-sign-in recovery reachable after auth fails without admitting other routes", async () => {
    const { snapshot, container, draw } = createWarmSurface();
    draw();
    expect(container.querySelector("openclaw-app-shell")).not.toBeNull();
    const gateway = runtime!.context.gateway;
    let stored = true;
    gateway.hasStoredDeviceToken = () => stored;
    snapshot.phase = "offline";
    snapshot.lastError = "Authentication rejected";
    snapshot.lastErrorCode = "AUTH_TOKEN_MISMATCH";
    draw();
    const gate = container.querySelector("openclaw-login-gate") as unknown as {
      props: { onOpenGatewaySettings: () => void };
    };
    expect(gate).not.toBeNull();
    expect(container.querySelector("openclaw-app-shell")).toBeNull();
    const navigation = vi.spyOn(runtime!.router, "navigate");
    gate.props.onOpenGatewaySettings();
    await expectDefined(navigation.mock.results[0], "Gateway settings navigation").value;
    navigation.mockRestore();
    expect(runtime!.context.router.getState().matches[0]?.routeId).toBe("connection");
    draw();
    expect(container.querySelector("openclaw-app-shell")).not.toBeNull();
    expect(container.querySelector("openclaw-login-gate")).toBeNull();
    stored = false;
    draw();
    expect(container.querySelector("openclaw-login-gate")).not.toBeNull();
  });

  const admissionCases: Array<{
    name: string;
    warm?: boolean;
    pinned?: boolean;
    phase?: "connecting" | "starting";
    error?: string;
    code?: string;
    surface: string;
  }> = [
    { name: "cold connection", warm: false, surface: ".connect-splash" },
    {
      name: "pairing rejection",
      error: "Pairing required",
      code: "PAIRING_REQUIRED",
      surface: "openclaw-login-gate",
    },
    { name: "manual login", pinned: true, surface: "openclaw-login-gate" },
    { name: "manual startup", pinned: true, phase: "starting", surface: ".connect-splash" },
  ];
  it.each(admissionCases)(
    "keeps $name outside the warm shell",
    ({ warm = true, pinned = false, phase = "connecting", error = null, code = null, surface }) => {
      const { app, snapshot, container, draw } = createWarmSurface(warm);
      Object.assign(app, { loginGatePinned: pinned });
      snapshot.phase = phase;
      snapshot.lastError = error;
      snapshot.lastErrorCode = code;
      draw();
      expect(container.querySelector("openclaw-app-shell")).toBeNull();
      expect(container.querySelector(surface)).not.toBeNull();
    },
  );
});
