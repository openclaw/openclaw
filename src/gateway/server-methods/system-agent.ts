import { randomUUID } from "node:crypto";
// OpenClaw gateway methods host the setup/repair conversation for clients.
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  buildSystemAgentInferenceUnavailableErrorDetails,
  buildSystemAgentSessionInvalidatedErrorDetails,
  ErrorCodes,
  errorShape,
  validateSystemAgentChatParams,
  validateSystemAgentChatHistoryParams,
  validateSystemAgentSetupActivateParams,
  validateSystemAgentSetupAuthStartParams,
  validateSystemAgentSetupDetectParams,
  validateSystemAgentSetupVerifyParams,
  type SystemAgentChatQuestion,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  SYSTEM_AGENT_APPROVAL_DECISIONS,
  SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
  type SystemAgentApprovalRequestPayload,
} from "../../infra/system-agent-approvals.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../runtime.js";
import {
  SystemAgentChatEngine,
  SystemAgentWizardAnswerError,
} from "../../system-agent/chat-engine.js";
import {
  acknowledgeSystemAgentGreetingDelivery,
  buildSystemAgentGreetingQuestion,
  loadSystemAgentGreetingFacts,
  resolveSystemAgentGreeting,
} from "../../system-agent/greeting.js";
import { isSystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import { buildNewAgentWelcome } from "../../system-agent/new-agent-welcome.js";
import { buildOnboardingWelcome } from "../../system-agent/onboarding-welcome.js";
import { describeSystemAgentPersistentOperation } from "../../system-agent/operations.js";
import {
  appendTranscriptReset,
  appendTranscriptTurn,
  readTranscriptTail,
} from "../../system-agent/transcript-store.js";
import { resolveUserPath } from "../../utils.js";
import { WizardSession } from "../../wizard/session.js";
import {
  buildRequestedApprovalEvent,
  handlePendingApprovalRequest,
  listVisiblePendingApprovalRequests,
} from "./approval-shared.js";
import { sanitizeSystemAgentChatParams } from "./system-agent-chat-params.js";
import {
  buildSystemAgentChatResult,
  getSystemAgentChatInputError,
  runSystemAgentChatInput,
} from "./system-agent-chat-turn.js";
import {
  assertSystemAgentGatewayExecutionActive,
  runSystemAgentGatewayMutationTask,
  runSystemAgentGatewayOwnerTask,
  runSystemAgentGatewayTask,
} from "./system-agent-execution-lifecycle.js";
import {
  evictOldestSystemAgentSession,
  getSystemAgentSessionQueue,
  resolveSystemAgentSessionOwnerKey,
  type SystemAgentChatSession,
} from "./system-agent-session-ownership.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/**
 * `openclaw.chat` lets clients (macOS app onboarding, future UIs) run the
 * same conversational setup as `openclaw setup`. Structured setup owns
 * the pre-inference phase; a new chat session starts only after a live model
 * turn succeeds.
 *
 * The bounded session map owns only in-flight wizard and approval state. The
 * sanitized conversation is a durable machine-wide logbook; `reset: true`
 * replaces the in-memory session without deleting that transcript.
 */
export type { SystemAgentChatSession } from "./system-agent-session-ownership.js";

const DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT = 100;
const PROVIDER_AUTH_SESSION_TIMEOUT_MS = 25 * 60 * 1000;
const PROVIDER_PREPARE_SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const persistedEngineHistoryLengths = new WeakMap<SystemAgentChatSession["engine"], number>();
function acknowledgeDeliveredSystemAgentWelcome(session: SystemAgentChatSession): void {
  const auditSequence = session.welcomeAuditSequence;
  if (auditSequence === undefined) {
    return;
  }
  acknowledgeSystemAgentGreetingDelivery({ auditSequence });
  delete session.welcomeAuditSequence;
}

function persistEngineHistory(engine: SystemAgentChatSession["engine"], startIndex: number): void {
  const firstUnpersistedIndex = Math.max(
    startIndex,
    persistedEngineHistoryLengths.get(engine) ?? startIndex,
  );
  const at = Date.now();
  for (const turn of engine.historySince(firstUnpersistedIndex)) {
    // Engine history is authoritative here: sensitive user text has already
    // been replaced by the mask marker before it crosses this boundary.
    appendTranscriptTurn({ ...turn, at });
  }
  persistedEngineHistoryLengths.set(engine, engine.historyLength());
}

let systemAgentSetupActivationInProgress = false;

class SystemAgentSetupActivationBusyError extends Error {}

/** Admit one setup mutation without queueing work past a caller timeout. */
export async function runExclusiveSystemAgentSetupActivation<T>(
  task: () => Promise<T>,
): Promise<T> {
  if (systemAgentSetupActivationInProgress) {
    throw new SystemAgentSetupActivationBusyError(
      "OpenClaw setup is already in progress; try again when it finishes.",
    );
  }
  systemAgentSetupActivationInProgress = true;
  try {
    return await task();
  } finally {
    systemAgentSetupActivationInProgress = false;
  }
}

function queueDelegatedApproval(params: {
  context: GatewayRequestContext;
  sessions: Map<string, SystemAgentChatSession>;
  session: SystemAgentChatSession;
  sessionId: string;
  delegation: {
    agentId?: string;
    sessionKey?: string;
  };
  proposal: NonNullable<ReturnType<SystemAgentChatSession["engine"]["getPendingOperatorProposal"]>>;
}): string {
  if (params.session.pendingApproval?.proposalHash === params.proposal.hash) {
    return params.session.pendingApproval.id;
  }
  const manager = params.context.systemAgentApprovalManager;
  if (!manager) {
    throw new Error("OpenClaw approval registry unavailable");
  }
  const description = describeSystemAgentPersistentOperation(params.proposal.operation);
  const request: SystemAgentApprovalRequestPayload = {
    title: "OpenClaw change",
    description,
    command: description,
    proposalHash: params.proposal.hash,
    allowedDecisions: SYSTEM_AGENT_APPROVAL_DECISIONS,
    agentId: params.delegation?.agentId ?? null,
    sessionKey: params.delegation?.sessionKey ?? null,
    sessionId: params.sessionId,
    turnSourceChannel: null,
    turnSourceAccountId: null,
  };
  const record = manager.create(
    request,
    SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
    `system-agent:${randomUUID()}`,
  );
  const decisionPromise = manager.register(record, SYSTEM_AGENT_APPROVAL_TIMEOUT_MS);
  params.session.pendingApproval = { id: record.id, proposalHash: params.proposal.hash };
  const requestEvent = buildRequestedApprovalEvent(record);
  void handlePendingApprovalRequest({
    manager,
    record,
    decisionPromise,
    respond: () => undefined,
    context: params.context,
    requestEventName: "openclaw.approval.requested",
    requestEvent,
    twoPhase: true,
    deliverRequest: () => false,
    keepPendingWithoutRoute: true,
    requireDeliveryRoute: false,
    afterDecision: async (decision) =>
      await runWithGatewayIndependentRootWorkContinuation(() =>
        runSystemAgentGatewayTask(async () => {
          // The original request has returned; keep approval, audit, and restart drain-visible.
          if (params.sessions.get(params.sessionId) !== params.session) {
            return;
          }
          if (params.session.pendingApproval?.id === record.id) {
            params.session.pendingApproval = undefined;
          }
          await params.session.engine.resolveOperatorApproval(decision, params.proposal.hash);
        }, params.sessions),
      ),
    afterDecisionErrorLabel: "OpenClaw approval apply failed",
  });
  return record.id;
}

export const systemAgentHandlers: GatewayRequestHandlers = {
  "openclaw.approval.list": async ({ respond, client, context }) => {
    const manager = context.systemAgentApprovalManager;
    respond(
      true,
      manager ? listVisiblePendingApprovalRequests({ manager, client }) : [],
      undefined,
    );
  },
  "openclaw.chat.history": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentChatHistoryParams,
        "openclaw.chat.history",
        respond,
      )
    ) {
      return;
    }
    respond(
      true,
      { turns: readTranscriptTail(params.limit ?? DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT) },
      undefined,
    );
  },
  /** Structured onboarding: list reusable AI access on this host. */
  "openclaw.setup.detect": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupDetectParams,
        "openclaw.setup.detect",
        respond,
      )
    ) {
      return;
    }
    // Detection is read-only and may load native provider code. Keep it outside
    // the mutation lane and off the Gateway event loop so health stays live.
    const { detectSetupInferenceIsolated } =
      await import("../../system-agent/setup-inference-detection.js");
    respond(true, await detectSetupInferenceIsolated(), undefined);
  },
  /** Re-run the exact current default-agent inference route without mutating setup. */
  "openclaw.setup.verify": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupVerifyParams,
        "openclaw.setup.verify",
        respond,
      )
    ) {
      return;
    }
    await runSystemAgentGatewayTask(async () => {
      const { verifySetupInference } = await import("../../system-agent/setup-inference.js");
      respond(true, await verifySetupInference({ runtime: defaultRuntime }), undefined);
    }, context.systemAgentSessions);
  },
  /** Start one provider-owned OAuth/device-code login over the shared wizard transport. */
  "openclaw.setup.auth.start": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupAuthStartParams,
        "openclaw.setup.auth.start",
        respond,
      )
    ) {
      return;
    }
    assertSystemAgentGatewayExecutionActive(context.systemAgentSessions);
    if (context.findRunningWizard()) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "wizard already running"));
      return;
    }
    const sessionId = params.sessionId;
    const session = new WizardSession(
      async (prompter, signal) => {
        // Match setup.activate's lock order: setup admission before the Gateway
        // queue. Both stay held for the session, so a relaunched client cannot
        // start competing setup work while this server-owned flow can commit.
        const result = await runExclusiveSystemAgentSetupActivation(async () =>
          runSystemAgentGatewayTask(async () => {
            const { activateSetupInference } =
              await import("../../system-agent/setup-inference.js");
            return await activateSetupInference({
              kind: "provider-auth",
              authChoice: params.authChoice,
              ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
              surface: "gateway",
              runtime: {
                ...defaultRuntime,
                exit: (code: number | undefined): never => {
                  throw new Error(`setup step exited with code ${String(code)}`);
                },
              },
              prompter,
              signal,
              isCancelled: () => signal.aborted,
              onCommitStarted: () => session.lockCancellation(),
            });
          }, context.systemAgentSessions),
        );
        if (!result.ok) {
          throw new Error(result.error);
        }
      },
      { timeoutMs: PROVIDER_AUTH_SESSION_TIMEOUT_MS },
    );
    context.wizardSessions.set(sessionId, session);
    // Return ownership immediately so the client can cancel while provider auth waits.
    respond(true, { sessionId, done: false, status: "running" }, undefined);
  },
  /** Run one provider-owned prepare flow over the shared wizard transport. */
  "openclaw.setup.prepare.start": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupAuthStartParams,
        "openclaw.setup.prepare.start",
        respond,
      )
    ) {
      return;
    }
    assertSystemAgentGatewayExecutionActive(context.systemAgentSessions);
    if (context.findRunningWizard()) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "wizard already running"));
      return;
    }
    const sessionId = params.sessionId;
    const session = new WizardSession(
      async (prompter, signal) => {
        await runExclusiveSystemAgentSetupActivation(async () =>
          runSystemAgentGatewayTask(async () => {
            const [{ applyAuthChoiceLoadedPluginProvider }, setupShared] = await Promise.all([
              import("../../plugins/provider-auth-choice.js"),
              import("../../wizard/setup.shared.js"),
            ]);
            const snapshot = await setupShared.readSetupConfigFileSnapshot();
            if (!snapshot.valid) {
              throw new Error("Config is invalid. Run `openclaw doctor` before preparing a model.");
            }
            // Match the classic wizard: mutate the authored shape, not runtimeConfig,
            // so setup never writes resolved runtime defaults into openclaw.json.
            const baseConfig = snapshot.exists ? snapshot.sourceConfig : {};
            const workspaceDir = params.workspace?.trim()
              ? resolveUserPath(params.workspace.trim())
              : undefined;
            const applied = await applyAuthChoiceLoadedPluginProvider({
              authChoice: params.authChoice,
              config: baseConfig,
              prompter,
              runtime: {
                ...defaultRuntime,
                exit: (code: number | undefined): never => {
                  throw new Error(`setup step exited with code ${String(code)}`);
                },
              },
              setDefaultModel: false,
              preserveExistingDefaultModel: true,
              ...(workspaceDir ? { workspaceDir } : {}),
              signal,
              isRemote: true,
              beforePersistentEffect: () => {
                signal.throwIfAborted();
                session.lockCancellation();
              },
            });
            if (!applied || applied.retrySelection) {
              throw new Error(`Provider prepare method is unavailable: ${params.authChoice}`);
            }
            signal.throwIfAborted();
            session.lockCancellation();
            await setupShared.writeWizardConfigFile(applied.config, {
              allowConfigSizeDrop: false,
              baseSnapshot: snapshot,
              ...(snapshot.hash ? { baseHash: snapshot.hash } : {}),
              migrationBaseConfig: baseConfig,
            });
            if (applied.agentModelOverride) {
              session.setPreparedModelRef(applied.agentModelOverride);
            }
          }, context.systemAgentSessions),
        );
      },
      { timeoutMs: PROVIDER_PREPARE_SESSION_TIMEOUT_MS },
    );
    context.wizardSessions.set(sessionId, session);
    respond(true, { sessionId, done: false, status: "running" }, undefined);
  },
  /**
   * Structured onboarding: live-test one candidate and persist it on success.
   * Single-flight per gateway process because testing and persistence span
   * multiple config/plugin mutations. Concurrent callers fail fast instead of
   * queueing work that could outlive their RPC timeout. A failed attempt never
   * commits a broken model, managed plugin install, or setup state.
   */
  "openclaw.setup.activate": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupActivateParams,
        "openclaw.setup.activate",
        respond,
      )
    ) {
      return;
    }
    try {
      await runExclusiveSystemAgentSetupActivation(async () => {
        await runSystemAgentGatewayMutationTask(async () => {
          const { activateSetupInference } = await import("../../system-agent/setup-inference.js");
          const runtime = {
            ...defaultRuntime,
            // Setup runs inside the gateway process; a failing sub-step must reject
            // the RPC, never exit the daemon.
            exit: (code: number | undefined): never => {
              throw new Error(`setup step exited with code ${String(code)}`);
            },
          };
          const result = await activateSetupInference({
            kind: params.kind,
            ...(params.modelRef !== undefined ? { modelRef: params.modelRef } : {}),
            ...(params.authChoice !== undefined ? { authChoice: params.authChoice } : {}),
            ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
            ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
            surface: "gateway",
            runtime,
          });
          respond(true, result, undefined);
        }, context.systemAgentSessions);
      });
    } catch (error) {
      if (!(error instanceof SystemAgentSetupActivationBusyError)) {
        throw error;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error.message, { retryable: true }),
      );
    }
  },
  "openclaw.chat": async ({ params: rawParams, respond, client, context }) => {
    const params = sanitizeSystemAgentChatParams(rawParams);
    if (!assertValidParams(params, validateSystemAgentChatParams, "openclaw.chat", respond)) {
      return;
    }
    const inputError = getSystemAgentChatInputError(params);
    if (inputError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, inputError));
      return;
    }
    const sessions = context.systemAgentSessions;
    const ownerKey = resolveSystemAgentSessionOwnerKey({
      delegation: params.delegation,
      client,
    });
    if (!ownerKey) {
      return respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Caller unavailable."),
      );
    }
    await runSystemAgentGatewayOwnerTask(ownerKey, sessions, async () => {
      const sessionId = params.sessionId;
      // Serialize initialization, resets, and turns so competing engines cannot lose state.
      await getSystemAgentSessionQueue(sessions).enqueue(sessionId, async () => {
        assertSystemAgentGatewayExecutionActive(sessions, ownerKey);
        const boundSession = sessions.get(sessionId);
        if (boundSession && boundSession.ownerKey !== ownerKey) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw session belongs to another caller.", {
              details: buildSystemAgentSessionInvalidatedErrorDetails(),
            }),
          );
          return;
        }
        const supportsQrCode = hasGatewayClientCap(
          client?.connect.caps,
          GATEWAY_CLIENT_CAPS.SYSTEM_AGENT_QR_CODE,
        );
        if (boundSession && !params.reset && boundSession.supportsQrCode !== supportsQrCode) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "OpenClaw client capabilities changed; reset the session to continue.",
              { details: buildSystemAgentSessionInvalidatedErrorDetails() },
            ),
          );
          return;
        }
        if (params.reset) {
          const existing = sessions.get(sessionId);
          sessions.delete(sessionId);
          if (existing?.pendingApproval) {
            context.systemAgentApprovalManager?.expire(
              existing.pendingApproval.id,
              "session-reset",
            );
          }
          await existing?.engine.dispose();
          assertSystemAgentGatewayExecutionActive(sessions, ownerKey);
        }
        let session = sessions.get(sessionId);
        if ((params.wizardAnswer !== undefined || params.pollStepId !== undefined) && !session) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "No active OpenClaw chat session is awaiting that wizard step.",
              { details: buildSystemAgentSessionInvalidatedErrorDetails() },
            ),
          );
          return;
        }
        let greetingAuditSequence: number | undefined;
        const welcomeOnly =
          params.wizardAnswer === undefined &&
          params.pollStepId === undefined &&
          (params.message === undefined || !params.message.trim());
        if (!session) {
          const inference = params.delegation
            ? await import("../../system-agent/inference-fallback.js").then(
                ({ verifySystemAgentInferenceWithFallback }) =>
                  verifySystemAgentInferenceWithFallback({
                    requestingAgentId: params.delegation?.agentId,
                    runtime: defaultRuntime,
                  }),
              )
            : await import("../../system-agent/setup-inference.js").then(
                ({ verifySetupInference }) =>
                  verifySetupInference({ runtime: defaultRuntime, bindSession: true }),
              );
          assertSystemAgentGatewayExecutionActive(sessions, ownerKey);
          if (!inference.ok) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.UNAVAILABLE,
                `OpenClaw requires working inference: ${inference.error}`,
                {
                  details: buildSystemAgentInferenceUnavailableErrorDetails(),
                },
              ),
            );
            return;
          }
          // Gateway-hosted setup must never install or restart its own daemon.
          const engine = new SystemAgentChatEngine({
            surface: "gateway",
            supportsQrCode,
            verifiedInference: inference.binding,
            operatorApprovalOnly: params.delegation !== undefined,
            persistBackgroundHistory: (turns) => {
              persistEngineHistory(engine, engine.historyLength() - turns.length);
            },
          });
          // Reset keeps the durable logbook but starts model context clean.
          if (!params.reset) {
            engine.seedHistory(
              readTranscriptTail(30, { afterLastReset: true }).map(({ role, text }) => ({
                role,
                text,
              })),
            );
          }
          const welcomeHistoryStart = engine.historyLength();
          let welcome: string;
          let welcomeQuestion: SystemAgentChatQuestion | undefined;
          try {
            if (params.welcomeVariant === "onboarding") {
              const onboardingWelcome = await buildOnboardingWelcome({ engine });
              welcome = onboardingWelcome.text;
              welcomeQuestion = onboardingWelcome.question;
            } else if (params.welcomeVariant === "new-agent") {
              welcome = buildNewAgentWelcome({ engine });
            } else {
              const overview = await engine.loadOverview();
              const facts = loadSystemAgentGreetingFacts();
              greetingAuditSequence = facts.auditSequence;
              welcome = (
                await resolveSystemAgentGreeting({
                  overview,
                  facts,
                  planner: (plannerParams) => engine.planGreeting(plannerParams),
                  allowInference: welcomeOnly,
                })
              ).text;
              welcomeQuestion = buildSystemAgentGreetingQuestion(overview, facts);
              engine.noteAssistantMessage(welcome);
            }
          } catch (error) {
            await engine.dispose().catch(() => undefined);
            if (!isSystemAgentInferenceUnavailableError(error)) {
              throw error;
            }
            respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error.message));
            return;
          }
          try {
            assertSystemAgentGatewayExecutionActive(sessions, ownerKey);
          } catch (error) {
            await engine.dispose().catch(() => undefined);
            throw error;
          }
          if (!(await evictOldestSystemAgentSession(sessions, context))) {
            await engine.dispose().catch(() => undefined);
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.UNAVAILABLE,
                "OpenClaw chat is waiting for QR acknowledgements; try again after one completes.",
                { retryable: true },
              ),
            );
            return;
          }
          assertSystemAgentGatewayExecutionActive(sessions, ownerKey);
          if (params.reset) {
            appendTranscriptReset();
          }
          persistEngineHistory(engine, welcomeHistoryStart);
          session = {
            engine,
            welcome,
            ...(welcomeQuestion ? { welcomeQuestion } : {}),
            ...(greetingAuditSequence !== undefined
              ? { welcomeAuditSequence: greetingAuditSequence }
              : {}),
            lastUsedAt: Date.now(),
            ownerKey,
            supportsQrCode,
          };
          sessions.set(sessionId, session);
          if (welcomeOnly) {
            respond(
              true,
              {
                sessionId,
                reply: session.welcome,
                action: "none",
                ...(session.welcomeQuestion ? { question: session.welcomeQuestion } : {}),
              },
              undefined,
            );
            acknowledgeDeliveredSystemAgentWelcome(session);
            return;
          }
        }
        session.lastUsedAt = Date.now();
        if (
          params.wizardAnswer === undefined &&
          params.pollStepId === undefined &&
          (params.message === undefined || !params.message.trim())
        ) {
          respond(
            true,
            {
              sessionId,
              reply: session.welcome,
              action: "none",
              ...(session.welcomeQuestion ? { question: session.welcomeQuestion } : {}),
            },
            undefined,
          );
          acknowledgeDeliveredSystemAgentWelcome(session);
          return;
        }
        const historyStart = session.engine.historyLength();
        let reply: Awaited<ReturnType<SystemAgentChatEngine["handle"]>>;
        try {
          const turnReply = await runSystemAgentChatInput({
            engine: session.engine,
            input: params,
          });
          if (!turnReply) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw chat input is missing."),
            );
            return;
          }
          reply = turnReply;
        } catch (error) {
          persistEngineHistory(session.engine, historyStart);
          if (error instanceof SystemAgentWizardAnswerError) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
            return;
          }
          if (!isSystemAgentInferenceUnavailableError(error)) {
            throw error;
          }
          // A failed inference turn invalidates this conversation. Remove the
          // exact engine before cleanup so a retry must pass the live gate and
          // cannot resume partial proposal or CLI-session state.
          // Initialization failures stay unmarked because no live session existed.
          if (sessions.get(sessionId)?.engine === session.engine) {
            sessions.delete(sessionId);
          }
          try {
            await session.engine.dispose();
          } catch {
            // The inference error is authoritative; cleanup stays best-effort.
          }
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, error.message, {
              details: buildSystemAgentSessionInvalidatedErrorDetails(),
            }),
          );
          return;
        }
        persistEngineHistory(session.engine, historyStart);
        const delegation = params.delegation;
        let proposalId: string | undefined;
        if (delegation) {
          const proposal = session.engine.getPendingOperatorProposal();
          if (proposal) {
            proposalId = queueDelegatedApproval({
              context,
              sessions,
              session,
              sessionId,
              delegation,
              proposal,
            });
          }
        }
        respond(true, buildSystemAgentChatResult({ sessionId, reply, proposalId }), undefined);
      });
    });
  },
};
