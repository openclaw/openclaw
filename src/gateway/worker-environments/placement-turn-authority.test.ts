import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { captureAgentToolSourceExecutionGuard } from "../../agents/agent-tool-source-execution-guard.js";
import { createAgentHarnessHostCapabilities } from "../../agents/harness/host-capability.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { createStubTool } from "../../agents/test-helpers/agent-tool-stubs.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { createAgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { placementTurnOwner, type WorkerSessionPlacementIdentity } from "./placement-record.js";
import { updateTransition } from "./placement-row-codec.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import {
  advancePlacementFixtureToActive,
  createPlacementTurnClaimFixtureOps,
} from "./placement-test-fixtures.js";
import {
  isPlacementTurnToolAuthorized,
  stagePlacementTurnClaimWorkerPublication,
  stagePlacementTurnToolWorkerPublication,
} from "./placement-turn-authority.js";
import * as workerTurnOwners from "./placement-turn-claim-events.js";
import {
  bindWorkerTurnOwner,
  getWorkerTurnExecutionIdentityCapability,
  readWorkerTurnPromptCacheContext,
} from "./placement-turn-claim-events.js";
import { createPlacementWorkspaceResultOps } from "./placement-workspace-result.js";
import { createWorkerSessionToolSourceRunner } from "./worker-session-tool-source.js";
import { prepareWorkerAgentRuntimeIdentity } from "./worker-turn-payload.js";
import { captureWorkerTurnTranscriptSource } from "./worker-turn-transcript-target.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-placement-claim-close",
  agentId: "main",
  sessionKey: "agent:main:placement-claim-close",
};
let root: string;
let database: OpenClawStateDatabase;
let store: WorkerSessionPlacementStore;
let sessionTarget: BoundAgentRunSessionTarget;

beforeEach(async () => {
  root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-placement-authority-"),
  );
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  store = createWorkerSessionPlacementStore({ database });
  sessionTarget = { ...SESSION, storePath: path.join(root, "sessions.json") };
});
afterEach(async () => {
  await closeStateDatabaseForTest();
  await fs.rm(root, { recursive: true, force: true });
});
function advanceToActive(executionMode: "worker-turn" | "remote-exec" = "worker-turn") {
  return advancePlacementFixtureToActive(store, database, { ...SESSION, executionMode });
}

function workerClaimInput(name: string, active: Awaited<ReturnType<typeof advanceToActive>>) {
  return {
    ...SESSION,
    claimId: `claim-${name}`,
    runId: `run-${name}`,
    owner: placementTurnOwner(active),
  };
}

it("publishes native pending-result postimages before observers and rolls back tentative changes", async () => {
  const active = await advanceToActive();
  const claim = await store.claimTurn(workerClaimInput("native-result", active));
  await store.markWorkspaceResultPending(claim);
  const pending = store.preparedWorkspaceResult(claim)!;
  const results = createPlacementWorkspaceResultOps({
    path: database.path,
    instanceId: pending.gatewayInstanceId,
    now: () => 9_000,
    read: () => database.db,
    write: (write) => runOpenClawStateWriteTransaction(({ db }) => write(db), { database }),
  });
  const observed: Array<number | null | undefined> = [];
  const unsubscribe = sessionChanges.subscribe(() => {
    observed.push(store.preparedWorkspaceResult(claim)?.recoveryRequestedAtMs);
  });
  try {
    expect(() =>
      runOpenClawStateWriteTransaction(
        () => {
          results.handoffWorkspaceResultRecovery(claim);
          throw new Error("rollback native result");
        },
        { database },
      ),
    ).toThrow("rollback native result");
    expect(store.preparedWorkspaceResult(claim)).toBe(pending);
    expect(observed).toEqual([]);
    results.handoffWorkspaceResultRecovery(claim);
    expect(store.preparedWorkspaceResult(claim)?.recoveryRequestedAtMs).toBe(9_000);
    expect(observed).toEqual([9_000]);
    expect(pending.recoveryRequestedAtMs).toBeNull();
    results.abandonWorkspaceResult(store.preparedWorkspaceResult(claim)!);
    expect(store.preparedWorkspaceResult(claim)).toBeUndefined();
    expect(observed).toEqual([9_000, undefined]);
  } finally {
    unsubscribe();
  }
});

