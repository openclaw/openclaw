import assert from "node:assert/strict";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  claimMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as entryAdmission from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import * as entryPatch from "../../config/sessions/session-entry-patch.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import * as placementContext from "../../gateway/session-worker-placement-context.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  isAgentRunStaleLifecycleError,
  isRestartRecoveryClaimChangedError,
} from "../../infra/agent-lifecycle-error.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../../state/openclaw-agent-db-registry-listing.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const deliveryContext = {
  channel: "telegram",
  to: "chat",
  accountId: "default",
  threadId: "thread",
};

type ClaimControllerParams = Parameters<typeof createReplyRestartRecoveryClaimController>[0];
type ClaimScope = { agentId: string; storePath: string; sessionKey: string };
type UserMessage = Parameters<typeof createUserTurnTranscriptRecorder>[0]["message"];

const userMessage = (content = "continue", idempotencyKey?: string): UserMessage => ({
  role: "user",
  content,
  timestamp: 1,
  ...(idempotencyKey ? { idempotencyKey } : {}),
});

function observeSql() {
  const sql = observeHostDataSql();
  return Object.assign(sql, { [Symbol.dispose]: () => sql.restore() });
}

// Projecting fields preserves optional-field assertions: absent and undefined both match.
function recoveryState(entry: InternalSessionEntry | undefined) {
  return {
    status: entry?.status,
    runId: entry?.restartRecoveryDeliveryRunId,
    sourceRunId: entry?.restartRecoveryDeliverySourceRunId,
    fingerprint: entry?.restartRecoveryDeliveryRequestFingerprint,
  };
}

function transcriptMessages(scope: Parameters<typeof loadTranscriptEventsSync>[0]) {
  return loadTranscriptEventsSync(scope)
    .filter(isRecord)
    .filter((event) => event.type === "message")
    .map((event) => event.message);
}

async function expectAdmitted(
  controller: ReturnType<typeof createReplyRestartRecoveryClaimController>,
  recorder?: ReturnType<typeof createRecorder>,
) {
  await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
}

async function createStoredClaim(
  fields: Partial<InternalSessionEntry> = {},
  params: Partial<ClaimControllerParams> = {},
  createOperation?: (scope: ClaimScope, entry: InternalSessionEntry) => ReplyOperation,
) {
  const scope = {
    agentId: params.agentId ?? "main",
    storePath:
      params.storePath ?? path.join(tempDirs.make("openclaw-reply-claim-"), "sessions.json"),
    sessionKey: params.sessionKey ?? "agent:main:main",
  };
  const entry = { sessionId: "session", updatedAt: 1, ...fields };
  await replaceSessionEntry(scope, entry);
  const operation = createOperation?.(scope, entry);
  return { ...bindClaim(scope, entry, params, operation), operation };
}

function bindClaim(
  scope: ClaimScope,
  initialEntry: InternalSessionEntry,
  params: Partial<ClaimControllerParams> = {},
  operation?: ReplyOperation,
) {
  let entry = initialEntry;
  let sessionId = entry.sessionId;
  const getSessionId = params.getSessionId ?? (() => sessionId);
  const actor = createReplyRecoveryActorFixture({
    ...scope,
    agentId: scope.agentId ?? "main",
    getSessionId,
    operation,
  });
  const controller = createReplyRestartRecoveryClaimController({
    ...scope,
    getEntry: () => entry,
    getSessionId,
    setEntry: (next) => {
      entry = next;
    },
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    isRestartAbort: () => false,
    resolveDeliveryContext: () => undefined,
    ...params,
    acquireSessionActor: () => actor.acquireSessionActor(),
  });
  return {
    controller,
    admit: controller.admitUserTurn,
    begin: controller.beginBeforeAgentReply,
    checkpoint: controller.checkpointBeforeAgentReply,
    clear: controller.clear,
    scope,
    current: () => entry,
    read: () => loadSessionEntry(scope),
    recorder: (message = userMessage()) => createRecorder(scope, entry, message),
    retarget: () => {
      sessionId = "successor-session";
    },
    actor: async () =>
      expectDefined(await actor.acquireSessionActor(), "durable recovery actor").actor,
    [Symbol.asyncDispose]: () => actor[Symbol.asyncDispose](),
  };
}

