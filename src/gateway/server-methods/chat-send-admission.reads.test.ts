import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { seedCanonicalAcpSessionMeta } from "../../acp/runtime/session-meta-fixture.test-support.js";
import * as acpMetadata from "../../acp/runtime/session-meta-readonly.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionEntryReads from "../../config/sessions/session-entry-read-runtime.js";
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
import * as agentWriteAdmission from "../../state/openclaw-agent-write-admission.js";
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
import { runChatSendPreAdmission } from "./chat-send-pre-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession } from "./chat-send-session.js";

type Admission = Awaited<ReturnType<typeof admitChatSend>>;
type Session = Awaited<ReturnType<typeof prepareChatAdmission>>["session"];
type SubmittedInput = Awaited<ReturnType<typeof sessionAccessor.readSessionSubmittedInput>>;
type SubmittedInputScope = Parameters<typeof sessionAccessor.readSessionSubmittedInput>[0];
function submittedInputReader(message: SubmittedInput) {
  function read(
    scope: SubmittedInputScope,
    key: string,
    options: { includeSource: true },
  ): Promise<{ message: NonNullable<SubmittedInput>; source: "transcript" } | undefined>;
  function read(scope: SubmittedInputScope, key: string): Promise<SubmittedInput>;
  async function read(
    _scope: SubmittedInputScope,
    _key: string,
    options?: { includeSource: true },
  ) {
    return message && options?.includeSource ? { message, source: "transcript" as const } : message;
  }
  return read;
}
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
function expectAdmissionError(respond: ReturnType<typeof vi.fn>, fields: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(fields));
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
      });
      let admitted: Awaited<typeof pending> | undefined;
      try {
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
        nativePending = false;
        publishCommit?.();
        releaseReply.resolve();
        admitted = await pending;
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
          using reads = vi.spyOn(sessionEntryReads, "withSessionEntriesFromStoresInWorker");
          await withoutHostSql(async () => {
            admitted = await admitChatSend({ ...admission, respond });
            expect(respond).not.toHaveBeenCalled();
            expect(admitted.ok).toBe(true);
            assert(admitted.ok, "Session admission failed");
            expect(admitted.value).toMatchObject({
              admittedSessionSettings: { permissionMode: "full" },
              admittedSessionId: entry.sessionId,
            });
            expect(Boolean(admitted.value.restartSafeAdmission)).toBe(freshness === "fresh header");
            const lifecycleReads = reads.mock.calls.flatMap(([inputs]) =>
              inputs.filter((input) => input.lifecycleSessionKey === scope.sessionKey),
            );
            expect(lifecycleReads).toHaveLength(restartSafe ? 1 : 0);
          });
        } finally {
          cleanupAdmission(admitted, runId);
        }
      },
      { session: { reset: { mode: "daily" } } },
    ),
);