it.each(["native", "worker"] as const)(
  "revokes the maintenance inventory when a %s writer returns a failed placement to local",
  async (writer) => {
    await store.startDispatch(SESSION);
    const failed = await store.fail({
      sessionId: SESSION.sessionId,
      recoveryError: "dispatch failed",
    });
    const inventory = await store.prepareMaintenancePlacements();
    try {
      expect(inventory.placements).toEqual([failed]);
      if (writer === "native") {
        runOpenClawStateWriteTransaction(({ db }) => updateTransition(db, failed, "local", {}, 1), {
          database,
        });
      } else {
        await store.transition({
          sessionId: SESSION.sessionId,
          from: "failed",
          to: "local",
          expectedGeneration: failed.generation,
        });
      }
      expect(() => inventory.assertCurrent()).toThrow("placement inventory changed");
    } finally {
      inventory.release();
    }
  },
);

it.each(["requested", "worker-turn", "remote-exec", "unknown"] as const)(
  "fences maintenance across committed and uncertain %s to local publications",
  async (prior) => {
    const previous =
      prior === "worker-turn" || prior === "remote-exec"
        ? await advanceToActive(prior)
        : await store.startDispatch(SESSION);
    const identity = requireOpenClawStateDatabaseIdentity({ db: database.db });
    for (const settlement of ["commit", "invalidate"] as const) {
      const inventory = await store.prepareMaintenancePlacements();
      const publication = stagePlacementTurnClaimWorkerPublication(
        identity,
        {
          ...SESSION,
          state: "local",
          executionMode: "worker-turn",
          environmentId: null,
          activeOwnerEpoch: null,
          turnClaim: null,
        },
        undefined,
        prior === "unknown" ? undefined : previous.state,
      );
      try {
        expect.soft(() => inventory.assertCurrent()).toThrow("placement inventory changed");
        publication[settlement]();
        expect.soft(() => inventory.assertCurrent()).toThrow("placement inventory changed");
      } finally {
        publication.rollback();
        inventory.release();
      }
    }
  },
);

