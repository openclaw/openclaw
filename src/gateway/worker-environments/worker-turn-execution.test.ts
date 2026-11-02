import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { modelDefinition } from "../../agents/model-auth.fixtures.test-support.js";
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
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { resolveNodeWorkerLaunchToolNames } from "../../infra/node-runner-inventory.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import type { WorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import { roundTripWorkerLaunchDescriptor } from "../../worker/launch-descriptor.test-support.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { getWorkerTurnToolSurface } from "./placement-turn-claim-events.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import { registerWorkerTurnInferenceTests } from "./worker-turn-execution.inference.suite.js";
import {
  acknowledgeCompletedWorkerTurn,
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  credential,
  SESSION_ID,
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

afterAll(closeStateDatabaseForTest);

function unusedTunnel<T extends Partial<WorkerTunnelHandle>>(overrides: T) {
  return createWorkerTurnTunnel({
    runWorkspaceCommand: vi.fn(),
    syncWorkspace: vi.fn(),
    reconcileWorkspace: vi.fn(reconcileUnchangedLocalWorkspace),
    stop: vi.fn(),
    launchTurn: vi.fn(),
    ...overrides,
  });
}

function turnProvider(
  environments: Partial<WorkerTurnEnvironmentService>,
  options: Omit<
    Parameters<typeof createWorkerSessionTurnPlacementProvider>[0],
    "placements" | "environments"
  > = {},
) {
  return createWorkerSessionTurnPlacementProvider({
    placements,
    environments: { ...unusedEnvironments(), get: attachedEnvironment, ...environments },
    ...options,
  });
}

function credentialedProvider(
  tunnel: WorkerTunnelHandle,
  options: Parameters<typeof turnProvider>[1] = {},
) {
  return turnProvider(
    {
      acquireTurnCredential: async () => credential(),
      startTunnel: async () => tunnel,
    },
    options,
  );
}

function preparePolicyRuntime(input: ReturnType<typeof turn>) {
  return acquireAgentRunPreparedModelRuntime({
    config: input.config,
    agentId: input.agentId,
    agentDir: resolveAgentDir(input.config, input.agentId),
    workspaceDir: input.workspaceDir,
  });
}

type TurnProvider = ReturnType<typeof turnProvider>;
type ExecuteArgs = Parameters<TurnProvider["executeTurn"]>;
function execute(
  provider: TurnProvider,
  input: ExecuteArgs[1],
  runLocal: ExecuteArgs[2] = vi.fn(),
  assertCurrent?: ExecuteArgs[4],
) {
  return provider.executeTurn(
    { ...sessionTarget, runId: input.runId },
    input,
    runLocal,
    undefined,
    assertCurrent,
  );
}

function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function pausedTurn(runId: string) {
  const input = turn(runId);
  const abort = new AbortController();
  const entered = createDeferred();
  const release = createDeferred();
  return { input, abort, entered, release };
}

async function invalidateTurn(change: string, abort: AbortController) {
  const placement = placements.get(SESSION_ID);
  const claim = placement && projectWorkerSessionTurnClaim(placement);
  assert(claim, "expected admitted worker claim");
  if (change === "cancel") {
    abort.abort(new Error("fixture cancelled"));
  } else if (change === "claim") {
    await placements.releaseTurn(claim);
  } else if (change === "session") {
    await patchSessionEntryCore(sessionTarget, () => ({ sessionId: "replacement-session" }));
  }
}

function expectStopped(outcome: unknown, stop: Error, change: string, ...mocks: unknown[]) {
  if (change === "current") {
    expect(outcome).toBe(stop);
    for (const mock of mocks) {
      expect(mock).toHaveBeenCalledOnce();
    }
  } else {
    expect(outcome).toBeInstanceOf(Error);
    expectNoCalls(...mocks);
  }
}

const captureFailure = (error: unknown) => error;

describe("worker turn execution", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));
  afterEach(resetGlobalHookRunner);

  it.each([
    { throws: false, revokeAtCommit: false },
    { throws: true, revokeAtCommit: false },
    { throws: false, revokeAtCommit: true },
  ])("redacts blocked input before launch (%j)", async ({ throws, revokeAtCommit }) => {
    await seedActivePlacement();
    const input = turn("blocked-input");
    const recorder =
      throws || revokeAtCommit
        ? createUserTurnTranscriptRecorder({
            target: () => ({ ...sessionTarget, sessionEntry: undefined }),
            input: { text: input.prompt },
          })
        : undefined;
    let sql: ReturnType<typeof observeHostDataSql> | undefined;
    const handler = async () => {
      expect((await openSessionManager()).getEntries()).toEqual([]);
      sql = observeHostDataSql();
      if (throws) {
        throw new Error("synthetic policy failure");
      }
      return {
        outcome: "block" as const,
        reason: "synthetic policy",
        message: "Request blocked.",
      };
    };
    await using runtime = await preparePolicyRuntime(input);
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
    const provider = turnProvider(environments);
    const runLocal = vi.fn();
    const onUserMessagePersisted = vi.fn();
    let current = true;
    let reachedCommit = false;
    const revoked = new Error("synthetic authority closed");
    const admission = probe.admission(workerAdmission, (request, grant, admit) => {
      if (
        request.stage === "commit" &&
        isRecord(request.facts) &&
        isRecord(request.facts.publication) &&
        request.facts.publication.kind === "session-entry-patch-committed"
      ) {
        reachedCommit = true;
        current = !revokeAtCommit;
      }
      admit(request, grant);
    });
    try {
      const execution = execute(
        provider,
        {
          ...input,
          pluginGeneration: runtime.pluginGeneration,
          userTurnTranscriptRecorder: recorder,
          onUserMessagePersisted,
        },
        runLocal,
        () => {
          if (!current) {
            throw revoked;
          }
        },
      );
      if (revokeAtCommit) {
        await expect(execution).rejects.toThrow(revoked);
        expect(reachedCommit).toBe(true);
        expect(sql?.queries).toEqual([]);
        sql?.restore();
        expect((await openSessionManager()).getEntries()).toEqual([]);
        expectNoCalls(
          onUserMessagePersisted,
          environments.acquireTurnCredential,
          environments.startTunnel,
          runLocal,
        );
        return;
      }
      const result = await execution;
      expect(sql?.queries).toEqual([]);
      sql?.restore();
      expect(result.meta).toMatchObject({
        error: { kind: "hook_block" },
        livenessState: "blocked",
      });
      expectNoCalls(environments.acquireTurnCredential, environments.startTunnel, runLocal);
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
      sql?.restore();
      admission.mockRestore();
      registry.typedHooks.splice(registry.typedHooks.indexOf(registration), 1);
      input.preparedRunAdmission.close();
    }
  });

  it("fences a passing gate when run authority closes during its await", async () => {
    await seedActivePlacement();
    const entered = createDeferred();
    const release = createDeferred();
    const input = turn("revoked-gate");
    await using runtime = await preparePolicyRuntime(input);
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
    const provider = turnProvider(environments);
    let current = true;
    const execution = execute(
      provider,
      { ...input, pluginGeneration: runtime.pluginGeneration },
      vi.fn(),
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
      const tunnel = unusedTunnel({ launchTurn });
      const provider = credentialedProvider(tunnel);
      try {
        const outcome = await execute(
          provider,
          { ...input, onUserMessagePersisted },
          runLocal,
          () => {
            if (!current) {
              throw expectedFailure;
            }
          },
        ).catch(captureFailure);
        expect(outcome).toBeInstanceOf(SessionTranscriptMessageCommittedError);
        expect(outcome).toMatchObject({
          committedMessageId,
          committedTarget: sessionTarget,
          cause: expectedFailure,
        });
        expect(isRecordedModelFallbackStop(outcome)).toBe(true);
        expect(committedMessageId).toBeDefined();
        const entries = (await openSessionManager()).getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ id: committedMessageId, message: { role: "user" } });
        expect(onUserMessagePersisted).toHaveBeenCalledTimes(failure === "authority" ? 0 : 1);
        expectNoCalls(launchTurn, runLocal);
      } finally {
        opened.mockRestore();
        input.preparedRunAdmission.close();
      }
    },
  );

  it.each([false, true])(
    "preserves recorded workspace context and limits launch authority to supervisor tools (declared: %s)",
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
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async (request) => {
        const runtime = getWorkerTurnToolSurface({
          sessionId: SESSION_ID,
          runId: request.plan.assignment.runId,
          environmentId: request.plan.admission.environmentId,
          ownerEpoch: request.plan.admission.ownerEpoch,
          turnClaim: request.turnClaim,
        });
        expect(runtime?.getAdditionalInheritedToolNames()).toEqual([]);
        throw new WorkerRunnerCapacityError();
      });
      const tunnel = unusedTunnel({
        launchTurn,
        readLaunchToolNames: async () => launchToolNames,
      });
      const provider = credentialedProvider(tunnel);
      const input = turn("launch-tool-negotiation");
      const agentWorkspace = path.join(root, "agent-bootstrap");
      await mkdir(agentWorkspace);
      await Promise.all([
        writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions."),
        writeFile(path.join(agentWorkspace, "SOUL.md"), "Canonical agent identity."),
        writeFile(path.join(agentWorkspace, "USER.md"), "Canonical user context."),
        writeFile(path.join(agentWorkspace, "TOOLS.md"), "Canonical tool instructions."),
        writeFile(path.join(root, "AGENTS.md"), "Selected execution project instructions."),
        writeFile(path.join(root, "SOUL.md"), "Selected session identity."),
      ]);
      try {
        await expect(
          execute(provider, {
            ...input,
            toolsAllow: declared
              ? [...CORE_WORKER_LAUNCH_TOOL_NAMES, "sessions_list", "github_identity_status"]
              : undefined,
            config: {
              ...input.config,
              agents: {
                defaults: { ...input.config.agents.defaults, workspace: agentWorkspace },
              },
            },
            currentInboundContext: { text: "Current sender: fixture-sender" },
            extraSystemPrompt: "Current delivery: fixture-channel",
            extraSystemPromptTurnContext: { start: 0, text: "Current delivery: fixture-channel" },
          }),
        ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
        const request = launchTurn.mock.calls[0]![0];
        const { systemPrompt, prompt, runtimeContext } = request.plan.assignment;
        expect(systemPrompt).toContain("You are a personal assistant running inside OpenClaw.");
        expect(systemPrompt).not.toContain("Canonical agent instructions.");
        expect(systemPrompt).not.toContain("Canonical agent identity.");
        expect(systemPrompt).not.toContain("Canonical user context.");
        expect(systemPrompt).not.toContain("Canonical tool instructions.");
        expect(systemPrompt).toContain("Selected execution project instructions.");
        expect(systemPrompt).toContain("Selected session identity.");
        expect(systemPrompt).toContain("Working directory: /worker/workspace");
        expect(prompt).toMatch(
          /^\[[^\]]+\d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] Inspect this workspace$/u,
        );
        expect(runtimeContext).toContainEqual({
          kind: "conversation-data",
          text: "Current sender: fixture-sender",
        });
        expect(systemPrompt).not.toContain("Current delivery: fixture-channel");
        expect(runtimeContext).toContainEqual({
          kind: "runtime-instruction",
          text: "Current turn instructions (apply only to this turn):\n\nCurrent delivery: fixture-channel",
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
        expect(authorized?.includes("github_publish")).toBe(!declared);
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
      const { input, abort, entered, release } = pausedTurn(`execution-start-${change}`);
      const hydration = vi.spyOn(SessionManager, "openAsync");
      const deliberateStop = new WorkerRunnerCapacityError();
      const acquireTurnCredential = vi.fn(async () => {
        throw deliberateStop;
      });
      const startTunnel = vi.fn();
      const runLocal = vi.fn();
      const provider = turnProvider({ acquireTurnCredential, startTunnel });
      const operation = execute(
        provider,
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
      ).catch(captureFailure);
      try {
        await awaitGateBeforeSettlement(entered.promise, operation, "execution-start skipped");
        expectNoCalls(hydration, acquireTurnCredential, startTunnel);
        if (change === "cancel") {
          abort.abort(new Error("cancel during execution-start settlement"));
        }
        release.resolve();
        const outcome = await operation;
        expectStopped(outcome, deliberateStop, change, hydration, acquireTurnCredential);
        expectNoCalls(startTunnel, runLocal);
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
      const { input, abort, entered, release } = pausedTurn(`hydrate-${change}`);
      const open = SessionManager.openAsync.bind(SessionManager);
      let placementSql: ReturnType<typeof observeHostDataSql> | undefined;
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
          if (change === "current") {
            placementSql = observeHostDataSql();
          }
          return manager;
        });
      const deliberateStop = new WorkerRunnerCapacityError();
      const acquireTurnCredential = vi.fn(async () => {
        if (placementSql) {
          expect(
            placementSql.queries.filter((sql) => sql.includes("worker_session_placements")),
          ).toEqual([]);
          placementSql.restore();
          placementSql = undefined;
        }
        throw deliberateStop;
      });
      const startTunnel = vi.fn();
      const provider = turnProvider(
        { acquireTurnCredential, startTunnel },
        { reconcileActivePlacement: async () => {} },
      );
      let current = true;
      const operation = execute(
        provider,
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
        () => {
          if (!current) {
            throw new Error("fixture run closed");
          }
        },
      ).catch(captureFailure);
      try {
        await awaitGateBeforeSettlement(entered.promise, operation, "hydration skipped");
        expect(acquireTurnCredential).not.toHaveBeenCalled();
        if (change === "run") {
          current = false;
        }
        await invalidateTurn(change, abort);
        release.resolve();
        const outcome = await operation;
        expectStopped(outcome, deliberateStop, change, acquireTurnCredential);
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
        placementSql?.restore();
        input.preparedRunAdmission.close();
      }
    },
  );

  it("settles the committed terminal result when execution is cancelled during hydration", async () => {
    await seedActivePlacement();
    const { input, abort, entered, release } = pausedTurn("terminal-hydration");
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
    const tunnel = unusedTunnel({
      launchTurn,
      quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
      reconcileWorkspace: reconcileUnchangedLocalWorkspace,
    });
    const provider = turnProvider({
      acquireTurnCredential: async () => credential(),
      acknowledgeCredentialDelivery: async () => true,
      startTunnel: async () => tunnel,
    });
    const runLocal = vi.fn();
    const operation = execute(provider, { ...input, abortSignal: abort.signal }, runLocal);
    const settled = operation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await awaitGateBeforeSettlement(entered.promise, settled, "terminal hydration skipped");
      const committed = (await openSessionManager()).getPersistedEntries();
      const committedRows = readWorkerTurnTranscriptStorageRows();
      expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
      abort.abort(new Error("cancel after terminal acknowledgement"));
      release.resolve();
      expect(await operation).toMatchObject({ payloads: [{ text: "Committed reply 🦞" }] });
      await waitForSessionRunEnd(SESSION_ID, null);
      expect((await openSessionManager()).getPersistedEntries()).toEqual(committed);
      expect(readWorkerTurnTranscriptStorageRows()).toEqual(committedRows);
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
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
      const { input, abort, entered, release } = pausedTurn(`node-context-${change}`);
      const deliberateStop = new WorkerRunnerCapacityError();
      const measure = vi.fn(() => {
        throw deliberateStop;
      });
      const launchTurn = vi.fn();
      const runLocal = vi.fn();
      const tunnel = unusedTunnel({ launchTurn, measureLaunchTurn: measure });
      setActiveNodeContexts([
        {
          nodeId: "fixture-node",
          prepare: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      ]);
      const provider = credentialedProvider(tunnel, { reconcileActivePlacement: async () => {} });
      const operation = execute(provider, { ...input, abortSignal: abort.signal }, runLocal).catch(
        captureFailure,
      );
      try {
        await awaitGateBeforeSettlement(entered.promise, operation, "node preparation skipped");
        expect(measure).not.toHaveBeenCalled();
        await invalidateTurn(change, abort);
        release.resolve();
        const outcome = await operation;
        expectStopped(outcome, deliberateStop, change, measure);
        expectNoCalls(launchTurn, runLocal);
      } finally {
        release.resolve();
        await operation;
        setActiveNodeContexts([]);
        input.preparedRunAdmission.close();
      }
    },
  );

  it("honors nonreasoning worker Ultra effort in merge mode with scheduled tools", async () => {
    await seedActivePlacement();
    let descriptor: WorkerLaunchPlan | undefined;
    const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async ({ plan }) => {
      descriptor = roundTripWorkerLaunchDescriptor({
        ...plan,
        connectionEndpoint: { kind: "unix", socketPath: "/tmp/worker-approval.sock" },
      });
      throw new WorkerRunnerCapacityError();
    });
    const provider = credentialedProvider(
      unusedTunnel({ launchTurn, stop: vi.fn(async () => {}) }),
    );
    const runLocal = vi.fn();
    await expect(
      execute(
        provider,
        {
          ...turn("run-scheduled"),
          thinkLevel: "ultra",
          provider: "custom",
          model: "plain",
          config: {
            models: {
              mode: "merge",
              providers: {
                custom: {
                  baseUrl: "https://example.invalid/v1",
                  api: "openai-completions",
                  apiKey: "synthetic-worker-api-key",
                  models: [modelDefinition("plain", { reasoning: false })],
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
    expect(descriptor?.assignment.inferenceOptions.reasoning).toBe("off");
    expect(descriptor?.assignment.systemPrompt).toContain("Ultra active for this turn");
    expect(descriptor?.assignment.systemPrompt).not.toContain("Use `sessions_spawn`");
    expect(runLocal).not.toHaveBeenCalled();
    expect(descriptor?.assignment.toolAuthority).toMatchObject({
      allowedToolNames: ["exec", "process"],
      exec: { host: "gateway", security: "full", ask: "always" },
    });
  });

  registerWorkerTurnInferenceTests();

  it("fences a stale worker receipt while a current receipt proceeds to execution", async () => {
    await seedActivePlacement();
    const oldEnvironment = attachedEnvironment();
    const currentReceipt = oldEnvironment.bootstrapReceipt;
    oldEnvironment.bootstrapReceipt = {
      ...currentReceipt!,
      protocolFeatures: [
        WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
        WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
      ],
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

    await expect(execute(provider, turn("run-old-worker"), runLocal)).rejects.toThrow(
      "Active worker bundle lacks the current launch capability; reprovision the worker before launch",
    );

    expectNoCalls(runLocal, environments.acquireTurnCredential, environments.startTunnel);
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });

    oldEnvironment.bootstrapReceipt = currentReceipt;
    await expect(execute(provider, turn("run-current-worker"), runLocal)).rejects.toBe(passedFence);

    expect(environments.acquireTurnCredential).toHaveBeenCalledOnce();
    expect(environments.startTunnel).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });
});
