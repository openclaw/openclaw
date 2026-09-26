import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { scheduleChatDashboardSessionTitle } from "./chat-send-background.js";

const generate = vi.hoisted(() =>
  vi.fn<
    typeof import("../../auto-reply/reply/conversation-label-generator.js").generateConversationLabelWithFallback
  >(),
);
vi.mock("../../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: generate,
}));

it.each([
  { titleSource: undefined, expectedSource: "Original release plan" },
  { titleSource: "Accepted worktree intent", expectedSource: "Accepted worktree intent" },
])(
  "prepares one detached title entry from $expectedSource",
  async ({ titleSource, expectedSource }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
      };
      await state.writeConfig(cfg);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:detached-title",
        sessionId: "detached-title-session",
        storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
      };
      await replaceSessionEntry(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        ...(titleSource ? { pendingWorktree: { titleSource } } : {}),
      });
      await appendTranscriptMessage(scope, {
        cwd: state.workspaceDir,
        message: { role: "user", content: "Original release plan", timestamp: 1 },
      });
      const started = createDeferredCore();
      const generation = createDeferredCore<string>();
      const failed = createDeferredCore<never>();
      generate.mockReset().mockImplementation(async () => {
        started.resolve();
        return await generation.promise;
      });
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      context.logGateway.warn = (message) => failed.reject(new Error(message));
      const reads = observeSqliteReadSql(StatementSync.prototype);
      let released: Promise<void> | undefined;
      try {
        scheduleChatDashboardSessionTitle({
          ...scope,
          admittedSessionId: scope.sessionId,
          cfg,
          context,
          request: { rawMessage: "A later follow-up", normalizedAttachments: [] },
        });
        await Promise.race([started.promise, failed.promise]);
        released = getSessionWorkAdmissionRelease({
          scope: scope.storePath,
          identities: [scope.sessionKey, scope.sessionId],
        });
        expect(released).toBeDefined();
        expect(
          reads.queries.filter((sql) => /\b(?:from|join)\s+"?session_nodes\b/u.test(sql)).length,
        ).toBeLessThanOrEqual(1);
        expect(generate).toHaveBeenCalledOnce();
        expect(generate.mock.calls[0]?.[0].userMessage).toBe(expectedSource);
      } finally {
        reads.restore();
        generation.resolve("Original release plan");
        await released;
      }
      expect(loadSessionEntry(scope)?.displayName).toBe("Original release plan");
    });
  },
);
