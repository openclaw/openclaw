import { describe, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeSqliteReadSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptEvent,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { prepareAgentSession } from "../server-methods/agent-session-prepare.js";
import { prepareAgentRequestRouting } from "./agent-request-routing.js";

describe("agent session preparation worker boundary", () => {
  it("prepares ordinary and failed turns and rejects archived sessions without host row reads", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {};
      await state.writeConfig(cfg);
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      for (const kind of ["ordinary", "failed-present", "failed-missing", "archived"] as const) {
        const sessionKey = `agent:main:preparation-${kind}`;
        const scope = { agentId: "main", sessionKey, sessionId: kind };
        await upsertSessionEntryCore(scope, {
          sessionId: kind,
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
          ...(kind.startsWith("failed") ? { status: "failed" as const } : {}),
          ...(kind === "archived" ? { archivedAt: Date.now() } : {}),
        });
        if (kind === "failed-present") {
          await appendTranscriptEvent(scope, { type: "session", id: kind, version: 3 });
        }
        const respond = vi.fn();
        const reserveDedupe = vi.fn();
        const bindDedupeSessionTarget = vi.fn();
        const request = { sessionKey, message: "continue", idempotencyKey: kind };
        const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
        try {
          const routing = await prepareAgentRequestRouting({
            cfg,
            request,
            isRawModelRun: false,
            runId: kind,
            agentDedupeKeys: [kind],
            context,
            respond,
            reserveDedupe,
            bindDedupeSessionTarget,
            clearDedupe: vi.fn(),
            ...(kind === "ordinary"
              ? {
                  execApprovalFollowupApprovalId: "followup",
                  request: { ...request, execApprovalFollowupExpectedSessionId: kind },
                }
              : {}),
          });
          if (kind === "archived") {
            expect(routing).toBeUndefined();
            expect(respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({ code: "INVALID_REQUEST" }),
            );
          } else {
            expect(routing?.preAttachmentSession).toEqual({
              canonicalKey: sessionKey,
              sessionId: kind,
            });
            expect(bindDedupeSessionTarget).toHaveBeenCalledWith({
              sessionKey,
              agentId: "main",
              sessionId: kind,
            });
            const prepared = await prepareAgentSession({
              cfg,
              requestedSessionKey: sessionKey,
              request,
              canUseCronRunContinuation: false,
              lifecycleGeneration: "preparation",
              preAttachmentSession: routing?.preAttachmentSession,
              respond,
            });
            expect(prepared).toBeDefined();
            expect(prepared?.sessionId === kind).toBe(kind !== "failed-missing");
            expect(respond).not.toHaveBeenCalled();
          }
          expect(observation.queries.filter(isSessionEntryDataSql)).toEqual([]);
        } finally {
          observation.restore();
        }
      }
    });
  });
});
