import fs from "node:fs/promises";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import {
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
} from "../../infra/session-cost-usage.js";
import { sqliteWorkerPreloadEnv } from "../../infra/sqlite-worker-preload.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import { invokeUsage, writeUsage } from "./usage.test-support.js";

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
  expect(Array.from(observedWorkers, (worker) => worker.threadId)).toEqual(
    Array.from(observedWorkers, () => -1),
  );
  observedWorkers.clear();
});

type DecodeObservation = {
  operation: string;
  parsedRollups: number;
  parsedCheckpoints: number;
  parsedBucketBodies: number;
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
  let parsedCheckpoints = 0;
  let parsedBucketBodies = 0;
  parentPort.on("message", (message) => {
    if (message.responseId !== undefined) return;
    operation = message.input?.kind === "usage-cost" ? message.input.operation.kind : undefined;
    parsedRollups = parsedCheckpoints = parsedBucketBodies = 0;
  });
  const parse = JSON.parse;
  JSON.parse = function(text, ...args) {
    const value = Reflect.apply(parse, this, [text, ...args]);
    if (operation && value && typeof value === "object" && value.buckets && value.untimestamped) {
      parsedRollups++;
      if (Object.keys(value.buckets).length === 0) parsedCheckpoints++;
      else parsedBucketBodies++;
    }
    return value;
  };
  const post = parentPort.postMessage;
  parentPort.postMessage = function(message, ...args) {
    if (operation && (message.status === "ok" || message.status === "failed")) {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
        operation, parsedRollups, parsedCheckpoints, parsedBucketBodies, threadId,
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

it("refreshes registered usage.cost without decoding unchanged date partitions", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config = {};
    setRuntimeConfigSnapshot(config);
    const preload = state.path("observe-usage-decode.cjs");
    const observations = await observeUsageDecoding(preload, state.path("usage-decode.jsonl"));
    await withEnvAsync(sqliteWorkerPreloadEnv(preload), async () => {
      const timestamp = Date.parse("2026-09-18T12:00:00Z");
      const sessions = Array.from({ length: 4 }, (_, index) => ({
        agentId: "main",
        sessionKey: `agent:main:usage-checkpoint-${index}`,
        sessionId: `usage-checkpoint-${index}`,
      }));
      for (const session of sessions) {
        replaceSessionEntrySync(session, { sessionId: session.sessionId, updatedAt: timestamp });
        await writeUsage(session, state.workspaceDir, 10, timestamp, 1, 3);
      }
      const params = { config, agentId: "main", startMs: timestamp - 1, endMs: timestamp + 1 };
      expect((await loadCostUsageSummary(params)).totals.totalTokens).toBe(40);
      await writeUsage(sessions[0]!, state.workspaceDir, 10, timestamp, 1, 3);
      const work = new AsyncWorkScope();
      const respond = vi.fn();
      try {
        await work.track(() =>
          invokeUsage(
            "usage.cost",
            { agentId: "main", startDate: "2026-09-18", endDate: "2026-09-18" },
            config,
            { respond, handlers: coreGatewayHandlers, context: { getRuntimeConfig: () => config } },
          ),
        );
        await work.runWhenIdle(() => {});
      } finally {
        await work.drain();
      }
      expect(respond.mock.calls).toMatchObject([
        [true, { totals: { totalTokens: 40 } }, undefined],
      ]);
      const fresh = await loadCostUsageSummaryFromCache({ ...params, requestRefresh: false });
      expect(fresh).toMatchObject({
        cacheStatus: { status: "fresh" },
        totals: { totalTokens: 50 },
      });
      const records = await observations();
      const refreshes = records.filter((record) => record.operation === "refresh");
      expect(refreshes).toHaveLength(2);
      expect(refreshes[1]).toMatchObject({
        threadId: refreshes[0]!.threadId,
        parsedRollups: 2,
        parsedCheckpoints: 1,
        parsedBucketBodies: 1,
      });
      expect(records).toContainEqual(
        expect.objectContaining({
          operation: "summary",
          parsedRollups: 4,
          parsedCheckpoints: 4,
          parsedBucketBodies: 0,
        }),
      );
    });
  }));
