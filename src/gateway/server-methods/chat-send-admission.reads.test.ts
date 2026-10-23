import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { seedCanonicalAcpSessionMeta } from "../../acp/runtime/session-meta-fixture.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { retainGatewayPluginMetadata } from "../../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshotAsync } from "../../plugins/plugin-metadata-snapshot.js";
import * as sessionControllerLifecycle from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSource,
  getRpcSourceIdentity,
} from "../../sessions/session-controller.rpc-sources.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import {
  roleClient,
  rolePolicyConfig,
  sharingPolicyClient,
} from "../session-sharing.test-utils.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "../worker-environments/placement-test-fixtures.js";
import { stagePlacementTurnClaimWorkerPublication } from "../worker-environments/placement-turn-authority.js";
import { admitChatSend } from "./chat-send-admission.js";
import { prepareChatAdmission } from "./chat-send-admission.test-support.js";
import { startChatSendDiagnostics } from "./chat-send-diagnostics.js";
import { runChatSendPreAdmission } from "./chat-send-pre-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession } from "./chat-send-session.js";

type Admission = Awaited<ReturnType<typeof admitChatSend>>;
type Session = Awaited<ReturnType<typeof prepareChatAdmission>>["session"];
function admissionFixture(cfg: OpenClawConfig, runId: string) {
  const scope = { agentId: "main", sessionKey: `agent:main:dashboard:${runId}` };
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  return {
    cfg,
    scope,
    context,
    runId,
    seed(overrides: Partial<SessionEntry> = {}) {
      const entry = { sessionId: `${runId}-session`, updatedAt: 1, ...overrides };
      replaceSessionEntrySync(scope, entry);
      return entry;
    },
    prepare({ params, ...options }: Partial<Parameters<typeof prepareChatAdmission>[0]> = {}) {
      return prepareChatAdmission({
        context,
        client: null,
        ...options,
        params: {
          sessionKey: scope.sessionKey,
          message: "Hello",
          idempotencyKey: runId,
          ...params,
        },
      });
    },
  };
}
function cleanupAdmission(admitted: Admission | undefined, runId: string) {
  if (admitted?.ok) {
    admitted.value.cleanupAdmittedRun();
  }
  clearAgentRunContext(runId);
}
function lifecycleRelease(session: Session) {
  return sessionControllerLifecycle.captureSessionControllerSettlement({
    scope: session.storePath,
    identities: [session.sessionKey, session.entry?.sessionId],
  });
}
async function withoutHostSql(run: () => Promise<void>) {
  const sql = observeHostDataSql();
  try {
    await run();
    expect(sql.queries, sql.queries.join("\n")).toEqual([]);
  } finally {
    sql.restore();
  }
}
async function pendingWorkspaceResult(
  placements: Parameters<typeof advancePlacementFixtureToActive>[0],
  database: Parameters<typeof advancePlacementFixtureToActive>[1],
  scope: Parameters<typeof advancePlacementFixtureToActive>[2],
) {
  const active = await advancePlacementFixtureToActive(placements, database, scope);
  const claim = await placements.claimTurn({
    ...scope,
    claimId: "prior-worker-claim",
    runId: "prior-worker-run",
    owner: {
      kind: "worker",
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    },
  });
  await placements.markWorkspaceResultPending(claim);
  await placements.acceptWorkspaceResult(claim);
  return claim;
}
function pausePlacement(placements: ReturnType<typeof createWorkerSessionPlacementStore>) {
  const observed = createDeferred();
  const resume = createDeferred();
  const prepare = placements.prepareSessionPlacement.bind(placements);
  const spy = vi.spyOn(placements, "prepareSessionPlacement").mockImplementationOnce(async (id) => {
    const facts = await prepare(id);
    observed.resolve();
    await resume.promise;
    return facts;
  });
  return { observed, resume, [Symbol.dispose]: () => spy.mockRestore() };
}

async function withAdmissionTest(
  label: string,
  run: (fixture: ReturnType<typeof admissionFixture>) => Promise<void>,
  overrides: OpenClawConfig = {},
) {
  await withOpenClawTestState({ label }, async () => {
    await loadOrCreateProcessDeviceIdentityAsync();
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      ...overrides,
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    await run(admissionFixture(cfg, label));
  });
}