it("retains worker-parent source predicates through tool execution and rejects a reset before child commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target: BoundAgentRunSessionTarget = {
      ...SESSION,
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      expectedLifecycleRevision: "parent-lifecycle",
      expectedWriterRunId: "parent-writer",
    };
    const parent = {
      sessionId: target.sessionId,
      updatedAt: 1,
      lifecycleRevision: target.expectedLifecycleRevision,
      activeWriterRunId: target.expectedWriterRunId,
    };
    await replaceSessionEntry(target, parent);
    const active = await advanceToActive();
    const claim = await store.claimTurn(workerClaimInput("child-source", active));
    await store.authorizeWorkerTurnTools(claim, ["sessions_spawn"]);
    const source = captureWorkerTurnTranscriptSource(target);
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef(claim.runId),
      assertSourceCurrent: source,
      facts: {
        runId: claim.runId,
        agentId: SESSION.agentId,
        ingress: { kind: "worker", boundary: "test.child-source", state: "present" },
      },
    });
    let host: ReturnType<typeof createAgentHarnessHostCapabilities> | undefined;
    try {
      const prepared = await prepareWorkerAgentRuntimeIdentity({
        agentId: SESSION.agentId,
        sessionKey: SESSION.sessionKey,
        sessionTarget: target,
        promptCacheContext: { boundaryCount: 0 },
        assertSourceCurrent: source,
        runtimeInstanceId: active.environmentId,
        placements: store,
        turnClaim: claim,
        turn: {
          ...SESSION,
          sessionFile: SESSION.sessionKey,
          workspaceDir: state.root,
          prompt: "synthetic worker parent",
          timeoutMs: 5_000,
          runId: claim.runId,
          preparedRunAdmission: admission,
        },
      });
      const runner = createWorkerSessionToolSourceRunner({
        placements: store,
        resolveGatewayContext: () => undefined,
      });
      const writeChild = (reset: boolean) =>
        runner({
          source: { ...SESSION, turnClaim: claim },
          request: {
            identity: {
              environmentId: active.environmentId,
              ownerEpoch: active.activeOwnerEpoch,
              sessionId: claim.sessionId,
              runId: claim.runId,
              turnClaim: claim,
              credentialHash: "synthetic-child-source",
              bundleHash: "synthetic-child-source",
              rpcSetVersion: 1,
              protocolFeatures: [],
              credentialExpiresAtMs: 1,
            },
            toolName: "sessions_spawn",
            request: { toolCallId: "child-source", arguments: {} },
            tool: () => {
              host = createAgentHarnessHostCapabilities({
                attempt: {
                  ...target,
                  runId: claim.runId,
                  admittedRunContext: prepared.admittedRunContext,
                },
                pluginId: "synthetic-worker",
              });
              return host.capabilities.bindToolSurface([
                {
                  ...createStubTool("sessions_spawn"),
                  execute: async () => {
                    const guard = captureAgentToolSourceExecutionGuard();
                    const sql = reset ? undefined : observeHostDataSql();
                    const child = await patchSessionEntryCore(
                      { ...target, sessionKey: `agent:main:child-source-${reset}` },
                      () => {
                        if (reset) {
                          replaceSessionEntrySync(target, {
                            ...parent,
                            lifecycleRevision: "replacement",
                          });
                        }
                        return { label: "child" };
                      },
                      {
                        workerGuard: { source: guard },
                        fallbackEntry: {
                          sessionId: `child-${reset}`,
                          updatedAt: 1,
                          parentSessionKey: target.sessionKey,
                        },
                        skipMaintenance: true,
                      },
                    ).finally(() => sql?.restore());
                    if (sql) {
                      expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
                    }
                    return { content: [], details: child };
                  },
                },
              ])[0]!;
            },
          },
        });
      expect((await writeChild(false)).details).toMatchObject({
        sessionId: "child-false",
        parentSessionKey: target.sessionKey,
        label: "child",
      });
      host?.close();
      await expect(writeChild(true)).rejects.toThrow(
        `Session ${target.sessionId} worker turn authority changed`,
      );
      expect(loadSessionEntry(target)?.lifecycleRevision).toBe("replacement");
      expect(
        loadSessionEntry({ ...target, sessionKey: "agent:main:child-source-true" }),
      ).toBeUndefined();
    } finally {
      host?.close();
      await store.releaseTurn(claim);
      admission.close();
    }
  });
});

it("fences pending tool revocation and cannot revive grants after claim release", async () => {
  const active = await advanceToActive();
  const claim = await store.claimTurn({
    ...SESSION,
    claimId: "tool-publication",
    runId: "tool-publication-run",
    owner: placementTurnOwner(active),
  });
  const identity = requireOpenClawStateDatabaseIdentity({ db: database.db });
  const grant = () =>
    stagePlacementTurnToolWorkerPublication(identity, { claim, toolNames: ["sessions_send"] });
  const authorized = () => isPlacementTurnToolAuthorized(identity, claim, "sessions_send");
  grant().commit();
  expect(authorized()).toBe(true);
  expect(
    isPlacementTurnToolAuthorized(
      identity,
      { ...claim, owner: { kind: "local" } },
      "sessions_send",
    ),
  ).toBe(false);
  const refused = stagePlacementTurnToolWorkerPublication(identity, { claim, toolNames: null });
  expect(authorized()).toBe(false);
  refused.rollback();
  expect(authorized()).toBe(true);
  const delayed = grant();
  await store.releaseTurn(claim);
  expect(authorized()).toBe(false);
  delayed.commit();
  expect(authorized()).toBe(false);
});

