import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import * as sessionLifecycle from "../../sessions/session-lifecycle-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
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

it.each(["known-source", "new-terminal", "new-receipt"] as const)(
  "refuses a conflicting or unprepared %s after admission waits",
  async (source) => {
    await withOpenClawTestState({ label: "chat-admission-retry-comparison" }, async () => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {} } },
      } satisfies OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);
      const sessionKey = "agent:main:dashboard:retry-comparison";
      const runId = "chat-admission-retry-comparison";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: "retry-comparison-session",
          updatedAt: 1,
          ...(source === "known-source" ? { restartRecoveryTerminalRunIds: [runId] } : {}),
        },
      );
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
      if (source === "new-terminal") {
        // The prepared request predates this receipt; its own reservation is not retry evidence.
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { ...session.entry!, restartRecoveryTerminalRunIds: [runId] },
        );
      }
      const comparison = vi.spyOn(sessionAccessor, "readSessionSubmittedInput");
      if (source === "known-source") {
        comparison.mockResolvedValueOnce({ role: "user", timestamp: 100, content: "Hello" });
      }
      comparison.mockResolvedValue({
        role: "user",
        timestamp: 100,
        content: "Hello",
        __openclaw: { humanMentions: [{ profileId: "bob", start: 0, end: 5 }] },
      });
      const begin = sessionLifecycle.beginSessionWorkAdmission;
      const publication =
        source === "new-receipt"
          ? vi
              .spyOn(sessionLifecycle, "beginSessionWorkAdmission")
              .mockImplementation(async (params) => {
                const lease = await begin(params);
                context.dedupe.delete(pendingChatSendDedupeKey(runId));
                context.dedupe.set(`chat:${runId}`, {
                  ts: 200,
                  ok: true,
                  payload: { runId, status: "ok" },
                });
                return lease;
              })
          : undefined;
      const respond = vi.fn();
      let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
      try {
        admitted = await admitChatSend({
          request: request.value,
          session,
          client: null,
          context,
          respond,
        });
        expect(admitted.ok).toBe(false);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining(
            source === "new-receipt"
              ? { code: "UNAVAILABLE", retryable: true }
              : {
                  code: "INVALID_REQUEST",
                  message: expect.stringContaining("already used for different input"),
                  ...(source === "known-source"
                    ? { details: { reason: "chat-request-conflict" } }
                    : {}),
                },
          ),
        );
        expect(context.chatAbortControllers.size).toBe(0);
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
        expect(context.dedupe.size).toBe(source === "new-receipt" ? 1 : 0);
        expect(
          sessionLifecycle.getSessionWorkAdmissionRelease({
            scope: session.storePath,
            identities: [sessionKey, session.entry?.sessionId],
          }),
        ).toBeUndefined();
      } finally {
        publication?.mockRestore();
        comparison.mockRestore();
        if (admitted?.ok) {
          admitted.value.cleanupAdmittedRun();
        }
        session.releaseSessionTarget();
        clearAgentRunContext(runId);
      }
    });
  },
);

it.each([
  "lifecycle rotation",
  "placement publication",
  "service replacement",
  "unavailable reader",
] as const)("refuses %s while preparing placement admission", async (change) => {
  await withOpenClawTestState({ label: "chat-placement-admission" }, async () => {
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {} } },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, cfg);
    const sessionKey = "agent:main:dashboard:placement-admission";
    const runId = "chat-placement-admission";
    const scope = { agentId: "main", sessionKey };
    const entry: SessionEntry = { sessionId: "placement-session", updatedAt: 1 };
    replaceSessionEntrySync(scope, entry);
    const request = normalizeChatSendRequest({
      client: null,
      params: { sessionKey, message: "Hello", idempotencyKey: runId },
    });
    if (!request.ok) {
      throw new Error(request.error);
    }
    const placements = createWorkerSessionPlacementStore();
    const getMany = vi.fn(() => new Map());
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      workerSessionPlacementService: change === "unavailable reader" ? { getMany } : placements,
    });
    const prepared = prepareChatSendSession({ request: request.value, client: null, context });
    if (!prepared.ok) {
      throw new Error("Session preparation failed");
    }
    const session = qualifyChatSendSession(prepared.value);
    const initialEntry = structuredClone(sessionAccessor.loadSessionEntry(scope));
    const observed = createDeferred();
    const resume = createDeferred();
    const preparePlacement = placements.prepareRuntimeRefresh.bind(placements);
    const delayed = vi
      .spyOn(placements, "prepareRuntimeRefresh")
      .mockImplementationOnce(async (sessionId) => {
        const facts = await preparePlacement(sessionId);
        observed.resolve();
        await resume.promise;
        return facts;
      });
    const respond = vi.fn();
    let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    const pending = admitChatSend({
      request: request.value,
      session,
      client: null,
      context,
      respond,
    }).then((result) => (admitted = result));
    try {
      if (change !== "unavailable reader") {
        await awaitGateBeforeSettlement(observed.promise, pending, "chat skipped placement facts");
        if (change === "lifecycle rotation") {
          rotateAgentEventLifecycleGeneration();
        } else if (change === "placement publication") {
          await placements.startDispatch({ ...scope, sessionId: entry.sessionId });
        } else {
          context.workerSessionPlacementService = createWorkerSessionPlacementStore();
        }
        resume.resolve();
      }
      expect((await pending).ok).toBe(false);
      expect(respond).toHaveBeenCalledOnce();
      expect(context.chatAbortControllers.size).toBe(0);
      expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
      expect(sessionAccessor.loadSessionEntry(scope)).toEqual(initialEntry);
      expect(
        sessionLifecycle.getSessionWorkAdmissionRelease({
          scope: session.storePath,
          identities: [sessionKey, entry.sessionId],
        }),
      ).toBeUndefined();
      if (change === "unavailable reader") {
        expect(respond.mock.calls[0]?.[2]?.message).toContain(
          "Worker placement admission reader is unavailable",
        );
        expect(getMany).not.toHaveBeenCalled();
      }
    } finally {
      resume.resolve();
      await Promise.allSettled([pending]);
      delayed.mockRestore();
      if (admitted?.ok) {
        admitted.value.cleanupAdmittedRun();
      }
      session.releaseSessionTarget();
      clearAgentRunContext(runId);
    }
  });
});