async function appendHeader(
  scope: { agentId: string; sessionKey: string },
  entry: SessionEntry,
  timestamp: number,
) {
  await sessionAccessor.appendTranscriptEvent(
    { ...scope, sessionId: entry.sessionId },
    {
      type: "session",
      version: 3,
      id: entry.sessionId,
      timestamp: new Date(timestamp).toISOString(),
      cwd: "/synthetic/workspace",
    },
  );
}

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
  (store) =>
    withAdmissionTest(
      `chat-first-turn-${store}`,
      async ({ cfg, context }) => {
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
        assert(request.ok, "Request normalization failed");
        await withServingMetadata(cfg, async () => {
          expect(existsSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }))).toBe(
            store === "admitted",
          );
          await withoutHostSql(async () => {
            const authorized = await resolveSessionMutationAuthorizationAsync({
              client,
              method: "chat.send",
              requestParams: request.value.p,
              context,
            });
            using _ = {
              [Symbol.dispose]: () => authorized.authorization?.release?.(),
            };
            expect(authorized.error).toBeNull();
            const prepared = await prepareChatSendSession({
              request: request.value,
              client,
              context,
            });
            expect(prepared).toMatchObject({ ok: true, value: { entry: undefined } });
            assert(prepared.ok && authorized.authorization, "First-turn preparation failed");
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
          });
          assertNoRetainedSessionSharingReads();
        });
      },
      rolePolicyConfig(),
    ),
);

