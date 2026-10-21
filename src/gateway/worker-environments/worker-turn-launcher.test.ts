import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import * as preparedModelRuntime from "../../agents/prepared-model-runtime.js";
import {
  installSessionPlacementAdmissionProvider,
  prepareSessionPlacementSandbox,
  resolveSessionPlacementRuntimeOverride,
  sessionPlacementUsesWorkerInference,
} from "../../agents/session-placement-admission.js";
import { resolveSessionPlacementForcedTerminalSettlement } from "../../agents/session-placement-forced-terminal-settlement.js";
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
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { isCompetingSessionControllerWorkActive } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  createLauncher,
  executeTurn,
  expectUncalled,
  localResult,
  runIdentity,
} from "./worker-turn-launcher-flow.test-support.js";
import * as fx from "./worker-turn-launcher.test-support.js";
import {
  prepareWorkerTurnTranscriptSource,
  resolveWorkerTurnTranscriptTarget,
} from "./worker-turn-transcript-target.js";

afterAll(closeStateDatabaseForTest);

const sandboxInput = (workspaceDir = "/caller/workspace") => ({
  agentId: "main",
  sessionId: fx.SESSION_ID,
  sessionKey: fx.SESSION_KEY,
  workspaceDir,
});
const transcriptMismatch = "transcript identity does not match the active turn";

function scopedObservation<T extends { restore(): void }>(observation: T) {
  return { ...observation, [Symbol.dispose]: () => observation.restore() };
}

