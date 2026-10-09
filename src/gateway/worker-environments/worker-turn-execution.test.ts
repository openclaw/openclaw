import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { isRecordedModelFallbackStop } from "../../agents/model-fallback-stop.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import { SessionTranscriptMessageCommittedError } from "../../agents/sessions/session-manager-message-error.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  CORE_WORKER_LAUNCH_TOOL_NAMES,
  resolveCoreToolExecutionLocation,
} from "../../agents/tool-catalog.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resolveSqliteReadScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { resolveNodeWorkerLaunchToolNames } from "../../infra/node-runner-inventory.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  completeWorkerLaunchDescriptor,
  parseWorkerLaunchPlan,
  type WorkerLaunchPlan,
} from "../../worker/launch-descriptor.js";
import { roundTripWorkerLaunchDescriptor } from "../../worker/launch-descriptor.test-support.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import { registerWorkerTurnInferenceTests } from "./worker-turn-execution.inference.suite.js";
import {
  acknowledgeCompletedWorkerTurn,
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  credential,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  openSessionManager,
  readWorkerTurnTranscriptStorageRows,
  root,
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
  afterEach(resetGlobalHookRunner);

  it.each([
    { recorderOwned: false, throws: false },
    { recorderOwned: true, throws: false },
    { recorderOwned: false, throws: true },
    { recorderOwned: true, throws: true },
  ])("redacts blocked input before launch (%j)", async ({ recorderOwned, throws }) => {
    await seedActivePlacement();
    const input = turn("blocked-input");
    const recorder = recorderOwned
      ? createUserTurnTranscriptRecorder({
          target: { ...sessionTarget, sessionEntry: undefined },
          input: { text: input.prompt },
        })
      : undefined;
    const handler = vi.fn(async () => {
      expect((await openSessionManager()).getEntries()).toEqual([]);
      if (throws) {
        throw new Error("synthetic policy failure");
      }
      return { outcome: "block" as const, reason: "synthetic policy", message: "Request blocked." };
    });
    await using runtime = await acquireAgentRunPreparedModelRuntime({
      config: input.config,
      agentId: input.agentId,
      agentDir: resolveAgentDir(input.config, input.agentId),
      workspaceDir: input.workspaceDir,
    });
    const registry = runtime.snapshot.pluginRegistry;
    assert(registry);
    const registration = {
      pluginId: "policy",
      hookName: "before_agent_run" as const,
      handler,
      source: "test",
    };
    registry.typedHooks.push(registration);
    initializeGlobalHookRunner(registry);
    const environments = { ...unusedEnvironments(), get: attachedEnvironment };
    const provider = createWorkerSessionTurnPlacementProvider({ placements, environments });
    const runLocal = vi.fn();
    const onUserMessagePersisted = vi.fn();
    try {
      const result = await provider.executeTurn(
        { ...sessionTarget, runId: input.runId },
        {
          ...input,
          pluginGeneration: runtime.pluginGeneration,
          userTurnTranscriptRecorder: recorder,
          onUserMessagePersisted,
        },
        runLocal,
      );
      expect(result.meta.error?.kind).toBe("hook_block");
      expect(result.meta.livenessState).toBe("blocked");
      expect(handler).toHaveBeenCalledOnce();
      expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
      expect(environments.startTunnel).not.toHaveBeenCalled();
      expect(runLocal).not.toHaveBeenCalled();
      const messages = (await openSessionManager()).buildSessionContext().messages;
      expect(messages).toEqual([
        expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: result.payloads?.[0]?.text }],
          idempotencyKey: `hook-block:before_agent_run:user:${input.runId}`,
          __openclaw: {
            beforeAgentRunBlocked: {
              blockedBy: throws ? "before_agent_run" : "policy",
              blockedAt: expect.any(Number),
            },
          },
        }),
      ]);
      expect(JSON.stringify(readWorkerTurnTranscriptStorageRows())).not.toContain(input.prompt);
      expect(onUserMessagePersisted).toHaveBeenCalledExactlyOnceWith(messages[0]);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    } finally {
      registry.typedHooks.splice(registry.typedHooks.indexOf(registration), 1);
      input.preparedRunAdmission.close();
    }
  });

  it("fences a passing gate when run authority closes during its await", async () => {
    await seedActivePlacement();
    const entered = createDeferred();
    const release = createDeferred();
    const input = turn("revoked-gate");
    await using runtime = await acquireAgentRunPreparedModelRuntime({
      config: input.config,
      agentId: input.agentId,
      agentDir: resolveAgentDir(input.config, input.agentId),
      workspaceDir: input.workspaceDir,
    });
    const registry = runtime.snapshot.pluginRegistry;
    assert(registry);
    const registration = {
      pluginId: "policy",
      hookName: "before_agent_run" as const,
      source: "test",
      handler: async () => {
        entered.resolve();
        await release.promise;
        return { outcome: "pass" as const };
      },
    };
    registry.typedHooks.push(registration);
    initializeGlobalHookRunner(registry);
    const environments = { ...unusedEnvironments(), get: attachedEnvironment };
    const provider = createWorkerSessionTurnPlacementProvider({ placements, environments });
    let current = true;
    const execution = provider.executeTurn(
      { ...sessionTarget, runId: input.runId },
      { ...input, pluginGeneration: runtime.pluginGeneration },
      vi.fn(),
      undefined,
      () => {
        if (!current) {
          throw new Error("synthetic authority closed");
        }
      },
    );
    const outcome = execution.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(entered.promise, execution, "turn skipped its input gate");
      current = false;
      release.resolve();
      expect(await outcome).toMatchObject({ message: "synthetic authority closed" });
      expect((await openSessionManager()).getEntries()).toEqual([]);
      expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await outcome;
      registry.typedHooks.splice(registry.typedHooks.indexOf(registration), 1);
      input.preparedRunAdmission.close();
    }
  });

  it.each(["authority", "acknowledgement"] as const)(
    "retains the committed user receipt when %s fails before worker launch",
    async (failure) => {
      await seedActivePlacement();
      const input = turn(`user-commit-${failure}`);
      const expectedFailure = new Error(`synthetic ${failure} failure`);
      let current = true;
      let committedMessageId: string | undefined;
      const open = SessionManager.openAsync.bind(SessionManager);
      const opened = vi
        .spyOn(SessionManager, "openAsync")
        .mockImplementationOnce(async (...args) => {
          const manager = await open(...args);
          const append = manager.appendMessageAsync.bind(manager);
          vi.spyOn(manager, "appendMessageAsync").mockImplementation(async (...appendArgs) => {
            committedMessageId = await append(...appendArgs);
            if (failure === "authority") {
              current = false;
            }
            return committedMessageId;
          });
          return manager;
        });
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>();
      const onUserMessagePersisted = vi.fn(() => {
        if (failure === "acknowledgement") {
          throw expectedFailure;
        }
      });
      const runLocal = vi.fn();
      const tunnel = createWorkerTurnTunnel({
        launchTurn,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(),
      });
      const provider = createWorkerSessionTurnPlacementProvider({
        placements,
        environments: {
          ...unusedEnvironments(),
          get: attachedEnvironment,
          acquireTurnCredential: async () => credential(),
          startTunnel: async () => tunnel,
        },
      });
      try {
        const outcome = await provider
          .executeTurn(
            { ...sessionTarget, runId: input.runId },
            { ...input, onUserMessagePersisted },
            runLocal,
            undefined,
            () => {
              if (!current) {
                throw expectedFailure;
              }
            },
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(outcome).toBeInstanceOf(SessionTranscriptMessageCommittedError);
        expect(outcome).toMatchObject({
          committedMessageId,
          committedTarget: {
            ...sessionTarget,
            storePath: resolveSqliteReadScope(sessionTarget).path,
          },
          cause: expectedFailure,
        });
        expect(isRecordedModelFallbackStop(outcome)).toBe(true);
        expect(committedMessageId).toBeDefined();
        const entries = (await openSessionManager()).getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ id: committedMessageId, message: { role: "user" } });
        expect(onUserMessagePersisted).toHaveBeenCalledTimes(failure === "authority" ? 0 : 1);
        expect(launchTurn).not.toHaveBeenCalled();
        expect(runLocal).not.toHaveBeenCalled();
      } finally {
        opened.mockRestore();
        input.preparedRunAdmission.close();
      }
    },
  );

  it.each([false, true])(
    "preserves prepared context and limits launch authority to supervisor tools (declared: %s)",
    async (declared) => {
      await seedActivePlacement();
      const launchToolNames = resolveNodeWorkerLaunchToolNames({
        enabled: true,
        capacity: { total: 1, available: 1 },
        environmentSession: 1,
        capturedExecPolicy: true,
        promptContext: 1,
        ...(declared ? { launchToolNames: [...CORE_WORKER_LAUNCH_TOOL_NAMES] } : {}),
      });
      const authorize = vi.spyOn(placements, "authorizeWorkerTurnTools");
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async () => {
        throw new WorkerRunnerCapacityError();
      });
      const tunnel = createWorkerTurnTunnel({
        launchTurn,
        readLaunchToolNames: async () => launchToolNames,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(),
      });
      const provider = createWorkerSessionTurnPlacementProvider({
        placements,
        environments: {
          ...unusedEnvironments(),
          get: attachedEnvironment,
          acquireTurnCredential: async () => credential(),
          startTunnel: async () => tunnel,
        },
      });
      const input = turn("launch-tool-negotiation");
      const agentWorkspace = path.join(root, "agent-bootstrap");
      await mkdir(agentWorkspace);
      await Promise.all([
        writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions."),
        writeFile(path.join(agentWorkspace, "SOUL.md"), "Canonical agent identity."),
        writeFile(path.join(agentWorkspace, "USER.md"), "Canonical user context."),
        writeFile(path.join(agentWorkspace, "TOOLS.md"), "Canonical tool instructions."),
        writeFile(path.join(root, "AGENTS.md"), "Selected execution project instructions."),
        writeFile(path.join(root, "SOUL.md"), "Unselected execution identity must stay private."),
      ]);
      try {
        await expect(
          provider.executeTurn(
            { ...sessionTarget, runId: input.runId },
            {
              ...input,
              config: {
                ...input.config,
                agents: {
                  defaults: { ...input.config.agents.defaults, workspace: agentWorkspace },
                },
              },
              currentInboundContext: { text: "Current sender: fixture-sender" },
            },
            vi.fn(),
          ),
        ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
        expect(launchTurn).toHaveBeenCalledOnce();
        const request = launchTurn.mock.calls[0]![0];
        expect(parseWorkerLaunchPlan(request.plan)).toEqual(request.plan);
        const { systemPrompt, prompt, runtimeContext } = request.plan.assignment;
        expect(systemPrompt).toContain("You are a personal assistant running inside OpenClaw.");
        expect(systemPrompt).toContain("Canonical agent instructions.");
        expect(systemPrompt).toContain("Canonical agent identity.");
        expect(systemPrompt).toContain("Canonical user context.");
        expect(systemPrompt).not.toContain("Canonical tool instructions.");
        expect(systemPrompt).toContain("Selected execution project instructions.");
        expect(systemPrompt).not.toContain("Unselected execution identity must stay private.");
        expect(systemPrompt).toContain("Working directory: /worker/workspace");
        expect(prompt).toMatch(
          /^\[[^\]]+\d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] Inspect this workspace$/u,
        );
        expect(runtimeContext).toContainEqual({
          kind: "conversation-data",
          text: "Current sender: fixture-sender",
        });
        const allowed = request.plan.assignment.toolAuthority.allowedToolNames;
        expect(allowed.length).toBeGreaterThan(0);
        expect(allowed.filter((name) => !launchToolNames.includes(name))).toEqual([]);
        expect(
          allowed.every((name) => resolveCoreToolExecutionLocation(name) === "placement"),
        ).toBe(true);
        expect(allowed.includes("ls")).toBe(declared);
        expect(allowed).not.toContain("sessions_list");
        const authorized = authorize.mock.calls[0]?.[1];
        expect(authorized).toEqual(
          expect.arrayContaining([...allowed, "sessions_list", "github_identity_status"]),
        );
        expect(authorized).not.toContain("github_publish");
        expect(authorize).toHaveBeenCalledExactlyOnceWith(
          request.turnClaim,
          authorized,
          expect.any(Function),
        );
      } finally {
        authorize.mockRestore();
        input.preparedRunAdmission.close();
      }
    },
  );

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
            onExecutionStarted: async (info) => {
              expect(info?.backend).toBe("cloud-worker");
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
      const source = await SessionManager.openAsync(sessionTarget);
      await source.appendMessageAsync(
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
          expect((await SessionManager.openAsync(sessionTarget)).getPersistedEntries()).toEqual(
            before,
          );
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
    let terminalAcknowledged = false;
    let terminalHydrationHeld = false;
    const hydration = vi.spyOn(SessionManager, "openAsync").mockImplementation(async (...args) => {
      const manager = await open(...args);
      if (terminalAcknowledged && !terminalHydrationHeld) {
        terminalHydrationHeld = true;
        entered.resolve();
        await release.promise;
      }
      return manager;
    });
    const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async (request) => {
      request.onDispatchReady?.();
      const leafId = await (
        await openSessionManager()
      ).appendMessageAsync(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "Committed reply 🦞" }],
          timestamp: 2,
        }),
      );
      const result = await acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
      terminalAcknowledged = true;
      return result;
    });
    const tunnel = createWorkerTurnTunnel({
      launchTurn,
      runWorkspaceCommand: vi.fn(),
      syncWorkspace: vi.fn(),
      stop: vi.fn(),
      quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
      reconcileWorkspace: reconcileUnchangedLocalWorkspace,
    });
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
      const committed = (await openSessionManager()).getPersistedEntries();
      const committedRows = readWorkerTurnTranscriptStorageRows();
      expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
      abort.abort(new Error("cancel after terminal acknowledgement"));
      release.resolve();
      expect(await operation).toMatchObject({ payloads: [{ text: "Committed reply 🦞" }] });
      expect((await openSessionManager()).getPersistedEntries()).toEqual(committed);
      expect(readWorkerTurnTranscriptStorageRows()).toEqual(committedRows);
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
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
      const tunnel = createWorkerTurnTunnel({
        launchTurn,
        measureLaunchTurn: measure,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(),
      });
      setActiveNodeContexts([
        {
          nodeId: "fixture-node",
          prepare: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      ]);
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
        setActiveNodeContexts([]);
        input.preparedRunAdmission.close();
      }
    },
  );

  it.each([
    { mode: "merge", reasoning: false, thinkingLevelMap: undefined, expected: "off" },
    { mode: "replace", reasoning: true, thinkingLevelMap: { high: null }, expected: "medium" },
  ] as const)(
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
      const tunnel = createWorkerTurnTunnel({
        launchTurn,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      });
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
                    apiKey: "synthetic-worker-api-key",
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

  registerWorkerTurnInferenceTests();

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
