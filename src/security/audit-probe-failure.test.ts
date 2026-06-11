import { describe, expect, it } from "vitest";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";
import { runSecurityAudit } from "./audit.js";

function requireProbeFailure(findings: ReturnType<typeof collectDeepProbeFindings>) {
  const finding = findings.find((entry) => entry.checkId === "gateway.probe_failed");
  if (!finding) {
    throw new Error("Expected gateway probe failure finding");
  }
  return finding;
}

describe("security audit deep probe failure", () => {
  it("uses a presence-level gateway probe for deep audit reachability", async () => {
    const calls: unknown[] = [];
    const report = await runSecurityAudit({
      config: {},
      env: {},
      deep: true,
      includeFilesystem: false,
      includeChannelSecurity: false,
      loadPluginSecurityCollectors: false,
      stateDir: "/tmp/openclaw-test-state",
      configPath: "/tmp/openclaw-test-config.json",
      probeGatewayFn: async (opts) => {
        calls.push(opts);
        return {
          ok: true,
          url: opts.url,
          connectLatencyMs: 1,
          error: null,
          close: null,
          auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
          health: null,
          status: null,
          presence: [],
          configSnapshot: null,
        };
      },
    });

    expect(report.deep?.gateway?.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ detailLevel: "presence" });
  });

  it("adds probe_failed warnings for deep probe failure modes", () => {
    const cases: Array<{
      name: string;
      deep: {
        gateway: {
          attempted: boolean;
          url: string | null;
          ok: boolean;
          error: string | null;
          close?: { code: number; reason: string } | null;
        };
      };
      expectedError: string;
    }> = [
      {
        name: "probe returns failed result",
        deep: {
          gateway: {
            attempted: true,
            ok: false,
            url: "ws://127.0.0.1:18789",
            error: "connect failed",
            close: null,
          },
        },
        expectedError: "connect failed",
      },
      {
        name: "probe throws",
        deep: {
          gateway: {
            attempted: true,
            ok: false,
            url: "ws://127.0.0.1:18789",
            error: "probe boom",
            close: null,
          },
        },
        expectedError: "probe boom",
      },
    ];

    for (const testCase of cases) {
      const findings = collectDeepProbeFindings({ deep: testCase.deep });
      const probeFailure = requireProbeFailure(findings);
      expect(probeFailure.detail, testCase.name).toContain(testCase.expectedError);
    }
  });
});
