import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import * as gatewayCall from "../gateway/call.js";
import * as uiLinks from "../gateway/control-ui-links.js";
import * as browserHandoff from "../infra/browser-handoff.js";
import * as browserOpen from "../infra/browser-open.js";
import * as handoff from "./control-ui-handoff.js";
import { runBrowserHatchHandoff } from "./onboard-browser-handoff.js";

function createMocks() {
  return {
    callGateway: vi.spyOn(gatewayCall, "callGateway"),
    waitForControlUiDocument: vi.spyOn(handoff, "waitForControlUiDocument"),
    issueControlUiBrowserHandoff: vi.spyOn(handoff, "issueControlUiBrowserHandoff"),
    hasVerifiedControlUiLoopbackAlias: vi.spyOn(handoff, "hasVerifiedControlUiLoopbackAlias"),
    detectBrowserOpenSupport: vi.spyOn(browserOpen, "detectBrowserOpenSupport"),
    openUrlPrivately: vi.spyOn(browserHandoff, "openUrlPrivately"),
    resolveAdvertisedControlUiLinks: vi.spyOn(uiLinks, "resolveAdvertisedControlUiLinks"),
  };
}
let sharedMocks: ReturnType<typeof createMocks>;

const connectedControlUiPresence = {
  host: GATEWAY_CLIENT_IDS.CONTROL_UI,
  mode: GATEWAY_CLIENT_MODES.WEBCHAT,
  reason: "connect",
  deviceId: "same-device",
  instanceId: "existing-tab",
  ts: 1,
};
const links = { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" };
const browserUrl = `${links.httpUrl}#bootstrapToken=one-time-bootstrap&gatewayUrl=${encodeURIComponent(links.wsUrl)}`;
let prompter: ReturnType<typeof createWizardPrompter>;

beforeEach(async () => {
  sharedMocks = createMocks();
  prompter = createWizardPrompter();
  await Promise.all([import("../agents/utility-model.js"), import("./onboard-agent-target.js")]);
  vi.useFakeTimers({ now: 0, toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  for (const name of [
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "OPENCLAW_GATEWAY_PORT",
    "SSH_CLIENT",
    "SSH_TTY",
    "SSH_CONNECTION",
    "REMOTE_CONTAINERS",
    "CODESPACES",
  ]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("OPENCLAW_LOCALE", "en");
  sharedMocks.callGateway.mockResolvedValueOnce([]).mockResolvedValue([connectedControlUiPresence]);
  sharedMocks.waitForControlUiDocument.mockResolvedValue({ ready: true });
  sharedMocks.hasVerifiedControlUiLoopbackAlias.mockResolvedValue(true);
  sharedMocks.issueControlUiBrowserHandoff.mockImplementation(async (target: typeof links) => ({
    browserUrl: `${target.httpUrl}#bootstrapToken=one-time-bootstrap&gatewayUrl=${encodeURIComponent(target.wsUrl)}`,
    expiresAtMs: 123_456,
  }));
  sharedMocks.detectBrowserOpenSupport.mockResolvedValue({ ok: false });
  sharedMocks.openUrlPrivately.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function displayedNotes() {
  return vi
    .mocked(prompter.note)
    .mock.calls.map(([message]) => message)
    .join("\n");
}

async function runHandoff(
  params: Partial<Parameters<typeof runBrowserHatchHandoff>[0]> = {},
  advanceMs = 0,
) {
  const result = runBrowserHatchHandoff({
    config: {},
    prompter,
    ...params,
  });
  await vi.advanceTimersByTimeAsync(advanceMs);
  return await result;
}

it("opens utility-only setup on the custodian route", async () => {
  sharedMocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
  const result = await runHandoff({
    config: {
      meta: { migrations: { utilityModelSeparation: true } },
      agents: { defaults: { utilityModel: "fixture/small" } },
    },
  });
  expect(result).toBe(true);
  const url = new URL(sharedMocks.openUrlPrivately.mock.calls[0]![0]);
  expect(url).toMatchObject({ pathname: "/custodian", search: "?onboarding=1" });
  expect(url.hash).toContain("bootstrapToken=one-time-bootstrap");
});

it.each(["heartbeat", "disconnect", "new-tab"] as const)(
  "uses connection identity rather than presence freshness: %s",
  async (change) => {
    sharedMocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
    sharedMocks.callGateway
      .mockReset()
      .mockResolvedValueOnce([connectedControlUiPresence])
      .mockImplementation(async () => [
        {
          ...connectedControlUiPresence,
          ts: Date.now(),
          ...(change === "disconnect" ? { reason: "disconnect" } : {}),
          ...(change === "new-tab" ? { instanceId: "new-tab" } : {}),
        },
      ]);
    expect(await runHandoff({}, change === "new-tab" ? 0 : 60_000)).toBe(change === "new-tab");
    expect(Date.now()).toBe(change === "new-tab" ? 0 : 60_000);
    if (change !== "new-tab") {
      expect(prompter.note).not.toHaveBeenCalledWith(
        "Dashboard connected — continuing in your browser.",
        expect.anything(),
      );
    }
  },
);

it("prints the coordinator's HTTPS tunnel destination for a headless loopback TLS Gateway", async () => {
  expect(
    await runHandoff({
      agentId: "coordinator",
      config: {
        gateway: {
          bind: "loopback",
          controlUi: { basePath: "/control" },
          tls: { enabled: true },
        },
      },
    }),
  ).toBe(true);
  const displayed = displayedNotes();
  expect(displayed).toContain("?session=agent%3Acoordinator%3Amain#");
  expect(displayed).toContain("https://localhost:18789/control/");
  expect(displayed).not.toContain("http://localhost:18789/control/");
  expect(displayed).toContain("#bootstrapToken=one-time-bootstrap");
});

it("falls back to the SSH hint and manual timeout when the browser opener rejects", async () => {
  sharedMocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
  sharedMocks.openUrlPrivately.mockRejectedValue(new Error("browser command failed"));
  sharedMocks.callGateway.mockReset().mockResolvedValue([]);
  vi.stubEnv("SSH_CONNECTION", "192.0.2.1 12345 192.0.2.2 22");
  expect(await runHandoff({}, 300_000)).toBe(false);
  expect(Date.now()).toBe(300_000);
  expect(sharedMocks.openUrlPrivately).toHaveBeenCalledWith(browserUrl);
  expect(displayedNotes()).toContain("ssh -N -L 18789:127.0.0.1:18789");
  expect(displayedNotes()).toContain("#bootstrapToken=one-time-bootstrap");
});

it.each([false, true])("uses secure headless custom-bind links (TLS=%s)", async (tls) => {
  const host = "10.211.55.4";
  await runHandoff({
    config: {
      gateway: {
        bind: "custom",
        customBindHost: host,
        controlUi: { basePath: "/dashboard" },
        ...(tls ? { tls: { enabled: true } } : {}),
        auth: { token: "test-token" },
      },
    },
  });
  const displayed = displayedNotes();
  for (const secret of ["test-token", "#token=", "openclaw devices approve <requestId>"]) {
    expect(displayed).not.toContain(secret);
  }
  expect(displayed).toContain("#bootstrapToken=one-time-bootstrap");
  if (tls) {
    expect(displayed).toContain(
      `https://${host}:18789/dashboard/#bootstrapToken=one-time-bootstrap`,
    );
    expect(displayed).toContain(
      `gatewayUrl=${encodeURIComponent(`wss://${host}:18789/dashboard`)}`,
    );
    expect(displayed).not.toContain("ssh -N -L");
  } else {
    for (const hint of [
      "http://127.0.0.1:18789/dashboard/",
      "ssh -N -L 18789:127.0.0.1:18789",
      "http://localhost:18789/dashboard/",
    ]) {
      expect(displayed).toContain(hint);
    }
    expect(displayed).not.toContain(`http://${host}:18789`);
    expect(sharedMocks.resolveAdvertisedControlUiLinks).not.toHaveBeenCalled();
    expect(sharedMocks.issueControlUiBrowserHandoff).toHaveBeenCalledWith({
      httpUrl: "http://127.0.0.1:18789/dashboard/",
      wsUrl: "ws://127.0.0.1:18789/dashboard",
    });
  }
});

it("keeps resolved password SecretRefs inside the Gateway presence request", async () => {
  const gatewayPassword = ["private", "password"].join("-");
  vi.stubEnv("DASHBOARD_TEST_PASSWORD", gatewayPassword);
  await runHandoff({
    config: {
      secrets: { providers: { default: { source: "env" } }, defaults: { env: "default" } },
      gateway: {
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "DASHBOARD_TEST_PASSWORD" },
        },
      },
    },
  });
  expect(sharedMocks.callGateway.mock.calls.map(([options]) => options.password)).toEqual([
    gatewayPassword,
    gatewayPassword,
  ]);
  expect(displayedNotes()).not.toContain(gatewayPassword);
  expect(displayedNotes()).toContain("#bootstrapToken=one-time-bootstrap");
  expect(sharedMocks.issueControlUiBrowserHandoff).toHaveBeenCalledWith(links);
});

it.each(["suppressed", "disabled", "document", "presence", "bootstrap"] as const)(
  "does not open browser credentials after a %s gate failure",
  async (reason) => {
    if (reason === "document") {
      sharedMocks.waitForControlUiDocument.mockImplementation(async ({ onPending }) => {
        onPending?.();
        return { ready: false, reason: "Control UI build failed." };
      });
    } else if (reason === "presence") {
      sharedMocks.callGateway.mockReset().mockRejectedValue(new Error("gateway unavailable"));
    } else if (reason === "bootstrap") {
      sharedMocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
      sharedMocks.issueControlUiBrowserHandoff.mockRejectedValue(new Error("state unavailable"));
    }
    const result = await runHandoff({
      config: reason === "disabled" ? { gateway: { controlUi: { enabled: false } } } : {},
      suppressTokenOutput: reason === "suppressed",
    });
    expect(result).toBe(false);
    expect(sharedMocks.openUrlPrivately).not.toHaveBeenCalled();
    if (reason === "suppressed" || reason === "disabled") {
      expect(sharedMocks.detectBrowserOpenSupport).not.toHaveBeenCalled();
      expect(sharedMocks.waitForControlUiDocument).not.toHaveBeenCalled();
    }
    if (reason === "document") {
      expect(sharedMocks.callGateway).not.toHaveBeenCalled();
      expect(prompter.progress).toHaveBeenCalledWith("Preparing the Control UI…");
      expect(vi.mocked(prompter.progress).mock.results[0]?.value.stop).toHaveBeenCalledOnce();
    }
    if (reason === "bootstrap") {
      expect(prompter.note).not.toHaveBeenCalled();
    } else {
      expect(sharedMocks.issueControlUiBrowserHandoff).not.toHaveBeenCalled();
    }
  },
);
