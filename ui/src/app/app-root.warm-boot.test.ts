/* @vitest-environment jsdom */
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../components/login-gate.ts";
import { i18n } from "../i18n/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./app-host.ts";
import type { OpenClawApp } from "./app-root.ts";
import type { BootRecord } from "./boot-record.ts";
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

function createWarmSurface(warm = true, pathname = "/chat/main") {
  window.history.replaceState({}, "", pathname);
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

  it("keeps cold first connections on the existing splash", () => {
    const { container, draw } = createWarmSurface(false);
    draw();

    expect(container.querySelector(".connect-splash")).not.toBeNull();
    expect(container.querySelector("openclaw-app-shell")).toBeNull();
  });

  it("keeps a browser handoff behind gateway authentication and replaces the shell after connect", () => {
    const { snapshot, container, draw } = createWarmSurface(true, "/focus/browser/handoff-1");
    draw();
    expect(container.querySelector("openclaw-human-intervention-panel")).toBeNull();

    Object.assign(snapshot, {
      phase: "connected",
      client: { request: vi.fn(), gatewayUrl: "ws://gateway.test" },
      hello: {
        auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
        features: {
          methods: [
            "browser.handoff.get",
            "browser.handoff.claim",
            "browser.handoff.browser",
            "browser.handoff.complete",
          ],
        },
      },
    });
    draw();

    const panel = container.querySelector("openclaw-human-intervention-panel");
    expect(panel).not.toBeNull();
    expect((panel as unknown as { handoffId: string }).handoffId).toBe("handoff-1");
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