function createTrackedClaim(
  fields: Partial<InternalSessionEntry> = {},
  params: Partial<ClaimControllerParams> = {},
) {
  return createStoredClaim(
    { restartRecoveryDeliveryRunId: "recovery-run", ...fields },
    { admissionRunId: "recovery-run", ...params },
  );
}
function createRecorder(scope: ClaimScope, entry: InternalSessionEntry, message = userMessage()) {
  return createUserTurnTranscriptRecorder({
    message,
    target: { ...scope, sessionId: entry.sessionId, sessionEntry: entry },
    updateMode: "none",
  });
}

async function createAcknowledgedClaim() {
  const sourceTurnId = "acknowledged-source";
  const fixture = await createTrackedClaim(
    {
      lifecycleRunId: "recovery-run",
      restartRecoveryDeliveryRequestFingerprint: "acknowledged-fingerprint",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
      startedAt: 1,
    },
    { sourceTurnId },
  );
  const entry = fixture.current();
  const transcriptScope = { ...fixture.scope, sessionId: entry.sessionId };
  const recorder = fixture.recorder(
    userMessage("Synthetic acknowledged input", `${sourceTurnId}:user`),
  );
  await recorder.persistApproved();
  return { ...fixture, recorder, sourceTurnId, transcriptScope };
}

