import fs from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  createSessionEntryWithTranscript,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { refreshCostUsageCacheForAgent } from "../../infra/session-cost-usage-aggregation.js";
import {
  readSessionCostUsageRollupBodyInDatabase,
  writeSessionCostUsageRollupInDatabase,
} from "../../infra/session-cost-usage-cache.kernel.js";
import { readSessionCostUsageRollupRows } from "../../infra/session-cost-usage-cache.test-support.js";
import {
  prepareUsageCostWorker,
  runUsageCostWorker,
} from "../../infra/session-cost-usage-worker-runtime.js";
import {
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
} from "../../infra/session-cost-usage.js";
import { sqliteWorkerPreloadEnv } from "../../infra/sqlite-worker-preload.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { GatewayRequestContext } from "./types.js";

const observedWorkers = vi.hoisted(() => new Set<Worker>());

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<Worker["postMessage"]>): void {
        const message = args[0];
        if (isRecord(message) && isRecord(message.input) && message.input.kind === "usage-cost") {
          observedWorkers.add(this);
        }
        super.postMessage(...args);
      }
    },
  };
});

afterEach(() => {
  const workers = [...observedWorkers];
  observedWorkers.clear();
  for (const worker of workers) {
    expect(worker.threadId).toBe(-1);
  }
});

type DecodeObservation = {
  operation: string;
  parsedRollups: number;
  threadId: number;
};

async function observeUsageDecoding(preload: string, log: string) {
  await fs.writeFile(log, "");
  await fs.writeFile(
    preload,
    `const fs = require("node:fs");
const { parentPort, threadId } = require("node:worker_threads");
if (parentPort) {
  let operation;
  let parsedRollups = 0;
  parentPort.on("message", (message) => {
    if (message.responseId !== undefined) return;
    operation = message.input?.kind === "usage-cost" ? message.input.operation.kind : undefined;
    parsedRollups = 0;
  });
  const parse = JSON.parse;
  JSON.parse = function(text, ...args) {
    const rollup = operation && typeof text === "string" && text.includes('"buckets"') &&
      text.includes('"untimestamped"');
    if (rollup) parsedRollups++;
    return Reflect.apply(parse, this, [text, ...args]);
  };
  const post = parentPort.postMessage;
  parentPort.postMessage = function(message, ...args) {
    if (operation && (message.status === "ok" || message.status === "failed")) {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
        operation, parsedRollups, threadId,
      }) + "\\n");
      operation = undefined;
    }
    return Reflect.apply(post, this, [message, ...args]);
  };
}

`,
  );
  return async (): Promise<DecodeObservation[]> =>
    (await fs.readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DecodeObservation);
}

function usageLine(id: string): string {
  return `${JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-18T12:00:00Z",
    message: {
      role: "assistant",
      content: "Synthetic usage",
      provider: "synthetic",
      model: "synthetic",
      usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
    },
  })}\n`;
}

function appendSessionUsage(
  target: Parameters<typeof persistSessionTranscriptTurn>[0],
  cwd: string,
) {
  const timestamp = Date.parse("2026-09-18T12:00:00Z");
  return persistSessionTranscriptTurn(target, {
    cwd,
    updateMode: "none",
    messages: [
      {
        message: {
          role: "assistant",
          content: "Synthetic usage",
          timestamp,
          provider: "synthetic",
          model: "synthetic",
          usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
        },
        now: timestamp,
      },
    ],
  });
}