describe("worker turn launcher local placement", () => {
  let localProvider: ReturnType<typeof fx.createWorkerSessionTurnPlacementProvider>;
  beforeEach(async () => {
    await fx.setupWorkerTurnLauncherTest();
    localProvider = createLauncher();
  });
  afterEach(() => fx.cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

  it("reads absent sandbox placement without caller-thread SQL", async () => {
    using cleanup = new DisposableStack();
    cleanup.defer(installSessionPlacementAdmissionProvider(localProvider));
    using sql = scopedObservation(observeMainThreadSql());
    using prepared = await prepareSessionPlacementSandbox(sandboxInput(fx.root));
    expect(prepared.sandbox).toBeNull();
    prepared.assertCurrent();
    sql.expectIdle();
    await fx.seedActivePlacement("remote-exec");
    sql.clear();
    expect(prepared.assertCurrent).toThrow("placement authority changed");
    sql.expectIdle();
  });

  it.each([
    ["worker-turn", "inference"],
    ["remote-exec", "inference"],
    ["worker-turn", "runtime"],
    ["remote-exec", "runtime"],
  ] as const)(
    "reads current %s %s placement facts without caller-thread SQL",
    async (executionMode, kind) => {
      const environment = {
        ...fx.attachedEnvironment(),
        providerId: "device",
        profileSnapshot: { settings: { inference: "worker" } },
      };
      const provider =
        kind === "inference"
          ? createLauncher({ environments: { ...fx.unusedEnvironments(), get: () => environment } })
          : localProvider;
      const read =
        kind === "inference"
          ? sessionPlacementUsesWorkerInference
          : resolveSessionPlacementRuntimeOverride;
      const absent = kind === "inference" ? false : undefined;
      const identity = { sessionId: fx.SESSION_ID, sessionKey: fx.SESSION_KEY, agentId: "main" };
      {
        using cleanup = new DisposableStack();
        cleanup.defer(installSessionPlacementAdmissionProvider(provider));
        using sql = scopedObservation(observeMainThreadSql());
        expect(await read(identity)).toBe(absent);
        sql.expectIdle();
        await fx.seedActivePlacement(executionMode);
        sql.clear();
        const expected =
          executionMode === "worker-turn" ? (kind === "inference" ? true : "openclaw") : absent;
        expect(await read(identity)).toBe(expected);
        if (kind === "runtime") {
          expect(await read({ sessionId: fx.SESSION_ID })).toBe(expected);
        }
        for (const mismatch of [
          { sessionId: "other-session" },
          { sessionKey: "agent:main:other" },
          { agentId: "other-agent" },
        ]) {
          expect(await read({ ...identity, ...mismatch })).toBe(absent);
        }
        if (kind === "inference") {
          environment.ownerEpoch += 1;
          expect(await read(identity)).toBe(false);
        }
        sql.expectIdle();
      }
      expect(await read(identity)).toBe(absent);
    },
  );

  it.each([
    ["missing incarnation", { sessionId: undefined }, "missing its transcript identity"],
    ["stale incarnation", { sessionId: "stale-session" }, transcriptMismatch],
    ["agent", { agentId: "other" }, transcriptMismatch],
    ["session key", { sessionKey: "agent:main:other" }, transcriptMismatch],
    ["target key agent", { sessionKey: "agent:other:main" }, transcriptMismatch],
  ] as const)("rejects a transcript target with %s", (_label, mismatch, error) => {
    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:main",
        sessionTarget: {
          agentId: "main",
          sessionId: "current-session",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
          ...mismatch,
        },
      }),
    ).toThrow(error);
  });
  it("rejects a transcript target after its session key is rebound", async () => {
    await upsertSessionEntryCore(fx.sessionTarget, {
      sessionId: "replacement-session",
      updatedAt: Date.now() + 1,
    });

    await expect(prepareWorkerTurnTranscriptSource(fx.sessionTarget)).rejects.toThrow(
      "transcript identity is no longer current",
    );
  });
  it("keeps the exact local claim cleanup across compaction successor acceptance", async () => {
    using cleanup = new DisposableStack();
    cleanup.defer(installSessionPlacementAdmissionProvider(localProvider));
    const result = await localProvider.executeTurn(
      runIdentity("run-local"),
      fx.turn("run-local"),
      async () => {
        const placement = fx.placements.get(fx.SESSION_ID);
        expect(placement?.turnClaim).toMatchObject({ owner: "local", runId: "run-local" });
        const settle = resolveSessionPlacementForcedTerminalSettlement();
        if (!settle) {
          throw new Error("expected exact local claim cleanup");
        }
        await fx.withWorkerCompactionAdoption("run-local", async (adopt) => {
          await expect(adopt("session-local-successor")).resolves.toBe(fx.SESSION_ID);
          expect(loadSessionEntry(fx.sessionTarget)?.sessionId).toBe("session-local-successor");
          expect(fx.placements.get(fx.SESSION_ID)).toEqual(placement);
          expect(await fx.placements.getAsync("session-local-successor")).toBeUndefined();
          await settle();
          expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();
        });
        return {
          payloads: [{ text: "local" }],
          meta: { durationMs: 1, terminalReply: { disposition: "visible", text: "local" } },
        };
      },
    );

    expect(result.payloads).toEqual([{ text: "local" }]);
    expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();
  });

  it("leaves no placement row for an auxiliary model run without a session key", async () => {
    const runLocal = vi.fn(localResult);
    {
      using sql = scopedObservation(observeMainThreadSql());
      await localProvider.executeTurn(
        { sessionId: fx.SESSION_ID, agentId: "main", runId: "run-model-probe" },
        { ...fx.turn("run-model-probe"), modelRun: true },
        runLocal,
      );
      sql.expectIdle();
    }
    expect(runLocal).toHaveBeenCalledOnce();
    expect(await fx.placements.listAsync()).toEqual([]);
  });

  it.each(["cancellation", "placement publication", "run revocation"] as const)(
    "refuses an auxiliary run after %s during placement preparation",
    async (change) => {
      const prepared = createDeferred();
      const resume = createDeferred();
      const read = fx.placements.prepareRuntimeRefresh.bind(fx.placements);
      const prepare = vi
        .spyOn(fx.placements, "prepareRuntimeRefresh")
        .mockImplementation(async (id) => {
          const observation = await read(id);
          prepared.resolve();
          await resume.promise;
          return observation;
        });
      const cancellation = new AbortController();
      const refusal = new Error("run revoked during placement preparation");
      let revoked = false;
      const runLocal = vi.fn(localResult);
      const operation = localProvider.executeTurn(
        { sessionId: fx.SESSION_ID, agentId: "main", runId: "run-model-probe" },
        { ...fx.turn("run-model-probe"), modelRun: true, abortSignal: cancellation.signal },
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
          await fx.placements.startDispatch(fx.sessionTarget);
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
    ["agent id", { agentId: "other", sessionKey: fx.SESSION_KEY }],
    ["session key", { agentId: "main", sessionKey: "agent:main:other" }],
    ["blank agent id", { agentId: " ", sessionKey: fx.SESSION_KEY }],
    ["blank session key", { agentId: "main", sessionKey: " " }],
    ["omitted", undefined],
  ] as const)(
    "validates supplied placement identity before workspace access (%s)",
    async (label, identity) => {
      await fx.seedActivePlacement();
      const resolveWorkspace = vi.fn(async () => {
        throw new Error("workspace reached");
      });
      const runLocal = vi.fn(localResult);
      const provider = createLauncher({ resolveWorkspace });
      const runId = label === "omitted" ? "run-inherited-identity" : `run-conflict-${label}`;
      await expect(
        provider.executeTurn(
          { sessionId: fx.SESSION_ID, ...identity, runId },
          fx.turn(runId),
          runLocal,
        ),
      ).rejects.toThrow(
        identity
          ? /Worker turn (agent id|session key) (?:is required|does not match)/u
          : "workspace reached",
      );
      if (identity) {
        expectUncalled(resolveWorkspace, runLocal);
        expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();
      } else {
        expect(resolveWorkspace).toHaveBeenCalledWith({
          sessionId: fx.SESSION_ID,
          agentId: "main",
          sessionKey: fx.SESSION_KEY,
        });
      }
    },
  );

  it.each(["absent", "local"] as const)(
    "prepares %s placement once before claiming an admitted local turn",
    async (state) => {
      setRuntimeConfigSnapshot({ session: { store: fx.sessionTarget.storePath } });
      const claim = runIdentity("run-prepared-local");
      if (state === "local") {
        await localProvider.executeLocalTurn(claim, async () => {});
      }
      const { databaseClaim } = await loadSessionEntryForAdmission(fx.sessionTarget);
      const operation = createReplyOperation({ ...claim, resetTriggered: false });
      const binding = bindReplyOperationDatabaseAdmission(
        operation,
        claim,
        undefined,
        databaseClaim,
      );
      const projection = vi.spyOn(fx.placements, "readProjection");
      const standaloneEntry = vi.spyOn(sessionEntryReader, "readSessionEntryReadOnlyInWorker");
      const acquire = fx.placements.claimTurn.bind(fx.placements);
      const preparationRequests: number[] = [];
      const claimTurn = vi.spyOn(fx.placements, "claimTurn").mockImplementation((...args) => {
        preparationRequests.push(projection.mock.calls.length);
        return acquire(...args);
      });
      try {
        expect(binding.operationAdmission.reader).toBeDefined();
        await localProvider.executeTurn(
          claim,
          { ...fx.turn(claim.runId), replyOperation: operation },
          async () => {
            expect(fx.placements.get(fx.SESSION_ID)?.turnClaim?.runId).toBe(claim.runId);
            return { meta: { durationMs: 1 } };
          },
        );
        expect(preparationRequests).toEqual([1]);
        expect(standaloneEntry).not.toHaveBeenCalled();
        expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();
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
      setRuntimeConfigSnapshot({ session: { store: fx.sessionTarget.storePath } });
      const claim = runIdentity("repository-local");
      if (state === "local") {
        await localProvider.executeLocalTurn(claim, async () => {});
      }
      const repository = await getSessionRepositoryWorkspaceStore().create({
        agentId: "main",
        sessionKey: fx.SESSION_KEY,
        url: "https://github.com/example/repository.git",
        assertCurrent: () => {},
      });
      await upsertSessionEntryCore(fx.sessionTarget, {
        sessionId: fx.SESSION_ID,
        updatedAt: Date.now(),
        repositoryWorkspaceId: repository.workspaceId,
      });
      const runLocal = vi.fn(localResult);
      await expect(localProvider.executeTurn(claim, fx.turn(), runLocal)).rejects.toThrow(
        "needs a cloud worker",
      );
      {
        using sql = scopedObservation(observeHostDataSql());
        await expect(localProvider.executeLocalTurn(claim, runLocal)).rejects.toThrow(
          "needs a cloud worker",
        );
        expect(
          sql.queries.filter((query) =>
            /\bsession_(?:nodes|windows|participants|entry_snapshots)\b/.test(query),
          ),
        ).toEqual([]);
      }
      expect(runLocal).not.toHaveBeenCalled();

      // Publication can retain the old repository row after an explicit move.
      await patchSessionEntryCore(
        fx.sessionTarget,
        (entry) => ({ ...entry, repositoryWorkspaceId: undefined }),
        { replaceEntry: true },
      );
      expect(loadSessionEntry(fx.sessionTarget)?.repositoryWorkspaceId).toBeUndefined();
      await localProvider.executeLocalTurn(claim, runLocal);
      expect(runLocal).toHaveBeenCalledOnce();
      expect(await getSessionRepositoryWorkspaceStore().get(repository.workspaceId)).toBeDefined();
    },
  );

  it.each(["caller revocation", "placement publication"] as const)(
    "rejects local placement after %s during the metadata read",
    async (change) => {
      setRuntimeConfigSnapshot({ session: { store: fx.sessionTarget.storePath } });
      const controller = new AbortController();
      const revoked = new Error("local turn source retired");
      const read = sessionEntryReader.readSessionEntryReadOnlyInWorker;
      using cleanup = new DisposableStack();
      cleanup.use(
        vi
          .spyOn(sessionEntryReader, "readSessionEntryReadOnlyInWorker")
          .mockImplementationOnce(async (...args) => {
            const entry = await read(...args);
            if (change === "caller revocation") {
              controller.abort(revoked);
            } else {
              await fx.placements.startDispatch(fx.sessionTarget);
            }
            return entry;
          }),
      );
      const runLocal = vi.fn(localResult);
      await expect(
        localProvider.executeTurn(
          runIdentity("revoked-local"),
          fx.turn("revoked-local"),
          runLocal,
          undefined,
          () => controller.signal.throwIfAborted(),
        ),
      ).rejects.toThrow(
        change === "caller revocation"
          ? revoked.message
          : `Local turn rejected for session ${fx.SESSION_ID} in placement requested`,
      );
      expect(fx.placements.get(fx.SESSION_ID)?.turnClaim ?? null).toBeNull();
      expect(runLocal).not.toHaveBeenCalled();
    },
  );

  it("does not let a stale local finally release a reclaimed run id", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const secondStarted = createDeferred();
    const releaseSecond = createDeferred();
    const claim = runIdentity("run-restarted");

    const first = localProvider.executeLocalTurn(claim, async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;
    const firstClaim = fx.placements.get(fx.SESSION_ID)?.turnClaim;
    if (!firstClaim) {
      throw new Error("Expected the first local turn claim");
    }
    const firstClaimId = firstClaim.claimId;
    // Live local claims belong to the placement owner; startup only clears legacy SQL claims.
    expect(
      await fx.placements.releaseTurn({
        sessionId: fx.SESSION_ID,
        claimId: firstClaimId,
        runId: firstClaim.runId,
        placementGeneration: firstClaim.generation,
        owner: { kind: "local" },
      }),
    ).toMatchObject({ turnClaim: null });

    const second = localProvider.executeLocalTurn(claim, async () => {
      secondStarted.resolve();
      await releaseSecond.promise;
    });
    await secondStarted.promise;
    const secondClaimId = fx.placements.get(fx.SESSION_ID)?.turnClaim?.claimId;
    expect(secondClaimId).toBeTruthy();
    expect(secondClaimId).not.toBe(firstClaimId);

    releaseFirst.resolve();
    await first;
    expect(fx.placements.get(fx.SESSION_ID)?.turnClaim?.claimId).toBe(secondClaimId);

    releaseSecond.resolve();
    await second;
    expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();
  });

  it("retains cancelled native turn custody until raw settlement and fences its late cleanup", async () => {
    const oldRunStarted = createDeferred();
    const finishOldRun = createDeferred();
    const replacementStarted = createDeferred();
    const finishReplacement = createDeferred();
    const admission = fx.sessionTarget;
    const handle = createEmbeddedRunHandle({ runId: "run-cancelled" });
    let oldOperation: ReturnType<typeof createReplyOperation> | undefined;
    let settleOldPlacement: (() => Promise<void>) | undefined;
    const oldRun = withSessionTurn(admission, async (operation) => {
      if (!operation) {
        throw new Error("Expected the admitted native controller operation");
      }
      oldOperation = operation;
      return await localProvider.executeLocalTurn(
        { ...admission, runId: "run-cancelled" },
        async () => {
          settleOldPlacement = resolveSessionPlacementForcedTerminalSettlement();
          attachActiveEmbeddedRun(
            fx.SESSION_ID,
            handle,
            fx.SESSION_KEY,
            undefined,
            "main",
            operation,
          );
          oldRunStarted.resolve();
          try {
            await finishOldRun.promise;
          } finally {
            detachActiveEmbeddedRun(fx.SESSION_ID, handle, fx.SESSION_KEY);
          }
        },
      );
    });
    let replacement: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(oldRunStarted.promise, oldRun, "Native turn did not start");
      const oldClaimId = fx.placements.get(fx.SESSION_ID)?.turnClaim?.claimId;
      expect(oldClaimId).toBeTruthy();
      oldOperation?.abortByUser();
      replacement = withSessionTurn(admission, async () => {
        await localProvider.executeLocalTurn(
          { ...admission, runId: "run-replacement" },
          async () => {
            replacementStarted.resolve();
            await finishReplacement.promise;
          },
        );
      });
      expect(
        isCompetingSessionControllerWorkActive(fx.sessionTarget.storePath, [
          fx.SESSION_KEY,
          fx.SESSION_ID,
        ]),
      ).toBe(true);
      expect(fx.placements.get(fx.SESSION_ID)?.turnClaim?.claimId).toBe(oldClaimId);
      finishOldRun.resolve();
      await oldRun;
      await awaitGateBeforeSettlement(
        replacementStarted.promise,
        replacement,
        "Replacement did not start after native settlement",
      );
      const replacementClaimId = fx.placements.get(fx.SESSION_ID)?.turnClaim?.claimId;
      expect(replacementClaimId).toBeTruthy();
      expect(replacementClaimId).not.toBe(oldClaimId);
      expect(settleOldPlacement).toBeDefined();
      await settleOldPlacement?.();
      expect(fx.placements.get(fx.SESSION_ID)?.turnClaim?.claimId).toBe(replacementClaimId);
      finishReplacement.resolve();
      await replacement;
      expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();
    } finally {
      finishOldRun.resolve();
      finishReplacement.resolve();
      await Promise.allSettled([oldRun, replacement]);
    }
  });

  it("rejects local CLI execution after worker activation", async () => {
    await fx.seedActivePlacement();
    const runLocal = vi.fn(async () => ({ kind: "cli" }));

    await expect(
      localProvider.executeLocalTurn(runIdentity("run-local-after-dispatch"), runLocal),
    ).rejects.toThrow(`Local turn rejected for session ${fx.SESSION_ID} in placement active`);

    expect(runLocal).not.toHaveBeenCalled();
    expect(fx.placements.get(fx.SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("rejects an active worker turn assigned to a configured CLI runtime", async () => {
    const runtimeId = "claude-cli";
    await fx.seedActivePlacement();
    const getEnvironment = vi.fn(() => undefined);
    const environments: fx.WorkerTurnEnvironmentService = {
      ...fx.unusedEnvironments(),
      get: getEnvironment,
    };
    const provider = createLauncher({ environments });
    const runLocal = vi.fn(localResult);
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
    using cleanup = new DisposableStack();
    cleanup.use(
      vi
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
        }),
    );

    // The raw turn selects OpenClaw; admission must use the prepared owner's policy.
    await expect(executeTurn(provider, runId, runLocal)).rejects.toThrow(
      `Cloud worker turns require the OpenClaw runtime, not ${runtimeId}`,
    );

    expectUncalled(runLocal, getEnvironment);
    expect(fx.placements.get(fx.SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["current", "placement-replaced", "node-replaced"] as const)(
    "prepares an exact remote sandbox (%s)",
    async (scenario) => {
      await fx.seedActivePlacement("remote-exec");
      const environment =
        scenario === "placement-replaced"
          ? fx.attachedEnvironment()
          : {
              ...fx.attachedEnvironment(),
              providerId: "device",
              nodeDeviceId: "paired-node-1",
              sshEndpoint: null,
              ...(scenario === "current" ? { sharedHost: true } : {}),
            };
      const get = vi.fn<fx.WorkerTurnEnvironmentService["get"]>(() => environment);
      if (scenario === "node-replaced") {
        get
          .mockReturnValueOnce(environment)
          .mockReturnValueOnce(environment)
          .mockReturnValueOnce({ ...environment, nodeDeviceId: "replacement-node" });
      }
      const provider = createLauncher({
        environments: {
          ...fx.unusedEnvironments(),
          get,
          ...(scenario === "current" ? { resolveSshIdentity: undefined } : {}),
        },
        ...(scenario === "placement-replaced"
          ? {
              resolveWorkspace: async () => {
                const placement = fx.placements.get(fx.SESSION_ID);
                if (placement?.state !== "active") {
                  throw new Error("expected an active placement");
                }
                await fx.placements.startDrain({
                  sessionId: fx.SESSION_ID,
                  environmentId: placement.environmentId,
                  ownerEpoch: placement.activeOwnerEpoch,
                  expectedGeneration: placement.generation,
                });
                return { kind: "local" as const, path: "/local/managed-worktree" };
              },
            }
          : {}),
      });
      if (scenario !== "current") {
        await expect(provider.prepareSandbox(sandboxInput())).rejects.toThrow(
          scenario === "placement-replaced"
            ? "placement authority changed"
            : "environment changed while preparing its sandbox",
        );
        return;
      }
      using prepared = await provider.prepareSandbox(sandboxInput());
      expect(prepared.sandbox).toMatchObject({
        backendId: "node",
        placementExecutionMode: "remote-exec",
        placementNodeId: "paired-node-1",
        containerWorkdir: "/worker/workspace",
      });
      using sql = scopedObservation(observeMainThreadSql());
      prepared.assertCurrent();
      sql.expectIdle();
      environment.nodeDeviceId = "replacement-node";
      expect(prepared.assertCurrent).toThrow("environment changed");
      sql.expectIdle();
    },
  );
});
