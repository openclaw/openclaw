import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";

describe("chat history registry projection", () => {
  it.each(["chat.history", "chat.startup"] as const)(
    "%s polls an unchanged cursor without hydrating retained subagent tasks",
    async (method) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async () => {
          const scope = {
            agentId: "main",
            sessionKey: "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001",
            sessionId: "registry-history",
          };
          await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
          await appendTranscriptMessage(scope, {
            message: { role: "user", content: [{ type: "text", text: "Hello" }] },
          });
          saveSubagentRegistryToSqlite(
            new Map([
              [
                "retained",
                {
                  runId: "retained",
                  childSessionKey: "agent:main:subagent:retained",
                  requesterSessionKey: scope.sessionKey,
                  requesterDisplayKey: "registry-history",
                  task: `retained-history-task:${"x".repeat(32_768)}`,
                  cleanup: "keep",
                  createdAt: 1,
                  execution: { status: "terminal", startedAt: 1, endedAt: 2 },
                  completion: { required: false },
                  delivery: { status: "not_required" },
                },
              ],
            ]),
          );
          const context = await createHistoryReadContext();
          const request = async (cursor?: unknown) => {
            let result: unknown;
            await expectDefined(
              chatHistoryHandlers[method],
              "history handler",
            )({
              params:
                method === "chat.startup" && !cursor
                  ? { shortId: "12345678", slugHint: "registry-history", agentId: "main" }
                  : { sessionKey: scope.sessionKey, ...(cursor ? { cursor } : {}) },
              context,
              req: { type: "req", id: "registry-history", method },
              client: null,
              isWebchatConnect: () => false,
              respond: (ok, payload, error) => {
                expect(error).toBeUndefined();
                expect(ok).toBe(true);
                result = payload;
              },
            });
            return expectDefined(asOptionalRecord(result), "history response");
          };
          const initial = await request();
          expect(initial.deltaCursor).toEqual(expect.any(String));
          if (method === "chat.startup") {
            expect(initial.resolution).toMatchObject({ ok: true, key: scope.sessionKey });
          }
          clearSubagentRunsReadCacheForTest();
          const parse = vi.spyOn(JSON, "parse");
          try {
            const delta = await request(initial.deltaCursor);
            expect(delta).toMatchObject({ kind: "delta", messages: [] });
            expect(
              parse.mock.calls.some(([value]) => value.includes("retained-history-task:")),
            ).toBe(false);
          } finally {
            parse.mockRestore();
            clearSubagentRunsReadCacheForTest();
          }
        },
      );
    },
  );
});
