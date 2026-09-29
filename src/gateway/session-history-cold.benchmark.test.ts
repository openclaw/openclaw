import { performance } from "node:perf_hooks";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { withCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-active-projection.js";
import { readRestoredSessionTranscript } from "../config/sessions/session-cold-storage-read.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import { maintenanceConfig } from "../config/sessions/session-cold-storage.test-support.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import { identifiedClient } from "./server-methods/sessions-read-cache.test-support.js";
import type { RespondFn } from "./server-methods/types.js";
import { createSessionTranscriptReader } from "./session-transcript-read-kernel.js";
import {
  resolveTranscriptReadTarget,
  toTranscriptReadScope,
} from "./session-transcript-read-target.js";
import { readSessionMessagesMatchingIdAsync } from "./session-transcript-readers.js";

it.runIf(process.env.OPENCLAW_HISTORY_COLD_BENCH === "1")(
  "measures cold chat.history and repeated exact message lookup caller CPU",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cold-bench",
        sessionId: "cold-bench",
        storePath: database.path,
      };
      const rows = 5_000;
      await replaceSessionEntry(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        visibility: "shared",
      });
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        ...Array.from({ length: rows }, (_, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId: index ? `message-${index - 1}` : null,
          message: { role: "assistant", content: `Synthetic ${index} ${"x".repeat(1_024)}` },
        })),
      ]);
      await waitForSessionTranscriptProjection(scope);
      const context = await createHistoryReadContext();
      const client = identifiedClient("history-benchmark");
      const history = async (): Promise<unknown[]> => {
        let response: Parameters<RespondFn> | undefined;
        await chatHistoryHandlers["chat.history"]!({
          params: { sessionKey: scope.sessionKey, limit: 20 },
          context,
          client,
          req: { type: "req", id: "cold-bench", method: "chat.history" },
          isWebchatConnect: () => false,
          respond: (...args) => {
            response = args;
          },
        });
        expect(response?.[0]).toBe(true);
        const payload = asOptionalRecord(response?.[1]);
        if (!Array.isArray(payload?.messages)) {
          throw new Error("Expected history messages");
        }
        return payload.messages;
      };
      const golden = await history();
      await replaceSessionEntry(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        lastActivityAt: 1,
        lastInteractionAt: 1,
        visibility: "shared",
      });
      database.db.exec("UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1");
      expect(
        await runSessionColdStorageMaintenance({ config: maintenanceConfig(database.path) }),
      ).toMatchObject({ archivedTranscripts: 1 });
      expect(readSessionColdTranscript(database.db, scope.sessionId)).toBeDefined();
      const coldStart = performance.now();
      const coldCpu = process.threadCpuUsage();
      const restored = await history();
      const coldElapsed = process.threadCpuUsage(coldCpu);
      console.log(
        JSON.stringify({
          method: "chat.history",
          rows,
          cold: true,
          cpuMs: (coldElapsed.user + coldElapsed.system) / 1_000,
          wallMs: performance.now() - coldStart,
        }),
      );
      expect(restored).toEqual(golden);
      const lookup = () => readSessionMessagesMatchingIdAsync(scope, "message-4999");
      const expected = await lookup();
      expect(expected).toHaveLength(1);
      // The original acquisition composition, sharing the unchanged lookup kernel.
      const localReader = createSessionTranscriptReader({
        resolveTarget: resolveTranscriptReadTarget,
        readSnapshot: async (target, read, options) => {
          const bound = toTranscriptReadScope(target);
          return readRestoredSessionTranscript(
            bound,
            () => withCurrentProjectionSnapshot(bound, read, options),
            options,
          );
        },
      });
      for (const [mode, read] of [
        ["caller", () => localReader.readSessionMessagesMatchingIdAsync(scope, "message-4999")],
        ["worker", lookup],
      ] as const) {
        const samples = [];
        for (let round = 0; round < 7; round++) {
          const start = performance.now();
          const cpu = process.threadCpuUsage();
          for (let call = 0; call < 10; call++) {
            expect(await read()).toEqual(expected);
          }
          const elapsed = process.threadCpuUsage(cpu);
          if (round >= 2) {
            samples.push({
              cpuMs: (elapsed.user + elapsed.system) / 10_000,
              wallMs: (performance.now() - start) / 10,
            });
          }
        }
        console.log(
          JSON.stringify({
            method: "message-lookup",
            mode,
            rows,
            samples,
            medianCpuMs: samples.map((s) => s.cpuMs).toSorted((a, b) => a - b)[2],
            medianWallMs: samples.map((s) => s.wallMs).toSorted((a, b) => a - b)[2],
          }),
        );
      }
    });
  },
);