it.each([
  { settlement: "commit", replace: true },
  { settlement: "invalidate", replace: true },
  { settlement: "invalidate", replace: false },
] as const)(
  "settles dispatch $settlement authority without revoking a replacement (replace: $replace)",
  async ({ settlement, replace }) => {
    const predecessor = await store.claimTurn({
      ...SESSION,
      claimId: "local-predecessor",
      runId: "local-run",
      owner: { kind: "local" },
    });
    const predecessorAuthority = await store.prepareTurnClaimAuthority(predecessor);
    const previous = store.get(SESSION.sessionId);
    if (!previous) {
      throw new Error("expected local predecessor placement");
    }
    const publication = stagePlacementTurnClaimWorkerPublication(
      requireOpenClawStateDatabaseIdentity({ db: database.db }),
      { ...previous, state: "requested" },
    );
    expect(predecessorAuthority.isCurrent()).toBe(true);
    if (!replace) {
      try {
        const revoked = vi.fn();
        predecessorAuthority.onRevoked(revoked);
        publication.invalidate();
        expect(predecessorAuthority.isCurrent()).toBe(false);
        expect(revoked).toHaveBeenCalledOnce();
        publication.commit();
        expect(predecessorAuthority.isCurrent()).toBe(false);
        expect(revoked).toHaveBeenCalledOnce();
      } finally {
        predecessorAuthority.release();
      }
      return;
    }
    await store.releaseTurn(predecessor);
    const active = await advanceToActive();
    const successor = await store.claimTurn({
      ...SESSION,
      claimId: "worker-successor",
      runId: "worker-run",
      owner: placementTurnOwner(active),
    });
    const successorAuthority = await store.prepareTurnClaimAuthority(successor);
    try {
      publication[settlement]();
      expect(predecessorAuthority.isCurrent()).toBe(false);
      expect(successorAuthority.isCurrent()).toBe(true);
      expect(store.validateTurnClaim(successor)).toBe(true);
    } finally {
      predecessorAuthority.release();
      successorAuthority.release();
    }
  },
);

it.each([
  { mode: "local", failed: false },
  { mode: "worker-turn", failed: false },
  { mode: "remote-exec", failed: false },
  { mode: "remote-exec", failed: true },
] as const)(
  "retains prepared $mode claims across compatible transitions (persisted failed: $failed)",
  async ({ mode, failed }) => {
    const active = mode === "local" ? undefined : await advanceToActive(mode);
    const claim = await store.claimTurn({
      ...SESSION,
      claimId: "claim-prepared-continuity",
      runId: "run-prepared-continuity",
      owner: active ? placementTurnOwner(active) : { kind: "local" },
    });
    if (failed) {
      // The decoder accepts this persisted shape; a new drain requires reconciliation first.
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare(`UPDATE worker_session_placements SET state = 'failed',
          recovery_error = 'previous worker failure', terminal_reason = 'previous worker failure',
          terminal_at_ms = 1 WHERE session_id = ?`).run(claim.sessionId);
        },
        { database },
      );
    }
    const authority = await store.prepareTurnClaimAuthority(claim);
    try {
      if (failed) {
        expect(authority.isCurrent()).toBe(true);
        await store.fail({ sessionId: claim.sessionId, recoveryError: "cleanup is still pending" });
      } else if (active) {
        if (claim.owner.kind === "worker") {
          await store.updateAckCursors({ claim, liveEvent: 2 });
          expect(authority.isCurrent()).toBe(true);
          await store.startWorkspaceResultDrain(claim);
        } else {
          await store.startDrain({
            sessionId: claim.sessionId,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
            expectedGeneration: active.generation,
          });
        }
      } else {
        await store.startDispatch(SESSION);
        expect(authority.isCurrent()).toBe(true);
        await store.fail({
          sessionId: claim.sessionId,
          recoveryError: "synthetic dispatch failure",
        });
      }
      expect(authority.isCurrent()).toBe(true);
      if (failed) {
        await store.releaseTurn(claim);
        expect(authority.isCurrent()).toBe(false);
      }
    } finally {
      authority.release();
    }
  },
);

