// Verifies probe failure audit reporting.
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";
import { runSecurityAuditCore } from "./audit.js";

describe("security audit deep probe failure", () => {
  it("redacts gateway URL credentials from the deep audit report", async () => {
    const user = "audit-user-sentinel";
    const password = "audit-password-sentinel";
    const querySecret = "audit-query-sentinel";
    const url = `wss://${user}:${password}@gateway.example.test/socket?client_secret=${querySecret}`;

    const report = await withEnvAsync({ OPENCLAW_GATEWAY_URL: undefined }, async () =>
      runSecurityAuditCore({
        config: { gateway: { mode: "remote", remote: { url } } },
        sourceConfig: { gateway: { mode: "remote", remote: { url } } },
        env: {},
        deep: true,
        includeFilesystem: false,
        includeChannelSecurity: false,
        loadPluginSecurityCollectors: false,
        probeGatewayFn: async ({ url: probeUrl }) => ({
          ok: false,
          url: probeUrl,
          connectLatencyMs: null,
          error: `failed to connect to ${probeUrl}`,
          close: { code: 1006, reason: `connection closed at ${probeUrl}` },
          auth: { role: null, scopes: [], capability: "unknown" },
          health: null,
          status: null,
          presence: null,
          configSnapshot: null,
        }),
      }),
    );

    expect(report.deep?.gateway).toMatchObject({
      url: "wss://***:***@gateway.example.test/socket?client_secret=***",
      error: "failed to connect to wss://***:***@gateway.example.test/socket?client_secret=***",
      close: {
        reason: "connection closed at wss://***:***@gateway.example.test/socket?client_secret=***",
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(user);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(querySecret);
  });

  it("adds a probe_failed warning with the reported error", () => {
    expect(
      collectDeepProbeFindings({
        deep: {
          gateway: {
            attempted: true,
            ok: false,
            url: "ws://127.0.0.1:18789",
            error: "connect failed",
            close: null,
          },
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        checkId: "gateway.probe_failed",
        severity: "warn",
        detail: "connect failed",
      }),
    );
  });
});
