import fs from "node:fs/promises";
import type { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import {
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
} from "../../infra/session-cost-usage.js";
import { sqliteWorkerPreloadEnv } from "../../infra/sqlite-worker-preload.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
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
