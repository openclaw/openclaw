// Verifies probe failure audit reporting.
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runSecurityAuditCore } from "./audit.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("security audit deep probe failure", () => {
  it.each([false, true])("redacts probe errors and forwards cancellation: %s", async (cancel) => {
    const user = "audit-user-sentinel";
    const password = "audit-password-sentinel";
    const querySecret = "audit-query-sentinel";
    const url = `wss://${user}:${password}@gateway.example.test/socket?client_secret=${querySecret}`;
    const controller = new AbortController();
    const reason = new Error("audit interrupted");

    const audit = withEnvAsync({ OPENCLAW_GATEWAY_URL: undefined }, async () =>
      runSecurityAuditCore({
        config: { gateway: { mode: "remote", remote: { url } } },
        sourceConfig: { gateway: { mode: "remote", remote: { url } } },
        env: {},
        deep: true,
        includeFilesystem: false,
        plugins: [],
        loadPluginSecurityCollectors: false,
        stateDir: tempDirs.make("audit-probe-"),
        signal: controller.signal,
        probeGatewayFn: async ({ url: probeUrl }) => {
          if (cancel) controller.abort(reason);
          return {
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
          };
        },
      }),
    );
    if (cancel) {
      await expect(audit).rejects.toBe(reason);
      return;
    }
    const report = await audit;

    expect(report.deep?.gateway).toMatchObject({
      url: "wss://***:***@gateway.example.test/socket?client_secret=***",
      error: "failed to connect to wss://***:***@gateway.example.test/socket?client_secret=***",
      close: {
        reason: "connection closed at wss://***:***@gateway.example.test/socket?client_secret=***",
      },
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        checkId: "gateway.probe_failed",
        severity: "warn",
        detail: "failed to connect to wss://***:***@gateway.example.test/socket?client_secret=***",
      }),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(user);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(querySecret);
  });
});