it.each(["unchanged", "caller revoked", "session replaced"] as const)(
  "joins native worker result completion before chat admission (%s)",
  (change) =>
    withAdmissionTest("chat-placement-settlement", async (f) => {
      const { scope, runId, context } = f;
      const entry = f.seed();
      const database = openOpenClawStateDatabase();
      const placements = createWorkerSessionPlacementStore({ database });
      const claim = await pendingWorkspaceResult(placements, database, {
        ...scope,
        sessionId: entry.sessionId,
      });
      context.workerSessionPlacementService = placements;
      const admission = await f.prepare({
        isDirectExternalUser: true,
        params: { message: "Continue" },
      });
      let clock = 0;
      using _ = vi.spyOn(performance, "now").mockImplementation(() => clock);
      const log = { info: vi.fn() };
      using diagnostics = startChatSendDiagnostics(log);
      const queued = createDeferred();
      const begin = createDeferred();
      const beginAdmission = sessionControllerLifecycle.beginSessionEffect;
      using delayedAdmission = vi.spyOn(sessionControllerLifecycle, "beginSessionEffect");
      delayedAdmission.mockImplementationOnce(async (params) => {
        queued.resolve();
        await begin.promise;
        return beginAdmission(params);
      });
      using placement = pausePlacement(placements);
      const committed = createDeferred();
      const consuming = createDeferred();
      const releaseReply = createDeferred();
      const observeCommit = operationAdmission.observeSqliteWorkerCommittedFacts;
      let publishCommit: (() => void) | undefined;
      using delayedPublication = vi.spyOn(operationAdmission, "observeSqliteWorkerCommittedFacts");
      delayedPublication.mockImplementation((operation, observer) => {
        observeCommit(operation, (receipt) => {
          if (
            isRecord(receipt.facts) &&
            isRecord(receipt.facts.placement) &&
            receipt.facts.placement.sessionId === entry.sessionId &&
            receipt.facts.placement.turnClaim === null
          ) {
            publishCommit = () => observer(receipt);
            committed.resolve();
          } else {
            observer(receipt);
          }
        });
      });
      const receiveReply = brokerReply.receiveSqliteWorkerReply;
      using delayedReply = vi.spyOn(brokerReply, "receiveSqliteWorkerReply");
      delayedReply.mockImplementation((slot, reply, owner) => {
        if (
          slot.current?.request.type === "execute" &&
          reply.ok &&
          !reply.transfer &&
          !reply.input
        ) {
          const receipt: unknown = deserialize(reply.value);
          if (
            isRecord(receipt) &&
            isRecord(receipt.placement) &&
            receipt.placement.sessionId === entry.sessionId
          ) {
            void releaseReply.promise.then(() => receiveReply(slot, reply, owner));
            return;
          }
        }
        receiveReply(slot, reply, owner);
      });
      const respond = vi.fn();
      let callerCurrent = true;
      let nativePending = false;
      let completion: Promise<unknown> | undefined;
      const pending = admitChatSend({
        ...admission,
        respond,
        assertCurrent() {
          if (!callerCurrent) {
            throw new Error("Original chat caller revoked during worker settlement");
          }
          if (nativePending) {
            consuming.resolve();
          }
        },
        diagnostics,
      });
      let admitted: Awaited<typeof pending> | undefined;
      try {
        await awaitGateBeforeSettlement(
          queued.promise,
          pending,
          "chat skipped lifecycle admission",
        );
        clock = 300;
        begin.resolve();
        await awaitGateBeforeSettlement(
          placement.observed.promise,
          pending,
          "chat skipped placement acquisition",
        );
        completion = placements.completeWorkspaceResultAndReleaseTurn(claim);
        await awaitGateBeforeSettlement(
          committed.promise,
          completion,
          "worker completion skipped its native commit",
        );
        clock = 600;
        nativePending = true;
        placement.resume.resolve();
        await awaitGateBeforeSettlement(
          consuming.promise,
          pending,
          "chat skipped writer-ordered validation",
        );
        if (change === "caller revoked") {
          callerCurrent = false;
        } else if (change === "session replaced") {
          replaceSessionEntrySync(scope, { sessionId: "replacement-session", updatedAt: 2 });
        }
        clock = 900;
        nativePending = false;
        publishCommit?.();
        releaseReply.resolve();
        admitted = await pending;
        clock = 1_900;
        diagnostics.finish();
        // Later reporting cannot extend either a completed or rejected owner's span.
        expect(log.info).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("detail.admission.revalidate=600ms detail.admission.work=900ms"),
        );
        expect(admitted.ok, JSON.stringify(respond.mock.calls[0]?.[2])).toBe(
          change === "unchanged",
        );
        if (change === "unchanged") {
          expect(getRpcSourceIdentity(getRpcSource(runId)!)).toMatchObject({
            sessionId: entry.sessionId,
          });
          expect(respond).not.toHaveBeenCalled();
        } else {
          expect(getRpcSource(runId)).toBeUndefined();
          expect(respond.mock.calls[0]?.[2]?.message).toContain(
            change === "caller revoked"
              ? "Original chat caller revoked"
              : "changed while starting work",
          );
        }
      } finally {
        begin.resolve();
        placement.resume.resolve();
        publishCommit?.();
        releaseReply.resolve();
        await Promise.allSettled([pending, ...(completion ? [completion] : [])]);
        cleanupAdmission(admitted, runId);
      }
    }),
);

it.each([
  ["canonical free ACP", "acp:canonical", true],
  ["unconfirmed free ACP", "acp:unconfirmed", false],
  ["deleted ordinary owner", "dashboard:deleted", false],
] as const)("prepares %s without caller-thread SQL", (name, suffix, withMetadata) =>
  withAdmissionTest("chat-unconfigured-owner", async ({ cfg, context }) => {
    const agentId = "external-harness";
    const sessionKey = `agent:${agentId}:${suffix}`;
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
    assert(request.ok, "Request normalization failed");
    await withServingMetadata(cfg, async () => {
      await withoutHostSql(async () => {
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
      });
    });
  }),
);

