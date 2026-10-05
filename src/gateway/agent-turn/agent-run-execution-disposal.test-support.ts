import { DatabaseSync } from "node:sqlite";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  retainPreparedPluginGeneration,
  retainPreparedPluginRegistry,
} from "../../agents/prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "../../agents/prepared-model-runtime.resources.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import { retainRuntimePluginWork } from "../../agents/runtime-plugin-work.js";
import * as runtimePlugins from "../../agents/runtime-plugins.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../plugins/registry-inspection.test-support.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { registerChatAbortController, type ChatAbortControllerEntry } from "../chat-abort.js";
import { createChatAbortContext } from "../server-methods/chat.abort.test-helpers.js";
import { startAgentRunExecution } from "./agent-run-execution-phase.js";

export function createExecution(
  options: {
    aborted?: boolean;
    assertContextCurrent?: () => void;
    pendingInputSettlement?: () => Promise<void>;
  } = {},
) {
  const abortCleanup = vi.fn();
  const gatewayRelease = vi.fn();
  const callerRelease = vi.fn();
  const { promise: runtimeReleased, resolve: resolveRuntimeReleased } = createDeferred();
  const runtimeRelease = vi.fn(async () => resolveRuntimeReleased());
  const controller = new AbortController();
  if (options.aborted) {
    controller.abort();
  }
  return {
    abortCleanup,
    gatewayRelease,
    callerRelease,
    runtimeRelease,
    runtimeReleased,
    params: {
      assertContextCurrent: options.assertContextCurrent,
      prepared: {
        releaseCallerAuthority: callerRelease,
        activeGatewayWorkAdmission: {
          release: gatewayRelease,
          run: async (run: () => Promise<void>) => await run(),
        },
        activeRunAbort: {
          cleanup: abortCleanup,
          controller,
          registered: false,
        },
        effectiveAllowModelOverride: false,
        lifecycleStorePath: "",
        operationalRunInstance: {},
        preparedModelRuntimeLease: { [Symbol.asyncDispose]: runtimeRelease, snapshot: {} },
        replyDispatchRuntime: {
          config: { runtime: "A" },
          pluginGeneration: "generation-A",
        },
        unpersistedOffloadedRefs: [],
        userTurn: {
          recorder: options.pendingInputSettlement
            ? { waitForPendingInputSettlement: options.pendingInputSettlement }
            : undefined,
          execApprovalFollowupHandoffClaimId: "claim",
          message: "continue",
          senderIsOwner: false,
          suppressPromptPersistence: false,
        },
        workspaceOverride: "/workspace/A",
      },
      request: {},
      cfg: {},
      activeSessionAgentId: "main",
      delivery: {},
      isNewSession: false,
      isRawModelRun: true,
      isOneShotModelRun: true,
      isRestartRecoveryResumeRun: false,
      suppressVisibleSessionEffects: true,
      images: [],
      imageOrder: [],
      media: [],
      runId: "owner-test",
      agentDedupeKeys: [],
      bestEffortDeliver: false,
      lifecycleGeneration: "test",
      preserveUserFacingSessionModelState: false,
      skipAgentInitialSessionTouch: true,
      canUseInternalRuntimeHandoff: false,
      client: null,
      context: {
        getSessionEventSubscriberConnIds: () => new Set(),
        dedupe: new Map(),
        deps: {},
        logGateway: { error: vi.fn(), warn: vi.fn() },
      },
      io: {
        emitAcceptance: vi.fn(),
        emitFinal: vi.fn(),
      },
      releaseCronContinuationClaimWithRecovery: async () => true,
    } as unknown as Parameters<typeof startAgentRunExecution>[0],
  };
}

