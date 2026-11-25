import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
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

type DecodeObservation = {
  operation: string;
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
  let parsedCheckpoints = 0;
  let parsedBucketBodies = 0;
  parentPort.on("message", (message) => {
    if (message.responseId !== undefined) return;
    operation = message.input?.kind === "usage-cost" ? message.input.operation.kind : undefined;
    parsedCheckpoints = parsedBucketBodies = 0;
  });
  const parse = JSON.parse;
  JSON.parse = function(text, ...args) {
    const value = Reflect.apply(parse, this, [text, ...args]);
    if (operation && value && typeof value === "object" && value.buckets && value.untimestamped) {
      if (Object.keys(value.buckets).length === 0) parsedCheckpoints++;
      else parsedBucketBodies++;
    }
    return value;
  };
  const post = parentPort.postMessage;
  parentPort.postMessage = function(message, ...args) {
    if (operation && (message.status === "ok" || message.status === "failed")) {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
        operation, parsedCheckpoints, parsedBucketBodies, threadId,
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
      // The report refreshes the appended session before it answers.
      expect(respond.mock.calls).toMatchObject([
        [true, { totals: { totalTokens: 50 } }, undefined],
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
        parsedCheckpoints: 1,
        parsedBucketBodies: 1,
      });
      expect(records).toContainEqual(
        expect.objectContaining({
          operation: "summary",
          parsedCheckpoints: 4,
          parsedBucketBodies: 0,
        }),
      );
    });
  }));

it.each([
  {
    timeZone: "America/St_Johns",
    prior: "2007-11-03",
    repeated: "2007-11-04",
    instants: ["2007-11-04T02:30:30Z", "2007-11-04T02:31:30Z", "2007-11-04T03:30:30Z"],
  },
  {
    timeZone: "Antarctica/Casey",
    prior: "2010-03-04",
    repeated: "2010-03-05",
    instants: ["2010-03-04T14:30:00Z", "2010-03-04T15:30:00Z", "2010-03-04T16:30:00Z"],
  },
])(
  "counts each event on its civil date across repeated midnight in $timeZone",
  ({ timeZone, prior, repeated, instants }) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = {};
      setRuntimeConfigSnapshot(config);
      const session = { agentId: "main", sessionKey: "agent:main:midnight", sessionId: "midnight" };
      const timestamps = instants.map((time) => Date.parse(time));
      replaceSessionEntrySync(session, { sessionId: session.sessionId, updatedAt: timestamps[2]! });
      // The first and last events belong to the repeated day. The middle event belongs to the previous day.
      for (const [index, timestamp] of timestamps.entries()) {
        await writeUsage(session, state.workspaceDir, 2 ** index, timestamp);
      }
      await loadCostUsageSummary({
        config,
        agentId: session.agentId,
        startMs: timestamps[0]!,
        endMs: timestamps[2]!,
      });
      const before = { date: prior, totalTokens: 2 };
      const after = { date: repeated, totalTokens: 5 };
      for (const [startDate, endDate, totalTokens, daily] of [
        [repeated, repeated, 5, [after]],
        [prior, prior, 2, [before]],
        [prior, repeated, 7, [before, after]],
      ] as const) {
        const respond = await invokeUsage(
          "usage.cost",
          { startDate, endDate, agentId: session.agentId, mode: "specific", timeZone },
          config,
          { handlers: coreGatewayHandlers, context: { getRuntimeConfig: () => config } },
        );
        expect(respond.mock.calls).toMatchObject([
          [true, { totals: { totalTokens }, daily, cacheStatus: { status: "fresh" } }, undefined],
        ]);
      }
    }),
);