it.each(["ordinary", "fresh header", "stale header"] as const)(
  "uses current worker-prepared admission settings and freshness without host SQL (%s)",
  (freshness) =>
    withAdmissionTest(
      "chat-admission-read-count",
      async (f) => {
        const { scope, runId } = f;
        const restartSafe = freshness !== "ordinary";
        const now = Date.now();
        const entry = f.seed({
          updatedAt: now,
          skillsSnapshot: { prompt: "saved prompt".repeat(4096), skills: [] },
        });
        if (restartSafe) {
          await appendHeader(
            scope,
            entry,
            now - (freshness === "stale header" ? 2 * 24 * 60 * 60 * 1000 : 0),
          );
        }
        const admission = await f.prepare({ isDirectExternalUser: restartSafe });
        const { session } = admission;
        let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
        try {
          // Admission must read current settings even though preparation retained the old entry.
          replaceSessionEntrySync(scope, { ...entry, permissionMode: "full", updatedAt: now + 1 });
          expect([
            session.entry?.permissionMode,
            session.entry?.sessionStartedAt,
            session.entry?.createdAt,
          ]).toEqual([undefined, undefined, undefined]);
          const respond = vi.fn();
          await withoutHostSql(async () => {
            admitted = await admitChatSend({
              ...admission,
              respond,
            });
            expect(respond).not.toHaveBeenCalled();
            expect(admitted.ok).toBe(true);
            assert(admitted.ok, "Session admission failed");
            expect(admitted.value).toMatchObject({
              admittedSessionSettings: { permissionMode: "full" },
              admittedSessionId: entry.sessionId,
            });
            expect(Boolean(admitted.value.restartSafeAdmission)).toBe(freshness === "fresh header");
          });
        } finally {
          cleanupAdmission(admitted, runId);
        }
      },
      { session: { reset: { mode: "daily" } } },
    ),
);

it("releases rejected upload reservations so corrected input can reuse its key", () =>
  withAdmissionTest(
    "chat-upload-reservation",
    async (f) => {
      const { cfg } = f;
      f.seed();
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
        const blocked = await f.prepare({
          context,
          params: {
            idempotencyKey: runId,
            attachments: [
              {
                type: "file",
                mimeType: "text/plain",
                fileName: "blocked.txt",
                content: "aGVsbG8=",
              },
            ],
          },
        });
        const admission = admitChatSend({
          ...blocked,
          respond: vi.fn(),
        });
        if (failure === "throws") {
          await expect(admission).rejects.toBe(policyError);
        } else {
          await expect(admission).resolves.toMatchObject({ ok: false });
        }
        expect(context.dedupe.has(blocked.session.pendingChatSendKey)).toBe(false);
        expect(getRpcSource(runId)).toBeUndefined();
        const corrected = await f.prepare({
          context,
          params: { idempotencyKey: runId },
        });
        let retried: Awaited<ReturnType<typeof admitChatSend>> | undefined;
        try {
          retried = await admitChatSend({
            ...corrected,
            respond: vi.fn(),
          });
          expect(retried.ok).toBe(true);
        } finally {
          cleanupAdmission(retried, runId);
        }
      }
    },
    { gateway: { uploads: { enabled: false } } },
  ));
it.each(["known-source", "new-terminal", "new-receipt"] as const)(
  "refuses a conflicting or unprepared %s after admission waits",
  (source) =>
    withAdmissionTest("chat-admission-retry-comparison", async (f) => {
      const { scope, runId, context } = f;
      f.seed(source === "known-source" ? { restartRecoveryTerminalRunIds: [runId] } : {});
      const admission = await f.prepare();
      const { session } = admission;
      if (source === "new-terminal") {
        // The prepared request predates this receipt; its own reservation is not retry evidence.
        replaceSessionEntrySync(scope, {
          ...session.entry!,
          restartRecoveryTerminalRunIds: [runId],
        });
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
      const begin = sessionControllerLifecycle.beginSessionEffect;
      const publication =
        source === "new-receipt"
          ? vi
              .spyOn(sessionControllerLifecycle, "beginSessionEffect")
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
          ...admission,
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
        expect(getRpcSource(runId)).toBeUndefined();
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
        expect(context.dedupe.size).toBe(source === "new-receipt" ? 1 : 0);
        expect(
          sessionControllerLifecycle.isSessionControllerWorkActive(session.storePath, [
            session.sessionKey,
            session.entry?.sessionId,
          ]),
        ).toBe(false);
      } finally {
        publication?.mockRestore();
        comparison.mockRestore();
        cleanupAdmission(admitted, runId);
      }
    }),
);

