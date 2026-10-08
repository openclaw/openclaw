import { existsSync } from "node:fs";
import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { seedCanonicalAcpSessionMeta } from "../../acp/runtime/session-meta-fixture.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { retainGatewayPluginMetadata } from "../../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshotAsync } from "../../plugins/plugin-metadata-snapshot.js";
import * as sessionLifecycle from "../../sessions/session-lifecycle-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { admitChatSend } from "./chat-send-admission.js";
import { runChatSendPreAdmission } from "./chat-send-pre-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession, qualifyChatSendSession } from "./chat-send-session.js";

async function withServingMetadata(cfg: OpenClawConfig, run: () => Promise<void>) {
  const scheduler = createTestGatewayScheduler();
  const metadataOwner = retainGatewayPluginMetadata(scheduler);
  let profiles: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
  try {
    // Gateway bootstrap publishes metadata; session projection retains profile facts.
    // Neither startup owner may admit the request's agent database.
    const metadata = await metadataOwner.runBootstrap(() =>
      resolvePluginMetadataSnapshotAsync({ config: cfg, allowCurrent: false }),
    );
    metadataOwner.publish(metadata);
    setGatewayPluginMetadataSnapshot(metadata, { config: cfg });
    profiles = await prepareUserProfileCatalog();
    await run();
  } finally {
    profiles?.release();
    await metadataOwner.beginClose();
    await scheduler.stop();
    expect((await metadataOwner.close()).failures).toEqual([]);
  }
}

it.each(["absent", "admitted"] as const)(
  "prepares and authorizes a first chat turn without caller-thread SQL with an %s agent store",
  async (store) => {
    await withOpenClawTestState({ label: `chat-first-turn-${store}` }, async () => {
      const cfg = {
        ...rolePolicyConfig(),
        agents: { ownership: "explicit", entries: { main: {} } },
      } satisfies OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);
      const client = roleClient("write", `first-turn-${store}`);
      if (store === "admitted") {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: "agent:main:existing" },
          { sessionId: "existing-session", updatedAt: 1 },
        );
      }
      const request = await normalizeChatSendRequest({
        client,
        params: {
          sessionKey: "agent:main:first-turn",
          message: "Start a new conversation.",
          idempotencyKey: "first-turn",
        },
      });
      if (!request.ok) {
        throw new Error(request.error);
      }
      await withServingMetadata(cfg, async () => {
        expect(existsSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }))).toBe(
          store === "admitted",
        );
        const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
        const sql = observeHostDataSql();
        try {
          const authorized = await resolveSessionMutationAuthorizationAsync({
            client,
            method: "chat.send",
            requestParams: request.value.p,
            context,
          });
          expect(authorized.error).toBeNull();
          const prepared = await prepareChatSendSession({
            request: request.value,
            client,
            context,
          });
          expect(prepared).toMatchObject({ ok: true, value: { entry: undefined } });
          if (!prepared.ok || !authorized.authorization) {
            throw new Error("First-turn preparation failed");
          }
          const respond = vi.fn();
          expect(
            await runChatSendPreAdmission({
              request: request.value,
              session: prepared.value,
              client,
              context,
              respond,
              assertCurrent: authorized.authorization.assertCurrent,
              withCurrent: authorized.authorization.withCurrent,
            }),
          ).toBe(true);
          expect(respond).not.toHaveBeenCalled();
          expect(sql.queries, sql.queries.join("\n")).toEqual([]);
        } finally {
          sql.restore();
        }
      });
    });
  },
);

it.each([
  {
    name: "canonical free ACP",
    sessionKey: "agent:external-harness:acp:canonical",
    withMetadata: true,
  },
  {
    name: "unconfirmed free ACP",
    sessionKey: "agent:external-harness:acp:unconfirmed",
    withMetadata: false,
  },
  {
    name: "deleted ordinary owner",
    sessionKey: "agent:external-harness:dashboard:deleted",
    withMetadata: false,
  },
])("prepares $name without caller-thread SQL", async ({ name, sessionKey, withMetadata }) => {
  await withOpenClawTestState({ label: "chat-unconfigured-owner" }, async () => {
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {} } },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, cfg);
    const agentId = "external-harness";
    const entry: SessionEntry = {
      sessionId: "unconfigured-owner-session",
      lifecycleRevision: "unconfigured-owner-lifecycle",
      updatedAt: 1,
    };
    replaceSessionEntrySync({ agentId, sessionKey }, entry);
    if (withMetadata) {
      seedCanonicalAcpSessionMeta({
        agentId,
        sessionKey,
        lifecycleRevision: entry.lifecycleRevision,
        meta: {
          backend: "acpx",
          agent: agentId,
          runtimeSessionName: sessionKey,
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        },
      });
    }
    const request = await normalizeChatSendRequest({
      client: null,
      params: { sessionKey, message: "Continue this session.", idempotencyKey: name },
    });
    if (!request.ok) {
      throw new Error(request.error);
    }
    await withServingMetadata(cfg, async () => {
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const sql = observeHostDataSql();
      try {
        const prepared = await prepareChatSendSession({
          request: request.value,
          client: null,
          context,
        });
        expect(prepared).toMatchObject(
          withMetadata
            ? { ok: true, value: { agentId, sessionKey, entry } }
            : {
                ok: false,
                error: 'Agent "external-harness" no longer exists in configuration',
              },
        );
        expect(sql.queries, sql.queries.join("\n")).toHaveLength(0);
      } finally {
        sql.restore();
      }
    });
  });
});

