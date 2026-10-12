import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  claimMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
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
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../../state/openclaw-agent-db-registry-listing.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { createReplyOperation, type ReplyOperation } from "./reply-run-registry.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ClaimControllerParams = Parameters<typeof createReplyRestartRecoveryClaimController>[0];

function createController(
  params: Pick<
    ClaimControllerParams,
    "getEntry" | "getSessionId" | "setEntry" | "sessionKey" | "storePath"
  > &
    Partial<ClaimControllerParams>,
  operation?: ReplyOperation,
) {
  if (!params.sessionKey || !params.storePath) {
    throw new Error("Recovery fixture requires a stored session");
  }
  const actor = createReplyRecoveryActorFixture({
    agentId: params.agentId ?? "main",
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    getSessionId: params.getSessionId,
    operation,
  });
  const controller = createReplyRestartRecoveryClaimController({
    agentId: "main",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    isRestartAbort: () => false,
    resolveDeliveryContext: () => undefined,
    ...params,
    acquireSessionActor: () => actor.acquireSessionActor(),
  });
  return Object.assign(controller, {
    acquireSessionActor: () => actor.acquireSessionActor(),
    [Symbol.asyncDispose]: () => actor[Symbol.asyncDispose](),
  });
}

async function createTrackedClaim(
  fields: Partial<InternalSessionEntry> = {},
  params: Partial<ClaimControllerParams> = {},
) {
  const scope = {
    agentId: params.agentId ?? "main",
    storePath:
      params.storePath ?? path.join(tempDirs.make("openclaw-reply-claim-"), "sessions.json"),
    sessionKey: params.sessionKey ?? "agent:main:main",
  };
  let entry: InternalSessionEntry = {
    sessionId: "session",
    updatedAt: 1,
    restartRecoveryDeliveryRunId: "recovery-run",
    ...fields,
  };
  const sessionId = entry.sessionId;
  await replaceSessionEntry(scope, entry);
  const controller = createController({
    ...scope,
    admissionRunId: "recovery-run",
    getEntry: () => entry,
    getSessionId: () => sessionId,
    setEntry: (next) => {
      entry = next;
    },
    ...params,
  });
  return {
    controller,
    scope,
    current: () => entry,
    read: () => loadSessionEntry(scope),
    [Symbol.asyncDispose]: () => controller[Symbol.asyncDispose](),
  };
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
  const recorder = createUserTurnTranscriptRecorder({
    message: {
      role: "user",
      content: "Synthetic acknowledged input",
      timestamp: 1,
      idempotencyKey: `${sourceTurnId}:user`,
    },
    target: { ...transcriptScope, sessionEntry: entry },
    updateMode: "none",
  });
  await recorder.persistApproved();
  expect(recorder.hasPersisted()).toBe(true);
  return { ...fixture, recorder, sourceTurnId, transcriptScope };
}