it("rolls back claim fencing and never revives a retained approval after same-ID readmission", async () => {
  const active = await advanceToActive();
  const input = workerClaimInput("reused-after-release", active);
  const claim = await store.claimTurn(input);
  const instance = createOperationalRunInstanceRef(claim.runId);
  const delegated = claimAgentRunDelegatedAuthority(instance);
  await bindWorkerTurnOwner(store, claim, undefined, instance, sessionTarget, () => {});
  const capability = getWorkerTurnExecutionIdentityCapability(store, claim);
  if (!capability) {
    throw new Error("expected retained worker capability");
  }
  const validate = createAgentRuntimeApprovalAuthorityValidator(store);
  const identityParams = await capability.run((owner) => ({
    agentId: owner.agentId,
    sessionKey: owner.sessionKey,
    operationalRunInstance: owner.operationalRunInstance,
    approvalAuthority: owner.delegatedAuthority,
    workerTurnClaim: owner.turnClaim,
  }));
  const identity = await createAgentRuntimeIdentity(identityParams);
  const delayedIdentity = await createAgentRuntimeIdentity(identityParams);
  if (!identity || !delayedIdentity) {
    throw new Error("expected worker runtime identities");
  }
  const closed = vi.fn();
  const unregister = store.registerTurnClaimClosedHandler(closed);
  try {
    expect(validate(identity)).toBe(true);
    expect(() =>
      runOpenClawStateWriteTransaction(
        () => {
          createPlacementTurnClaimFixtureOps(database).releaseTurn(claim);
          expect(validate(identity)).toBe(false);
          expect(closed).not.toHaveBeenCalled();
          throw new Error("roll back outer placement transaction");
        },
        { database },
      ),
    ).toThrow("roll back outer placement transaction");
    expect(validate(identity)).toBe(true);
    await expect(capability.run(() => "still current")).resolves.toBe("still current");
    expect(closed).not.toHaveBeenCalled();

    const replacement = runOpenClawStateWriteTransaction(
      () => {
        const claims = createPlacementTurnClaimFixtureOps(database);
        claims.releaseTurn(claim);
        return claims.claimTurn(input);
      },
      { database },
    );
    expect(closed).toHaveBeenCalledOnce();
    const nextOwner = await bindWorkerTurnOwner(
      store,
      replacement,
      undefined,
      instance,
      sessionTarget,
      () => {},
    );
    expect(validate({ ...identity })).toBe(false);
    expect(validate(delayedIdentity)).toBe(false);
    await expect(capability.run(() => "stale")).rejects.toThrow("worker turn authority changed");
    expect(validateAgentRunDelegatedAuthority(delegated)).toBe(true);
    const next = await nextOwner.capability.run((owner) =>
      createAgentRuntimeIdentity({
        ...identityParams,
        approvalAuthority: owner.delegatedAuthority,
        workerTurnClaim: owner.turnClaim,
      }),
    );
    if (!next || next.delegatedAuthority.kind !== "worker") {
      throw new Error("expected replacement worker identity");
    }
    expect(validate(next)).toBe(true);
    next.delegatedAuthority.turnClaim = { ...replacement, claimId: "another claim" };
    expect(validate(next)).toBe(false);
  } finally {
    unregister();
    releaseAgentRunDelegatedAuthority(delegated);
  }
});