export function registerAgentRunDisposalTests(params: {
  dispatchAgentRunFromGateway: Mock<
    typeof import("./agent-run-dispatch.js").dispatchAgentRunFromGateway
  >;
  agentCommand: Mock<typeof import("../../commands/agent.js").agentCommandFromGatewayIngress>;
}) {
  const { dispatchAgentRunFromGateway, agentCommand } = params;
  it.each(["success", "startup failure", "cleanup failure", "completed cleanup failure"] as const)(
    "retains raw disposal after its real terminal producer settles %s",
    async (outcome) => {
      const execution = createExecution();
      const controllers = new Map<string, ChatAbortControllerEntry>();
      const instance = createOperationalRunInstanceRef(execution.params.runId);
      const registration = registerChatAbortController({
        chatAbortControllers: controllers,
        runId: execution.params.runId,
        sessionKey: "agent:main:composed-terminal-disposal",
        sessionId: "composed-terminal-disposal",
        operationalRunInstance: instance,
        kind: "agent",
        timeoutMs: 60_000,
      });
      if (!registration.entry) {
        throw new Error("Expected the composed execution registration");
      }
      const entry = registration.entry;
      execution.params.prepared.activeRunAbort = registration;
      execution.params.prepared.operationalRunInstance = instance;
      execution.params.lifecycleGeneration = getAgentEventLifecycleGeneration();
      Object.assign(
        execution.params.context,
        createChatAbortContext({ ...execution.params.context, chatAbortControllers: controllers }),
      );
      const admission = await beginSessionWorkAdmission({
        scope: "composed-terminal-disposal",
        identities: [entry.sessionKey, entry.sessionId],
        assertAllowed: () => {},
      });
      execution.params.prepared.activeGatewayWorkAdmission = admission;
      const commandEntered = createDeferred();
      const finishCommand = createDeferred();
      const saveEntered = createDeferred();
      const finishSave = createDeferred();
      const disposalEntered = createDeferred();
      const finishDisposal = createDeferred();
      agentCommand.mockImplementationOnce(async () => {
        commandEntered.resolve();
        await finishCommand.promise;
        if (outcome === "startup failure") {
          throw new Error("Synthetic command startup failure");
        }
        return { payloads: [], meta: { durationMs: 0 } };
      });
      const actualDispatch =
        await vi.importActual<typeof import("./agent-run-dispatch.js")>("./agent-run-dispatch.js");
      dispatchAgentRunFromGateway.mockImplementationOnce(
        actualDispatch.dispatchAgentRunFromGateway,
      );
      const cleanupFault = new Error("Synthetic unfinished runtime cleanup");
      execution.runtimeRelease.mockImplementation(async () => {
        disposalEntered.resolve();
        await finishDisposal.promise;
        if (outcome === "cleanup failure") {
          throw cleanupFault;
        }
      });
      const callbackFault = new Error("Synthetic completed inspection callback failure");
      let database: DatabaseSync | undefined;
      let nativeDisposals = 0;
      if (outcome === "completed cleanup failure") {
        const registry = createEmptyPluginRegistry();
        const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
        resources.attach(registry);
        const native = (database = new DatabaseSync(":memory:"));
        let releaseGeneration: (() => Promise<void>) | undefined = undefined;
        onTestFinished(async () => {
          finishDisposal.resolve();
          await releaseGeneration?.().catch(() => {});
          await resources.release().catch(() => {});
          if (native.isOpen) {
            native.close();
          }
        });
        const nativeDispose = async () => {
          nativeDisposals++;
          disposalEntered.resolve();
          await finishDisposal.promise;
          native.close();
          throw callbackFault;
        };
        resources.runRegistration("completed-cleanup", () => {
          resources.register("completed-cleanup", { id: "sqlite", dispose: nativeDispose });
        });
        const construction = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
        const discovery = vi
          .spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry")
          .mockResolvedValueOnce({
            registry,
            primaryRegistry: registry,
            resources,
            releaseRegistry: resources.release.bind(resources),
            releaseWork: retainRuntimePluginWork([registry]),
          });
        try {
          await construction.load({ config: {} }, () => {});
        } finally {
          discovery.mockRestore();
        }
        const generation: PreparedModelRuntimePluginGeneration = {
          remoteCatalog: null,
          pluginMetadataSnapshot: createPluginMetadataSnapshot({
            config: {},
            manifestRegistry: makeRegistry([]),
          }),
          inlineProviderModels: [],
          configuredCatalogEntries: [],
          pluginRegistry: registry,
        };
        releaseGeneration = retainPreparedPluginGeneration(generation);
        await construction[Symbol.asyncDispose]();
        execution.params.prepared.preparedModelRuntimeLease = {
          ...expectDefined(
            execution.params.prepared.preparedModelRuntimeLease,
            "ready session runtime",
          ),
          pluginGeneration: generation,
          [Symbol.asyncDispose]: releaseGeneration,
        };
        execution.params.prepared.replyDispatchRuntime = {
          ...execution.params.prepared.replyDispatchRuntime,
          pluginGeneration: generation,
        };
      }
      const finished = vi.fn();
      const completion = startAgentRunExecution(execution.params).then(finished);
      const observed = completion.catch((error: unknown) => error);
      try {
        await Promise.race([
          commandEntered.promise,
          disposalEntered.promise.then(() => {
            throw new Error("Execution entered disposal before command dispatch");
          }),
        ]);
        const producer = entry.resolveTerminalProducer?.();
        expect(
          producer?.handoff(async (producerCompleted) => {
            await producerCompleted;
            saveEntered.resolve();
            await finishSave.promise;
          }),
        ).toBe(true);
        finishCommand.resolve();
        await Promise.race([
          saveEntered.promise,
          disposalEntered.promise.then(() => {
            throw new Error("Execution entered disposal before its terminal save");
          }),
        ]);
        expect(execution.runtimeRelease).not.toHaveBeenCalled();
        expect(entry.executionSettlement?.status).toBe("pending");
        finishSave.resolve();
        await disposalEntered.promise;
        expect(entry.resolveTerminalProducer?.()).toBeUndefined();
        expect(entry.registrationCleanupRequested).toBe(true);
        expect(entry.projectSessionActive).toBe(false);
        expect(registration.markExecutionStarted()).toBe(false);
        expect(controllers.get(execution.params.runId)).toBe(entry);
        expect(entry.executionSettlement?.status).toBe("pending");
        expect(execution.callerRelease).not.toHaveBeenCalled();
        expect(finished).not.toHaveBeenCalled();
        if (database) {
          expect(database.isOpen).toBe(true);
        }
        finishDisposal.resolve();
        if (outcome === "completed cleanup failure") {
          expect(collectNestedErrorCandidates(await observed)).toContain(callbackFault);
          expect(database?.isOpen).toBe(false);
          expect(nativeDisposals).toBe(1);
          expect(entry.executionSettlement?.status).toBe("rejected");
          expect(entry.executionSettlement?.cleanupSettled).toBe(true);
        } else if (outcome === "cleanup failure") {
          expect(await observed).toBe(cleanupFault);
          expect(entry.executionSettlement?.status).toBe("rejected");
          expect(entry.executionSettlement?.cleanupSettled).toBe(false);
        } else {
          await completion;
          expect(entry.executionSettlement?.status).toBe("fulfilled");
        }
        expect(controllers.has(execution.params.runId)).toBe(outcome === "cleanup failure");
        expect(execution.callerRelease).toHaveBeenCalledOnce();
      } finally {
        finishCommand.resolve();
        finishSave.resolve();
        finishDisposal.resolve();
        await observed;
        admission.release();
        controllers.clear();
      }
    },
  );
}