it("refreshes registered usage.cost without decoding unchanged fresh rollups", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const preload = state.path("observe-usage-decode.cjs");
    const observations = await observeUsageDecoding(preload, state.path("usage-decode.jsonl"));
    await withEnvAsync(sqliteWorkerPreloadEnv(preload), async () => {
      const config = getRuntimeConfig();
      const timestamp = Date.parse("2026-09-18T12:00:00Z");
      const sessions = Array.from({ length: 4 }, (_, index) => ({
        agentId: "main",
        sessionKey: `agent:main:usage-checkpoint-${index}`,
        sessionId: `usage-checkpoint-${index}`,
      }));
      for (const session of sessions) {
        replaceSessionEntrySync(session, { sessionId: session.sessionId, updatedAt: timestamp });
        await appendSessionUsage(session, state.workspaceDir);
      }
      const params = { config, agentId: "main", startMs: timestamp - 1, endMs: timestamp + 1 };
      expect((await loadCostUsageSummary(params)).totals.totalTokens).toBe(40);
      await appendSessionUsage(sessions[0]!, state.workspaceDir);
      const work = new AsyncWorkScope();
      const respond = vi.fn();
      try {
        await work.track(() =>
          expectDefined(
            coreGatewayHandlers["usage.cost"],
            "registered usage.cost",
          )({
            req: { type: "req", id: "checkpoint-refresh", method: "usage.cost" },
            params: { agentId: "main", startDate: "2026-09-18", endDate: "2026-09-18" },
            respond,
            client: null,
            isWebchatConnect: () => false,
            context: { getRuntimeConfig: () => config } as GatewayRequestContext,
          }),
        );
        await AsyncWorkScope.runWhenAllIdle(
          () => [work],
          () => {},
        );
      } finally {
        await work.drain();
      }
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({ totals: expect.objectContaining({ totalTokens: 40 }) }),
        undefined,
      );
      const fresh = await loadCostUsageSummaryFromCache({ ...params, requestRefresh: false });
      expect(fresh.cacheStatus).toMatchObject({ status: "fresh" });
      expect(fresh.totals.totalTokens).toBe(50);
      const records = await observations();
      const refreshes = records.filter((record) => record.operation === "refresh");
      expect(refreshes).toHaveLength(2);
      expect(refreshes[1]).toMatchObject({
        threadId: refreshes[0]!.threadId,
        parsedRollups: 1,
      });
      expect(
        records.some((record) => record.operation === "summary" && record.parsedRollups === 4),
      ).toBe(true);
    });
  });
});

