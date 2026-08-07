import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveHealthHookDeadlineFixturePluginDir,
  withHealthHookDeadlineFixture,
} from "./gateway-rpc-account-health-hook-deadlines.js";
import {
  runGatewayRpcAccountHealthProof,
  statusSummaryMentions,
  withSiblingAccount,
} from "./gateway-rpc-account-health.js";

describe("Gateway RPC account health producer", () => {
  it("adds one sibling without replacing existing QA channel config", () => {
    const config = withSiblingAccount(
      {
        channels: {
          "qa-channel": {
            enabled: true,
            baseUrl: "http://127.0.0.1:43124",
            accounts: { existing: { enabled: false } },
          },
        },
      } as never,
      "http://127.0.0.1:43125",
    );

    expect(config.channels?.["qa-channel"]).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:43125",
      botUserId: "openclaw",
      botDisplayName: "OpenClaw QA",
      allowFrom: ["*"],
      pollTimeoutMs: 250,
      accounts: {
        existing: { enabled: false },
        sibling: { enabled: true },
      },
    });
  });

  it("builds an isolated six-account channel hook deadline fixture", () => {
    const pluginDir = resolveHealthHookDeadlineFixturePluginDir();
    const config = withHealthHookDeadlineFixture({} as never, pluginDir, "delayed");
    expect(config.channels?.["qa-health-hook-deadline"]).toMatchObject({
      enabled: true,
      mode: "delayed",
      accounts: {
        "account-1": { enabled: true },
        "account-6": { enabled: true },
      },
    });
    expect(config.plugins).toMatchObject({
      enabled: true,
      allow: ["qa-health-hook-deadline"],
      entries: { "qa-health-hook-deadline": { enabled: true } },
    });
    expect(config.plugins?.load?.paths).toContain(pluginDir);
  });

  it("reads account visibility from status channel-summary lines", () => {
    const status = {
      channelSummary: [
        "\u001b[32mQA Channel: configured\u001b[39m",
        "  - default (http://127.0.0.1:43124)",
        "  - sibling (disabled, http://127.0.0.1:43124)",
      ],
    };

    expect(statusSummaryMentions(status, "QA Channel", "default", "sibling")).toBe(true);
    expect(statusSummaryMentions(status, "QA Channel", "sibling", "disabled")).toBe(true);
    expect(statusSummaryMentions(status, "qa-channel")).toBe(false);
  });

  it.runIf(process.env.OPENCLAW_QA_REAL_GATEWAY === "1")(
    "proves authenticated health/status RPC and a targeted account config reload",
    async () => {
      const proof = await runGatewayRpcAccountHealthProof(
        path.resolve(import.meta.dirname, "../../../.."),
      );

      expect(proof.initialHealthOk).toBe(true);
      expect(proof.initialStatusVisible).toBe(true);
      expect(proof.initialAccounts.default).toMatchObject({
        enabled: true,
        configured: true,
        running: true,
      });
      expect(proof.initialAccounts.sibling).toMatchObject({
        enabled: true,
        configured: true,
        running: true,
      });
      expect(proof.onlyTargetConfigChanged).toBe(true);
      expect(proof.finalAccounts.default).toMatchObject({
        enabled: true,
        configured: true,
        running: true,
      });
      expect(proof.finalAccounts.sibling).toMatchObject({
        enabled: false,
        configured: true,
        running: false,
      });
      expect(proof.finalStatusVisible).toBe(true);
      expect(proof.healthHookDeadlines.delayedCli).toMatchObject({
        accountCount: 6,
        skippedCount: 0,
        timedOutCount: 0,
      });
      expect(proof.healthHookDeadlines.delayedCli.durationMs).toBeGreaterThan(10_000);
      expect(proof.healthHookDeadlines.delayedCli.durationMs).toBeLessThanOrEqual(20_000);
      expect(proof.healthHookDeadlines.hangingRpc).toMatchObject({
        firstSkippedCount: 1,
        firstTimedOutCount: 5,
        secondSkippedCount: 6,
        secondTimedOutCount: 0,
      });
      expect(proof.healthHookDeadlines.hangingRpc.firstDurationMs).toBeGreaterThanOrEqual(9_000);
      expect(proof.healthHookDeadlines.hangingRpc.firstDurationMs).toBeLessThanOrEqual(16_000);
      expect(proof.healthHookDeadlines.hangingRpc.secondDurationMs).toBeLessThanOrEqual(3_000);
    },
    180_000,
  );
});
