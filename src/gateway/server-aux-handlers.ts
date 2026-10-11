import { randomUUID } from "node:crypto";
import { resolveProjectedMcpCodexToolApprovalMode } from "../agents/mcp-codex-tool-approval.js";
import { getRuntimeConfig } from "../config/io.js";
import type { DurableQuestion } from "../config/sessions/session-questions.types.js";
import type { AgentRunApprovalClosureReason } from "../infra/agent-run-approval-leases.js";
import {
  type AgentRunDelegatedAuthority,
  registerAgentRunDelegatedAuthorityClosedHandler,
} from "../infra/agent-run-registry.js";
import type { ApprovalNativeRouteCoordinator } from "../infra/approval-native-route-coordinator.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import {
  type ExecApprovalDecision,
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequestPayload,
} from "../infra/exec-approvals.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { handleQuestionChannelResolved } from "../infra/question-channel-runtime.js";
import {
  SYSTEM_AGENT_APPROVAL_DECISIONS,
  type SystemAgentApprovalRequestPayload,
} from "../infra/system-agent-approvals.js";
import { runWithRetainedGatewayRootWork } from "../process/gateway-work-admission.js";
import { resolveCommandSecretsFromActiveRuntimeSnapshot } from "../secrets/runtime-command-secrets.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import { getAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import type { AgentRuntimeDelegatedAuthority } from "./agent-runtime-identity-token.js";
import { resolveApprovalSessionAudienceWithFallback } from "./approval-session-audience.js";
import { createApprovalWebPushDelivery } from "./approval-web-push.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import {
  createExecApprovalIosPushDelivery,
  createPluginApprovalIosPushDelivery,
} from "./exec-approval-ios-push.js";
import {
  ExecApprovalManager,
  type OperatorApprovalLifecycleEvent,
  type OperatorStandingGrantMintSpec,
} from "./exec-approval-manager.js";
import { createLazyHandler } from "./lazy-handler.js";
import {
  createPlacementStandingGrantRuntime,
  type PlacementStandingGrantRuntime,
} from "./operator-approval-placement-grants.js";
import {
  closeOrphanedOperatorApprovals,
  pruneTerminalOperatorApprovals,
} from "./operator-approval-store.js";
import { createQuestionCompletionReceipts } from "./question-completion-receipts.js";
import { createQuestionContinuationPublication } from "./question-continuation-publication.js";
import { createQuestionContinuationWork } from "./question-continuation-work.js";
import { QuestionManager } from "./question-manager.js";
import { createQuestionRecovery } from "./question-recovery.js";
import { publishDurableQuestionResolution } from "./question-session-access.js";
import type { GatewayInstanceRuntime } from "./server-instance-runtime.types.js";
import { publishAppliedApprovalResolution } from "./server-methods/approval-publication.js";
import {
  cancelAgentRuntimeBoundApprovals,
  cancelUnboundRunApprovals,
  cancelWorkerTurnClaimBoundApprovals,
} from "./server-methods/approval-run-cancellation.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  createGatewaySecretsReloader,
  type GatewaySecretsReloaderParams,
} from "./server-secrets-reload.js";
import type { WorkerSessionTurnClaim } from "./worker-environments/placement-record.js";

type ApprovalPayload =
  | ExecApprovalRequestPayload
  | PluginApprovalRequestPayload
  | SystemAgentApprovalRequestPayload;