it.each([
  "caller revocation",
  "lifecycle rotation",
  "completed workspace result",
  "new remote placement",
  "retired placement",
  "indeterminate publication",
  "service replacement",
  "unavailable reader",
] as const)("handles %s while preparing placement admission", (change) =>
  withAdmissionTest("chat-placement-admission", async (f) => {
    const { scope, runId, context } = f;
    const now = Date.now();
    const entry = f.seed({ updatedAt: now });
    const accepted =
      change === "completed workspace result" ||
      change === "new remote placement" ||
      change === "retired placement";
    if (accepted) {
      await appendHeader(scope, entry, now);
    }
    const client = sharingPolicyClient({
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    const completingClaim =
      change === "completed workspace result"
        ? await pendingWorkspaceResult(placements, database, {
            ...scope,
            sessionId: entry.sessionId,
          })
        : undefined;
    const retiredPlacement =
      change === "retired placement"
        ? await placements.releaseTurn(
            await placements.claimTurn({
              ...scope,
              sessionId: entry.sessionId,
              owner: { kind: "local" },
              claimId: "retired-placement-claim",
              runId: "retired-placement-run",
            }),
          )
        : undefined;
    const getMany = vi.fn(() => new Map());
    context.workerSessionPlacementService =
      change === "unavailable reader" ? { getMany } : placements;
    const admission = await f.prepare({
      isDirectExternalUser: accepted,
      client,
    });
    expect(admission.prepared.restartSafeRequest).toBeDefined();
    const { session } = admission;
    const initialEntry = structuredClone(sessionAccessor.loadSessionEntry(scope));
    using placement = pausePlacement(placements);
    const respond = vi.fn();
    let callerCurrent = true;
    let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    const pending = admitChatSend({
      ...admission,
      respond,
      assertCurrent: () => {
        if (!callerCurrent) {
          throw new Error("Original chat caller revoked during placement preparation");
        }
      },
    }).then((result) => (admitted = result));
    try {
      if (change !== "unavailable reader") {
        await awaitGateBeforeSettlement(
          placement.observed.promise,
          pending,
          "chat skipped placement facts",
        );
        if (change === "caller revocation") {
          callerCurrent = false;
        } else if (change === "lifecycle rotation") {
          rotateAgentEventLifecycleGeneration();
        } else if (change === "completed workspace result") {
          await placements.completeWorkspaceResultAndReleaseTurn(completingClaim!);
        } else if (change === "new remote placement") {
          await placements.startDispatch({ ...scope, sessionId: entry.sessionId });
        } else if (change === "retired placement") {
          await placements.retireSessionPlacementAsync({
            sessionId: entry.sessionId,
            expectedState: "local",
            expectedGeneration: retiredPlacement!.generation,
          });
        } else if (change === "indeterminate publication") {
          const publication = await placements.startDispatch({
            ...scope,
            sessionId: entry.sessionId,
          });
          stagePlacementTurnClaimWorkerPublication(
            requireOpenClawStateDatabaseIdentity({ db: database.db }),
            publication,
            undefined,
            publication.state,
            publication,
          ).invalidate();
        } else {
          context.workerSessionPlacementService = createWorkerSessionPlacementStore();
        }
        placement.resume.resolve();
      }
      const result = await pending;
      expect(result.ok).toBe(accepted);
      if (accepted && result.ok) {
        expect(respond).not.toHaveBeenCalled();
        expect(getRpcSource(runId)).toBeDefined();
        expect(Boolean(result.value.restartSafeAdmission)).toBe(change === "retired placement");
      } else {
        expect(respond).toHaveBeenCalledOnce();
        expect(getRpcSource(runId)).toBeUndefined();
      }
      expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
      expect(sessionAccessor.loadSessionEntry(scope)).toEqual(initialEntry);
      if (!accepted) {
        expect(lifecycleRelease(session)).toBeUndefined();
      }
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
      placement.resume.resolve();
      await Promise.allSettled([pending]);
      cleanupAdmission(admitted, runId);
    }
    expect(getRpcSource(runId)).toBeUndefined();
    expect(lifecycleRelease(session)).toBeUndefined();
    if (admitted?.ok) {
      expect(admitted.value.gatewayWorkAdmission.isActive()).toBe(false);
    }
  }),
);
