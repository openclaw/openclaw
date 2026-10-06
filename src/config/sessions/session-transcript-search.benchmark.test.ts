import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import { searchSessionTranscripts } from "./session-transcript-search.js";

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1")(
  "measures scoped transcript search for 50 viewers over 5,000 session rows",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const rows = 5_000;
      const viewers = 50;
      const sessionKeys = Array.from({ length: rows }, (_, index) => `agent:main:bench-${index}`);
      runOpenClawAgentWriteTransaction(
        () => {
          for (const [index, sessionKey] of sessionKeys.entries()) {
            const sessionId = `bench-${index}`;
            replaceSessionEntrySync(
              { agentId: "main", sessionKey },
              { sessionId, updatedAt: index + 1, visibility: "shared" },
            );
            expect(
              appendTranscriptMessageSync(
                { agentId: "main", sessionKey, sessionId },
                {
                  eventId: `message-${index}`,
                  message: {
                    role: "assistant",
                    content: `Deployment needle context for session ${index}`,
                  },
                },
              ).ok,
            ).toBe(true);
          }
        },
        { agentId: "main" },
      );
      await reconcileSessionTranscriptIndexes({ agentId: "main" });
      await waitForSessionTranscriptIndexReconcile({ agentId: "main" });
      const request = async () =>
        await searchSessionTranscripts({
          agentId: "main",
          query: "needle",
          sessionKeys,
          limit: 10,
        });
      const golden = JSON.stringify(await request());
      expect(JSON.parse(golden).hits).toHaveLength(10);
      const samples: Array<{ cpuMs: number; wallMs: number }> = [];
      for (let round = 0; round < 7; round++) {
        const start = performance.now();
        const cpu = process.threadCpuUsage();
        const responses = await Promise.all(Array.from({ length: viewers }, request));
        const elapsed = process.threadCpuUsage(cpu);
        if (round >= 2) {
          samples.push({
            cpuMs: (elapsed.user + elapsed.system) / 1_000 / viewers,
            wallMs: (performance.now() - start) / viewers,
          });
        }
        expect(responses.every((response) => JSON.stringify(response) === golden)).toBe(true);
      }
      console.log(
        JSON.stringify({
          method: "searchSessionTranscripts",
          rows,
          viewers,
          samples,
          medianCpuMs: samples.map((sample) => sample.cpuMs).toSorted((a, b) => a - b)[2],
          medianWallMs: samples.map((sample) => sample.wallMs).toSorted((a, b) => a - b)[2],
        }),
      );
    });
  },
);
