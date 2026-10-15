import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as configEnv from "../config/config-env-vars.js";
import { resolveSqliteTranscriptScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { resolveUsageCostPricingFingerprint } from "./session-cost-usage-pricing-context.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import { loadSessionCostSummariesFromCache } from "./session-cost-usage.js";

const usageRecord =
  JSON.stringify({
    type: "message",
    id: "usage",
    parentId: null,
    timestamp: "2026-09-18T00:00:00Z",
    message: {
      role: "assistant",
      provider: "test",
      model: "test",
      usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
    },
  }) + "\n";

it("refreshes retained transcript windows whose session IDs contain colons", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const scope = resolveSqliteTranscriptScope({
      agentId: "main",
      sessionKey: "agent:main:retained-usage",
      sessionId: "legacy:session",
      storePath: database.path,
      env: state.env,
    });
    runOpenClawAgentWriteTransaction(
      (owner) => {
        appendTranscriptEventsInTransaction(
          owner,
          scope,
          [{ type: "session", version: 1, id: scope.sessionId }, JSON.parse(usageRecord)],
          { scheduleProjectionReconcile: false },
        );
      },
      { agentId: "main", path: database.path, env: state.env },
    );
    await expect(
      refreshCostUsageCacheForAgent({ agentId: "main", config: {}, env: state.env }),
    ).resolves.toBe("refreshed");
    await expect(
      loadSessionCostSummariesFromCache({
        agentId: "main",
        config: {},
        sessions: [{ sessionFile: `sqlite:main:legacy:session:${database.path}` }],
        requestRefresh: false,
      }),
    ).resolves.toMatchObject({ summaries: [{ totalTokens: 10, totalCost: 1 }] });
  });
});

it("retains requested SQLite selectors separately from physical rollup keys", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.path("custom", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(path.dirname(storePath), "openclaw-agent.sqlite"),
      env: state.env,
    });
    const sessionFiles = ["first", "second"].map((id) => `sqlite:main:${id}:${storePath}`);
    const prepared = prepareUsageCostWorker({
      agentId: "main",
      storePath,
      sessionFiles,
      env: state.env,
    });
    await expect(
      runUsageCostWorker(prepared, { kind: "inventory", sessionFiles }),
    ).resolves.toMatchObject({
      kind: "inventory",
      files: sessionFiles.map((sourcePath) => ({ kind: "sqlite", sourcePath })),
    });
  });
});

it("refreshes a custom store after another database changes its registered owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.path("custom", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const databasePath = path.join(path.dirname(storePath), "openclaw-agent.sqlite");
    openOpenClawAgentDatabase({ agentId: "main", path: databasePath, env: state.env });
    openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(path.dirname(storePath), "openclaw-agent.main.sqlite"),
      env: state.env,
    });
    const warmStore = state.path("warm", "sessions.json");
    fs.mkdirSync(path.dirname(warmStore), { recursive: true });
    // Warm discovery on an unrelated store; replacing this database must not retire that worker.
    await refreshCostUsageCacheForAgent({ agentId: "main", storePath: warmStore, env: state.env });
    await closeOpenClawAgentDatabaseByPathAsync(databasePath);
    unregisterOpenClawAgentDatabase({ agentId: "main", path: databasePath, env: state.env });
    fs.unlinkSync(databasePath);
    openOpenClawAgentDatabase({ agentId: "other", path: databasePath, env: state.env });
    const sessionFile = path.join(path.dirname(storePath), "recorded.jsonl");
    fs.writeFileSync(sessionFile, usageRecord);
    await expect(
      refreshCostUsageCacheForAgent({ agentId: "main", storePath, env: state.env, maxFiles: 1 }),
    ).resolves.toBe("refreshed");
    await expect(
      loadSessionCostSummariesFromCache({
        agentId: "main",
        config: { session: { store: storePath } },
        sessions: [{ sessionFile }],
        requestRefresh: false,
      }),
    ).resolves.toMatchObject({ summaries: [{ totalTokens: 10, totalCost: 1 }] });
  });
});

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
    fs.writeFileSync(sessionFile, usageRecord);
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