it("rejects a prepared reader reply after an identical claim was released and readmitted", async () => {
  const active = await advanceToActive();
  const input = workerClaimInput("delayed-preparation", active);
  const claim = await store.claimTurn(input);
  const read = store.readProjection.bind(store);
  const observed = createDeferredCore();
  const resume = createDeferredCore();
  vi.spyOn(store, "readProjection").mockImplementationOnce(async (...args) => {
    const result = await read(...args);
    observed.resolve();
    await resume.promise;
    return result;
  });
  const preparing = store.prepareTurnClaimAuthority(claim);
  try {
    await observed.promise;
    await store.releaseTurn(claim);
    const replacement = await store.claimTurn(input);
    resume.resolve();
    await expect(preparing).rejects.toThrow("turn claim authority changed");
    const current = await store.prepareTurnClaimAuthority(replacement);
    expect(current.isCurrent()).toBe(true);
    current.release();
  } finally {
    resume.resolve();
    await Promise.allSettled([preparing]);
  }
});

it.each(["preparing", "bound", "final source check"] as const)(
  "rejects revoked execution-owner authority during %s",
  async (phase) => {
    const active = await advanceToActive();
    const claim = await store.claimTurn(workerClaimInput("source-read-order", active));
    const instance = createOperationalRunInstanceRef(claim.runId);
    const delegated = claimAgentRunDelegatedAuthority(instance);
    const assertSourceCurrent = vi.fn();
    if (phase === "final source check") {
      assertSourceCurrent
        .mockImplementationOnce(() => {})
        .mockImplementation(() => {
          throw new Error("run closed during binding");
        });
    }
    const prepare = store.prepareTurnClaimAuthority.bind(store);
    const preparation =
      phase === "preparing"
        ? vi.spyOn(store, "prepareTurnClaimAuthority").mockImplementationOnce(async (input) => {
            const authority = await prepare(input);
            await store.releaseTurn(claim);
            return authority;
          })
        : undefined;
    try {
      const binding = bindWorkerTurnOwner(
        store,
        claim,
        undefined,
        instance,
        sessionTarget,
        assertSourceCurrent,
      );
      if (phase === "bound") {
        const { capability, takeFinishingOutcome } = await binding;
        await store.releaseTurn(claim);
        assertSourceCurrent.mockClear();
        expect(capability.receiptAuthority).toThrow("worker turn authority changed");
        expect(() => takeFinishingOutcome("synthetic-credential")).toThrow(
          "worker turn authority changed",
        );
      } else {
        await expect(binding).rejects.toThrow(
          phase === "preparing" ? "worker turn authority changed" : "run closed during binding",
        );
      }
      if (phase === "final source check") {
        expect(getWorkerTurnExecutionIdentityCapability(store, claim)).toBeUndefined();
      } else {
        expect(assertSourceCurrent).not.toHaveBeenCalled();
      }
    } finally {
      preparation?.mockRestore();
      releaseAgentRunDelegatedAuthority(delegated);
    }
  },
);

