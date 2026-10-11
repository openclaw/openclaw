import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { runBrowserHatchHandoff } from "./onboard-browser-handoff.js";

const sharedMocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  waitForControlUiDocument: vi.fn(),
  issueControlUiBrowserHandoff: vi.fn(),
  hasVerifiedControlUiLoopbackAlias: vi.fn(),
  detectBrowserOpenSupport: vi.fn(),
  openUrl: vi.fn(),
  resolveAdvertisedLanHostCore: vi.fn(),
  resolveAdvertisedControlUiLinks: vi.fn(),
}));

vi.mock("../infra/advertised-lan-host.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/advertised-lan-host.js")>()),
  resolveAdvertisedLanHostCore: sharedMocks.resolveAdvertisedLanHostCore,
}));
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: sharedMocks.callGateway,
}));
vi.mock("./control-ui-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-handoff.js")>()),
  waitForControlUiDocument: sharedMocks.waitForControlUiDocument,
  issueControlUiBrowserHandoff: sharedMocks.issueControlUiBrowserHandoff,
  hasVerifiedControlUiLoopbackAlias: sharedMocks.hasVerifiedControlUiLoopbackAlias,
}));
vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  detectBrowserOpenSupport: sharedMocks.detectBrowserOpenSupport,
  openUrl: sharedMocks.openUrl,
  resolveAdvertisedControlUiLinks: sharedMocks.resolveAdvertisedControlUiLinks,
}));

