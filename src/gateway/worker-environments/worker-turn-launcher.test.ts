import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_LAUNCH_V2_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  abortAndDrainEmbeddedAgentRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import * as preparedModelRuntime from "../../agents/prepared-model-runtime.js";
import {
  installSessionPlacementAdmissionProvider,
  prepareSessionPlacementSandbox,
  resolveSessionPlacementRuntimeOverride,
  sessionPlacementUsesWorkerInference,
} from "../../agents/session-placement-admission.js";
import {
  resolveSessionPlacementForcedTerminalSettlement,
  resolveSessionPlacementTurnSettlementAssertion,
} from "../../agents/session-placement-forced-terminal-settlement.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.operation.js";
import { bindReplyOperationDatabaseAdmission } from "../../auto-reply/reply/reply-turn-database-admission.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import * as sessionEntryReader from "../../config/sessions/session-entry-read-runtime.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createChatRunState } from "../server-chat-state.js";
import { prepareSessionLifecycleDrain } from "../server-methods/sessions-lifecycle-drain.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import {
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  withWorkerCompactionAdoption,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";

afterAll(closeStateDatabaseForTest);

describe("worker turn launcher local placement", () => {
  let localProvider: ReturnType<typeof createWorkerSessionTurnPlacementProvider>;
  beforeEach(async () => {
    await setupWorkerTurnLauncherTest();
    localProvider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });
  });
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

  it("reads absent sandbox placement without caller-thread SQL", async () => {
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });
    const uninstall = installSessionPlacementAdmissionProvider(provider);
    const sql = observeMainThreadSql();
    try {
      using prepared = await prepareSessionPlacementSandbox({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        workspaceDir: root,
      });
      expect(prepared.sandbox).toBeNull();
      prepared.assertCurrent();
      sql.expectIdle();
      await seedActivePlacement("remote-exec");
      sql.clear();
      expect(prepared.assertCurrent).toThrow("placement authority changed");
      sql.expectIdle();
    } finally {
      sql.restore();
      uninstall();
    }
  });

  it.each(["worker-turn", "remote-exec"] as const)(
    "uses current %s placement facts for worker inference without caller-thread SQL",
    async (executionMode) => {
      const environment = {
        ...attachedEnvironment(),
        providerId: "device",
        profileSnapshot: { settings: { inference: "worker" } },
      };
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: { ...unusedEnvironments(), get: () => environment },
        placements,
      });
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      const identity = { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main" };
      const sql = observeMainThreadSql();
      try {
        expect(await sessionPlacementUsesWorkerInference(identity)).toBe(false);
        sql.expectIdle();
        await seedActivePlacement(executionMode);
        sql.clear();
        expect(await sessionPlacementUsesWorkerInference(identity)).toBe(
          executionMode === "worker-turn",
        );
        for (const mismatch of [
          { sessionId: "other-session" },
          { sessionKey: "agent:main:other" },
          { agentId: "other-agent" },
        ]) {
          expect(await sessionPlacementUsesWorkerInference({ ...identity, ...mismatch })).toBe(
            false,
          );
        }
        environment.ownerEpoch += 1;
        expect(await sessionPlacementUsesWorkerInference(identity)).toBe(false);
        sql.expectIdle();
      } finally {
        sql.restore();
        uninstall();
      }
      expect(await sessionPlacementUsesWorkerInference(identity)).toBe(false);
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "uses only the matching %s placement as a runtime default",
    async (executionMode) => {
      const uninstall = installSessionPlacementAdmissionProvider(localProvider);
      const identity = { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main" };
      const sql = observeMainThreadSql();
      try {
        expect(await resolveSessionPlacementRuntimeOverride(identity)).toBeUndefined();
        sql.expectIdle();
        await seedActivePlacement(executionMode);
        sql.clear();
        expect(await resolveSessionPlacementRuntimeOverride(identity)).toBe(
          executionMode === "worker-turn" ? "openclaw" : undefined,
        );
        expect(await resolveSessionPlacementRuntimeOverride({ sessionId: SESSION_ID })).toBe(
          executionMode === "worker-turn" ? "openclaw" : undefined,
        );
        for (const mismatch of [
          { sessionId: "other-session" },
          { sessionKey: "agent:main:other" },
          { agentId: "other-agent" },
        ]) {
          expect(
            await resolveSessionPlacementRuntimeOverride({ ...identity, ...mismatch }),
          ).toBeUndefined();
        }
        sql.expectIdle();
      } finally {
        sql.restore();
        uninstall();
      }
      expect(await resolveSessionPlacementRuntimeOverride(identity)).toBeUndefined();
    },
  );

  it("rejects a transcript target without a session incarnation", () => {
    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        sessionId: "current-session",
        sessionTarget: {
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
      }),
    ).toThrow("missing its transcript identity");
  });

  it("rejects a transcript target from another session incarnation", () => {
    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        sessionId: "current-session",
        sessionTarget: {
          agentId: "main",
          sessionId: "stale-session",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
      }),
    ).toThrow("transcript identity does not match the active turn");
  });

  it.each([
    ["agent", { agentId: "other", sessionKey: "agent:main:main" }],
    ["session key", { agentId: "main", sessionKey: "agent:main:other" }],
    ["target key agent", { agentId: "main", sessionKey: "agent:other:main" }],
  ])("rejects a transcript target with a different %s", (_label, identity) => {
    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:main",
        sessionTarget: {
          ...identity,
          sessionId: "current-session",
          storePath: "/tmp/sessions.json",
        },
      }),
    ).toThrow("transcript identity does not match the active turn");
  });
  it("rejects a transcript target after its session key is rebound", async () => {
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: "replacement-session",
      updatedAt: Date.now() + 1,
    });

    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        sessionTarget,
      }),
    ).toThrow("transcript identity is no longer current");
  });
  it("keeps the exact local claim cleanup across compaction successor acceptance", async () => {
    const uninstall = installSessionPlacementAdmissionProvider(localProvider);
    try {
      const result = await localProvider.executeTurn(
        { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: "run-local" },
        turn("run-local"),
        async () => {
          const placement = placements.get(SESSION_ID);
          expect(placement?.turnClaim).toMatchObject({ owner: "local", runId: "run-local" });
          const settle = resolveSessionPlacementForcedTerminalSettlement();
          if (!settle) {
            throw new Error("expected exact local claim cleanup");
          }
          await withWorkerCompactionAdoption("run-local", async (adopt) => {
            await expect(adopt("session-local-successor")).resolves.toBe(SESSION_ID);
            expect(loadSessionEntry(sessionTarget)?.sessionId).toBe("session-local-successor");
            expect(placements.get(SESSION_ID)).toEqual(placement);
            expect(placements.get("session-local-successor")).toBeUndefined();
            await settle();
            expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
          });
          return { payloads: [{ text: "local" }], meta: { durationMs: 1 } };
        },
      );

      expect(result.payloads).toEqual([{ text: "local" }]);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    } finally {
      uninstall();
    }
  });

  it("leaves no placement row for an auxiliary model run without a session key", async () => {
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    const sql = observeMainThreadSql();
    try {
      await localProvider.executeTurn(
        { sessionId: SESSION_ID, agentId: "main", runId: "run-model-probe" },
        { ...turn("run-model-probe"), modelRun: true },
        runLocal,
      );
      sql.expectIdle();
    } finally {
      sql.restore();
    }

    expect(runLocal).toHaveBeenCalledOnce();
    expect(placements.list()).toEqual([]);
  });

  it.each(["cancellation", "placement publication", "run revocation"] as const)(
    "refuses an auxiliary run after %s during placement preparation",
    async (change) => {
      const prepared = createDeferred();
      const resume = createDeferred();
      const read = placements.prepareRuntimeRefresh.bind(placements);
      const prepare = vi
        .spyOn(placements, "prepareRuntimeRefresh")
        .mockImplementation(async (id) => {
          const observation = await read(id);
          prepared.resolve();
          await resume.promise;
          return observation;
        });
      const cancellation = new AbortController();
      const refusal = new Error("run revoked during placement preparation");
      let revoked = false;
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      const operation = localProvider.executeTurn(
        { sessionId: SESSION_ID, agentId: "main", runId: "run-model-probe" },
        { ...turn("run-model-probe"), modelRun: true, abortSignal: cancellation.signal },
        runLocal,
        undefined,
        () => {
          if (revoked) {
            throw refusal;
          }
        },
      );
      const settled = operation.catch((error: unknown) => error);
      try {
        await awaitGateBeforeSettlement(
          prepared.promise,
          operation,
          "run bypassed placement preparation",
        );
        if (change === "placement publication") {
          await placements.startDispatch(sessionTarget);
        } else if (change === "cancellation") {
          cancellation.abort(refusal);
        } else {
          revoked = true;
        }
        resume.resolve();
        await expect(operation).rejects.toThrow(
          change === "placement publication" ? "placement authority changed" : refusal.message,
        );
        expect(runLocal).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await settled;
        prepare.mockRestore();
      }
    },
  );

  it.each([
    ["agent id", { agentId: "other", sessionKey: SESSION_KEY }],
    ["session key", { agentId: "main", sessionKey: "agent:main:other" }],
    ["blank agent id", { agentId: " ", sessionKey: SESSION_KEY }],
    ["blank session key", { agentId: "main", sessionKey: " " }],
  ])(
    "rejects a conflicting supplied placement %s before workspace access",
    async (_label, identity) => {
      await seedActivePlacement();
      const resolveWorkspace = vi.fn(async () => ({ kind: "local" as const, path: root }));
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: unusedEnvironments(),
        placements,
        resolveWorkspace,
      });

      await expect(
        provider.executeTurn(
          { sessionId: SESSION_ID, ...identity, runId: `run-conflict-${_label}` },
          turn(`run-conflict-${_label}`),
          runLocal,
        ),
      ).rejects.toThrow(/Worker turn (agent id|session key) (?:is required|does not match)/u);
      expect(resolveWorkspace).not.toHaveBeenCalled();
      expect(runLocal).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    },
  );

  it("inherits omitted placement identity before workspace access", async () => {
    await seedActivePlacement();
    const resolveWorkspace = vi.fn(async () => {
      throw new Error("workspace reached");
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
      resolveWorkspace,
    });

    await expect(
      provider.executeTurn(
        { sessionId: SESSION_ID, runId: "run-inherited-identity" },
        turn("run-inherited-identity"),
        vi.fn(),
      ),
    ).rejects.toThrow("workspace reached");
    expect(resolveWorkspace).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      agentId: "main",
      sessionKey: SESSION_KEY,
    });
  });

  it("holds a local placement claim around CLI execution", async () => {
    let assertSettlementCurrent: (() => void) | undefined;

    const result = await localProvider.executeLocalTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: "run-cli" },
      async () => {
        assertSettlementCurrent = resolveSessionPlacementTurnSettlementAssertion();
        assertSettlementCurrent?.();
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({
          owner: "local",
          runId: "run-cli",
        });
        return { kind: "cli" };
      },
    );

    expect(result).toEqual({ kind: "cli" });
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    expect(assertSettlementCurrent).toBeDefined();
    expect(() => assertSettlementCurrent?.()).toThrow("settlement is closed");
  });

  it.each(["absent", "local"] as const)(
    "prepares %s placement once before claiming an admitted local turn",
    async (state) => {
      setRuntimeConfigSnapshot({ session: { store: sessionTarget.storePath } });
      const claim = {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-prepared-local",
      };
      if (state === "local") {
        await localProvider.executeLocalTurn(claim, async () => {});
      }
      const { databaseClaim } = await loadSessionEntryForAdmission(sessionTarget);
      const operation = createReplyOperation({ ...claim, resetTriggered: false });
      const binding = bindReplyOperationDatabaseAdmission(
        operation,
        claim,
        undefined,
        databaseClaim,
      );
      const projection = vi.spyOn(placements, "readProjection");
      const standaloneEntry = vi.spyOn(sessionEntryReader, "readSessionEntryReadOnlyInWorker");
      const acquire = placements.claimTurn.bind(placements);
      const preparationRequests: number[] = [];
      const claimTurn = vi.spyOn(placements, "claimTurn").mockImplementation((...args) => {
        preparationRequests.push(projection.mock.calls.length);
        return acquire(...args);
      });
      try {
        expect(binding.operationAdmission.reader).toBeDefined();
        await localProvider.executeTurn(
          claim,
          { ...turn(claim.runId), replyOperation: operation },
          async () => {
            expect(placements.get(SESSION_ID)?.turnClaim?.runId).toBe(claim.runId);
            return { meta: { durationMs: 1 } };
          },
        );
        expect(preparationRequests).toEqual([1]);
        expect(standaloneEntry).not.toHaveBeenCalled();
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      } finally {
        claimTurn.mockRestore();
        standaloneEntry.mockRestore();
        projection.mockRestore();
        operation.complete();
        await binding.releaseWorkerDatabaseClaim?.();
        if (!binding.releaseWorkerDatabaseClaim) {
          await databaseClaim.release();
        }
      }
    },
  );

  it.each(["absent", "local"])(
    "keeps a repository session off the Gateway with %s placement",
    async (state) => {
      setRuntimeConfigSnapshot({ session: { store: sessionTarget.storePath } });
      const claim = {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "repository-local",
      };
      if (state === "local") {
        await localProvider.executeLocalTurn(claim, async () => {});
      }
      const repository = await getSessionRepositoryWorkspaceStore().create({
        agentId: "main",
        sessionKey: SESSION_KEY,
        url: "https://github.com/example/repository.git",
        assertCurrent: () => {},
      });
      await upsertSessionEntryCore(sessionTarget, {
        sessionId: SESSION_ID,
        updatedAt: Date.now(),
        repositoryWorkspaceId: repository.workspaceId,
      });
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      await expect(localProvider.executeTurn(claim, turn(), runLocal)).rejects.toThrow(
        "needs a cloud worker",
      );
      const sql = observeHostDataSql();
      try {
        await expect(localProvider.executeLocalTurn(claim, runLocal)).rejects.toThrow(
          "needs a cloud worker",
        );
        expect(
          sql.queries.filter((query) =>
            /\bsession_(?:nodes|windows|participants|entry_snapshots)\b/.test(query),
          ),
        ).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(runLocal).not.toHaveBeenCalled();

      // Publication can retain the old repository row after an explicit move.
      await patchSessionEntryCore(
        sessionTarget,
        (entry) => ({ ...entry, repositoryWorkspaceId: undefined }),
        { replaceEntry: true },
      );
      expect(loadSessionEntry(sessionTarget)?.repositoryWorkspaceId).toBeUndefined();
      await localProvider.executeLocalTurn(claim, runLocal);
      expect(runLocal).toHaveBeenCalledOnce();
      expect(await getSessionRepositoryWorkspaceStore().get(repository.workspaceId)).toBeDefined();
    },
  );

  it.each(["caller revocation", "placement publication"] as const)(
    "rejects local placement after %s during the metadata read",
    async (change) => {
      setRuntimeConfigSnapshot({ session: { store: sessionTarget.storePath } });
      const controller = new AbortController();
      const revoked = new Error("local turn source retired");
      const read = sessionEntryReader.readSessionEntryReadOnlyInWorker;
      const heldRead = vi
        .spyOn(sessionEntryReader, "readSessionEntryReadOnlyInWorker")
        .mockImplementationOnce(async (...args) => {
          const entry = await read(...args);
          if (change === "caller revocation") {
            controller.abort(revoked);
          } else {
            await placements.startDispatch(sessionTarget);
          }
          return entry;
        });
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      try {
        await expect(
          localProvider.executeTurn(
            {
              sessionId: SESSION_ID,
              sessionKey: SESSION_KEY,
              agentId: "main",
              runId: "revoked-local",
            },
            turn("revoked-local"),
            runLocal,
            undefined,
            () => controller.signal.throwIfAborted(),
          ),
        ).rejects.toThrow(
          change === "caller revocation"
            ? revoked.message
            : `Local turn rejected for session ${SESSION_ID} in placement requested`,
        );
        expect(placements.get(SESSION_ID)?.turnClaim ?? null).toBeNull();
        expect(runLocal).not.toHaveBeenCalled();
      } finally {
        heldRead.mockRestore();
      }
    },
  );

  it("mints a fresh claim token when a later turn reuses the run id", async () => {
    const claimIds: string[] = [];
    const claim = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      runId: "run-reused",
    };

    for (let index = 0; index < 2; index += 1) {
      await localProvider.executeLocalTurn(claim, async () => {
        const claimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
        if (!claimId) {
          throw new Error("expected active placement claim");
        }
        claimIds.push(claimId);
      });
    }

    expect(claimIds).toHaveLength(2);
    expect(claimIds[0]).not.toBe(claimIds[1]);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("does not let a stale local finally release a reclaimed run id", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const secondStarted = createDeferred();
    const releaseSecond = createDeferred();
    const claim = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      runId: "run-restarted",
    };

    const first = localProvider.executeLocalTurn(claim, async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;
    const firstClaimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
    expect(placements.clearLocalTurnClaimsAfterRestart()).toBe(1);

    const second = localProvider.executeLocalTurn(claim, async () => {
      secondStarted.resolve();
      await releaseSecond.promise;
    });
    await secondStarted.promise;
    const secondClaimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
    expect(secondClaimId).toBeTruthy();
    expect(secondClaimId).not.toBe(firstClaimId);

    releaseFirst.resolve();
    await first;
    expect(placements.get(SESSION_ID)?.turnClaim?.claimId).toBe(secondClaimId);

    releaseSecond.resolve();
    await second;
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("releases a force-cleared embedded turn for archive without clearing its replacement", async () => {
    const startedAt = Date.now() - 60_000;
    setRuntimeConfigSnapshot({ session: { store: sessionTarget.storePath } });
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: SESSION_ID,
      startedAt,
      updatedAt: startedAt,
    });
    const runningEntry = loadSessionEntry(sessionTarget);
    expect(runningEntry).toMatchObject({
      sessionId: SESSION_ID,
      startedAt,
      updatedAt: expect.any(Number),
    });
    if (!runningEntry) {
      throw new Error("expected running session entry");
    }
    const oldRunStarted = createDeferred();
    const finishOldRun = createDeferred();
    const replacementStarted = createDeferred();
    const finishReplacement = createDeferred();
    let assertOldSettlementCurrent: (() => void) | undefined;
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };

    const oldRun = localProvider.executeLocalTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-force-cleared",
      },
      async () => {
        assertOldSettlementCurrent = resolveSessionPlacementTurnSettlementAssertion();
        assertOldSettlementCurrent?.();
        setActiveEmbeddedRun(SESSION_ID, handle, SESSION_KEY);
        oldRunStarted.resolve();
        await finishOldRun.promise;
      },
    );
    await oldRunStarted.promise;
    const oldClaimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
    expect(oldClaimId).toBeTruthy();

    await expect(
      abortAndDrainEmbeddedAgentRun({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        settleMs: 100,
        forceClear: true,
        reason: "stuck_recovery",
      }),
    ).resolves.toMatchObject({ forceCleared: true });
    expect(assertOldSettlementCurrent).toBeDefined();
    expect(() => assertOldSettlementCurrent?.()).toThrow("settlement is closed");
    const killedEntry = loadSessionEntry(sessionTarget);
    expect(killedEntry).toMatchObject({
      sessionId: SESSION_ID,
      status: "killed",
      abortedLastRun: true,
    });
    expect(killedEntry?.updatedAt).toBeGreaterThan(runningEntry.updatedAt);

    const context = {
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      cancelRunBoundApprovals: vi.fn(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      chatRunState: createChatRunState(),
      dedupe: new Map(),
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(),
      workerSessionPlacementService: placements,
    } as unknown as GatewayRequestContext;
    const archiveDrain = await prepareSessionLifecycleDrain({
      action: "archive",
      context,
      storePath: sessionTarget.storePath,
      sessionKeys: [SESSION_KEY],
      sessionId: SESSION_ID,
      agentId: "main",
      sessionKey: SESSION_KEY,
      lifecycleIdentities: [SESSION_KEY, SESSION_ID],
    });
    expect(archiveDrain.hasAuthoritativeWork()).toBe(false);
    archiveDrain.release();

    const replacement = localProvider.executeLocalTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-replacement",
      },
      async () => {
        replacementStarted.resolve();
        await finishReplacement.promise;
      },
    );
    await replacementStarted.promise;
    const replacementClaimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
    expect(replacementClaimId).toBeTruthy();
    expect(replacementClaimId).not.toBe(oldClaimId);

    finishOldRun.resolve();
    await oldRun;
    expect(placements.get(SESSION_ID)?.turnClaim?.claimId).toBe(replacementClaimId);

    finishReplacement.resolve();
    await replacement;
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("rejects local CLI execution after worker activation", async () => {
    await seedActivePlacement();
    const runLocal = vi.fn(async () => ({ kind: "cli" }));

    await expect(
      localProvider.executeLocalTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-local-after-dispatch",
        },
        runLocal,
      ),
    ).rejects.toThrow(`Local turn rejected for session ${SESSION_ID} in placement active`);

    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it.each([
    ["CLI", "claude-cli"],
    ["plugin", "test-harness"],
  ])(
    "rejects an active worker turn assigned to a configured %s runtime",
    async (_kind, runtimeId) => {
      await seedActivePlacement();
      const getEnvironment = vi.fn(() => undefined);
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: getEnvironment,
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      const runId = `run-${runtimeId}`;
      const config = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-luna": { agentRuntime: { id: runtimeId } },
            },
          },
        },
      };
      const release = vi.fn(async () => {});
      const acquire = vi
        .spyOn(preparedModelRuntime, "acquireAgentRunPreparedModelRuntime")
        .mockImplementationOnce(async (input) => {
          const metadataSnapshot = createEmptyPluginMetadataSnapshot(input.workspaceDir);
          return {
            snapshot: {
              catalogOwner: undefined,
              agentId: input.agentId,
              agentDir: input.agentDir,
              workspaceDir: input.workspaceDir,
              activeProjectKeys: [],
              config,
              observationConfig: config,
              isCurrent: () => true,
              authModes: {},
              metadataSnapshot,
              allowGatewaySubagentBinding: false,
              modelCatalog: { entries: [], routeVariants: [] },
              configuredRuntimeModels: [],
              findConfiguredRuntimeModel: () => undefined,
              inlineProviderModels: [],
              createStores: () => {
                throw new Error("unsupported runtime must not create model stores");
              },
            },
            pluginGeneration: {
              remoteCatalog: null,
              pluginMetadataSnapshot: metadataSnapshot,
              inlineProviderModels: [],
              configuredCatalogEntries: [],
            },
            [Symbol.asyncDispose]: release,
          };
        });

      try {
        // The raw turn selects OpenClaw; admission must use the prepared owner's policy.
        await expect(
          provider.executeTurn(
            { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
            turn(runId),
            runLocal,
          ),
        ).rejects.toThrow(`Cloud worker turns require the OpenClaw runtime, not ${runtimeId}`);

        expect(runLocal).not.toHaveBeenCalled();
        expect(getEnvironment).not.toHaveBeenCalled();
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
        expect(release).toHaveBeenCalledOnce();
      } finally {
        acquire.mockRestore();
      }
    },
  );

  it("resolves an exact paired-device sandbox without requiring an SSH identity resolver", async () => {
    await seedActivePlacement("remote-exec");
    const environment = {
      ...attachedEnvironment(),
      providerId: "device",
      nodeDeviceId: "paired-node-1",
      sharedHost: true,
      sshEndpoint: null,
    };
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => environment),
      resolveSshIdentity: undefined,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    using prepared = await provider.prepareSandbox({
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      workspaceDir: "/caller/workspace",
    });
    expect(prepared.sandbox).toMatchObject({
      backendId: "node",
      placementExecutionMode: "remote-exec",
      placementNodeId: "paired-node-1",
      containerWorkdir: "/worker/workspace",
    });
    const sql = observeMainThreadSql();
    try {
      prepared.assertCurrent();
      sql.expectIdle();
      environment.nodeDeviceId = "replacement-node";
      expect(prepared.assertCurrent).toThrow("environment changed");
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

  it("rejects a remote-exec placement replaced while resolving its managed workspace", async () => {
    await seedActivePlacement("remote-exec");
    const environment = attachedEnvironment();
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: { ...unusedEnvironments(), get: vi.fn(() => environment) },
      placements,
      resolveWorkspace: async () => {
        const placement = placements.get(SESSION_ID);
        if (placement?.state !== "active") {
          throw new Error("expected an active placement");
        }
        await placements.startDrain({
          sessionId: SESSION_ID,
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
          expectedGeneration: placement.generation,
        });
        return { kind: "local", path: "/local/managed-worktree" };
      },
    });

    await expect(
      provider.prepareSandbox({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        workspaceDir: "/caller/workspace",
      }),
    ).rejects.toThrow("placement authority changed");
  });

  it("rejects a paired-node environment replaced after sandbox preparation", async () => {
    await seedActivePlacement("remote-exec");
    const environment = {
      ...attachedEnvironment(),
      providerId: "device",
      nodeDeviceId: "paired-node-1",
      sshEndpoint: null,
    };
    const get = vi
      .fn<WorkerTurnEnvironmentService["get"]>()
      .mockReturnValueOnce(environment)
      .mockReturnValueOnce(environment)
      .mockReturnValueOnce({ ...environment, nodeDeviceId: "replacement-node" });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: { ...unusedEnvironments(), get },
      placements,
    });

    await expect(
      provider.prepareSandbox({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        workspaceDir: "/caller/workspace",
      }),
    ).rejects.toThrow("environment changed while preparing its sandbox");
  });

  it("rejects a reused worker bundle without the current launch contract", async () => {
    await seedActivePlacement();
    const oldEnvironment = attachedEnvironment();
    oldEnvironment.bootstrapReceipt = {
      ...oldEnvironment.bootstrapReceipt!,
      protocolFeatures: [WORKER_LAUNCH_V2_PROTOCOL_FEATURE],
    };
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => oldEnvironment),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-old-worker",
        },
        turn("run-old-worker"),
        runLocal,
      ),
    ).rejects.toThrow("reprovision the worker before launch");

    expect(runLocal).not.toHaveBeenCalled();
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    expect(environments.startTunnel).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });
});
