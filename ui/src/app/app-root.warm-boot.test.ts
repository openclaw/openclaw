/* @vitest-environment jsdom */
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../components/login-gate.ts";
import { i18n } from "../i18n/index.ts";
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

function createWarmSurface(warm = true) {
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

  it("renders the shell during the first connection when a boot record is present", () => {
    const { container, draw } = createWarmSurface();
    draw();

    expect(container.querySelector("openclaw-app-shell")).not.toBeNull();
    expect(container.querySelector(".connect-splash")).toBeNull();
    expect(container.querySelector("openclaw-login-gate")).toBeNull();
  });

  it("returns to the login gate after a warm connection fails", () => {
    const { snapshot, container, draw } = createWarmSurface();
    draw();
    expect(container.querySelector("openclaw-app-shell")).not.toBeNull();

    snapshot.phase = "offline";
    snapshot.lastError = "Authentication rejected";
    snapshot.lastErrorCode = "AUTH_TOKEN_MISMATCH";
    draw();

    expect(container.querySelector("openclaw-login-gate")).not.toBeNull();
    expect(container.querySelector("openclaw-app-shell")).toBeNull();
  });

  it("keeps saved-sign-in recovery reachable after auth fails without admitting other routes", async () => {
    const { snapshot, container, draw } = createWarmSurface();
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

  it("keeps cold first connections on the existing splash", () => {
    const { container, draw } = createWarmSurface(false);
    draw();

    expect(container.querySelector(".connect-splash")).not.toBeNull();
    expect(container.querySelector("openclaw-app-shell")).toBeNull();
  });

  it.each(["connecting", "starting"] as const)(
    "does not replace a manual login submission with warm shell during %s",
    (phase) => {
      const { app, snapshot, container, draw } = createWarmSurface();
      Object.assign(app, { loginGatePinned: true });
      snapshot.phase = phase;
      draw();

      expect(container.querySelector("openclaw-app-shell")).toBeNull();
      expect(
        container.querySelector(phase === "starting" ? ".connect-splash" : "openclaw-login-gate"),
      ).not.toBeNull();
    },
  );
});