const connectedControlUiPresence = {
  host: GATEWAY_CLIENT_IDS.CONTROL_UI,
  mode: GATEWAY_CLIENT_MODES.WEBCHAT,
  reason: "connect",
  deviceId: "same-device",
  instanceId: "existing-tab",
  text: "Control UI",
  ts: 1,
};
const links = { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" };
const browserUrl = `${links.httpUrl}#bootstrapToken=one-time-bootstrap&gatewayUrl=${encodeURIComponent(links.wsUrl)}`;

beforeEach(async () => {
  await Promise.all([import("../agents/utility-model.js"), import("./onboard-agent-target.js")]);
  vi.useFakeTimers();
  vi.setSystemTime(0);
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
  sharedMocks.callGateway
    .mockReset()
    .mockResolvedValueOnce([])
    .mockResolvedValue([connectedControlUiPresence]);
  sharedMocks.waitForControlUiDocument.mockReset().mockResolvedValue({ ready: true });
  sharedMocks.hasVerifiedControlUiLoopbackAlias.mockReset().mockResolvedValue(true);
  sharedMocks.issueControlUiBrowserHandoff
    .mockReset()
    .mockImplementation(async (target: typeof links) => ({
      browserUrl: `${target.httpUrl}#bootstrapToken=one-time-bootstrap&gatewayUrl=${encodeURIComponent(target.wsUrl)}`,
      expiresAtMs: 123_456,
    }));
  sharedMocks.detectBrowserOpenSupport.mockReset().mockResolvedValue({ ok: false });
  sharedMocks.openUrl.mockReset().mockResolvedValue(true);
  sharedMocks.resolveAdvertisedLanHostCore.mockReset().mockResolvedValue(null);
  sharedMocks.resolveAdvertisedControlUiLinks.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function displayedNotes(prompter: ReturnType<typeof createWizardPrompter>) {
  return vi
    .mocked(prompter.note)
    .mock.calls.map(([message]) => message)
    .join("\n");
}

async function runHandoff(params: Parameters<typeof runBrowserHatchHandoff>[0]) {
  const result = runBrowserHatchHandoff(params);
  await vi.runAllTimersAsync();
  return await result;
}

describe("runBrowserHatchHandoff", () => {
  it.each([true, false])(
    "opens utility-only setup on the custodian route (browser=%s)",
    async (opened) => {
      const prompter = createWizardPrompter();
      sharedMocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
      sharedMocks.openUrl.mockResolvedValue(opened);
      const result = await runHandoff({
        config: {
          meta: { migrations: { utilityModelSeparation: true } },
          agents: { defaults: { utilityModel: "fixture/small" } },
        },
        prompter,
      });
      expect(result).toEqual({ handedOff: true });
      const url = new URL(sharedMocks.openUrl.mock.calls[0]![0]);
      expect(url.pathname).toBe("/custodian");
      expect(url.searchParams.get("onboarding")).toBe("1");
      expect(url.searchParams.has("session")).toBe(false);
      expect(url.hash).toContain("bootstrapToken=one-time-bootstrap");
      if (!opened) {
        expect(displayedNotes(prompter)).toContain("/custodian?onboarding=1");
      }
    },
  );

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
      const prompter = createWizardPrompter();
      const result = await runHandoff({ config: {}, prompter });
      expect(result).toEqual(
        change === "new-tab" ? { handedOff: true } : { handedOff: false, reason: "timeout" },
      );
      expect(Date.now()).toBe(change === "new-tab" ? 0 : 60_000);
      if (change !== "new-tab") {
        expect(prompter.note).not.toHaveBeenCalledWith(
          "Dashboard connected — continuing in your browser.",
          expect.anything(),
        );
      }
    },
  );

  it("opens once when the browser is available", async () => {
    sharedMocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
    const prompter = createWizardPrompter();
    expect(await runHandoff({ config: {}, prompter })).toEqual({ handedOff: true });
    expect(sharedMocks.openUrl).toHaveBeenCalledOnce();
    expect(sharedMocks.openUrl).toHaveBeenCalledWith(browserUrl);
    expect(sharedMocks.issueControlUiBrowserHandoff).toHaveBeenCalledWith(links);
    expect(sharedMocks.callGateway).toHaveBeenCalledTimes(2);
    expect(prompter.note).toHaveBeenCalledWith(
      "Dashboard connected — continuing in your browser.",
      "Continue in your browser",
    );
  });

  it.each([true, false])(
    "preserves the coordinator target in the browser handoff (GUI: %s)",
    async (gui) => {
      sharedMocks.detectBrowserOpenSupport.mockResolvedValue({ ok: gui });
      const prompter = createWizardPrompter();
      expect(await runHandoff({ config: {}, prompter, agentId: "coordinator" })).toEqual({
        handedOff: true,
      });
      if (gui) {
        expect(sharedMocks.openUrl).toHaveBeenCalledWith(
          expect.stringContaining("?session=agent%3Acoordinator%3Amain#bootstrapToken="),
        );
      } else {
        expect(displayedNotes(prompter)).toContain("?session=agent%3Acoordinator%3Amain#");
      }
    },
  );

  it("probes the configured Gateway without a redundant target URL", async () => {
    const config = { gateway: { port: 19001, auth: { token: "test-token" } } };
    expect(await runHandoff({ config, prompter: createWizardPrompter() })).toEqual({
      handedOff: true,
    });
    expect(sharedMocks.callGateway).toHaveBeenCalledTimes(2);
    for (const [options] of sharedMocks.callGateway.mock.calls) {
      expect(options).toMatchObject({
        config,
        method: "system-presence",
        token: "test-token",
        ignoreEnvUrlOverride: true,
      });
      expect(options).not.toHaveProperty("url");
    }
  });

  it("prints a one-time pairing URL and waits longer without a browser", async () => {
    sharedMocks.callGateway.mockReset().mockResolvedValue([]);
    const prompter = createWizardPrompter();
    expect(
      await runHandoff({ config: { gateway: { auth: { token: "test-token" } } }, prompter }),
    ).toEqual({ handedOff: false, reason: "timeout" });
    expect(Date.now()).toBe(300_000);
    expect(sharedMocks.openUrl).not.toHaveBeenCalled();
    expect(sharedMocks.issueControlUiBrowserHandoff).toHaveBeenCalledWith(links);
    const displayed = displayedNotes(prompter);
    expect(displayed).toContain(browserUrl);
    expect(displayed).toContain("ssh -N -L 18789:127.0.0.1:18789");
    expect(displayed).not.toContain("test-token");
    expect(displayed).not.toContain("#token=");
  });

  it("prints an HTTPS tunnel destination for a headless loopback TLS Gateway", async () => {
    const prompter = createWizardPrompter();
    await runHandoff({
      config: {
        gateway: {
          port: 18789,
          bind: "loopback",
          controlUi: { basePath: "/control" },
          tls: { enabled: true },
        },
      },
      prompter,
    });
    const displayed = displayedNotes(prompter);
    expect(displayed).toContain("https://localhost:18789/control/");
    expect(displayed).not.toContain("http://localhost:18789/control/");
    expect(displayed).toContain("#bootstrapToken=one-time-bootstrap");
  });

  it.each(["returns false", "rejects"])(
    "falls back to the SSH hint and manual timeout when the browser opener %s",
    async (outcome) => {
      sharedMocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
      if (outcome === "rejects") {
        sharedMocks.openUrl.mockRejectedValue(new Error("browser command failed"));
      } else {
        sharedMocks.openUrl.mockResolvedValue(false);
      }
      sharedMocks.callGateway.mockReset().mockResolvedValue([]);
      vi.stubEnv("SSH_CONNECTION", "192.0.2.1 12345 192.0.2.2 22");
      const prompter = createWizardPrompter();
      expect(await runHandoff({ config: {}, prompter })).toEqual({
        handedOff: false,
        reason: "timeout",
      });
      expect(Date.now()).toBe(300_000);
      expect(sharedMocks.openUrl).toHaveBeenCalledWith(browserUrl);
      expect(displayedNotes(prompter)).toContain("ssh -N -L 18789:127.0.0.1:18789");
      expect(displayedNotes(prompter)).toContain("#bootstrapToken=one-time-bootstrap");
    },
  );

  it("prints the one-time pairing URL when browser launch fails", async () => {
    sharedMocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
    sharedMocks.openUrl.mockResolvedValue(false);
    const prompter = createWizardPrompter();
    await runHandoff({ config: { gateway: { auth: { token: "test-token" } } }, prompter });
    const displayed = displayedNotes(prompter);
    expect(displayed).toContain(browserUrl);
    expect(displayed).not.toContain("test-token");
    expect(displayed).not.toContain("#token=");
    expect(displayed).not.toContain("ssh -N -L");
  });

  it.each([
    { bind: "lan" as const, host: "10.211.55.3" },
    { bind: "tailnet" as const, host: "100.64.0.8" },
    { bind: "custom" as const, host: "10.211.55.4" },
  ])("tunnels headless plaintext $bind binds through secure localhost", async ({ bind, host }) => {
    const prompter = createWizardPrompter();
    await runHandoff({
      config: {
        gateway: {
          bind,
          ...(bind === "custom" ? { customBindHost: host } : {}),
          controlUi: { basePath: "/dashboard" },
          auth: { token: "test-token" },
        },
      },
      prompter,
    });
    const displayed = displayedNotes(prompter);
    expect(displayed).toContain("http://127.0.0.1:18789/dashboard/");
    expect(displayed).toContain("ssh -N -L 18789:127.0.0.1:18789");
    expect(displayed).toContain("http://localhost:18789/dashboard/");
    expect(displayed).not.toContain(`http://${host}:18789`);
    expect(displayed).not.toContain("openclaw devices approve <requestId>");
    expect(displayed).not.toContain("test-token");
    expect(displayed).not.toContain("#token=");
    expect(displayed).toContain("#bootstrapToken=one-time-bootstrap");
    expect(sharedMocks.resolveAdvertisedControlUiLinks).not.toHaveBeenCalled();
    expect(sharedMocks.issueControlUiBrowserHandoff).toHaveBeenCalledWith({
      httpUrl: "http://127.0.0.1:18789/dashboard/",
      wsUrl: "ws://127.0.0.1:18789/dashboard",
    });
  });

  it.each([
    { bind: "lan" as const, host: "10.211.55.3" },
    { bind: "tailnet" as const, host: "100.64.0.8" },
    { bind: "custom" as const, host: "10.211.55.4" },
  ])("prints the secure advertised URL for headless TLS $bind binds", async ({ bind, host }) => {
    const prompter = createWizardPrompter();
    sharedMocks.resolveAdvertisedControlUiLinks.mockResolvedValue({
      httpUrl: `https://${host}:18789/dashboard/`,
      wsUrl: `wss://${host}:18789/dashboard`,
    });
    await runHandoff({
      config: {
        gateway: {
          bind,
          ...(bind === "custom" ? { customBindHost: host } : {}),
          controlUi: { basePath: "/dashboard" },
          tls: { enabled: true },
          auth: { token: "test-token" },
        },
      },
      prompter,
    });
    const displayed = displayedNotes(prompter);
    expect(displayed).toContain(
      `https://${host}:18789/dashboard/#bootstrapToken=one-time-bootstrap`,
    );
    expect(displayed).toContain(
      `gatewayUrl=${encodeURIComponent(`wss://${host}:18789/dashboard`)}`,
    );
    expect(displayed).not.toContain("ssh -N -L");
    expect(displayed).not.toContain("test-token");
    expect(displayed).not.toContain("#token=");
    expect(displayed).not.toContain("openclaw devices approve <requestId>");
    expect(sharedMocks.resolveAdvertisedControlUiLinks).toHaveBeenCalledWith({
      bind,
      port: 18789,
      customBindHost: bind === "custom" ? host : undefined,
      basePath: "/dashboard",
      tlsEnabled: true,
    });
  });

  it("keeps headless TLS handoff available when all LAN discovery fails", async () => {
    const prompter = createWizardPrompter();
    sharedMocks.resolveAdvertisedLanHostCore.mockRejectedValue(
      new Error("default route unavailable"),
    );
    sharedMocks.resolveAdvertisedControlUiLinks.mockImplementation(async (params) => {
      const { resolveAdvertisedControlUiLinks } = await import("../gateway/control-ui-links.js");
      return await resolveAdvertisedControlUiLinks(params);
    });
    const networkInterfaces = vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
      throw new Error("uv_interface_addresses failed");
    });
    const result = await runHandoff({
      config: {
        gateway: {
          bind: "lan",
          controlUi: { basePath: "/dashboard" },
          tls: { enabled: true },
          auth: { token: "test-token" },
        },
      },
      prompter,
    });
    expect(result).toEqual({ handedOff: true });
    expect(sharedMocks.resolveAdvertisedLanHostCore).toHaveBeenCalledOnce();
    expect(networkInterfaces).toHaveBeenCalled();
    const displayed = displayedNotes(prompter);
    expect(displayed).toContain("https://127.0.0.1:18789/dashboard/");
    expect(displayed).not.toContain("test-token");
    expect(displayed).not.toContain("#token=");
    expect(displayed).toContain("#bootstrapToken=one-time-bootstrap");
  });

  it("keeps resolved password SecretRefs inside the Gateway presence request", async () => {
    const prompter = createWizardPrompter();
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
      prompter,
    });
    expect(sharedMocks.callGateway).toHaveBeenCalledTimes(2);
    for (const [options] of sharedMocks.callGateway.mock.calls) {
      expect(options.password).toBe(gatewayPassword);
    }
    expect(displayedNotes(prompter)).not.toContain(gatewayPassword);
    expect(displayedNotes(prompter)).toContain("#bootstrapToken=one-time-bootstrap");
    expect(sharedMocks.issueControlUiBrowserHandoff).toHaveBeenCalledWith(links);
  });

  it("bounds the final presence probe by the remaining handoff time", async () => {
    sharedMocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
    const probeTimeouts: number[] = [];
    sharedMocks.callGateway
      .mockReset()
      .mockResolvedValueOnce([connectedControlUiPresence])
      .mockImplementation(async ({ timeoutMs }) => {
        probeTimeouts.push(timeoutMs);
        vi.setSystemTime(Date.now() + timeoutMs / 2);
        return [connectedControlUiPresence];
      });
    expect(await runHandoff({ config: {}, prompter: createWizardPrompter() })).toEqual({
      handedOff: false,
      reason: "timeout",
    });
    expect(Date.now()).toBe(60_000);
    expect(probeTimeouts.at(-1)).toBe(1_000);
    expect(probeTimeouts.every((timeoutMs) => timeoutMs <= 5_000)).toBe(true);
  });

  it.each(["suppressed", "disabled"])(
    "does not open or issue credentials when the Control UI is %s",
    async (reason) => {
      const result = await runHandoff({
        config: reason === "disabled" ? { gateway: { controlUi: { enabled: false } } } : {},
        prompter: createWizardPrompter(),
        suppressTokenOutput: reason === "suppressed",
      });
      expect(result).toEqual({ handedOff: false, reason: "target-unavailable" });
      expect(sharedMocks.detectBrowserOpenSupport).not.toHaveBeenCalled();
      expect(sharedMocks.waitForControlUiDocument).not.toHaveBeenCalled();
      expect(sharedMocks.issueControlUiBrowserHandoff).not.toHaveBeenCalled();
      expect(sharedMocks.openUrl).not.toHaveBeenCalled();
    },
  );

  it("does not issue browser credentials while the dashboard document is unavailable", async () => {
    sharedMocks.waitForControlUiDocument.mockResolvedValue({
      ready: false,
      reason: "Control UI build failed.",
      status: 503,
    });
    expect(await runHandoff({ config: {}, prompter: createWizardPrompter() })).toEqual({
      handedOff: false,
      reason: "target-unavailable",
    });
    expect(sharedMocks.callGateway).not.toHaveBeenCalled();
    expect(sharedMocks.issueControlUiBrowserHandoff).not.toHaveBeenCalled();
    expect(sharedMocks.openUrl).not.toHaveBeenCalled();
  });

  it("starts and stops preparation progress only when the document reports pending", async () => {
    const stop = vi.fn();
    const prompter = createWizardPrompter({ progress: vi.fn(() => ({ update: vi.fn(), stop })) });
    sharedMocks.waitForControlUiDocument.mockImplementation(async ({ onPending }) => {
      onPending?.();
      return { ready: true };
    });
    await runHandoff({ config: {}, prompter });
    expect(prompter.progress).toHaveBeenCalledWith("Preparing the Control UI…");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("fails safely when a browser bootstrap cannot be issued", async () => {
    sharedMocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
    sharedMocks.issueControlUiBrowserHandoff.mockRejectedValue(new Error("state unavailable"));
    const prompter = createWizardPrompter();
    expect(await runHandoff({ config: {}, prompter })).toEqual({
      handedOff: false,
      reason: "target-unavailable",
    });
    expect(sharedMocks.openUrl).not.toHaveBeenCalled();
    expect(prompter.note).not.toHaveBeenCalled();
  });
});
