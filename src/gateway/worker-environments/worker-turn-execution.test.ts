import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { setActiveNodeContext } from "../../infra/active-node-context.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  completeWorkerLaunchDescriptor,
  type WorkerLaunchPlan,
} from "../../worker/launch-descriptor.js";
import { roundTripWorkerLaunchDescriptor } from "../../worker/launch-descriptor.test-support.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  credential,
  measureLaunchTurn,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  openSessionManager,
  readWorkerTurnTranscriptStorageRows,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

describe("worker turn execution", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each(["current", "cancel"] as const)(
    "waits for execution-start settlement before new-turn work (%s)",
    async (change) => {
      await seedActivePlacement();
      const input = turn(`execution-start-${change}`);
      const abort = new AbortController();
      const entered = createDeferred();
      const release = createDeferred();
      const hydration = vi.spyOn(SessionManager, "openAsync");
      const deliberateStop = new WorkerRunnerCapacityError();
      const acquireTurnCredential = vi.fn(async () => {
        throw deliberateStop;
      });
      const startTunnel = vi.fn();
      const runLocal = vi.fn();
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: {
          ...unusedEnvironments(),
          get: attachedEnvironment,
          acquireTurnCredential,
          startTunnel,
        },
        placements,
      });
      const operation = provider
        .executeTurn(
          { ...sessionTarget, runId: input.runId },
          {
            ...input,
            abortSignal: abort.signal,
            onExecutionStarted: async () => {
              // Earlier workspace recovery and externally owned writes retain their own ordering.
              hydration.mockClear();
              acquireTurnCredential.mockClear();
              startTunnel.mockClear();
              entered.resolve();
              await release.promise;
            },
          },
          runLocal,
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      try {
        expect(await Promise.race([entered.promise.then(() => "entered"), operation])).toBe(
          "entered",
        );
        expect(hydration).not.toHaveBeenCalled();
        expect(acquireTurnCredential).not.toHaveBeenCalled();
        expect(startTunnel).not.toHaveBeenCalled();
        if (change === "cancel") {
          abort.abort(new Error("cancel during execution-start settlement"));
        }
        release.resolve();
        const outcome = await operation;
        if (change === "current") {
          expect(outcome).toBe(deliberateStop);
          expect(hydration).toHaveBeenCalledOnce();
          expect(acquireTurnCredential).toHaveBeenCalledOnce();
        } else {
          expect(outcome).toBeInstanceOf(Error);
          expect(hydration).not.toHaveBeenCalled();
          expect(acquireTurnCredential).not.toHaveBeenCalled();
        }
        expect(startTunnel).not.toHaveBeenCalled();
        expect(runLocal).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await operation;
        hydration.mockRestore();
        input.preparedRunAdmission.close();
      }
    },
  );

  it.each(["current", "cancel", "run", "phase", "claim", "session"] as const)(
    "checks %s ownership after writable transcript hydration before acquiring credentials",
    async (change) => {
      await seedActivePlacement();
      const source = SessionManager.open(sessionTarget);
      source.appendMessage(
        makeAgentUserMessage({ content: "Preserve 🦞\nexact history", timestamp: 1 }),
      );
      const before = source.getPersistedEntries();
      const beforeRows = readWorkerTurnTranscriptStorageRows();
      const input = turn(`hydrate-${change}`);
      const abort = new AbortController();
      const entered = createDeferred();
      const release = createDeferred();
      const open = SessionManager.openAsync.bind(SessionManager);
      const hydration = vi
        .spyOn(SessionManager, "openAsync")
        .mockImplementationOnce(async (...args) => {
          requireNodeSqlite();
          const probes = change === "current" ? observeMainThreadSql() : undefined;
          let manager: SessionManager;
          try {
            probes?.calibrate();
            manager = await open(...args);
            probes?.expectIdle();
          } finally {
            probes?.restore();
          }
          expect(manager.getPersistedEntries()).toEqual(before);
          entered.resolve();
          await release.promise;
          return manager;
        });
      const deliberateStop = new WorkerRunnerCapacityError();
      const acquireTurnCredential = vi.fn(async () => {
        throw deliberateStop;
      });
      const startTunnel = vi.fn();
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: {
          ...unusedEnvironments(),
          get: attachedEnvironment,
          acquireTurnCredential,
          startTunnel,
        },
        placements,
        reconcileActivePlacement: async () => {},
      });
      let current = true;
      const operation = provider
        .executeTurn(
          { ...sessionTarget, runId: input.runId },
          {
            ...input,
            abortSignal: abort.signal,
            onExecutionPhase: ({ phase }) => {
              if (change === "phase" && phase === "model_resolution") {
                current = false;
              }
            },
          },
          vi.fn(),
          undefined,
          () => {
            if (!current) {
              throw new Error("fixture run closed");
            }
          },
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      try {
        expect(await Promise.race([entered.promise.then(() => "hydrated"), operation])).toBe(
          "hydrated",
        );
        expect(acquireTurnCredential).not.toHaveBeenCalled();
        const placement = placements.get(SESSION_ID);
        const claim = placement && projectWorkerSessionTurnClaim(placement);
        assert(claim, "expected admitted worker claim");
        if (change === "cancel") {
          abort.abort(new Error("fixture cancelled"));
        } else if (change === "run") {
          current = false;
        } else if (change === "claim") {
          await placements.releaseTurn(claim);
        } else if (change === "session") {
          await patchSessionEntryCore(sessionTarget, () => ({ sessionId: "replacement-session" }));
        }
        release.resolve();
        const outcome = await operation;
        if (change === "current") {
          expect(outcome).toBe(deliberateStop);
          expect(acquireTurnCredential).toHaveBeenCalledOnce();
        } else {
          expect(outcome).toBeInstanceOf(Error);
          expect(acquireTurnCredential).not.toHaveBeenCalled();
        }
        expect(startTunnel).not.toHaveBeenCalled();
        if (change !== "session") {
          expect(SessionManager.open(sessionTarget).getPersistedEntries()).toEqual(before);
          expect(readWorkerTurnTranscriptStorageRows()).toEqual(beforeRows);
        }
      } finally {
        release.resolve();
        await operation;
        hydration.mockRestore();
        input.preparedRunAdmission.close();
      }
    },
  );

  it("settles the committed terminal result when execution is cancelled during hydration", async () => {
    await seedActivePlacement();
    const abort = new AbortController();
    const input = turn("terminal-hydration");
    const entered = createDeferred();
    const release = createDeferred();
    const open = SessionManager.openAsync.bind(SessionManager);
    let reads = 0;
    const hydration = vi.spyOn(SessionManager, "openAsync").mockImplementation(async (...args) => {
      const manager = await open(...args);
      if (++reads === 2) {
        entered.resolve();
        await release.promise;
      }
      return manager;
    });
    const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async (request) => {
      request.onDispatchReady?.();
      const leafId = openSessionManager().appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "Committed reply 🦞" }],
          timestamp: 2,
        }),
      );
      createWorkerSessionPlacementGate(placements).updateAckCursors({
        claim: request.turnClaim,
        transcriptSeq: 2,
        liveSeq: 1,
      });
      return {
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
        stderr: "",
        stdout: JSON.stringify({
          status: "completed",
          transcriptLeafId: leafId,
          transcriptNextSeq: 3,
        }),
      };
    });
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      launchTurn,
      measureLaunchTurn,
      runWorkspaceCommand: vi.fn(),
      syncWorkspace: vi.fn(),
      stop: vi.fn(),
      quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
      reconcileWorkspace: async (request) => {
        assert(request.source.kind === "local", "expected local workspace");
        request.source.journal.commit(MANIFEST_REF);
        return {
          manifestRef: MANIFEST_REF,
          changed: false,
          verifyStable: async () => {},
          verifyLocalStable: async () => {},
        };
      },
    };
    const provider = createWorkerSessionTurnPlacementProvider({
      placements,
      environments: {
        ...unusedEnvironments(),
        get: attachedEnvironment,
        acquireTurnCredential: async () => credential(),
        acknowledgeCredentialDelivery: async () => true,
        startTunnel: async () => tunnel,
      },
    });
    const runLocal = vi.fn();
    const operation = provider.executeTurn(
      { ...sessionTarget, runId: input.runId },
      { ...input, abortSignal: abort.signal },
      runLocal,
    );
    const settled = operation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      expect(await Promise.race([entered.promise.then(() => "hydrated"), settled])).toBe(
        "hydrated",
      );
      const committed = openSessionManager().getPersistedEntries();
      const committedRows = readWorkerTurnTranscriptStorageRows();
      expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
      abort.abort(new Error("cancel after terminal acknowledgement"));
      release.resolve();
      expect(await operation).toMatchObject({ payloads: [{ text: "Committed reply 🦞" }] });
      expect(openSessionManager().getPersistedEntries()).toEqual(committed);
      expect(readWorkerTurnTranscriptStorageRows()).toEqual(committedRows);
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      expect(launchTurn).toHaveBeenCalledOnce();
      expect(runLocal).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await settled;
      hydration.mockRestore();
      input.preparedRunAdmission.close();
    }
  });

  it.each(["current", "cancel", "claim", "session"] as const)(
    "revalidates %s authority after node context preparation before measuring a launch",
    async (change) => {
      await seedActivePlacement();
      const input = turn(`node-context-${change}`);
      const abort = new AbortController();
      const entered = createDeferred();
      const release = createDeferred();
      const deliberateStop = new WorkerRunnerCapacityError();
      const measure = vi.fn(() => {
        throw deliberateStop;
      });
      const launchTurn = vi.fn();
      const runLocal = vi.fn();
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn,
        measureLaunchTurn: measure,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(),
      };
      setActiveNodeContext(
        { nodeId: "fixture-node" },
        {
          prepare: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      );
      const provider = createWorkerSessionTurnPlacementProvider({
        placements,
        environments: {
          ...unusedEnvironments(),
          get: attachedEnvironment,
          acquireTurnCredential: async () => credential(),
          startTunnel: async () => tunnel,
        },
        reconcileActivePlacement: async () => {},
      });
      const operation = provider
        .executeTurn(
          { ...sessionTarget, runId: input.runId },
          { ...input, abortSignal: abort.signal },
          runLocal,
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      try {
        expect(await Promise.race([entered.promise.then(() => "preparing"), operation])).toBe(
          "preparing",
        );
        expect(measure).not.toHaveBeenCalled();
        const placement = placements.get(SESSION_ID);
        const claim = placement && projectWorkerSessionTurnClaim(placement);
        assert(claim, "expected admitted worker claim");
        if (change === "cancel") {
          abort.abort(new Error("cancel during node context preparation"));
        } else if (change === "claim") {
          await placements.releaseTurn(claim);
        } else if (change === "session") {
          await patchSessionEntryCore(sessionTarget, () => ({ sessionId: "replacement-session" }));
        }
        release.resolve();
        const outcome = await operation;
        if (change === "current") {
          expect(outcome).toBe(deliberateStop);
          expect(measure).toHaveBeenCalledOnce();
        } else {
          expect(outcome).toBeInstanceOf(Error);
          expect(measure).not.toHaveBeenCalled();
        }
        expect(launchTurn).not.toHaveBeenCalled();
        expect(runLocal).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await operation;
        setActiveNodeContext(null);
        input.preparedRunAdmission.close();
      }
    },
  );

  it.each(
    ([undefined, "merge", "replace"] as const).flatMap((mode) => [
      { mode, reasoning: false, thinkingLevelMap: undefined, expected: "off" },
      { mode, reasoning: true, thinkingLevelMap: { high: null }, expected: "medium" },
    ]),
  )(
    "honors configured worker Ultra effort $expected in mode $mode with scheduled tools",
    async (testCase) => {
      await seedActivePlacement();
      let descriptor: WorkerLaunchPlan | undefined;
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async ({ plan }) => {
        descriptor = roundTripWorkerLaunchDescriptor(
          completeWorkerLaunchDescriptor(plan, {
            kind: "unix",
            socketPath: "/tmp/worker-approval.sock",
          }),
        );
        throw new WorkerRunnerCapacityError();
      });
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn,
        measureLaunchTurn,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      };
      const environments = {
        ...unusedEnvironments(),
        get: vi.fn(() => attachedEnvironment()),
        acquireTurnCredential: vi.fn(async () => credential()),
        startTunnel: vi.fn(async () => tunnel),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const runLocal = vi.fn();
      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: "run-scheduled",
          },
          {
            ...turn("run-scheduled"),
            thinkLevel: "ultra",
            provider: "custom",
            model: "plain",
            config: {
              models: {
                mode: testCase.mode,
                providers: {
                  custom: {
                    baseUrl: "https://example.invalid/v1",
                    api: "openai-completions",
                    models: [
                      {
                        id: "plain",
                        name: "Plain",
                        reasoning: testCase.reasoning,
                        thinkingLevelMap: testCase.thinkingLevelMap,
                        input: ["text"],
                        contextWindow: 8192,
                        maxTokens: 2048,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      },
                    ],
                  },
                },
              },
            },
            permissionMode: "full",
            execSession: { permissionMode: "full" },
            execOverrides: { host: "gateway", security: "full", ask: "off" },
            toolsAllow: ["exec", "process"],
            scheduledToolPolicy: {
              version: 1,
              mode: "trusted",
              execTarget: { host: "gateway", ask: "always" },
            },
          },
          runLocal,
        ),
      ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
      expect(launchTurn).toHaveBeenCalledOnce();
      expect(descriptor?.assignment.inferenceOptions.reasoning).toBe(testCase.expected);
      expect(descriptor?.assignment.systemPrompt).toContain("Ultra active for this turn");
      expect(descriptor?.assignment.systemPrompt).not.toContain("Use `sessions_spawn`");
      expect(runLocal).not.toHaveBeenCalled();
      expect(descriptor?.assignment.toolAuthority).toMatchObject({
        allowedToolNames: [],
        exec: { host: "gateway", security: "full", ask: "always" },
      });
    },
  );

  it.each([
    [WORKER_LAUNCH_V2_PROTOCOL_FEATURE],
    [WORKER_LAUNCH_V2_PROTOCOL_FEATURE, WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
  ])(
    "fences a stale worker receipt %j while a current receipt proceeds to execution",
    async (...protocolFeatures) => {
      await seedActivePlacement();
      const oldEnvironment = attachedEnvironment();
      const currentReceipt = oldEnvironment.bootstrapReceipt;
      oldEnvironment.bootstrapReceipt = {
        ...currentReceipt!,
        protocolFeatures,
      };
      const passedFence = new Error("current worker receipt passed the turn-execution fence");
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: vi.fn(() => oldEnvironment),
        acquireTurnCredential: vi.fn(async () => {
          throw passedFence;
        }),
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
      ).rejects.toThrow(
        "Active worker bundle lacks the current launch capability; reprovision the worker before launch",
      );

      expect(runLocal).not.toHaveBeenCalled();
      expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
      expect(environments.startTunnel).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });

      oldEnvironment.bootstrapReceipt = currentReceipt;
      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: "run-current-worker",
          },
          turn("run-current-worker"),
          runLocal,
        ),
      ).rejects.toBe(passedFence);

      expect(environments.acquireTurnCredential).toHaveBeenCalledOnce();
      expect(environments.startTunnel).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    },
  );
});
