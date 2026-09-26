import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { admitChatSend } from "./chat-send-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession, qualifyChatSendSession } from "./chat-send-session.js";

it("loads fresh admission metadata once after preparing the session", async () => {
  await withOpenClawTestState({ label: "chat-admission-read-count" }, async () => {
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {} } },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, cfg);
    const sessionKey = "agent:main:dashboard:admission-reads";
    const runId = "chat-admission-read-count";
    const scope = { agentId: "main", sessionKey };
    const entry: SessionEntry = {
      sessionId: "admission-session",
      updatedAt: 1,
      skillsSnapshot: { prompt: "saved prompt".repeat(4096), skills: [] },
    };
    replaceSessionEntrySync(scope, entry);
    const request = normalizeChatSendRequest({
      client: null,
      params: { sessionKey, message: "Hello", idempotencyKey: runId },
    });
    if (!request.ok) {
      throw new Error(request.error);
    }
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const prepared = prepareChatSendSession({ request: request.value, client: null, context });
    if (!prepared.ok) {
      throw new Error("Session preparation failed");
    }
    const session = qualifyChatSendSession(prepared.value);
    let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    try {
      // Admission must read current settings even though preparation retained the old entry.
      replaceSessionEntrySync(scope, { ...entry, permissionMode: "full", updatedAt: 2 });
      expect(session.entry?.permissionMode).toBeUndefined();
      const sql = observeSqliteReadSql(StatementSync.prototype);
      const respond = vi.fn();
      try {
        admitted = await admitChatSend({
          request: request.value,
          session,
          client: null,
          context,
          respond,
        });
        expect(respond).not.toHaveBeenCalled();
        expect(admitted.ok).toBe(true);
        if (!admitted.ok) {
          throw new Error("Session admission failed");
        }
        expect(admitted.value.admittedSessionSettings?.permissionMode).toBe("full");
        expect(admitted.value.admittedSessionId).toBe(entry.sessionId);
        // Physical-source/absent-key guards may query keys without decoding entry metadata.
        const metadataReads = sql.queries.filter(
          (query) => /\bsession_nodes\b/u.test(query) && /\bentry_json\b/u.test(query),
        );
        expect(metadataReads.length, metadataReads.join("\n")).toBeLessThanOrEqual(1);
      } finally {
        sql.restore();
      }
    } finally {
      if (admitted?.ok) {
        admitted.value.cleanupAdmittedRun();
      }
      session.releaseSessionTarget();
      clearAgentRunContext(runId);
    }
  });
});