describe("createReplyRestartRecoveryClaimController", () => {
  it.each(["absent", "persisted"] as const)(
    "leaves source-less lifecycle admission to its existing writer when the recorder is %s",
    async (mode) => {
      const scope = {
        agentId: "main",
        storePath: path.join(tempDirs.make("openclaw-source-less-lifecycle-"), "sessions.json"),
        sessionKey: "agent:main:main",
      };
      const entry: InternalSessionEntry = { sessionId: "source-less-session", updatedAt: 1 };
      await replaceSessionEntry(scope, entry);
      const recorder =
        mode === "persisted"
          ? createUserTurnTranscriptRecorder({
              message: { role: "user", content: "continue", timestamp: 1 },
              target: { ...scope, sessionId: entry.sessionId, sessionEntry: entry },
              updateMode: "none",
            })
          : undefined;
      await recorder?.persistApproved();
      const before = loadSessionEntry(scope);
      const write = vi.spyOn(sessionAccessor, "updateSessionEntry");
      try {
        await using controller = createController({
          ...scope,
          admissionRunId: "source-less-run",
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          getEntry: () => entry,
          getSessionId: () => entry.sessionId,
          isRestartAbort: () => false,
          resolveDeliveryContext: () => undefined,
          setEntry: () => {},
        });
        await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
        expect(write).not.toHaveBeenCalled();
        expect(loadSessionEntry(scope)).toEqual(before);
      } finally {
        write.mockRestore();
      }
    },
  );

  it.each([
    { completion: "runtime", owner: "main", metadata: {} },
    { completion: "handled-silent", owner: "main", metadata: {} },
    { completion: "restart", owner: "main", metadata: {} },
    { completion: "restart", owner: "spawned child", metadata: { spawnDepth: 1 } },
    { completion: "restart", owner: "role-owned child", metadata: { subagentRole: "leaf" } },
  ] as const)(
    "settles source-less execution custody through $completion for $owner without claiming delivery authority",
    ({ completion, owner, metadata }) =>
      withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = {
          agentId: "main",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
          sessionKey: "agent:main:dashboard:recovery-admission",
        };
        const lifecycleGeneration = getAgentEventLifecycleGeneration();
        const executionRunId = "source-less-execution";
        let restartAborted = false;
        let entry: InternalSessionEntry = {
          sessionId: "source-less-session",
          updatedAt: 1,
          ...metadata,
        };
        const expectedRuns =
          owner === "main" ? [{ runId: executionRunId, lifecycleGeneration }] : undefined;
        await replaceSessionEntry(scope, entry);
        const recorder = createUserTurnTranscriptRecorder({
          message: { role: "user", content: "continue the task", timestamp: 1 },
          target: { ...scope, sessionId: entry.sessionId, sessionEntry: entry },
          updateMode: "none",
        });
        await using controller = createController({
          ...scope,
          admissionRunId: "source-less-run",
          executionRunId,
          lifecycleGeneration,
          getEntry: () => entry,
          getSessionId: () => entry.sessionId,
          isRestartAbort: () => restartAborted,
          resolveDeliveryContext: () => undefined,
          setEntry: (next) => {
            entry = next;
          },
        });

        await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
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

    async function createPlacementAdmission() {
      const root = placementDirs.make("openclaw-reply-placement-admission-");
      const scope = {
        agentId: "main",
        storePath: path.join(root, "sessions.json"),
        sessionKey: "agent:main:placement",
      };
      const entry: InternalSessionEntry = { sessionId: "placement-session", updatedAt: 1 };
      await replaceSessionEntry(scope, entry);
      const service = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ path: path.join(root, "placement.sqlite") }),
      });
      await service.startDispatch({
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        sessionId: entry.sessionId,
      });
      const context: placementContext.SessionWorkerPlacementContext = {
        workerSessionPlacementService: service,
      };
      vi.spyOn(placementContext, "resolveSessionWorkerPlacementContext").mockImplementation(
        () => context,
      );
      const sourceTurnId = "placement-source";
      const recorder = createUserTurnTranscriptRecorder({
        message: { role: "user", content: "continue", timestamp: 1, idempotencyKey: sourceTurnId },
        target: { ...scope, sessionId: entry.sessionId, sessionEntry: entry },
        updateMode: "none",
      });
      await expect(
        recorder.stageApproved?.({ runId: "placement-run", assertCurrent: () => {} }),
      ).resolves.toBe(true);
      const persistApproved = vi.spyOn(recorder, "persistApproved");
      const setEntry = vi.fn();
      let sessionId = entry.sessionId;
      const controller = createController({
        ...scope,
        getEntry: () => entry,
        getSessionId: () => sessionId,
        setEntry,
        sourceTurnId,
      });
      return {
        context,
        controller,
        entry,
        persistApproved,
        recorder,
        scope,
        service,
        setEntry,
        sourceTurnId,
        retarget: () => {
          sessionId = "successor-session";
        },
        [Symbol.asyncDispose]: () => controller[Symbol.asyncDispose](),
      };
    }

    it("leaves staged worker input with placement admission without caller-thread SQL", async () => {
      await using fixture = await createPlacementAdmission();
      const hostSql = observeHostDataSql();
      try {
        expect(fixture.service.getMany([fixture.entry.sessionId]).size).toBe(1);
        expect(hostSql.queries.length).toBeGreaterThan(0);
        hostSql.calls.forEach((call) => call.mockClear());
        hostSql.queries.length = 0;

        await expect(fixture.controller.admitUserTurn(fixture.recorder)).resolves.toBe("admitted");

        expect(hostSql.queries).toEqual([]);
        expect(fixture.persistApproved).not.toHaveBeenCalled();
        expect(fixture.recorder.hasPersisted()).toBe(false);
        expect(fixture.setEntry).not.toHaveBeenCalled();
      } finally {
        hostSql.restore();
      }
    });

    it("refuses an unavailable placement observation instead of reading synchronously", async () => {
      await using fixture = await createPlacementAdmission();
      fixture.context.workerSessionPlacementService = {
        getMany: (ids) => fixture.service.getMany(ids),
      };
      const hostSql = observeHostDataSql();
      try {
        await expect(fixture.controller.admitUserTurn(fixture.recorder)).rejects.toThrow(
          "Worker placement observation service is unavailable",
        );
        expect(hostSql.queries).toEqual([]);
        expect(fixture.persistApproved).not.toHaveBeenCalled();
      } finally {
        hostSql.restore();
      }
    });

    it.each([
      "placement-publication",
      "session-retarget",
      "lifecycle-rotation",
      "service-replacement",
      "service-removal",
      "pending-input-persisted",
      "terminal-source",
    ] as const)("revalidates %s while placement preparation is pending", async (change) => {
      await using fixture = await createPlacementAdmission();
      const prepared = createDeferred();
      const resume = createDeferred();
      const prepare = fixture.service.prepareRuntimeRefresh.bind(fixture.service);
      vi.spyOn(fixture.service, "prepareRuntimeRefresh").mockImplementation(async (sessionId) => {
        const observation = await prepare(sessionId);
        prepared.resolve();
        await resume.promise;
        return observation;
      });
      const admission = fixture.controller.admitUserTurn(fixture.recorder);
      const outcome = admission.catch((error: unknown) => error);
      try {
        await awaitGateBeforeSettlement(
          prepared.promise,
          admission,
          "admission settled before placement preparation",
        );
        if (change === "placement-publication") {
          await fixture.service.fail({
            sessionId: fixture.entry.sessionId,
            recoveryError: "placement interrupted",
          });
        } else if (change === "session-retarget") {
          fixture.retarget();
        } else if (change === "lifecycle-rotation") {
          rotateAgentEventLifecycleGeneration();
        } else if (change === "service-replacement") {
          fixture.context.workerSessionPlacementService = { ...fixture.service };
        } else if (change === "service-removal") {
          fixture.context.workerSessionPlacementService = undefined;
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
            "placement-publication": `Session ${fixture.entry.sessionId} placement authority changed`,
            "session-retarget": "session changed before durable user-turn admission",
            "service-replacement":
              "Worker placement service changed before durable user-turn admission",
            "service-removal":
              "Worker placement service changed before durable user-turn admission",
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
      const scope = {
        agentId: "ops",
        storePath: path.join(tempDirs.make("openclaw-reply-read-owner-"), "sessions.json"),
        sessionKey: "global",
      };
      const entry: InternalSessionEntry = {
        sessionId: "original-session",
        updatedAt: 1,
        status: undefined,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryBeforeAgentReplyState: "handled-reply",
      };
      await replaceSessionEntry(scope, entry);
      const before = loadSessionEntry(scope);
      const operation = createReplyOperation({
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        sessionId: entry.sessionId,
        resetTriggered: false,
      });
      const setEntry = vi.fn();
      await using controller = createController(
        {
          ...scope,
          admissionRunId: "recovery-run",
          getEntry: () => entry,
          getSessionId: () => operation.sessionId,
          setEntry,
        },
        operation,
      );
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
          expect(isAgentRunStaleLifecycleError(failure)).toBe(true);
        }
        expect(setEntry).not.toHaveBeenCalled();
        expect(loadSessionEntry(scope)).toEqual(before);
      } finally {
        await outcome;
        operation.complete();
      }
    },
  );

  it.each(["global", "unknown"])(
    "keeps the selected agent through a %s hook checkpoint",
    async (sessionKey) => {
      const root = tempDirs.make("openclaw-owned-reply-claim-");
      const storePath = path.join(root, "sessions.json");
      const main = { agentId: "main", storePath, sessionKey };
      const ops = { agentId: "ops", storePath, sessionKey };
      await replaceSessionEntry(main, { sessionId: "main-session", updatedAt: 1 });
      const mainBefore = loadSessionEntry(main);
      await using fixture = await createTrackedClaim(
        { sessionId: "ops-session", restartRecoveryDeliveryRunId: "ops-recovery" },
        { ...ops, admissionRunId: "ops-recovery" },
      );
      const { controller } = fixture;
      await expect(controller.admitUserTurn()).resolves.toBe("admitted");
      const hostSql = observeHostDataSql();
      try {
        expect(loadSessionEntry(ops)?.sessionId).toBe("ops-session");
        expect(hostSql.calls.some((call) => call.mock.calls.length > 0)).toBe(true);
        hostSql.calls.forEach((call) => call.mockClear());
        expect(await controller.isArmed()).toBe(false);
        hostSql.calls.forEach((call) => expect(call).not.toHaveBeenCalled());
      } finally {
        hostSql.restore();
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
    },
  );

  it("adopts an exact channel recovery claim before execution starts", async () => {
    const deliveryContext = {
      channel: "telegram",
      to: "chat",
      accountId: "default",
      threadId: "thread",
    };
    await using fixture = await createTrackedClaim(
      {
        abortedLastRun: false,
        lifecycleRunId: "recovery-run",
        restartRecoveryDeliveryContext: deliveryContext,
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
        restartRecoveryDeliverySourceRunId: "source-turn",
        restartRecoveryDeliveryToolCallId: "message-call",
        sessionId: "channel-session",
        startedAt: 1,
        updatedAt: 1,
      },
      {
        sessionKey: "agent:main:telegram:group:chat:topic:thread",
        resolveDeliveryContext: () => deliveryContext,
        sourceTurnId: "source-turn",
      },
    );
    const { controller, read } = fixture;

    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    const persisted = read();
    expect(persisted).toMatchObject({
      restartRecoveryDeliveryContext: deliveryContext,
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "source-turn",
      restartRecoveryDeliveryToolCallId: "message-call",
    });
    expect(persisted?.status).toBeUndefined();
  });

  it("adopts and settles acknowledged input through hook checkpoints without caller-thread SQL", async () => {
    await using fixture = await createAcknowledgedClaim();
    const persistApproved = vi.spyOn(fixture.recorder, "persistApproved");
    const sql = observeHostDataSql();
    try {
      await expect(fixture.controller.admitUserTurn(fixture.recorder)).resolves.toBe("admitted");
      expect(sql.queries).toEqual([]);
      expect(fixture.current().restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
      invalidateRegisteredAgentDatabasesMemo({});
      await expect(fixture.controller.beginBeforeAgentReply()).resolves.toBe(true);
      expect(fixture.current().restartRecoveryBeforeAgentReplyState).toBe("pending");
      await fixture.controller.checkpointBeforeAgentReply({ state: "handled-silent" });
      expect(fixture.current().restartRecoveryBeforeAgentReplyState).toBe("handled-silent");
      invalidateRegisteredAgentDatabasesMemo({});
      await fixture.controller.clear();
      expect(sql.queries).toEqual([]);
      expect(persistApproved).not.toHaveBeenCalled();
    } finally {
      sql.restore();
      persistApproved.mockRestore();
    }
    const persisted = fixture.read();
    expect(persisted).toMatchObject({
      sessionId: fixture.transcriptScope.sessionId,
      status: "done",
      restartRecoveryTerminalRunIds: [fixture.sourceTurnId],
    });
    expect(persisted?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(persisted?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(persisted?.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
    expect(
      loadTranscriptEventsSync(fixture.transcriptScope).filter(
        (event) => isRecord(event) && event.type === "message",
      ),
    ).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          role: "user",
          content: "Synthetic acknowledged input",
          idempotencyKey: `${fixture.sourceTurnId}:user`,
        }),
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
      if (stage === "cleanup") {
        await expect(fixture.controller.admitUserTurn(fixture.recorder)).resolves.toBe("admitted");
      }
      const replace = () => {
        replaceSessionEntrySync(fixture.scope, {
          ...fixture.read()!,
          ...(change === "metadata"
            ? { model: "concurrent-model" }
            : { restartRecoveryDeliverySourceRunId: "concurrent-source" }),
        });
      };
      const { actor } = expectDefined(
        await fixture.controller.acquireSessionActor(),
        "durable recovery actor",
      );
      const adopt = actor.adoptRun.bind(actor);
      const patch = entryPatch.patchSessionEntryInWorker;
      const spy =
        stage === "admission"
          ? vi.spyOn(actor, "adoptRun").mockImplementationOnce((...args) => {
              replace();
              return adopt(...args);
            })
          : vi.spyOn(entryPatch, "patchSessionEntryInWorker").mockImplementationOnce((params) => {
              replace();
              return patch(params);
            });
      try {
        const outcome = await (
          stage === "cleanup"
            ? fixture.controller.clear()
            : fixture.controller.admitUserTurn(fixture.recorder)
        ).catch((error: unknown) => error);
        if (change === "metadata") {
          expect(outcome).toBe(stage === "cleanup" ? undefined : "admitted");
          expect(fixture.current().model).toBe("concurrent-model");
        } else if (stage === "admission") {
          expect(isRestartRecoveryClaimChangedError(outcome)).toBe(true);
        } else {
          expect(outcome).toBeUndefined();
        }
        expect(spy).toHaveBeenCalled();
        const persisted = fixture.read();
        expect(persisted?.status).toBeUndefined();
        expect(persisted?.restartRecoveryDeliveryRunId).toBe(
          stage === "cleanup" && change === "metadata" ? undefined : "recovery-run",
        );
        expect(persisted?.restartRecoveryDeliverySourceRunId).toBe(
          change === "source-claim"
            ? "concurrent-source"
            : stage === "cleanup"
              ? undefined
              : fixture.sourceTurnId,
        );
        expect(persisted?.restartRecoveryDeliveryRequestFingerprint).toBe(
          stage === "admission" && change === "source-claim"
            ? "acknowledged-fingerprint"
            : undefined,
        );
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each(["transaction", "commit"] as const)(
    "preserves lifecycle refusal at the actor %s boundary without writing the hook checkpoint",
    async (boundary) => {
      await using fixture = await createAcknowledgedClaim();
      await fixture.controller.admitUserTurn(fixture.recorder);
      const before = fixture.read();
      const { actor } = expectDefined(
        await fixture.controller.acquireSessionActor(),
        "durable recovery actor",
      );
      const adopt = actor.adoptRun.bind(actor);
      let revoked = false;
      const spy = vi.spyOn(actor, "adoptRun").mockImplementationOnce((input, authority, observer) =>
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
      try {
        const failure = await fixture.controller
          .beginBeforeAgentReply()
          .catch((error: unknown) => error);
        expect(revoked).toBe(true);
        expect(isAgentRunStaleLifecycleError(failure)).toBe(true);
        expect(fixture.read()).toEqual(before);
        expect(fixture.current()).toEqual(before);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each(["begin", "handled-reply", "unhandled"] as const)(
    "rejects a stale lifecycle before the %s hook checkpoint",
    async (checkpoint) => {
      await using fixture = await createAcknowledgedClaim();
      await fixture.controller.admitUserTurn(fixture.recorder);
      if (checkpoint !== "begin") {
        await fixture.controller.beginBeforeAgentReply();
      }
      const original = structuredClone(fixture.current());
      await replaceSessionEntry(fixture.scope, {
        ...original,
        lifecycleRevision: "successor-generation",
      });
      const successor = fixture.read();

      await expect(
        checkpoint === "begin"
          ? fixture.controller.beginBeforeAgentReply()
          : fixture.controller.checkpointBeforeAgentReply(
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
      await fixture.controller.admitUserTurn(fixture.recorder);
      const original = structuredClone(fixture.current());
      const successor = {
        ...original,
        ...(replacement === "session" ? { sessionId: "successor-session" } : {}),
        lifecycleRevision: "successor-generation",
      };
      const patch = entryPatch.patchSessionEntryInWorker;
      let storedSuccessor: InternalSessionEntry | undefined;
      const spy = vi.spyOn(entryPatch, "patchSessionEntryInWorker").mockImplementation((params) => {
        // The released synchronous writer can replace the row after host admission.
        replaceSessionEntrySync(fixture.scope, successor);
        storedSuccessor = structuredClone(fixture.read());
        return patch(params);
      });
      try {
        await fixture.controller.clear();
        expect(spy).toHaveBeenCalledOnce();
        expect(fixture.current()).toEqual(original);
        expect(storedSuccessor).toMatchObject({
          sessionId: successor.sessionId,
          lifecycleRevision: successor.lifecycleRevision,
        });
        expect(fixture.read()).toEqual(storedSuccessor);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("retargets durable user-turn admission to the prepared reply session", async () => {
    const storePath = path.join(tempDirs.make("openclaw-reply-admission-"), "sessions.json");
    const sessionKey = "plugin-binding:codex:target";
    const sessionId = "bound-session-id";
    const entry = { sessionId, updatedAt: Date.now() };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const recorder = createUserTurnTranscriptRecorder({
      message: { role: "user", content: "hello", timestamp: 1 },
      target: {
        agentId: "main",
        sessionId: "unprepared-session",
        sessionKey: "unprepared-key",
        sessionEntry: undefined,
        storePath,
      },
      updateMode: "none",
    });
    const persistApproved = vi.spyOn(recorder, "persistApproved");
    await using controller = createController({
      getEntry: () => entry,
      getSessionId: () => sessionId,
      resolveUserTurnTarget: (target) => ({
        ...target,
        sessionEntry: target.entry,
        agentId: "main",
      }),
      sessionKey,
      setEntry: () => {},
      storePath,
    });

    await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
    expect(persistApproved).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSessionId: sessionId,
        target: expect.objectContaining({ sessionId, sessionKey, storePath, agentId: "main" }),
      }),
    );
    expect(recorder.getAdmissionReceipt()?.sessionId).toBe(sessionId);
  });

  it.each(["metadata", "recovery-cycle", "owner-release"] as const)(
    "admits only unchanged recovery ownership after a concurrent %s write",
    async (change) => {
      const storePath = path.join(tempDirs.make("openclaw-reply-admission-race-"), "sessions.json");
      const sessionKey = "agent:main:telegram:group:chat:topic:thread";
      const scope = { storePath, sessionKey };
      const sessionId = "channel-session-id";
      const sourceTurnId = "telegram-update-new";
      const deliveryContext = {
        channel: "telegram",
        to: "chat",
        accountId: "default",
        threadId: "thread",
      };
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
        expect(owner.kind).toBe("claimed");
        if (owner.kind !== "claimed") {
          throw new Error("recovery owner was not acquired");
        }
        releaseOwner = () => releaseMainSessionRecoveryOwner(owner.lease);
        entry = (await updateSessionEntry(scope, () => entry)) as InternalSessionEntry;
      } else {
        await replaceSessionEntry(scope, entry);
      }
      const sourceMessage = {
        role: "user" as const,
        content: "continue",
        idempotencyKey: sourceTurnId,
        timestamp: 1,
      };
      const recorder = createUserTurnTranscriptRecorder({
        message: sourceMessage,
        target: { agentId: "main", sessionEntry: entry, sessionId, ...scope },
        updateMode: "none",
      });
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
      await using controller = createController({
        getEntry: () => entry,
        getSessionId: () => sessionId,
        resolveDeliveryContext: () => deliveryContext,
        setEntry: (next) => {
          entry = next;
        },
        sourceTurnId,
        ...scope,
      });

      if (change === "metadata") {
        await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
        expect(persistApproved).not.toHaveBeenCalled();
        const persisted = loadSessionEntry(scope);
        expect(persisted).toMatchObject({
          model: "gpt-5.6-luna",
          restartRecoveryDeliverySourceRunId: sourceTurnId,
        });
        expect(persisted?.status).toBeUndefined();
      } else {
        await expect(controller.admitUserTurn(recorder)).rejects.toThrow(
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