it("uses fresh worker-prepared admission settings without host metadata reads", async () => {
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
    const request = await normalizeChatSendRequest({
      client: null,
      params: { sessionKey, message: "Hello", idempotencyKey: runId },
    });
    if (!request.ok) {
      throw new Error(request.error);
    }
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const prepared = await prepareChatSendSession({
      request: request.value,
      client: null,
      context,
    });
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
        expect(metadataReads, metadataReads.join("\n")).toHaveLength(0);
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

it("releases rejected upload reservations so corrected input can reuse its key", async () => {
  await withOpenClawTestState({ label: "chat-upload-reservation" }, async () => {
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {} } },
      gateway: { uploads: { enabled: false } },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, cfg);
    const sessionKey = "agent:main:dashboard:upload-retry";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey },
      { sessionId: "upload-session", updatedAt: 1 },
    );
    for (const failure of ["denied", "throws"] as const) {
      const runId = `upload-retry-${failure}`;
      const policyError = new Error("fixture upload policy unavailable");
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      context.getCommittedRuntimeConfig = () => {
        if (failure === "throws") {
          throw policyError;
        }
        return cfg;
      };
      const blocked = await normalizeChatSendRequest({
        client: null,
        params: {
          sessionKey,
          message: "Hello",
          idempotencyKey: runId,
          attachments: [
            { type: "file", mimeType: "text/plain", fileName: "blocked.txt", content: "aGVsbG8=" },
          ],
        },
      });
      if (!blocked.ok) {
        throw new Error("fixture attachment normalization failed");
      }
      const prepared = await prepareChatSendSession({
        request: blocked.value,
        client: null,
        context,
      });
      if (!prepared.ok) {
        throw new Error("fixture session preparation failed");
      }
      const session = qualifyChatSendSession(prepared.value);
      try {
        const admission = admitChatSend({
          request: blocked.value,
          session,
          client: null,
          context,
          respond: vi.fn(),
        });
        if (failure === "throws") {
          await expect(admission).rejects.toBe(policyError);
        } else {
          await expect(admission).resolves.toMatchObject({ ok: false });
        }
        expect(context.dedupe.has(session.pendingChatSendKey)).toBe(false);
        expect(context.chatAbortControllers.size).toBe(0);
      } finally {
        session.releaseSessionTarget();
      }
      const corrected = await normalizeChatSendRequest({
        client: null,
        params: { sessionKey, message: "Hello", idempotencyKey: runId },
      });
      if (!corrected.ok) {
        throw new Error("fixture corrected normalization failed");
      }
      const next = await prepareChatSendSession({
        request: corrected.value,
        client: null,
        context,
      });
      if (!next.ok) {
        throw new Error("fixture retry preparation failed");
      }
      const retrySession = qualifyChatSendSession(next.value);
      let retried: Awaited<ReturnType<typeof admitChatSend>> | undefined;
      try {
        retried = await admitChatSend({
          request: corrected.value,
          session: retrySession,
          client: null,
          context,
          respond: vi.fn(),
        });
        expect(retried.ok).toBe(true);
      } finally {
        if (retried?.ok) {
          retried.value.cleanupAdmittedRun();
        }
        retrySession.releaseSessionTarget();
        clearAgentRunContext(runId);
      }
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
      const request = await normalizeChatSendRequest({
        client: null,
        params: { sessionKey, message: "Hello", idempotencyKey: runId },
      });
      if (!request.ok) {
        throw new Error(request.error);
      }
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const prepared = await prepareChatSendSession({
        request: request.value,
        client: null,
        context,
      });
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
  "caller revocation",
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
    const request = await normalizeChatSendRequest({
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
    const prepared = await prepareChatSendSession({
      request: request.value,
      client: null,
      context,
    });
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
    let callerCurrent = true;
    let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    const pending = admitChatSend({
      request: request.value,
      session,
      client: null,
      context,
      respond,
      assertCurrent: () => {
        if (!callerCurrent) {
          throw new Error("Original chat caller revoked during placement preparation");
        }
      },
    }).then((result) => (admitted = result));
    try {
      if (change !== "unavailable reader") {
        await awaitGateBeforeSettlement(observed.promise, pending, "chat skipped placement facts");
        if (change === "caller revocation") {
          callerCurrent = false;
        } else if (change === "lifecycle rotation") {
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
      } else if (change === "caller revocation") {
        expect(respond.mock.calls[0]?.[2]?.message).toContain(
          "Original chat caller revoked during placement preparation",
        );
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