it("checks fresh metadata without hydrating bodies across inventory, pricing, targets, and worker closure", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const preload = state.path("observe-usage-decode.cjs");
    const observations = await observeUsageDecoding(preload, state.path("usage-decode.jsonl"));
    await withEnvAsync(sqliteWorkerPreloadEnv(preload), async () => {
      const config = getRuntimeConfig();
      const primary = "main";
      const secondary = "other";
      const primaryDir = state.sessionsDir(primary);
      const secondaryDir = state.sessionsDir(secondary);
      await fs.mkdir(primaryDir, { recursive: true });
      await fs.mkdir(secondaryDir, { recursive: true });
      const firstFile = path.join(primaryDir, "first.jsonl");
      const secondFile = path.join(primaryDir, "second.jsonl");
      await fs.writeFile(firstFile, usageLine("first"));
      await fs.writeFile(secondFile, usageLine("second"));
      await fs.writeFile(path.join(secondaryDir, "other.jsonl"), usageLine("other"));
      const summary = (agentId: string, pricing = config) =>
        loadCostUsageSummaryFromCache({
          agentId,
          config: pricing,
          startMs: Date.parse("2026-09-18T00:00:00Z"),
          endMs: Date.parse("2026-09-18T23:59:59Z"),
          requestRefresh: false,
        });
      const refresh = async (agentId: string, parsedRollups: number, pricing = config) => {
        const before = (await observations()).filter((record) => record.operation === "refresh");
        expect(await refreshCostUsageCacheForAgent({ agentId, config: pricing })).toBe("refreshed");
        const after = (await observations()).filter((record) => record.operation === "refresh");
        expect(after).toHaveLength(before.length + 1);
        const last = expectDefined(after.at(-1), "completed refresh observation");
        expect(last.parsedRollups).toBe(parsedRollups);
        return last;
      };
      await refresh(secondary, 0);
      await refresh(primary, 0);
      const seededWorkers = [...observedWorkers];
      await closeOpenClawAgentDatabasesAsync(state.root);
      expect(seededWorkers.every((worker) => worker.threadId === -1)).toBe(true);
      const cold = await refresh(primary, 0);
      expect((await refresh(primary, 0)).threadId).toBe(cold.threadId);

      // A cold worker and target changes need only metadata to recognize freshness.
      expect((await summary(secondary)).totals.totalTokens).toBe(10);
      expect((await refresh(primary, 0)).threadId).toBe(cold.threadId);
      expect((await refresh(secondary, 0)).threadId).toBe(cold.threadId);
      expect((await refresh(primary, 0)).threadId).toBe(cold.threadId);

      await fs.appendFile(firstFile, usageLine("first-appended"));
      await fs.appendFile(secondFile, usageLine("second-appended"));
      expect(await refreshCostUsageCacheForAgent({ agentId: primary, config, maxFiles: 1 })).toBe(
        "refreshed",
      );
      expect(
        (await observations()).findLast((record) => record.operation === "refresh")?.parsedRollups,
      ).toBe(1);
      expect((await summary(primary)).cacheStatus).toMatchObject({ cachedFiles: 2, staleFiles: 1 });
      await refresh(primary, 1);
      expect((await summary(primary)).totals.totalTokens).toBe(40);

      const rewrite = (value: (text: string) => string) => {
        const row = expectDefined(
          readSessionCostUsageRollupRows(primary).find((entry) => entry.key === firstFile),
          "first cache row",
        );
        const valueJson = value(row.valueJson);
        expect(
          runOpenClawAgentWriteTransaction(
            ({ db }) =>
              writeSessionCostUsageRollupInDatabase(db, {
                rollupId: row.key,
                previousValueJson: new TextEncoder().encode(row.valueJson),
                valueJson: new TextEncoder().encode(valueJson),
                blob: readSessionCostUsageRollupBodyInDatabase(db, row)?.blob ?? null,
                updatedAt: row.updatedAt,
              }),
            { agentId: primary },
            { operationLabel: "session-cost-usage.rollup.write" },
          ),
        ).toBe(true);
        return { ...row, valueJson };
      };
      const whitespace = rewrite((text) => `${text}\n`);
      await refresh(primary, 0);
      expect(readSessionCostUsageRollupRows(primary).find((row) => row.key === firstFile)).toEqual(
        whitespace,
      );
      const invalid = rewrite((text) => `${text.trimEnd().slice(0, -1)},"version":0}`);
      await refresh(primary, 0);
      expect(
        readSessionCostUsageRollupRows(primary).find((row) => row.key === firstFile)?.valueJson,
      ).not.toBe(invalid.valueJson);
      expect((await summary(primary)).totals.totalTokens).toBe(40);

      const newFile = path.join(primaryDir, "new.jsonl");
      await fs.writeFile(newFile, usageLine("new"));
      await refresh(primary, 0);
      expect((await summary(primary)).totals.totalTokens).toBe(50);
      await fs.rm(secondFile);
      await refresh(primary, 0);
      expect(
        readSessionCostUsageRollupRows(primary)
          .map((row) => row.key)
          .toSorted(),
      ).toEqual([firstFile, newFile].toSorted());
      expect((await summary(primary)).totals.totalTokens).toBe(30);

      const changedPricing: OpenClawConfig = {
        ...config,
        models: {
          providers: {
            synthetic: {
              baseUrl: "https://synthetic.invalid",
              models: [
                {
                  id: "synthetic",
                  name: "Synthetic model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 4096,
                  maxTokens: 1024,
                  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      };
      await refresh(primary, 0, changedPricing);
      await refresh(primary, 0, changedPricing);
      expect((await summary(primary, changedPricing)).totals.totalTokens).toBe(30);
      await refresh(primary, 0, config);
      expect((await summary(primary)).cacheStatus?.status).toBe("fresh");
    });
  });
});

it("checks incognito freshness without decoding report bodies or creating durable files", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const preload = state.path("observe-usage-decode.cjs");
    const observations = await observeUsageDecoding(preload, state.path("usage-decode.jsonl"));
    await withEnvAsync(sqliteWorkerPreloadEnv(preload), async () => {
      const agentId = "usage-incognito";
      const databasePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId });
      const sessionId = "incognito-checkpoint";
      const target = {
        agentId,
        sessionKey: `agent:${agentId}:dashboard:incognito-checkpoint`,
        storePath: databasePath,
        env: state.env,
      };
      await createSessionEntryWithTranscript(
        target,
        () => ({ ok: true, entry: { incognito: true as const, sessionId, updatedAt: 1 } }),
        { cwd: state.workspaceDir },
      );
      await appendSessionUsage({ ...target, sessionId }, state.workspaceDir);
      const sessionFile = formatSqliteSessionFileMarker({
        agentId,
        sessionId,
        storePath: databasePath,
      });
      const prepared = prepareUsageCostWorker({
        agentId,
        databasePath,
        storePath: databasePath,
        sessionFiles: [sessionFile],
      });
      for (const parsedRollups of [0, 0, 0]) {
        expect(
          await runUsageCostWorker(prepared, { kind: "refresh", sessionFiles: [sessionFile] }),
        ).toMatchObject({ kind: "refresh" });
        expect(
          (await observations()).findLast((record) => record.operation === "refresh")
            ?.parsedRollups,
        ).toBe(parsedRollups);
      }
      await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