describe("createReplyRestartRecoveryClaimController", () => {
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(() => clearRuntimeConfigSnapshot());

  it("leaves already-persisted source-less admission to its existing writer", async () => {
    await using fixture = await createStoredClaim(
      { sessionId: "source-less-session" },
      { admissionRunId: "source-less-run", setEntry: () => {} },
    );
    const { scope, controller } = fixture;
    const recorder = fixture.recorder();
    await recorder.persistApproved();
    const before = fixture.read();
    await expectAdmitted(controller, recorder);
    expect(loadSessionEntry(scope)).toEqual(before);
  });

  it.each([
    ["runtime", "main", {}],
    ["handled-silent", "main", {}],
    ["restart", "main", {}],
    ["restart", "spawned child", { spawnDepth: 1 }],
    ["restart", "role-owned child", { subagentRole: "leaf" }],
  ] as const)(
    "settles source-less execution custody through %s for %s without claiming delivery authority",
    (completion, owner, metadata) =>
      withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        setRuntimeConfigSnapshot({});
        const scope = {
          agentId: "main",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
          sessionKey: "agent:main:dashboard:recovery-admission",
        };
        const lifecycleGeneration = getAgentEventLifecycleGeneration();
        const executionRunId = "source-less-execution";
        let restartAborted = false;
        await using fixture = await createStoredClaim(
          { sessionId: "source-less-session", ...metadata },
          {
            ...scope,
            admissionRunId: "source-less-run",
            executionRunId,
            lifecycleGeneration,
            isRestartAbort: () => restartAborted,
          },
        );
        const entry = fixture.current();
        const { controller } = fixture;
        const expectedRuns =
          owner === "main" ? [{ runId: executionRunId, lifecycleGeneration }] : undefined;
        const recorder = fixture.recorder(userMessage("continue the task"));
        await expectAdmitted(controller, recorder);
        expect(recorder.hasPersisted()).toBe(true);
        expect(loadSessionEntry(scope)).toMatchObject({
          abortedLastRun: false,
        });
        expect(loadSessionEntry(scope)?.restartRecoveryRuns).toEqual(expectedRuns);
        expect(loadSessionEntry(scope)?.status).toBeUndefined();
        expect(loadSessionEntry(scope)?.restartRecoveryDeliveryRunId).toBeUndefined();
        expect(loadSessionEntry(scope)?.restartRecoveryDeliverySourceRunId).toBeUndefined();
        if (completion === "handled-silent") {
          await controller.beginBeforeAgentReply();
          await controller.checkpointBeforeAgentReply({ state: "handled-silent" });
        } else {
          const startedAt = Date.now();
          const event = {
            runId: executionRunId,
            lifecycleGeneration,
            sessionId: entry.sessionId,
            ts: startedAt,
          };
          await persistGatewaySessionLifecycleEvent({
            ...scope,
            event: { ...event, data: { phase: "start", startedAt } },
          });
          expect(loadSessionEntry(scope)?.lifecycleRunId).toBe(executionRunId);
          restartAborted = completion === "restart";
          await persistGatewaySessionLifecycleEvent({
            ...scope,
            event: {
              ...event,
              ts: startedAt + 10,
              data: {
                phase: "end",
                endedAt: startedAt + 10,
                ...(restartAborted ? { aborted: true, stopReason: "restart" } : {}),
              },
            },
          });
        }
        await controller.clear();
        const settled = loadSessionEntry(scope);
        expect(settled?.status).toBe(restartAborted ? "interrupted" : "done");
        if (restartAborted) {
          expect(settled?.restartRecoveryRuns).toEqual(expectedRuns);
          expect(await controller.isArmed()).toBe(owner === "main");
        } else {
          expect(settled?.restartRecoveryRuns).toBeUndefined();
        }
        expect(settled?.restartRecoveryDeliveryRunId).toBeUndefined();
      }),
  );

  describe("placement observations", () => {
    const placementDirs = useStateDatabaseTempDirs();

    async function createPlacementAdmission(local = false) {
      const root = placementDirs.make("openclaw-reply-placement-admission-");
      const scope = {
        agentId: "main",
        storePath: path.join(root, "sessions.json"),
        sessionKey: "agent:main:placement",
      };
      const setEntry = vi.fn();
      const sourceTurnId = "placement-source";
      const fixture = await createStoredClaim(
        { sessionId: "placement-session" },
        { ...scope, setEntry, sourceTurnId },
      );
      const entry = fixture.current();
      const service = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ path: path.join(root, "placement.sqlite") }),
      });
      if (!local) {
        await service.startDispatch({
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          sessionId: entry.sessionId,
        });
      }
      const context: placementContext.SessionWorkerPlacementContext = {
        workerSessionPlacementService: service,
      };
      vi.spyOn(placementContext, "resolveSessionWorkerPlacementContext").mockImplementation(
        () => context,
      );
      const recorder = fixture.recorder(userMessage("continue", sourceTurnId));
      await expect(
        recorder.stageApproved?.({ runId: "placement-run", assertCurrent: () => {} }),
      ).resolves.toBe(true);
      const persistApproved = vi.spyOn(recorder, "persistApproved");
      return {
        ...fixture,
        context,
        entry,
        persistApproved,
        recorder,
        service,
        setEntry,
        sourceTurnId,
      };
    }

    it("leaves staged worker input with placement admission without caller-thread SQL", async () => {
      await using fixture = await createPlacementAdmission();
      using hostSql = observeSql();
      await expectAdmitted(fixture.controller, fixture.recorder);
      expect(hostSql.queries).toEqual([]);
      expect(fixture.persistApproved).not.toHaveBeenCalled();
      expect(fixture.recorder.hasPersisted()).toBe(false);
      expect(fixture.setEntry).not.toHaveBeenCalled();
    });

    it("admits a follow-up while the preceding local turn finishes during session preparation", async () => {
      await using fixture = await createPlacementAdmission(true);
      const predecessor = await fixture.service.claimTurn({
        ...fixture.scope,
        sessionId: fixture.entry.sessionId,
        owner: { kind: "local" },
        runId: "preceding-run",
        claimId: "preceding-claim",
      });
      const load = entryAdmission.loadSessionEntryForAdmission;
      using read = vi.spyOn(entryAdmission, "loadSessionEntryForAdmission");
      read.mockImplementationOnce(async (...args) => {
        const entry = await load(...args);
        await fixture.service.releaseTurn(predecessor);
        return entry;
      });

      await expectAdmitted(fixture.controller, fixture.recorder);
      expect(fixture.recorder.hasPersisted()).toBe(true);
      expect(await fixture.service.getAsync(fixture.entry.sessionId)).toMatchObject({
        state: "local",
        turnClaim: null,
      });
    });

    it("refuses an unavailable placement observation instead of reading synchronously", async () => {
      await using fixture = await createPlacementAdmission();
      fixture.context.workerSessionPlacementService = {
        getMany: (ids) => fixture.service.getMany(ids),
      };
      using hostSql = observeSql();
      await expect(fixture.admit(fixture.recorder)).rejects.toThrow(
        "Worker placement observation service is unavailable",
      );
      expect(hostSql.queries).toEqual([]);
      expect(fixture.persistApproved).not.toHaveBeenCalled();
    });

    it.each([
      "session-retarget",
      "lifecycle-rotation",
      "pending-input-persisted",
      "terminal-source",
    ] as const)("revalidates %s while session preparation is pending", async (change) => {
      await using fixture = await createPlacementAdmission();
      const prepared = createDeferred();
      const resume = createDeferred();
      const load = entryAdmission.loadSessionEntryForAdmission;
      using read = vi.spyOn(entryAdmission, "loadSessionEntryForAdmission");
      read.mockImplementationOnce(async (...args) => {
        const entry = await load(...args);
        prepared.resolve();
        await resume.promise;
        return entry;
      });
      const admission = fixture.admit(fixture.recorder);
      const outcome = admission.catch((error: unknown) => error);
      try {
        await awaitGateBeforeSettlement(
          prepared.promise,
          admission,
          "admission settled before placement preparation",
        );
        if (change === "session-retarget") {
          fixture.retarget();
        } else if (change === "lifecycle-rotation") {
          rotateAgentEventLifecycleGeneration();
        } else if (change === "pending-input-persisted") {
          fixture.recorder.markRuntimePersisted(fixture.recorder.getPendingInputMessage?.());
        } else {
          await updateSessionEntry(fixture.scope, () => ({
            restartRecoveryTerminalRunIds: [fixture.sourceTurnId],
          }));
        }
        resume.resolve();
        const result = await outcome;
        if (change === "terminal-source") {
          expect(result).toBe("duplicate-source");
        } else if (change === "lifecycle-rotation") {
          expect(isAgentRunStaleLifecycleError(result)).toBe(true);
        } else {
          const message = {
            "session-retarget": "session changed before durable user-turn admission",
            "pending-input-persisted":
              "pending user turn changed before durable user-turn admission",
          }[change];
          expect(result).toMatchObject({ message });
        }
        expect(fixture.persistApproved).not.toHaveBeenCalled();
        expect(fixture.setEntry).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await outcome;
      }
    });
  });

  it.each(["session-retarget", "lifecycle-rotation"] as const)(
    "does not adopt a recovery claim after %s while its row read is pending",
    async (change) => {
      const setEntry = vi.fn();
      await using fixture = await createStoredClaim(
        {
          sessionId: "original-session",
          restartRecoveryDeliveryRunId: "recovery-run",
          restartRecoveryBeforeAgentReplyState: "handled-reply",
        },
        {
          agentId: "ops",
          sessionKey: "global",
          admissionRunId: "recovery-run",
          getSessionId: () => operation.sessionId,
          setEntry,
        },
        (scope, entry) =>
          createReplyOperation({
            agentId: scope.agentId,
            sessionKey: scope.sessionKey,
            sessionId: entry.sessionId,
            resetTriggered: false,
          }),
      );
      const operation = expectDefined(fixture.operation, "reply operation");
      const { controller } = fixture;
      const before = fixture.read();
      const admission = controller.admitUserTurn();
      const outcome = admission.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        if (change === "session-retarget") {
          operation.updateSessionId("successor-session");
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        const failure = await outcome;
        if (change === "session-retarget") {
          expect(failure).toMatchObject({
            message: "session changed before durable user-turn admission",
          });
        } else {
          expect(failure).toBeInstanceOf(Error);
        }
        expect(setEntry).not.toHaveBeenCalled();
        expect(fixture.read()).toEqual(before);
      } finally {
        await outcome;
        operation.complete();
      }
    },
  );

  it("keeps the selected agent through a global hook checkpoint", async () => {
    const root = tempDirs.make("openclaw-owned-reply-claim-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "global";
    const main = { agentId: "main", storePath, sessionKey };
    const ops = { agentId: "ops", storePath, sessionKey };
    await replaceSessionEntry(main, { sessionId: "main-session", updatedAt: 1 });
    const mainBefore = loadSessionEntry(main);
    await using fixture = await createTrackedClaim(
      { sessionId: "ops-session", restartRecoveryDeliveryRunId: "ops-recovery" },
      { ...ops, admissionRunId: "ops-recovery" },
    );
    const { controller } = fixture;
    await expectAdmitted(controller);
    {
      using hostSql = observeSql();
      expect(loadSessionEntry(ops)?.sessionId).toBe("ops-session");
      expect(hostSql.calls.some((call) => call.mock.calls.length > 0)).toBe(true);
      hostSql.calls.forEach((call) => call.mockClear());
      expect(await controller.isArmed()).toBe(false);
      hostSql.calls.forEach((call) => expect(call).not.toHaveBeenCalled());
    }
    await expect(controller.beginBeforeAgentReply()).resolves.toBe(true);
    await controller.checkpointBeforeAgentReply({
      state: "handled-reply",
      pendingFinalDelivery: {
        intentId: "ops-intent",
        text: "ops hook reply",
        deliveries: [{ id: "ops-delivery", state: "prepared" }],
      },
    });
    await controller.clear();
    expect(loadSessionEntry(ops)).toMatchObject({
      sessionId: "ops-session",
      restartRecoveryBeforeAgentReplyState: "handled-reply",
      pendingFinalDelivery: { intentId: "ops-intent", text: "ops hook reply" },
    });
    expect(loadSessionEntry(ops)?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(loadSessionEntry(main)).toEqual(mainBefore);
  });

  it("adopts an exact channel recovery claim before execution starts", async () => {
    const claim = {
      restartRecoveryDeliveryContext: deliveryContext,
      restartRecoveryDeliveryReceiptState: "terminal-pending" as const,
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "source-turn",
      restartRecoveryDeliveryToolCallId: "message-call",
    };
    await using fixture = await createTrackedClaim(
      {
        ...claim,
        abortedLastRun: false,
        lifecycleRunId: "recovery-run",
        sessionId: "channel-session",
        startedAt: 1,
      },
      {
        sessionKey: "agent:main:telegram:group:chat:topic:thread",
        resolveDeliveryContext: () => deliveryContext,
        sourceTurnId: "source-turn",
      },
    );
    const { controller, read } = fixture;

    await expectAdmitted(controller);
    const persisted = read();
    expect(persisted).toMatchObject(claim);
    expect(persisted?.status).toBeUndefined();
  });

  it.each(["killed", undefined] as const)(
    "retires a current-generation stopped channel claim with status %s for the next turn",
    async (status) => {
      const generation = getAgentEventLifecycleGeneration();
      await using fixture = await createStoredClaim(
        {
          abortedLastRun: true,
          status,
          restartRecoveryDeliveryRunId: "stopped-run",
          restartRecoveryDeliverySourceRunId: "stopped-source",
          restartRecoveryDeliveryContext: deliveryContext,
          restartRecoverySourceIngress: "channel",
          restartRecoverySourceReplyDeliveryMode: "message_tool_only",
          restartRecoveryRuns: [{ runId: "stopped-run", lifecycleGeneration: generation }],
        },
        {
          admissionRunId: "successor-run",
          sourceTurnId: "successor-source",
          resolveDeliveryContext: () => deliveryContext,
        },
      );
      const recorder = fixture.recorder(userMessage("next room message", "successor-source"));
      await expectAdmitted(fixture.controller, recorder);
      expect(fixture.read()).toMatchObject({
        abortedLastRun: false,
        lifecycleRunId: "successor-run",
        restartRecoveryDeliveryRunId: "successor-run",
        restartRecoveryDeliverySourceRunId: "successor-source",
        restartRecoveryTerminalRunIds: ["stopped-source"],
      });
      expect(fixture.read()?.status).toBeUndefined();
      expect(fixture.read()?.restartRecoveryRuns).toEqual([
        { runId: "stopped-run", lifecycleGeneration: generation },
        { runId: "successor-run", lifecycleGeneration: generation },
      ]);
      await expect(fixture.begin()).resolves.toBe(true);
      await fixture.checkpoint({ state: "handled-silent" });
      await fixture.clear();
      expect(fixture.read()).toMatchObject({
        status: "done",
        restartRecoveryTerminalRunIds: ["stopped-source", "successor-source"],
      });
      expect(fixture.read()?.restartRecoveryDeliveryRunId).toBeUndefined();
    },
  );

  it.each(["interrupted", "older-generation", "marked-recovery"] as const)(
    "keeps a genuine %s recovery claim from successor acquisition",
    async (state) => {
      const generation = getAgentEventLifecycleGeneration();
      await using fixture = await createStoredClaim(
        {
          abortedLastRun: true,
          status: state === "interrupted" ? "interrupted" : "killed",
          restartRecoveryDeliveryRunId: "recovery-run",
          restartRecoveryDeliverySourceRunId: "recovery-source",
          restartRecoveryDeliveryContext: deliveryContext,
          restartRecoverySourceIngress: "channel",
          restartRecoveryRuns:
            state === "older-generation"
              ? [{ runId: "recovery-run", lifecycleGeneration: "prior-generation" }]
              : undefined,
          mainRestartRecovery:
            state === "marked-recovery"
              ? { cycleId: "recovery-cycle", revision: 1, chargedAttempts: 0 }
              : undefined,
        },
        {
          admissionRunId: "successor-run",
          sourceTurnId: "successor-source",
          resolveDeliveryContext: () => deliveryContext,
          lifecycleGeneration: generation,
        },
      );
      const before = fixture.read();
      const recorder = fixture.recorder(userMessage("next room message", "successor-source"));
      await expect(fixture.admit(recorder)).rejects.toThrow("restart recovery claim changed");
      expect(fixture.read()).toEqual(before);
    },
  );

  it("adopts and settles acknowledged input through hook checkpoints without caller-thread SQL", async () => {
    await using fixture = await createAcknowledgedClaim();
    using persistApproved = vi.spyOn(fixture.recorder, "persistApproved");
    {
      using sql = observeSql();
      await expectAdmitted(fixture.controller, fixture.recorder);
      expect(sql.queries).toEqual([]);
      expect(fixture.current().restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
      invalidateRegisteredAgentDatabasesMemo({});
      await expect(fixture.begin()).resolves.toBe(true);
      expect(fixture.current().restartRecoveryBeforeAgentReplyState).toBe("pending");
      await fixture.checkpoint({ state: "handled-silent" });
      expect(fixture.current().restartRecoveryBeforeAgentReplyState).toBe("handled-silent");
      invalidateRegisteredAgentDatabasesMemo({});
      await fixture.clear();
      expect(sql.queries).toEqual([]);
      expect(persistApproved).not.toHaveBeenCalled();
    }
    const persisted = fixture.read();
    expect(persisted).toMatchObject({
      sessionId: fixture.transcriptScope.sessionId,
      status: "done",
      restartRecoveryTerminalRunIds: [fixture.sourceTurnId],
    });
    expect(recoveryState(persisted)).toEqual({
      status: "done",
      runId: undefined,
      sourceRunId: undefined,
      fingerprint: undefined,
    });
    expect(transcriptMessages(fixture.transcriptScope)).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Synthetic acknowledged input",
        idempotencyKey: `${fixture.sourceTurnId}:user`,
      }),
    ]);
  });

  it.each([
    { stage: "admission", change: "metadata" },
    { stage: "admission", change: "source-claim" },
    { stage: "cleanup", change: "metadata" },
    { stage: "cleanup", change: "source-claim" },
  ] as const)(
    "preserves in-process $change changes across the $stage writer",
    async ({ stage, change }) => {
      await using fixture = await createAcknowledgedClaim();
      const cleanup = stage === "cleanup";
      const sourceChanged = change === "source-claim";
      if (cleanup) {
        await expectAdmitted(fixture.controller, fixture.recorder);
      }
      const replace = () => {
        replaceSessionEntrySync(fixture.scope, {
          ...fixture.read()!,
          ...(sourceChanged
            ? { restartRecoveryDeliverySourceRunId: "concurrent-source" }
            : { model: "concurrent-model" }),
        });
      };
      const actor = await fixture.actor();
      const adopt = actor.adoptRun.bind(actor);
      const patch = entryPatch.patchSessionEntryInWorker;
      using interleaving = !cleanup
        ? vi.spyOn(actor, "adoptRun").mockImplementationOnce((...args) => {
            replace();
            return adopt(...args);
          })
        : vi.spyOn(entryPatch, "patchSessionEntryInWorker").mockImplementationOnce((params) => {
            replace();
            return patch(params);
          });
      const outcome = await (cleanup ? fixture.clear() : fixture.admit(fixture.recorder)).catch(
        (error: unknown) => error,
      );
      expect(interleaving).toHaveBeenCalled();
      if (!sourceChanged) {
        expect(outcome).toBe(cleanup ? undefined : "admitted");
        expect(fixture.current().model).toBe("concurrent-model");
      } else if (!cleanup) {
        expect(isRestartRecoveryClaimChangedError(outcome)).toBe(true);
      } else {
        expect(outcome).toBeUndefined();
      }
      const persisted = fixture.read();
      expect(recoveryState(persisted)).toEqual({
        status: undefined,
        runId: cleanup && !sourceChanged ? undefined : "recovery-run",
        sourceRunId: sourceChanged
          ? "concurrent-source"
          : cleanup
            ? undefined
            : fixture.sourceTurnId,
        fingerprint: !cleanup && sourceChanged ? "acknowledged-fingerprint" : undefined,
      });
    },
  );

  it.each(["transaction", "commit"] as const)(
    "preserves lifecycle refusal at the actor %s boundary without writing the hook checkpoint",
    async (boundary) => {
      await using fixture = await createAcknowledgedClaim();
      await fixture.admit(fixture.recorder);
      const before = fixture.read();
      const actor = await fixture.actor();
      const adopt = actor.adoptRun.bind(actor);
      let revoked = false;
      using spy = vi.spyOn(actor, "adoptRun").mockImplementationOnce((input, authority, observer) =>
        adopt(
          input,
          {
            ...authority,
            authorize(stage, facts, publication) {
              if (stage === boundary && !revoked) {
                revoked = true;
                rotateAgentEventLifecycleGeneration();
              }
              authority.authorize(stage, facts, publication);
            },
          },
          observer,
        ),
      );
      const failure = await fixture.begin().catch((error: unknown) => error);
      expect(revoked).toBe(true);
      expect(spy).toHaveBeenCalled();
      expect(isAgentRunStaleLifecycleError(failure)).toBe(true);
      expect(fixture.read()).toEqual(before);
      expect(fixture.current()).toEqual(before);
    },
  );

  it.each(["begin", "handled-reply", "unhandled"] as const)(
    "rejects a stale lifecycle before the %s hook checkpoint",
    async (checkpoint) => {
      await using fixture = await createAcknowledgedClaim();
      await fixture.admit(fixture.recorder);
      if (checkpoint !== "begin") {
        await fixture.begin();
      }
      const original = structuredClone(fixture.current());
      await replaceSessionEntry(fixture.scope, {
        ...original,
        lifecycleRevision: "successor-generation",
      });
      const successor = fixture.read();

      await expect(
        checkpoint === "begin"
          ? fixture.begin()
          : fixture.checkpoint(
              checkpoint === "unhandled"
                ? { state: undefined }
                : {
                    state: "handled-reply",
                    pendingFinalDelivery: {
                      text: "Hook-owned reply",
                      intentId: "hook-intent",
                      deliveries: [{ id: "hook-delivery", state: "prepared" }],
                    },
                  },
            ),
      ).rejects.toThrow("restart recovery claim changed");
      expect(fixture.current()).toEqual(original);
      expect(fixture.read()).toEqual(successor);
      expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
    },
  );

  it.each(["session", "lifecycle"] as const)(
    "does not install a replacement %s after refused claim cleanup",
    async (replacement) => {
      await using fixture = await createAcknowledgedClaim();
      await fixture.admit(fixture.recorder);
      const original = structuredClone(fixture.current());
      const successor = {
        ...original,
        ...(replacement === "session" ? { sessionId: "successor-session" } : {}),
        lifecycleRevision: "successor-generation",
      };
      const patch = entryPatch.patchSessionEntryInWorker;
      let storedSuccessor: InternalSessionEntry | undefined;
      using spy = vi.spyOn(entryPatch, "patchSessionEntryInWorker").mockImplementation((params) => {
        // The released synchronous writer can replace the row after host admission.
        replaceSessionEntrySync(fixture.scope, successor);
        storedSuccessor = structuredClone(fixture.read());
        return patch(params);
      });
      await fixture.clear();
      expect(spy).toHaveBeenCalledOnce();
      expect(fixture.current()).toEqual(original);
      expect(storedSuccessor).toMatchObject({
        sessionId: successor.sessionId,
        lifecycleRevision: successor.lifecycleRevision,
      });
      expect(fixture.read()).toEqual(storedSuccessor);
    },
  );

  it("retargets durable user-turn admission to the prepared reply session", async () => {
    await using fixture = await createStoredClaim(
      { sessionId: "bound-session-id", updatedAt: Date.now() },
      {
        sessionKey: "plugin-binding:codex:target",
        setEntry: () => {},
        resolveUserTurnTarget: (target) => ({
          ...target,
          sessionEntry: target.entry,
          agentId: "main",
        }),
      },
    );
    const { storePath } = fixture.scope;
    const { sessionId } = fixture.current();
    const recorder = createUserTurnTranscriptRecorder({
      message: userMessage("hello"),
      target: {
        agentId: "main",
        storePath,
        sessionKey: "unprepared-key",
        sessionId: "unprepared-session",
        sessionEntry: undefined,
      },
      updateMode: "none",
    });
    await expectAdmitted(fixture.controller, recorder);
    expect(recorder.getAdmissionReceipt()?.sessionId).toBe(sessionId);
    expect(transcriptMessages({ ...fixture.scope, sessionId })).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
    ]);
  });

  it.each(["metadata", "recovery-cycle", "owner-release"] as const)(
    "admits only unchanged recovery ownership after a concurrent %s write",
    async (change) => {
      const storePath = path.join(tempDirs.make("openclaw-reply-admission-race-"), "sessions.json");
      const sessionKey = "agent:main:telegram:group:chat:topic:thread";
      const scope = { storePath, sessionKey };
      const sessionId = "channel-session-id";
      const sourceTurnId = "telegram-update-new";
      const requesterOrigin = { sessionKey, messageProvider: "telegram", senderId: "bob" };
      let entry: InternalSessionEntry = {
        sessionId,
        updatedAt: 10,
        abortedLastRun: false,
        restartRecoveryDeliveryContext: deliveryContext,
        restartRecoveryDeliveryRunId: "orphaned-run",
        restartRecoveryDeliverySourceRunId: "telegram-update-old",
        status: "done",
      };
      let releaseOwner: (() => Promise<unknown>) | undefined;
      if (change === "owner-release") {
        await replaceSessionEntry(scope, {
          sessionId,
          updatedAt: 10,
          abortedLastRun: true,
          status: undefined,
          mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
        });
        const owner = await claimMainSessionRecoveryOwner({
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          sessionId,
          target: scope,
        });
        assert(owner.kind === "claimed");
        releaseOwner = () => releaseMainSessionRecoveryOwner(owner.lease);
        entry = (await updateSessionEntry(scope, () => entry)) as InternalSessionEntry;
      } else {
        await replaceSessionEntry(scope, entry);
      }
      await using fixture = bindClaim({ agentId: "main", ...scope }, entry, {
        resolveDeliveryContext: () => deliveryContext,
        sourceTurnId,
        requesterOrigin,
      });
      const sourceMessage = userMessage("continue", sourceTurnId);
      const recorder = fixture.recorder(sourceMessage);
      const persist = recorder.persistApproved.bind(recorder);
      const persistApproved = vi.spyOn(recorder, "persistApproved");
      if (change === "metadata") {
        recorder.markRuntimePersisted();
        vi.spyOn(recorder, "resolveMessage").mockImplementation(async () => {
          await updateSessionEntry(scope, (current) => ({
            model: "gpt-5.6-luna",
            updatedAt: current.updatedAt + 1,
          }));
          return sourceMessage;
        });
      } else {
        persistApproved.mockImplementation(async (options) => {
          if (releaseOwner) {
            await releaseOwner();
          } else {
            await updateSessionEntry(scope, () => ({
              mainRestartRecovery: { cycleId: "cycle-new", revision: 1, chargedAttempts: 0 },
            }));
          }
          return persist(options);
        });
      }
      requesterOrigin.senderId = "alice";

      if (change === "metadata") {
        await expectAdmitted(fixture.controller, recorder);
        expect(persistApproved).not.toHaveBeenCalled();
        const persisted = loadSessionEntry(scope);
        expect(persisted).toMatchObject({
          model: "gpt-5.6-luna",
          restartRecoveryDeliverySourceRunId: sourceTurnId,
          restartRecoveryRequesterSource: {
            agentId: "main",
            sessionKey,
            sessionId,
            sourceRunId: sourceTurnId,
            requesterOrigin: { senderId: "bob" },
          },
        });
        expect(persisted?.status).toBeUndefined();
      } else {
        await expect(fixture.admit(recorder)).rejects.toThrow(
          "session changed before durable user-turn admission",
        );
        const persisted = loadSessionEntry(scope);
        expect(persisted).toMatchObject({
          restartRecoveryDeliveryRunId: "orphaned-run",
          restartRecoveryDeliverySourceRunId: "telegram-update-old",
          status: "done",
        });
        if (change === "owner-release") {
          expect(persisted).not.toHaveProperty("mainRestartRecovery");
        } else {
          expect(persisted?.mainRestartRecovery).toMatchObject({
            cycleId: "cycle-new",
            revision: 1,
          });
        }
      }
    },
  );
});
