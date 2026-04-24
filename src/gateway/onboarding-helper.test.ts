import { describe, expect, it, vi } from "vitest";
import { ADMIN_SCOPE, READ_SCOPE } from "./method-scopes.js";
import {
  answerWizardSession,
  completePairing,
  getPairingSetup,
  getWizardSessionStatus,
  probeOnboarding,
  startWizardSession,
} from "./onboarding-helper.js";

function createDeps() {
  return {
    callGatewayScoped: vi.fn(),
    loadConfig: vi.fn(() => ({
      gateway: {
        mode: "local",
        port: 18789,
        tls: { enabled: false },
        auth: { mode: "token", token: "desktop-token" },
      },
    })),
    resolvePairingSetupFromConfig: vi.fn(),
    encodePairingSetupCode: vi.fn(() => "setup-code-123"),
    runCommandWithTimeout: vi.fn(),
  };
}

describe("onboarding-helper", () => {
  it("probes gateway reachability and resolves pairing setup details", async () => {
    const deps = createDeps();
    deps.callGatewayScoped.mockResolvedValue({ ok: true });
    deps.resolvePairingSetupFromConfig.mockResolvedValue({
      ok: true,
      payload: {
        url: "wss://desktop.tailnet.ts.net",
        token: "pair-token",
      },
      authLabel: "token",
      urlSource: "gateway.remote.url",
    });

    await expect(probeOnboarding({}, deps)).resolves.toMatchObject({
      action: "probe-onboarding",
      gatewayReachable: true,
      pairing: {
        url: "wss://desktop.tailnet.ts.net",
        token: "pair-token",
        password: null,
        authLabel: "token",
        urlSource: "gateway.remote.url",
        setupCode: "setup-code-123",
        error: null,
      },
    });

    expect(deps.callGatewayScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "health",
        params: { probe: true },
        scopes: [READ_SCOPE],
      }),
    );
    expect(deps.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        preferRemoteUrl: true,
        runCommandWithTimeout: deps.runCommandWithTimeout,
      }),
    );
  });

  it("surfaces unresolved pairing config without failing the probe", async () => {
    const deps = createDeps();
    deps.callGatewayScoped.mockResolvedValue({ ok: true });
    deps.resolvePairingSetupFromConfig.mockResolvedValue({
      ok: false,
      error: "Gateway is only bound to loopback.",
    });

    await expect(getPairingSetup({}, deps)).resolves.toMatchObject({
      action: "get-pairing-setup",
      verified: false,
      pairing: {
        url: null,
        setupCode: null,
        error: "Gateway is only bound to loopback.",
      },
    });
  });

  it("marks plaintext remote pairing targets as blocked", async () => {
    const deps = createDeps();
    deps.callGatewayScoped.mockResolvedValue({ ok: true });
    deps.resolvePairingSetupFromConfig.mockResolvedValue({
      ok: true,
      payload: {
        url: "ws://203.0.113.10:18789",
        token: "pair-token",
      },
      authLabel: "token",
      urlSource: "gateway.remote.url",
    });

    await expect(probeOnboarding({}, deps)).resolves.toMatchObject({
      pairing: {
        url: "ws://203.0.113.10:18789",
        token: "pair-token",
        urlSource: "gateway.remote.url",
        error: expect.stringContaining("insecure remote ws://"),
      },
    });
  });

  it("starts wizard sessions with operator.admin scope", async () => {
    const deps = createDeps();
    deps.callGatewayScoped.mockResolvedValue({
      sessionId: "wiz-1",
      done: false,
      status: "running",
      step: {
        id: "step-intro",
        type: "note",
        title: "OpenClaw onboarding",
      },
    });

    await expect(startWizardSession({}, deps)).resolves.toEqual({
      action: "start-wizard",
      sessionId: "wiz-1",
      done: false,
      status: "running",
      error: null,
      step: {
        id: "step-intro",
        type: "note",
        title: "OpenClaw onboarding",
      },
    });

    expect(deps.callGatewayScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "wizard.start",
        params: { mode: "local" },
        scopes: [ADMIN_SCOPE],
      }),
    );
  });

  it("uses wizard.next for answers and wizard.status for status fetch", async () => {
    const deps = createDeps();
    deps.callGatewayScoped
      .mockResolvedValueOnce({
        done: false,
        status: "running",
        step: {
          id: "step-risk",
          type: "confirm",
          message: "Continue?",
        },
      })
      .mockResolvedValueOnce({
        status: "done",
      });

    await expect(
      answerWizardSession(
        "wiz-2",
        {
          stepId: "step-intro",
          value: true,
        },
        {},
        deps,
      ),
    ).resolves.toMatchObject({
      action: "answer-wizard",
      sessionId: "wiz-2",
      done: false,
      status: "running",
      step: {
        id: "step-risk",
        type: "confirm",
      },
    });

    await expect(getWizardSessionStatus("wiz-2", {}, deps)).resolves.toEqual({
      action: "get-wizard-status",
      sessionId: "wiz-2",
      done: true,
      status: "done",
      error: null,
      step: null,
    });

    expect(deps.callGatewayScoped).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "wizard.next",
        params: {
          sessionId: "wiz-2",
          answer: {
            stepId: "step-intro",
            value: true,
          },
        },
      }),
    );
    expect(deps.callGatewayScoped).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "wizard.status",
        params: {
          sessionId: "wiz-2",
        },
      }),
    );
  });

  it("verifies pairing credentials by making an authenticated health call", async () => {
    const deps = createDeps();
    deps.callGatewayScoped.mockResolvedValue({ ok: true });

    await expect(
      completePairing(
        {
          url: "wss://desktop.tailnet.ts.net",
          token: "pair-token",
        },
        {},
        deps,
      ),
    ).resolves.toMatchObject({
      action: "complete-pairing",
      gatewayUrl: "wss://desktop.tailnet.ts.net",
      gatewayReachable: true,
      verified: true,
      pairing: {
        url: "wss://desktop.tailnet.ts.net",
        token: "pair-token",
        password: null,
        authLabel: "token",
        setupCode: "setup-code-123",
      },
    });

    expect(deps.callGatewayScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "health",
        params: { probe: true },
        scopes: [READ_SCOPE],
        url: "wss://desktop.tailnet.ts.net",
        token: "pair-token",
      }),
    );
  });

  it("propagates gateway failures during pairing verification", async () => {
    const deps = createDeps();
    deps.callGatewayScoped.mockRejectedValue(new Error("gateway timeout after 10000ms"));

    await expect(
      completePairing(
        {
          url: "wss://desktop.tailnet.ts.net",
          token: "pair-token",
        },
        {},
        deps,
      ),
    ).rejects.toThrow("gateway timeout");
  });
});