it.for([
  "unchanged",
  "lifecycle changed",
  "lifecycle changed before admission",
  "caller revoked",
] as const)(
  "prepares ACP before an unrelated writer settles but keeps final admission ordered (%s)",
  async (change, { signal }) =>
    withAdmissionTest("chat-admission-preparation-order", async (f) => {
      const { scope, runId } = f;
      const now = Date.now();
      const entry = f.seed({
        updatedAt: now,
        sessionStartedAt: now,
        lifecycleRevision: "original-lifecycle",
      });
      await appendHeader(scope, entry, now);
      const replaceLifecycle = () => {
        const lifecycleRevision = "replacement-lifecycle";
        replaceSessionEntrySync(scope, { ...entry, lifecycleRevision, updatedAt: now + 1 });
        seedCanonicalAcpSessionMeta({
          ...scope,
          lifecycleRevision,
          meta: {
            backend: "acpx",
            agent: scope.agentId,
            runtimeSessionName: scope.sessionKey,
            mode: "persistent",
            state: "idle",
            lastActivityAt: now,
          },
        });
      };
      const admission = await f.prepare({ isDirectExternalUser: true });
      expect(admission.session.restartSafeRequest).toBeDefined();
      if (change === "lifecycle changed before admission") {
        replaceLifecycle();
      }
      await sessionEntryReads.readSessionEntryReadOnlyInWorker(scope);
      const held = createDeferred();
      const release = createDeferred();
      const holder = agentWriteAdmission.runOpenClawAgentWriteAdmission(
        { agentId: scope.agentId },
        async () => {
          held.resolve();
          await release.promise;
          replaceSessionEntrySync(
            { ...scope, sessionKey: `${scope.sessionKey}:unrelated` },
            { sessionId: "unrelated-session", updatedAt: now },
          );
          if (change === "lifecycle changed") {
            replaceLifecycle();
          }
        },
      );
      const firstPreparation = createDeferred<"ACP" | "writer admission">();
      const orderedRequested = createDeferred();
      const metadataBindings: Array<{
        lifecycleRevision: string | undefined;
        hasMetadata: boolean;
      }> = [];
      const readMetadata = acpMetadata.readAcpSessionMetaForEntries;
      using metadata = vi.spyOn(acpMetadata, "readAcpSessionMetaForEntries");
      metadata.mockImplementation(async (params, options) => {
        firstPreparation.resolve("ACP");
        const result = await readMetadata(params, options);
        for (const [index, selected] of params.entries.entries()) {
          if (selected.sessionKey === scope.sessionKey) {
            metadataBindings.push({
              lifecycleRevision: selected.entry?.lifecycleRevision,
              hasMetadata: result[index] != null,
            });
          }
        }
        return result;
      });
      const readOrdered = agentWriteAdmission.runOpenClawAgentWriteAdmissions;
      using ordered = vi.spyOn(agentWriteAdmission, "runOpenClawAgentWriteAdmissions");
      ordered.mockImplementation((options, consume, abortSignal) => {
        firstPreparation.resolve("writer admission");
        orderedRequested.resolve();
        return readOrdered(options, consume, abortSignal);
      });
      let callerCurrent = true;
      const respond = vi.fn();
      let admitted: Admission | undefined;
      let pending: Promise<Admission> | undefined;
      try {
        await withinTest(held.promise, signal);
        pending = admitChatSend({
          ...admission,
          respond,
          assertCurrent() {
            if (!callerCurrent) {
              throw new Error("Original chat caller revoked before final admission");
            }
          },
        }).then((result) => (admitted = result));
        expect(
          await withinTest(
            awaitGateBeforeSettlement(
              firstPreparation.promise,
              pending,
              "chat skipped preparation",
            ),
            signal,
          ),
        ).toBe("ACP");
        await withinTest(
          awaitGateBeforeSettlement(
            orderedRequested.promise,
            pending,
            "chat skipped final ordering",
          ),
          signal,
        );
        expect(metadataBindings).toEqual([
          { lifecycleRevision: "original-lifecycle", hasMetadata: false },
        ]);
        expect(admitted).toBeUndefined();
        expect(respond).not.toHaveBeenCalled();
        callerCurrent = change !== "caller revoked";
        release.resolve();
        await holder;
        admitted = await pending;
        if (change === "caller revoked") {
          expect(admitted.ok).toBe(false);
          expectAdmissionError(respond, {
            message: expect.stringContaining("Original chat caller revoked"),
          });
          expect(getRpcSource(runId)).toBeUndefined();
        } else {
          expect(admitted.ok, JSON.stringify(respond.mock.calls)).toBe(true);
          assert(admitted.ok, "Session admission failed");
          expect(Boolean(admitted.value.restartSafeAdmission)).toBe(change === "unchanged");
          expect(respond).not.toHaveBeenCalled();
          if (change === "lifecycle changed" || change === "lifecycle changed before admission") {
            expect(metadataBindings).toEqual([
              { lifecycleRevision: "original-lifecycle", hasMetadata: false },
              { lifecycleRevision: "replacement-lifecycle", hasMetadata: true },
            ]);
          }
        }
      } finally {
        release.resolve();
        await Promise.allSettled([holder, ...(pending ? [pending] : [])]);
        cleanupAdmission(admitted, runId);
      }
    }),
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
        const admission = admitChatSend({ ...blocked, respond: vi.fn() });
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
          retried = await admitChatSend({ ...corrected, respond: vi.fn() });
          expect(retried.ok).toBe(true);
        } finally {
          cleanupAdmission(retried, runId);
        }
      }
    },
    { gateway: { uploads: { enabled: false } } },
  ));
it.each(["new-terminal", "new-receipt"] as const)(
  "refuses a conflicting or unprepared %s after admission waits",
  (source) =>
    withAdmissionTest("chat-admission-retry-comparison", async (f) => {
      const { scope, runId, context } = f;
      f.seed();
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
      comparison.mockImplementation(
        submittedInputReader({
          role: "user",
          timestamp: 100,
          content: "Hello",
          __openclaw: { humanMentions: [{ profileId: "bob", start: 0, end: 5 }] },
        }),
      );
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
        admitted = await admitChatSend({ ...admission, respond });
        expect(admitted.ok).toBe(false);
        expectAdmissionError(
          respond,
          source === "new-receipt"
            ? { code: "UNAVAILABLE", retryable: true }
            : {
                code: "INVALID_REQUEST",
                message: expect.stringContaining("already used for different input"),
              },
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
it("names the changed store key when refusing a send prepared against stale storage", () =>
  withAdmissionTest("chat-admission-store-key-changed", async (f) => {
    f.seed();
    const admission = await f.prepare();
    const { sessionTarget } = admission.session;
    const respond = vi.fn();
    const outcome = await admitChatSend({
      ...admission,
      session: {
        ...admission.session,
        sessionTarget: { ...sessionTarget, storeKey: `${sessionTarget.storeKey}:replaced` },
      },
      respond,
    });
    expect(outcome.ok).toBe(false);
    expectAdmissionError(respond, {
      message: "Error: Session storage changed while starting work (store key). Retry.",
    });
    expect(getRpcSource(f.runId)).toBeUndefined();
  }));
