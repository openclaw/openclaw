import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as configEnv from "../config/config-env-vars.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { resolveUsageCostPricingFingerprint } from "./session-cost-usage-pricing-context.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import { loadSessionCostSummariesFromCache } from "./session-cost-usage.js";

it("keeps a usage inventory within its captured sibling database owners", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.path("usage-store", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const sessionFile = path.join(path.dirname(storePath), "recorded.jsonl");
    fs.writeFileSync(sessionFile, "{}\n");
    const prepared = prepareUsageCostWorker({ agentId: "main", storePath, env: state.env });
    // Another startup refresh creates a sibling after this operation captured its custody.
    openOpenClawAgentDatabase({
      agentId: "other",
      path: path.join(path.dirname(storePath), "openclaw-agent.other.sqlite"),
      env: state.env,
    });
    await expect(runUsageCostWorker(prepared, { kind: "inventory" })).resolves.toMatchObject({
      kind: "inventory",
      files: [{ kind: "jsonl", sourcePath: sessionFile }],
    });
  });
});

it("refreshes and reads usage with the captured Windows environment and database", async () => {
  await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
    const config = {};
    const agentId = "usage-env";
    const sessionFile = state.path("usage.jsonl");
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        timestamp: "2026-09-18T00:00:00Z",
        message: {
          role: "assistant",
          provider: "test",
          model: "test",
          usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
        },
      }) + "\n",
    );
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env: state.env });
    const laterRoot = state.path("later-state");
    const defaultRoot = path.join(state.home, ".openclaw");
    const originalEnv = process.env;
    const hostPlatform = process.platform;
    const cloneEnv = configEnv.cloneEnvWithPlatformSemantics;
    const clone = vi.spyOn(configEnv, "cloneEnvWithPlatformSemantics").mockImplementation((input) =>
      // Only the real environment clone sees Windows; paths and SQLite stay host-native.
      withMockedPlatform("win32", () => cloneEnv(input)),
    );
    try {
      await expect(
        refreshCostUsageCacheForAgent({ agentId, config, sessionFiles: [sessionFile] }),
      ).resolves.toBe("refreshed");
      const env = { ...state.env };
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === "OPENCLAW_STATE_DIR") {
          delete env[key];
        }
      }
      env.OpenClaw_State_Dir = state.stateDir;
      const prepared = prepareUsageCostWorker({
        agentId,
        config,
        sessionFiles: [sessionFile],
        env,
      });
      expect(prepared.location.databasePath).toBe(databasePath);
      const pricingFingerprint = await resolveUsageCostPricingFingerprint(
        prepared.config,
        prepared.agentDir,
      );
      env.OpenClaw_State_Dir = laterRoot;
      process.env = { ...originalEnv, OPENCLAW_STATE_DIR: laterRoot };
      expect(process.platform).toBe(hostPlatform);
      expect(
        await runUsageCostWorker(prepared, {
          kind: "sessions",
          pricingFingerprint,
          sessions: [{ sessionFile }],
          dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
        }),
      ).toMatchObject({
        kind: "sessions",
        summaries: [{ totalTokens: 10, totalCost: 1 }],
        cacheStatus: { status: "fresh", cachedFiles: 1 },
      });
      process.env = originalEnv;
      expect(
        await loadSessionCostSummariesFromCache({
          agentId,
          config,
          sessions: [{ sessionFile }],
          requestRefresh: false,
        }),
      ).toMatchObject({ summaries: [{ totalTokens: 10, totalCost: 1 }] });
      expect(fs.existsSync(databasePath)).toBe(true);
      expect(fs.existsSync(defaultRoot)).toBe(false);
      expect(fs.existsSync(laterRoot)).toBe(false);
    } finally {
      process.env = originalEnv;
      clone.mockRestore();
    }
  });
});
