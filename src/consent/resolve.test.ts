import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { CONSENT_REASON } from "./reason-codes.js";
import { resetConsentGateResolverForTests, resolveConsentGateApi } from "./resolve.js";

const POLICY_VERSION = "1";

function consentConfig(overrides?: Partial<NonNullable<OpenClawConfig["gateway"]>["consentGate"]>): OpenClawConfig {
  return {
    gateway: {
      consentGate: {
        enabled: true,
        observeOnly: false,
        gatedTools: ["exec"],
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

describe("resolveConsentGateApi", () => {
  beforeEach(() => {
    resetConsentGateResolverForTests();
  });

  it("reuses in-memory token/WAL state across config changes", async () => {
    const cfg1 = consentConfig({ observeOnly: false, gatedTools: ["exec"] });
    const api1 = resolveConsentGateApi(cfg1);
    const token = await api1.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "session-a",
      contextHash: "ctx-a",
      ttlMs: 60_000,
      issuedBy: "test",
      policyVersion: POLICY_VERSION,
    });
    expect(token).not.toBeNull();

    // Simulate hot-reload changing policy knobs while runtime state should remain.
    const cfg2 = consentConfig({ observeOnly: true, gatedTools: ["exec", "write"] });
    const api2 = resolveConsentGateApi(cfg2);
    const consumed = await api2.consume({
      jti: token!.jti,
      tool: "exec",
      trustTier: "T0",
      sessionKey: "session-a",
      contextHash: "ctx-a",
    });
    expect(consumed.allowed).toBe(true);
  });

  it("uses a different runtime state when storagePath changes", async () => {
    const dir1 = mkdtempSync(path.join(tmpdir(), "consentgate-resolve-1-"));
    const dir2 = mkdtempSync(path.join(tmpdir(), "consentgate-resolve-2-"));
    try {
      const cfg1 = consentConfig({ storagePath: dir1 });
      const api1 = resolveConsentGateApi(cfg1);
      const token = await api1.issue({
        tool: "exec",
        trustTier: "T0",
        sessionKey: "session-a",
        contextHash: "ctx-a",
        ttlMs: 60_000,
        issuedBy: "test",
        policyVersion: POLICY_VERSION,
      });
      expect(token).not.toBeNull();

      const cfg2 = consentConfig({ storagePath: dir2 });
      const api2 = resolveConsentGateApi(cfg2);
      const consumed = await api2.consume({
        jti: token!.jti,
        tool: "exec",
        trustTier: "T0",
        sessionKey: "session-a",
        contextHash: "ctx-a",
      });
      expect(consumed.allowed).toBe(false);
      expect(consumed.reasonCode).toBe(CONSENT_REASON.TOKEN_NOT_FOUND);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