it("retains the original transcript and prompt cache facts while claim authority is prepared", async () => {
  const active = await advanceToActive();
  const claim = await store.claimTurn(workerClaimInput("target-snapshot", active));
  const instance = createOperationalRunInstanceRef(claim.runId);
  const delegated = claimAgentRunDelegatedAuthority(instance);
  const expected = {
    ...captureSessionTranscriptTargetBinding(sessionTarget),
    expectedLifecycleRevision: "original-lifecycle",
    expectedWriterRunId: claim.runId,
  };
  const requested = { ...expected };
  const promptCacheContext = {
    boundaryCount: 2,
    promptCacheKey: "gateway-cache",
    fastMode: true,
    fastModeStartedAtMs: 123,
    fastModeAutoOnSeconds: 30,
  };
  const binding = bindWorkerTurnOwner(
    store,
    claim,
    undefined,
    instance,
    requested,
    () => {},
    undefined,
    undefined,
    undefined,
    promptCacheContext,
  );
  const connection: WorkerConnectionIdentity = {
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    sessionId: claim.sessionId,
    runId: claim.runId,
    turnClaim: claim,
    credentialHash: "synthetic-credential-hash",
    bundleHash: "synthetic-bundle-hash",
    rpcSetVersion: 1,
    protocolFeatures: [],
    credentialExpiresAtMs: 1,
  };
  promptCacheContext.boundaryCount = 99;
  promptCacheContext.promptCacheKey = "replacement-cache";
  promptCacheContext.fastMode = false;
  promptCacheContext.fastModeStartedAtMs = 456;
  promptCacheContext.fastModeAutoOnSeconds = 60;
  requested.sessionId = "replacement-session";
  requested.storePath = path.join(root, "replacement.json");
  requested.expectedLifecycleRevision = "replacement-lifecycle";
  requested.expectedWriterRunId = "replacement-run";
  requested.env = { ...requested.env, OPENCLAW_STATE_DIR: path.join(root, "replacement-state") };
  try {
    const { capability } = await binding;
    expect(capability.sessionTarget).toEqual(expected);
    await capability.run((identity) => {
      expect(identity.sessionTarget).toEqual(expected);
    });
    expect(readWorkerTurnPromptCacheContext(connection)).toEqual({
      boundaryCount: 2,
      promptCacheKey: "gateway-cache",
      fastMode: true,
      fastModeStartedAtMs: 123,
      fastModeAutoOnSeconds: 30,
    });
    expect(
      readWorkerTurnPromptCacheContext({ ...connection, runId: "another-run" }),
    ).toBeUndefined();
    await store.releaseTurn(claim);
    expect(readWorkerTurnPromptCacheContext(connection)).toBeUndefined();
  } finally {
    await Promise.allSettled([binding]);
    if (store.validateTurnClaim(claim)) {
      await store.releaseTurn(claim);
    }
    releaseAgentRunDelegatedAuthority(delegated);
  }
});

it.each(["binding replacement", "run admission"] as const)(
  "rejects execution identity after authority changes during %s",
  async (phase) => {
    const active = await advanceToActive();
    const claim = await store.claimTurn(workerClaimInput("identity-authority", active));
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef(claim.runId),
      facts: {
        runId: claim.runId,
        agentId: SESSION.agentId,
        ingress: { kind: "worker", boundary: "test.worker-identity-authority", state: "present" },
      },
      ...(phase === "run admission"
        ? {
            onAdmitted: async () => {
              await store.releaseTurn(claim);
            },
          }
        : {}),
    });
    const bind = bindWorkerTurnOwner;
    const binding =
      phase === "binding replacement"
        ? vi
            .spyOn(workerTurnOwners, "bindWorkerTurnOwner")
            .mockImplementationOnce(async (...args) => {
              const original = await bind(...args);
              // Replace the owner before the awaiting caller can capture its receipt guard.
              await bind(...args);
              return original;
            })
        : undefined;
    const assertSourceCurrent = vi.fn();
    try {
      await expect(
        prepareWorkerAgentRuntimeIdentity({
          agentId: SESSION.agentId,
          sessionKey: SESSION.sessionKey,
          sessionTarget,
          promptCacheContext: { boundaryCount: 0 },
          assertSourceCurrent,
          runtimeInstanceId: active.environmentId,
          placements: store,
          turnClaim: claim,
          turn: {
            ...SESSION,
            sessionFile: path.join(root, "transcript.jsonl"),
            workspaceDir: root,
            prompt: "synthetic worker turn",
            timeoutMs: 5_000,
            runId: claim.runId,
            preparedRunAdmission: admission,
          },
        }),
      ).rejects.toThrow(
        phase === "run admission"
          ? "turn claim authority changed"
          : "worker turn authority changed",
      );
      if (phase === "binding replacement") {
        const successor = getWorkerTurnExecutionIdentityCapability(store, claim);
        if (!successor) {
          throw new Error("expected the same-claim successor to remain current");
        }
        expect(successor.receiptAuthority).not.toThrow();
      } else {
        expect(assertSourceCurrent).not.toHaveBeenCalled();
      }
    } finally {
      binding?.mockRestore();
      if (store.validateTurnClaim(claim)) {
        await store.releaseTurn(claim);
      }
      admission.close();
    }
  },
);

