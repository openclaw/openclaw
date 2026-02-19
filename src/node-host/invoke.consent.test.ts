/**
 * Tests for node-host consent envelope enforcement (ConsentGate).
 * When system.run is gated, the host must reject missing or invalid consent envelopes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleInvoke } from "./invoke.js";

const loadConfigMock = vi.fn();

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

// Avoid real exec-approvals and exec-host during consent-path tests.
vi.mock("../infra/exec-approvals.js", () => ({
  addAllowlistEntry: vi.fn(),
  analyzeArgvCommand: vi.fn(),
  evaluateExecAllowlist: vi.fn(),
  evaluateShellAllowlist: vi.fn(),
  requiresExecApproval: vi.fn(),
  normalizeExecApprovals: vi.fn(),
  mergeExecApprovalsSocketDefaults: vi.fn(),
  recordAllowlistUse: vi.fn(),
  resolveExecApprovals: vi.fn(() => ({
    agent: { security: "allowlist", ask: "none", autoAllowSkills: false, allowlist: [] },
    allowlist: [],
    socketPath: null,
    token: null,
  })),
  resolveSafeBins: vi.fn(() => []),
  ensureExecApprovals: vi.fn(),
  readExecApprovalsSnapshot: vi.fn(() => ({
    path: "",
    exists: false,
    hash: "",
    file: {},
  })),
  saveExecApprovals: vi.fn(),
}));

vi.mock("../infra/exec-host.js", () => ({
  requestExecHostViaSocket: vi.fn(),
}));

const skillBins = {
  current: vi.fn().mockResolvedValue(new Set<string>()),
};

function makeFrame(params: {
  consentEnvelope?: {
    jti: string;
    consumedAtMs: number;
    expiresAtMs: number;
    sessionKey: string;
  } | null;
  sessionKey?: string;
}) {
  const runParams = {
    command: ["sh", "-lc", "echo ok"],
    rawCommand: "echo ok",
    sessionKey: params.sessionKey ?? "test-session",
    ...(params.consentEnvelope !== undefined && { consentEnvelope: params.consentEnvelope }),
  };
  return {
    id: "invoke-consent-1",
    nodeId: "node-1",
    command: "system.run",
    paramsJSON: JSON.stringify(runParams),
  };
}

describe("node-host consent envelope", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({});
  });

  it("rejects system.run when ConsentGate is enabled and consent envelope is missing", async () => {
    loadConfigMock.mockReturnValue({
      gateway: {
        consentGate: {
          enabled: true,
          gatedTools: ["system.run"],
        },
      },
    });

    const requestCalls: Array<[string, unknown]> = [];
    const client = {
      request: vi.fn((method: string, params: unknown) => {
        requestCalls.push([method, params]);
        return Promise.resolve();
      }),
    };

    const frame = makeFrame({ consentEnvelope: undefined });

    await handleInvoke(frame, client as never, skillBins as never);

    expect(requestCalls).toHaveLength(1);
    expect(requestCalls[0][0]).toBe("node.invoke.result");
    const result = requestCalls[0][1] as { ok: boolean; error?: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_REQUEST");
    expect(result.error?.message).toContain("Consent required for system.run");
    expect(result.error?.message).toContain("missing or expired consent envelope");
  });

  it("rejects system.run when consent envelope is expired", async () => {
    loadConfigMock.mockReturnValue({
      gateway: {
        consentGate: {
          enabled: true,
          gatedTools: ["system.run"],
        },
      },
    });

    const requestCalls: Array<[string, unknown]> = [];
    const client = {
      request: vi.fn((method: string, params: unknown) => {
        requestCalls.push([method, params]);
        return Promise.resolve();
      }),
    };

    const frame = makeFrame({
      consentEnvelope: {
        jti: "token-123",
        consumedAtMs: 0,
        expiresAtMs: Date.now() - 1000,
        sessionKey: "test-session",
      },
    });

    await handleInvoke(frame, client as never, skillBins as never);

    expect(requestCalls).toHaveLength(1);
    const result = requestCalls[0][1] as { ok: boolean; error?: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Consent required for system.run");
    expect(result.error?.message).toContain("missing or expired consent envelope");
  });

  it("rejects when consent envelope sessionKey does not match params", async () => {
    loadConfigMock.mockReturnValue({
      gateway: {
        consentGate: {
          enabled: true,
          gatedTools: ["system.run"],
        },
      },
    });

    const requestCalls: Array<[string, unknown]> = [];
    const client = {
      request: vi.fn((method: string, params: unknown) => {
        requestCalls.push([method, params]);
        return Promise.resolve();
      }),
    };

    const frame = makeFrame({
      sessionKey: "other-session",
      consentEnvelope: {
        jti: "token-456",
        consumedAtMs: 0,
        expiresAtMs: Date.now() + 60_000,
        sessionKey: "test-session",
      },
    });

    await handleInvoke(frame, client as never, skillBins as never);

    expect(requestCalls).toHaveLength(1);
    const result = requestCalls[0][1] as { ok: boolean; error?: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Consent session key mismatch");
  });
});