type GatewayAuxHandlerLogger = {
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

export function createGatewayAuxHandlers(
  params: GatewaySecretsReloaderParams & {
    scheduler: GatewayScheduler;
    getQuestionRuntime?: () => GatewayInstanceRuntime | undefined;
    getQuestionContext?: () => GatewayRequestContext | undefined;
    log: GatewayAuxHandlerLogger;
    onApprovalLifecycle?: (event: OperatorApprovalLifecycleEvent) => void;
    onAgentRunAuthorityClosed?: (
      authority: AgentRunDelegatedAuthority,
      approvalReason?: AgentRunApprovalClosureReason,
    ) => void;
    validateAgentRuntimeDelegatedAuthority?: (authority: AgentRuntimeDelegatedAuthority) => boolean;
    /** Abort-wins guard: a tombstoned run must not mint standing authority. */
    hasRunAbortMarker?: (runId: string) => boolean;
    /** Native approval handlers of this Gateway's channel accounts register here. */
    getNativeApprovalRouteCoordinator: () => ApprovalNativeRouteCoordinator | undefined;
    /** Config-driven default expiry stamp for freshly minted standing grants. */
    resolveGrantDefaultExpiresAtMs?: (nowMs: number) => number | null;
    chatAbortControllers?: Map<string, ChatAbortControllerEntry>;
    registerWorkerTurnClaimClosedHandler?: (
      handler: (claim: WorkerSessionTurnClaim) => void,
    ) => () => void;
  },
) {
  // Approval kinds share one durable first-answer-wins registry and
  // Gateway-lifetime epoch while retaining separate in-process waiter maps.
  // A newly constructed Gateway cannot resume the prior lifetime's waiters.
  const approvalPersistence = { runtimeEpoch: randomUUID() };
  const placementStandingGrants = createPlacementStandingGrantRuntime({
    runtimeEpoch: approvalPersistence.runtimeEpoch,
  });
  const approvalStartupNowMs = Date.now();
  closeOrphanedOperatorApprovals({
    runtimeEpoch: approvalPersistence.runtimeEpoch,
    nowMs: approvalStartupNowMs,
  });
  pruneTerminalOperatorApprovals({ nowMs: approvalStartupNowMs });
  const presentationWork = new AsyncWorkScope();
  const trackPresentationWork = (run: () => Promise<void>): Promise<void> =>
    presentationWork.track(() => runWithRetainedGatewayRootWork(run));
  const createApprovalManager = <TPayload extends ApprovalPayload>(
    approvalKind: "exec" | "plugin" | "system-agent",
    resolveAllowedDecisions: (request: TPayload) => readonly ExecApprovalDecision[],
    resolveStandingGrantMint?: (request: TPayload) => OperatorStandingGrantMintSpec | null,
    retainPlacementStandingGrantAsync?: PlacementStandingGrantRuntime["retainAsync"],
  ) =>
    new ExecApprovalManager<TPayload>({
      scheduler: params.scheduler,
      approvalKind,
      persistence: approvalPersistence,
      resolveAudienceSessionKeys: resolveApprovalSessionAudienceWithFallback,
      resolveAllowedDecisions,
      ...(resolveStandingGrantMint ? { resolveStandingGrantMint } : {}),
      ...(retainPlacementStandingGrantAsync ? { retainPlacementStandingGrantAsync } : {}),
      ...(params.resolveGrantDefaultExpiresAtMs
        ? { resolveStandingGrantExpiresAtMs: params.resolveGrantDefaultExpiresAtMs }
        : {}),
      onLifecycle: params.onApprovalLifecycle,
      // Timeout expiry is gateway-clock truth: publish the terminal like a
      // resolve so reviewer surfaces need not infer it from their own clocks.
      onExpired: (record, liveRecord) =>
        publishAuthorityClosure({ kind: approvalKind, record, liveRecord }),
      validateAgentRuntimeDelegatedAuthority: params.validateAgentRuntimeDelegatedAuthority,
      onError: (error, context) =>
        params.log.error?.(
          `${context.approvalKind} approval ${context.operation} failed for ${context.approvalId}: ${String(error)}`,
        ),
    });
  const execApprovalManager = createApprovalManager<ExecApprovalRequestPayload>(
    "exec",
    resolveExecApprovalRequestAllowedDecisions,
    (request) => {
      const source = request.cronExecutionSource;
      const operationBinding = request.cronOperationBinding?.trim();
      const agentId = request.agentId?.trim();
      if (!source || !operationBinding || !agentId) {
        return null;
      }
      // Abort-wins: the abort owner tombstones the run before sweeping its
      // approvals, so a raced allow-always must not mint standing authority.
      if (request.runId && params.hasRunAbortMarker?.(request.runId) === true) {
        return null;
      }
      return {
        kind: "cron",
        agentId,
        cronJobId: source.jobId,
        jobConfigRevision: source.jobConfigRevision,
        operationBinding,
      };
    },
  );
  const execApprovalForwarder = createExecApprovalForwarder({
    getNativeApprovalRouteCoordinator: params.getNativeApprovalRouteCoordinator,
  });
  const approvalWebPushDelivery = createApprovalWebPushDelivery({
    getRuntimeConfig,
    log: params.log,
  });
  const execApprovalIosPushDelivery = createExecApprovalIosPushDelivery({ log: params.log });
  const loadExecApprovalHandlers = createLazyPromise(
    () =>
      import("./server-methods/exec-approval.js").then(({ createExecApprovalHandlers }) =>
        createExecApprovalHandlers(execApprovalManager, {
          forwarder: execApprovalForwarder,
          iosPushDelivery: execApprovalIosPushDelivery,
        }),
      ),
    { cacheRejections: true },
  );
  const reloadSecrets = createGatewaySecretsReloader(params);
  const loadSecretStoreWriteService = createLazyPromise(
    async () => {
      const { createSecretStoreWriteService } = await import("./server-methods/secrets.js");
      return createSecretStoreWriteService({ reloadSecrets, log: params.log });
    },
    { cacheRejections: true },
  );
  const questionManager = new QuestionManager(params.scheduler, () =>
    params.log.warn?.("Question terminal publication failed; answer state retained."),
  );
  let questionsClosing = false;
  const continuations = createQuestionContinuationWork({
    scheduler: params.scheduler,
    track: trackPresentationWork,
    isClosing: () => questionsClosing,
  });
  const assertQuestionOwnerCurrent = () => {
    if (questionsClosing || !params.getQuestionRuntime?.()?.isAvailable()) {
      throw new Error("Durable question Gateway owner is unavailable.");
    }
  };
  const publishContinuationReceipt = createQuestionContinuationPublication({
    questionManager,
    getContext: () => params.getQuestionContext?.(),
    assertCurrent: assertQuestionOwnerCurrent,
    warn: (message) => params.log.warn?.(message),
  });
  const completionReceipts = createQuestionCompletionReceipts({
    scheduler: params.scheduler,
    warn: (message) => params.log.warn?.(message),
  });
  const onContinuationOwed = (question: DurableQuestion) => {
    if (questionsClosing) {
      return;
    }
    const observation = questionManager.observe(question.record.id);
    void continuations.offer(question, async (signal) => {
      let admissionOwed = false;
      try {
        const runtime = params.getQuestionRuntime?.();
        const context = params.getQuestionContext?.();
        if (!runtime || !context) {
          throw new Error("Durable question native dispatcher is unavailable.");
        }
        const { dispatchQuestionContinuation } = await import("./question-continuation.js");
        const receipt = await dispatchQuestionContinuation({
          question,
          scope: question.sessionBinding,
          context,
          runtime,
          assertCurrent: assertQuestionOwnerCurrent,
          signal,
        });
        if (receipt.status === "admission_owed") {
          admissionOwed = true;
          return receipt;
        }
        if (receipt.status === "completion_owed" || receipt.status === "terminal_owed") {
          completionReceipts.offer(
            receipt,
            () => publishContinuationReceipt(question, observation),
            () => {
              if (observation) {
                questionManager.retireDurableCustodyObservation(observation);
              }
            },
          );
        }
      } catch (error) {
        params.log.warn?.(
          `durable question continuation ${question.record.id} failed: ${String(error)}`,
        );
      } finally {
        if (!admissionOwed) {
          await publishContinuationReceipt(question, observation);
        }
      }
      return undefined;
    });
  };
  const agentDatabaseStartup = getAgentDatabaseStartupAdmission();
  const questionRecovery = createQuestionRecovery({
    scheduler: params.scheduler,
    pendingPreparation: () => agentDatabaseStartup?.pendingPreparation,
    assertCurrent: assertQuestionOwnerCurrent,
    track: trackPresentationWork,
    warn: (message) => params.log.warn?.(message),
    discover: async () => {
      const context = params.getQuestionContext?.();
      assertQuestionOwnerCurrent();
      if (!context) {
        throw new Error("Durable question recovery context is unavailable.");
      }
      const { discoverRestartRecoveryStoreTargets } =
        await import("../agents/main-session-recovery/main-session-restart-recovery-shared.js");
      const unavailable: unknown[] = [];
      const targets = await discoverRestartRecoveryStoreTargets({
        cfg: (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)(),
        onUnavailable: (_target, error) => unavailable.push(error),
      });
      return {
        scopes: targets.map((target) =>
          Object.assign({}, target, { sessionKey: `agent:${target.agentId}:main` }),
        ),
        unavailable,
      };
    },
    recover: async (scope) => {
      const context = params.getQuestionContext?.();
      assertQuestionOwnerCurrent();
      if (!context) {
        throw new Error("Durable question recovery context is unavailable.");
      }
      const [
        { executeSessionQuestionOperation },
        { recoverDurableQuestions },
        { getAgentEventLifecycleGeneration },
      ] = await Promise.all([
        import("../config/sessions/session-questions.js"),
        import("./durable-question-runtime.js"),
        import("../infra/agent-events.js"),
      ]);
      await executeSessionQuestionOperation(
        { ...scope, assertCurrent: assertQuestionOwnerCurrent },
        { kind: "interrupt", gatewayEpoch: getAgentEventLifecycleGeneration() },
      );
      await recoverDurableQuestions(
        questionManager,
        [scope],
        onContinuationOwed,
        assertQuestionOwnerCurrent,
        () => ({
          onResolved: async (event, observation) => {
            assertQuestionOwnerCurrent();
            handleQuestionChannelResolved(event);
            await publishDurableQuestionResolution({
              context,
              event,
              observation,
              assertCurrent: assertQuestionOwnerCurrent,
            });
          },
        }),
      );
    },
  });
  const recoverDurableQuestionInteractions = questionRecovery.recover;
  const loadQuestionHandlers = createLazyPromise(
    async () => {
      const [{ createQuestionHandlers }, storeWriteService] = await Promise.all([
        import("./server-methods/question.js"),
        loadSecretStoreWriteService(),
      ]);
      return createQuestionHandlers(questionManager, storeWriteService, params.scheduler, {
        onContinuationOwed,
        waitForRecovery: questionRecovery.waitForRecovery,
      });
    },
    { cacheRejections: true },
  );
  const pluginApprovalManager = createApprovalManager<PluginApprovalRequestPayload>(
    "plugin",
    resolveCanonicalPluginApprovalRequestAllowedDecisions,
    (request) => {
      // Abort-wins for plugin approvals matches the cron mint boundary.
      if (request.runId && params.hasRunAbortMarker?.(request.runId) === true) {
        return null;
      }
      if (request.mcpTool && request.agentId && request.agentId !== "*") {
        const servers = getRuntimeConfig().mcp?.servers;
        const server =
          servers && Object.hasOwn(servers, request.mcpTool.server)
            ? servers[request.mcpTool.server]
            : undefined;
        // Explicit prompt always asks, even after an earlier operator grant.
        const mode =
          server &&
          resolveProjectedMcpCodexToolApprovalMode(request.mcpTool.server, server, server);
        if (server && server.enabled !== false && (mode === undefined || mode === "auto")) {
          return { kind: "mcp-tool", agentId: request.agentId, ...request.mcpTool };
        }
      }
      if (!request.placementGrant) {
        return null;
      }
      return { kind: "placement", ...request.placementGrant };
    },
    placementStandingGrants.retainAsync,
  );
  const systemAgentApprovalManager = createApprovalManager<SystemAgentApprovalRequestPayload>(
    "system-agent",
    () => SYSTEM_AGENT_APPROVAL_DECISIONS,
  );
  const approvalManagers = [execApprovalManager, pluginApprovalManager, systemAgentApprovalManager];
  const pluginApprovalIosPushDelivery = createPluginApprovalIosPushDelivery({ log: params.log });
  type PendingAuthorityPublication = {
    kind: ChannelApprovalKind;
    record: Parameters<typeof publishAppliedApprovalResolution>[0]["record"];
    liveRecord: Parameters<typeof publishAppliedApprovalResolution>[0]["liveRecord"];
  };
  let approvalPublicationContext: GatewayRequestContext | undefined;
  const pendingAuthorityPublications: PendingAuthorityPublication[] = [];
  const publishResolution = (
    { kind, record, liveRecord }: PendingAuthorityPublication,
    context: GatewayRequestContext,
    reason: "authority-close" | "run-abort",
  ) => {
    void trackPresentationWork(() =>
      publishAppliedApprovalResolution({
        record,
        liveRecord,
        context,
        forwarder: execApprovalForwarder,
        ...(kind === "exec"
          ? { iosPushDelivery: execApprovalIosPushDelivery }
          : kind === "plugin"
            ? { pluginIosPushDelivery: pluginApprovalIosPushDelivery }
            : {}),
      }).catch((error: unknown) => {
        context.logGateway?.error?.(
          `${kind} approvals: ${reason} publication failed: ${String(error)}`,
        );
      }),
    );
  };
  const publishAuthorityClosure = (publication: PendingAuthorityPublication) => {
    if (presentationWork.isClosing) {
      return;
    }
    if (approvalPublicationContext) {
      publishResolution(publication, approvalPublicationContext, "authority-close");
    } else {
      pendingAuthorityPublications.push(publication);
    }
  };
  const bindApprovalPublicationContext = (context: GatewayRequestContext) => {
    if (presentationWork.isClosing) {
      return;
    }
    approvalPublicationContext = context;
    for (const publication of pendingAuthorityPublications.splice(0)) {
      publishAuthorityClosure(publication);
    }
  };
  const unregisterApprovalAuthorityClosedObserver = registerAgentRunDelegatedAuthorityClosedHandler(
    (authority, approvalReason) => {
      for (const manager of approvalManagers) {
        const kind = manager.approvalKind;
        void cancelAgentRuntimeBoundApprovals<ApprovalPayload>({
          authority,
          reason: approvalReason,
          manager,
          publish: (record, liveRecord) => publishAuthorityClosure({ kind, record, liveRecord }),
        }).catch((error: unknown) => {
          params.log.error?.(
            `${kind} approvals: authority-close settlement failed: ${String(error)}`,
          );
        });
      }
      questionManager.cancelClosedAuthorities(authority.operationalRunInstance);
      params.onAgentRunAuthorityClosed?.(authority, approvalReason);
    },
  );
  const unregisterWorkerTurnClaimClosedObserver = params.registerWorkerTurnClaimClosedHandler?.(
    (claim) => {
      for (const manager of approvalManagers) {
        const kind = manager.approvalKind;
        void cancelWorkerTurnClaimBoundApprovals<ApprovalPayload>({
          claim,
          manager,
          publish: (record, liveRecord) => publishAuthorityClosure({ kind, record, liveRecord }),
        }).catch((error: unknown) => {
          params.log.error?.(`${kind} approvals: worker-claim settlement failed: ${String(error)}`);
        });
      }
      questionManager.cancelClosedAuthorities({ runId: claim.runId });
    },
  );
  const cancelRunBoundApprovals = (
    target: string | AgentRunDelegatedAuthority,
    context: GatewayRequestContext,
  ): Promise<number> => {
    if (presentationWork.isClosing) {
      return Promise.resolve(0);
    }
    const cancellations: Promise<number>[] = [];
    for (const manager of approvalManagers) {
      const kind = manager.approvalKind;
      const publish = (
        record: PendingAuthorityPublication["record"],
        liveRecord: PendingAuthorityPublication["liveRecord"],
      ) => publishResolution({ kind, record, liveRecord }, context, "run-abort");
      cancellations.push(
        typeof target === "string"
          ? cancelUnboundRunApprovals<ApprovalPayload>({ runId: target, manager, publish })
          : cancelAgentRuntimeBoundApprovals<ApprovalPayload>({
              authority: target,
              reason: "permission-change",
              manager,
              publish,
            }),
      );
    }
    return Promise.all(cancellations).then((counts) =>
      counts.reduce((sum, count) => sum + count, 0),
    );
  };
  const loadPluginApprovalHandlers = createLazyPromise(
    () =>
      import("./server-methods/plugin-approval.js").then(({ createPluginApprovalHandlers }) =>
        createPluginApprovalHandlers(pluginApprovalManager, {
          forwarder: execApprovalForwarder,
          iosPushDelivery: pluginApprovalIosPushDelivery,
        }),
      ),
    { cacheRejections: true },
  );
  const loadApprovalHandlers = createLazyPromise(
    () =>
      import("./server-methods/approval.js").then(({ createApprovalHandlers }) =>
        createApprovalHandlers({
          execApprovalManager,
          pluginApprovalManager,
          systemAgentApprovalManager,
          forwarder: execApprovalForwarder,
          iosPushDelivery: execApprovalIosPushDelivery,
          pluginIosPushDelivery: pluginApprovalIosPushDelivery,
        }),
      ),
    { cacheRejections: true },
  );
  const loadSecretsHandlers = createLazyPromise(
    async () => {
      const [{ createSecretsHandlers }, storeWriteService] = await Promise.all([
        import("./server-methods/secrets.js"),
        loadSecretStoreWriteService(),
      ]);
      return createSecretsHandlers({
        reloadSecrets,
        storeWriteService,
        log: params.log,
        resolveSecrets: async ({
          allowedPaths,
          commandName,
          forcedActivePaths,
          optionalActivePaths,
          providerOverrides,
          targetIds,
        }) => {
          const { assignments, diagnostics, inactiveRefPaths } =
            await resolveCommandSecretsFromActiveRuntimeSnapshot({
              commandName,
              targetIds: new Set(targetIds),
              ...(allowedPaths ? { allowedPaths: new Set(allowedPaths) } : {}),
              ...(forcedActivePaths ? { forcedActivePaths: new Set(forcedActivePaths) } : {}),
              ...(optionalActivePaths ? { optionalActivePaths: new Set(optionalActivePaths) } : {}),
              ...(providerOverrides ? { providerOverrides } : {}),
            });
          return { assignments, diagnostics, inactiveRefPaths };
        },
      });
    },
    { cacheRejections: true },
  );

  const beginCloseApprovalObservers = () => {
    for (const manager of approvalManagers) {
      manager.beginClose();
    }
  };
  let stopPromise: Promise<void> | undefined;
  const stopOperatorInteractions = (): Promise<void> => {
    if (!stopPromise) {
      stopPromise = (async () => {
        // Preserve the existing authority-observer stop boundary. Retirement is
        // local only; pending durable approvals belong to next-start epoch recovery.
        unregisterWorkerTurnClaimClosedObserver?.();
        unregisterApprovalAuthorityClosedObserver();
        beginCloseApprovalObservers();
        for (const manager of approvalManagers) {
          manager.retire();
        }
        questionsClosing = true;
        continuations.beginClose();
        completionReceipts.beginClose();
        questionRecovery.beginClose();
        questionManager.close();
        await Promise.all([
          questionRecovery.stop(),
          completionReceipts.stop(),
          continuations.stop(),
        ]);
        await questionManager.drain();
        await Promise.all(approvalManagers.map((manager) => manager.drain()));
        await presentationWork.drain();
        await execApprovalForwarder.stop();
        approvalPublicationContext = undefined;
        pendingAuthorityPublications.length = 0;
      })();
    }
    return stopPromise;
  };

  // Startup terminalized prior-runtime approvals above; retain their browser
  // publication until its real send/storage work finishes, including failure logging.
  void trackPresentationWork(() =>
    approvalWebPushDelivery.recoverTerminalDeliveries().catch((error: unknown) => {
      params.log.error?.(`approval Web Push restart recovery failed: ${String(error)}`);
    }),
  );

  const bindLazyHandlers = (load: Parameters<typeof createLazyHandler>[1]) => (method: string) =>
    createLazyHandler(method, load);
  const execApprovalHandler = bindLazyHandlers(loadExecApprovalHandlers);
  const pluginApprovalHandler = bindLazyHandlers(loadPluginApprovalHandlers);
  const approvalHandler = bindLazyHandlers(loadApprovalHandlers);
  const questionHandler = bindLazyHandlers(loadQuestionHandlers);
  const secretsHandler = bindLazyHandlers(loadSecretsHandlers);

  return {
    execApprovalManager,
    cancelRunBoundApprovals,
    forwardPluginApprovalRequest: execApprovalForwarder.handlePluginApprovalRequested,
    forwardExecApprovalRequest: execApprovalForwarder.handleRequested,
    forwardSystemAgentApprovalRequest: execApprovalForwarder.handleSystemAgentApprovalRequested,
    forwardSystemAgentApprovalResolved: execApprovalForwarder.handleSystemAgentApprovalResolved,
    execApprovalIosPushDelivery,
    approvalWebPushDelivery,
    pluginApprovalIosPushDelivery,
    pluginApprovalManager,
    placementStandingGrants,
    systemAgentApprovalManager,
    bindApprovalPublicationContext,
    beginCloseApprovalObservers,
    stopOperatorInteractions,
    questionManager,
    recoverDurableQuestionInteractions,
    extraHandlers: {
      "exec.approval.get": execApprovalHandler("exec.approval.get"),
      "exec.approval.list": execApprovalHandler("exec.approval.list"),
      "exec.approval.request": execApprovalHandler("exec.approval.request"),
      "exec.approval.waitDecision": execApprovalHandler("exec.approval.waitDecision"),
      "exec.approval.resolve": execApprovalHandler("exec.approval.resolve"),
      "exec.approval.grants.list": execApprovalHandler("exec.approval.grants.list"),
      "exec.approval.grants.revoke": execApprovalHandler("exec.approval.grants.revoke"),
      "plugin.approval.list": pluginApprovalHandler("plugin.approval.list"),
      "plugin.approval.request": pluginApprovalHandler("plugin.approval.request"),
      "plugin.approval.waitDecision": pluginApprovalHandler("plugin.approval.waitDecision"),
      "plugin.approval.resolve": pluginApprovalHandler("plugin.approval.resolve"),
      "approval.get": approvalHandler("approval.get"),
      "approval.history": approvalHandler("approval.history"),
      "approval.resolve": approvalHandler("approval.resolve"),
      "question.request": questionHandler("question.request"),
      "question.waitAnswer": questionHandler("question.waitAnswer"),
      "question.resolve": questionHandler("question.resolve"),
      "question.get": questionHandler("question.get"),
      "question.list": questionHandler("question.list"),
      "secrets.reload": secretsHandler("secrets.reload"),
      "secrets.resolve": secretsHandler("secrets.resolve"),
      "secrets.store.list": secretsHandler("secrets.store.list"),
      "secrets.store.set": secretsHandler("secrets.store.set"),
      "secrets.store.delete": secretsHandler("secrets.store.delete"),
      "secrets.store.import": secretsHandler("secrets.store.import"),
      "secrets.store.allowedHosts": secretsHandler("secrets.store.allowedHosts"),
    },
  };
}