it("keeps authority revoked when COMMIT succeeds but its outcome is lost", async () => {
  const active = await advanceToActive();
  const claim = await store.claimTurn(workerClaimInput("lost-commit", active));
  const authority = await store.prepareTurnClaimAuthority(claim);
  const exec = database.db.exec.bind(database.db);
  const failure = new Error("synthetic lost placement COMMIT outcome");
  const intercepted = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
    exec(sql);
    if (sql === "COMMIT") {
      throw failure;
    }
  });
  try {
    expect(() => createPlacementTurnClaimFixtureOps(database).releaseTurn(claim)).toThrow(failure);
    expect(authority.isCurrent()).toBe(false);
    const persisted = new DatabaseSync(database.path, { readOnly: true });
    try {
      expect(
        persisted
          .prepare("SELECT turn_claim_id FROM worker_session_placements WHERE session_id = ?")
          .get(claim.sessionId),
      ).toMatchObject({ turn_claim_id: null });
    } finally {
      persisted.close();
    }
  } finally {
    intercepted.mockRestore();
    authority.release();
  }
});

it("shares claim revocation across facades while restart clearing leaves worker claims live", async () => {
  const active = await advanceToActive();
  const worker = await store.claimTurn(workerClaimInput("shared-facade", active));
  const local = await store.claimTurn({
    sessionId: "session-local-restart",
    agentId: "main",
    sessionKey: "agent:main:local-restart",
    claimId: "claim-local-restart",
    runId: "run-local-restart",
    owner: { kind: "local" },
  });
  const workerAuthority = await store.prepareTurnClaimAuthority(worker);
  const localAuthority = await store.prepareTurnClaimAuthority(local);
  const alias = path.join(root, "placement-alias.sqlite");
  await fs.symlink(database.path, alias);
  const facade = createWorkerSessionPlacementStore({
    database: openOpenClawStateDatabase({ path: alias }),
  });
  const inventory = await store.prepareMaintenancePlacements();
  try {
    expect(facade.clearLocalTurnClaimsAfterRestart()).toBe(1);
    expect(localAuthority.isCurrent()).toBe(false);
    expect(workerAuthority.isCurrent()).toBe(true);
    inventory.assertCurrent();
    facade.retireSessionPlacement({
      sessionId: local.sessionId,
      expectedState: "local",
      expectedGeneration: local.placementGeneration,
    });
    inventory.assertCurrent();
    await facade.authorizeWorkerTurnTools(worker, ["sessions_send"]);
    expect(workerAuthority.isCurrent()).toBe(true);
    await facade.releaseTurn(worker);
    expect(workerAuthority.isCurrent()).toBe(false);
    expect(() => inventory.assertCurrent()).toThrow("placement inventory changed");
  } finally {
    inventory.release();
    workerAuthority.release();
    localAuthority.release();
  }
});

it("does not adopt an identical claim from a replacement database", async () => {
  const active = await advanceToActive();
  const input = workerClaimInput("replaced-database", active);
  const original = await store.claimTurn(input);
  const authority = await store.prepareTurnClaimAuthority(original);
  const pathname = database.path;
  await closeStateDatabaseForTest();
  await fs.rename(pathname, `${pathname}.retired`);
  database = openOpenClawStateDatabase({ path: pathname });
  store = createWorkerSessionPlacementStore({ database });
  const replacementPlacement = await advanceToActive();
  const replacement = await store.claimTurn({
    ...input,
    owner: placementTurnOwner(replacementPlacement),
  });
  const next = await store.prepareTurnClaimAuthority(replacement);
  try {
    expect(replacement).toEqual(original);
    expect(authority.isCurrent()).toBe(false);
    expect(next.isCurrent()).toBe(true);
  } finally {
    authority.release();
    next.release();
  }
});
