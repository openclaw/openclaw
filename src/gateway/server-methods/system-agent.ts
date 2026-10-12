import {
  buildSystemAgentInferenceUnavailableErrorDetails,
  buildSystemAgentSessionInvalidatedErrorDetails,
  ErrorCodes,
  errorShape,
  validateSystemAgentChatParams,
  validateSystemAgentChatHistoryParams,
  validateSystemAgentSetupActivateParams,
  validateSystemAgentSetupActivateStartParams,
  validateSystemAgentSetupAuthStartParams,
  validateSystemAgentSetupDetectParams,
  validateSystemAgentSetupAutoParams,
  validateSystemAgentSetupVerifyParams,
  type SystemAgentChatQuestion,
} from "../../../packages/gateway-protocol/src/index.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { defaultRuntime } from "../../runtime.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import {
  SystemAgentChatEngine,
  SystemAgentWizardAnswerError,
} from "../../system-agent/chat-engine.js";
import {
  acknowledgeSystemAgentGreetingDelivery,
  buildSystemAgentGreetingQuestion,
  createSystemAgentGreetingCache,
  loadSystemAgentGreetingFacts,
  resolveSystemAgentGreeting,
} from "../../system-agent/greeting.js";
import { isSystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import { buildNewAgentWelcome } from "../../system-agent/new-agent-welcome.js";
import { buildOnboardingWelcome } from "../../system-agent/onboarding-welcome.js";
import {
  createSystemAgentTranscriptStore,
  readTranscriptTailAsync,
} from "../../system-agent/transcript-store.js";
import { resolveUserPath } from "../../utils.js";
import { WizardSession } from "../../wizard/session.js";
import {
  authenticatedProfileUnavailableError,
  isGatewayClientProfilePending,
} from "./gateway-client-identity.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import {
  createAdmittedWizardSession,
  runExclusiveSystemAgentSetupActivation,
  respondSetupAdmissionBusy,
  SetupAdmissionBusyError,
} from "./setup-admission.js";
import type { GatewaySystemAgentSession as SystemAgentChatSession } from "./shared-types.js";
import { prepareDelegatedSystemAgentApproval } from "./system-agent-approval.js";
import { sanitizeSystemAgentChatParams } from "./system-agent-chat-params.js";
import {
  buildSystemAgentChatResult,
  buildSystemAgentRejoinResult,
  getSystemAgentChatInputError,
  persistSystemAgentEngineHistory,
  runSystemAgentChatInput,
} from "./system-agent-chat-turn.js";
import {
  activateGatewaySetupInference,
  createSystemAgentGatewayRuntime,
  runSystemAgentGatewayTask,
  verifyGatewaySetupInference,
} from "./system-agent-execution.js";
import { resolveSystemAgentSessionOwnerKey } from "./system-agent-session-owner.js";
import {
  rejectExistingSetupWizardSession,
  startSetupActivationWizard,
} from "./system-agent-setup-wizard.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler } from "./validation.js";

export type { SystemAgentChatSession };

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
const MAX_SYSTEM_AGENT_SESSIONS = 8;
const SYSTEM_AGENT_SEED_HISTORY_LIMIT = 30;
const DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT = 100;
// Covers a provider's 15-minute device-code window plus the post-login probe. Activation of a
// detected route shares it: without a saved profile or key, activation hosts the same sign-in.
const PROVIDER_AUTH_SESSION_TIMEOUT_MS = 25 * 60 * 1000;
const PROVIDER_PREPARE_SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
async function acknowledgeDeliveredSystemAgentWelcome(
  session: SystemAgentChatSession,
  cacheStore: ReturnType<typeof createSystemAgentGreetingCache>,
): Promise<void> {
  const auditSequence = session.welcomeAuditSequence;
  if (auditSequence === undefined) {
    return;
  }
  await acknowledgeSystemAgentGreetingDelivery({ auditSequence, cacheStore });
  delete session.welcomeAuditSequence;
}

async function evictOldestSession(
  sessions: Map<string, SystemAgentChatSession>,
  context: GatewayRequestContext,
): Promise<void> {
  if (sessions.size < MAX_SYSTEM_AGENT_SESSIONS) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, session] of sessions) {
    if (session.lastUsedAt < oldestAt) {
      oldestAt = session.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    const oldest = sessions.get(oldestKey);
    if (oldest?.pendingApproval) {
      await context.systemAgentApprovalManager?.expire(
        oldest.pendingApproval.id,
        "session-evicted",
      );
    }
    await oldest?.engine.dispose();
    sessions.delete(oldestKey);
  }
}

export const systemAgentHandlers: GatewayRequestHandlers = {
  "openclaw.chat.history": defineValidatedGatewayHandler(
    "openclaw.chat.history",
    validateSystemAgentChatHistoryParams,
    async (options) => {
      const { params, respond } = options;
      const authority = readGatewayRequestMutationAuthority(options);
      authority.assertCurrent();
      const turns = await readTranscriptTailAsync(
        params.limit ?? DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT,
      );
      authority.assertCurrent();
      respond(true, { turns }, undefined);
    },
  ),
  "openclaw.setup.detect": defineValidatedGatewayHandler(
    "openclaw.setup.detect",
    validateSystemAgentSetupDetectParams,
    async ({ params, respond }) => {
      const { detectSetupInference } = await import("../../system-agent/setup-inference.js");
      respond(true, await detectSetupInference({}, params.agentId), undefined);
    },
  ),
  "openclaw.setup.auto": defineValidatedGatewayHandler(
    "openclaw.setup.auto",
    validateSystemAgentSetupAutoParams,
    async ({ context, respond }) => {
      try {
        const { runGatewayAutomaticSetup } = await import("./system-agent-setup-auto.js");
        respond(true, await runGatewayAutomaticSetup(context), undefined);
      } catch (error) {
        if (!(error instanceof SetupAdmissionBusyError)) {
          throw error;
        }
        respondSetupAdmissionBusy(respond);
      }
    },
  ),
  "openclaw.setup.verify": defineValidatedGatewayHandler(
    "openclaw.setup.verify",
    validateSystemAgentSetupVerifyParams,
    async ({ params, respond, context }) => {
      await runSystemAgentGatewayTask(async () => {
        const result = await verifyGatewaySetupInference({
          runtime: defaultRuntime,
          context,
          ...params,
        });
        respond(true, result, undefined);
      });
    },
  ),
  "openclaw.setup.auth.start": defineValidatedGatewayHandler(
    "openclaw.setup.auth.start",
    validateSystemAgentSetupAuthStartParams,
    async (options) => {
      const { params, respond, context, client } = options;
      const { sessionId, ...activation } = params;
      await startSetupActivationWizard({
        sessionId,
        ownerKey: resolveSystemAgentSessionOwnerKey({ client }),
        assertCurrent: readGatewayRequestMutationAuthority(options).assertCurrent,
        activation: { ...activation, kind: "provider-auth" },
        timeoutMs: PROVIDER_AUTH_SESSION_TIMEOUT_MS,
        context,
        respond,
        isLocalClient: client?.internal?.isLocalClient === true,
      });
    },
  ),
  "openclaw.setup.activate.start": defineValidatedGatewayHandler(
    "openclaw.setup.activate.start",
    validateSystemAgentSetupActivateStartParams,
    async ({ params, respond, context }) => {
      const { sessionId, ...activation } = params;
      await startSetupActivationWizard({
        sessionId,
        activation,
        timeoutMs: PROVIDER_AUTH_SESSION_TIMEOUT_MS,
        context,
        respond,
      });
    },
  ),
  "openclaw.setup.prepare.start": defineValidatedGatewayHandler(
    "openclaw.setup.prepare.start",
    validateSystemAgentSetupAuthStartParams,
    async ({ params, respond, context }) => {
      const sessionId = params.sessionId;
      if (rejectExistingSetupWizardSession({ sessionId, context, respond })) {
        return;
      }
      const session = await createAdmittedWizardSession(
        () =>
          new WizardSession(
            async (prompter, signal, runnerSession) => {
              await runSystemAgentGatewayTask(async () => {
                const [{ prepareAuthChoiceLoadedPluginProvider }, setupShared, authConfig] =
                  await Promise.all([
                    import("../../plugins/provider-auth-choice.js"),
                    import("../../wizard/setup.shared.js"),
                    import("../../plugins/provider-auth-config.js"),
                  ]);
                const snapshot = await setupShared.readSetupConfigFileSnapshot();
                if (!snapshot.valid) {
                  throw new Error(
                    "Config is invalid. Run `openclaw doctor` before preparing a model.",
                  );
                }
                // Match the classic wizard: mutate the authored shape, not runtimeConfig,
                // so setup never writes resolved runtime defaults into openclaw.json.
                const baseConfig = snapshot.exists ? snapshot.sourceConfig : {};
                const workspaceDir = params.workspace?.trim()
                  ? resolveUserPath(params.workspace.trim())
                  : undefined;
                const prepared = await prepareAuthChoiceLoadedPluginProvider(
                  {
                    authChoice: params.authChoice,
                    ...(params.agentId ? { agentId: params.agentId } : {}),
                    config: baseConfig,
                    prompter,
                    runtime: createSystemAgentGatewayRuntime(),
                    setDefaultModel: false,
                    preserveExistingDefaultModel: true,
                    ...(workspaceDir ? { workspaceDir } : {}),
                    signal,
                    isRemote: true,
                    beforePersistentEffect: () => {
                      signal.throwIfAborted();
                      runnerSession.lockCancellationForPreparation();
                    },
                  },
                  (result) => result,
                );
                if (!prepared || prepared.retrySelection) {
                  throw new Error(
                    `Provider setup resolution failed for "${params.authChoice}". Run \`openclaw doctor --fix\`, restart the Gateway, and try again.`,
                  );
                }
                signal.throwIfAborted();
                runnerSession.lockCancellation();
                await prepared.persistAuthProfiles();
                await authConfig.writeProviderAuthConfig({
                  config: baseConfig,
                  configSnapshot: snapshot,
                  configPatch: authConfig.createProviderAuthConfigPatch(
                    baseConfig,
                    prepared.config,
                  ),
                  credentialsSaved: prepared.authProfiles.length > 0,
                  writeOptions: { allowConfigSizeDrop: false },
                });
                if (prepared.agentModelOverride) {
                  runnerSession.setPreparedModelRef(prepared.agentModelOverride);
                }
              });
            },
            { timeoutMs: PROVIDER_PREPARE_SESSION_TIMEOUT_MS },
          ),
      );
      if (!session) {
        respondSetupAdmissionBusy(respond);
        return;
      }
      context.wizardSessions.set(sessionId, session);
      respond(true, { sessionId, done: false, status: "running" }, undefined);
    },
  ),
  /**
   * Structured onboarding: live-test one candidate and persist it on success.
   * Single-flight per gateway process because testing and persistence span
   * multiple config/plugin mutations. Concurrent callers fail fast instead of
   * queueing work that could outlive their RPC timeout. Verification failures never
   * commit a broken model; post-commit application failures explain the saved state.
   */
  "openclaw.setup.activate": defineValidatedGatewayHandler(
    "openclaw.setup.activate",
    validateSystemAgentSetupActivateParams,
    async ({ params, respond }) => {
      try {
        const result = await runExclusiveSystemAgentSetupActivation(() =>
          activateGatewaySetupInference({
            ...params,
            surface: "gateway",
            runtime: createSystemAgentGatewayRuntime(),
          }),
        );
        respond(true, result, undefined);
      } catch (error) {
        if (!(error instanceof SetupAdmissionBusyError)) {
          throw error;
        }
        respondSetupAdmissionBusy(respond);
      }
    },
  ),
  "openclaw.chat": async (options) => {
    const { params: rawParams, respond, client, context } = options;
    const reject = (error: ReturnType<typeof errorShape>) => respond(false, undefined, error);
    const authority = readGatewayRequestMutationAuthority(options);
    const params = sanitizeSystemAgentChatParams(rawParams);
    if (!assertValidParams(params, validateSystemAgentChatParams, "openclaw.chat", respond)) {
      return;
    }
    const inputError = getSystemAgentChatInputError(params);
    if (inputError) {
      reject(errorShape(ErrorCodes.INVALID_REQUEST, inputError));
      return;
    }
    authority.assertCurrent();
    const env = { ...process.env };
    let ownedSession: SystemAgentChatSession | undefined;
    // Accepted logbook work belongs to the serialized task, not socket cancellation.
    const assertSessionCurrent = () => {
      if (context.systemAgentSessions.get(params.sessionId) !== ownedSession) {
        throw new Error("OpenClaw session changed during audit persistence");
      }
    };
    const transcript = createSystemAgentTranscriptStore({
      env,
      assertCurrent: assertSessionCurrent,
    });
    const greetingCache = createSystemAgentGreetingCache({
      env,
      assertCurrent: assertSessionCurrent,
    });
    const assertCurrent = () => {
      authority.assertCurrent();
      transcript.assertCurrent();
      greetingCache.assertCurrent();
    };
    const pending = await runSystemAgentGatewayTask(async () => {
      ownedSession = context.systemAgentSessions.get(params.sessionId);
      assertCurrent();
      const sessions = context.systemAgentSessions;
      const sessionId = params.sessionId;
      // Initialization, resets, turns, and approval application share this task owner.
      const ownerKey = resolveSystemAgentSessionOwnerKey({
        delegation: params.delegation,
        client,
      });
      if (!ownerKey) {
        if (isGatewayClientProfilePending(client)) {
          reject(authenticatedProfileUnavailableError());
          return undefined;
        }
        reject(errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw caller identity unavailable."));
        return undefined;
      }
      const boundSession = sessions.get(sessionId);
      if (boundSession && boundSession.ownerKey !== ownerKey) {
        // Structured invalidation details let clients with a persisted id mint a
        // fresh one instead of retry-looping against the foreign live session.
        reject(
          errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw session belongs to another caller.", {
            details: buildSystemAgentSessionInvalidatedErrorDetails(),
          }),
        );
        return undefined;
      }
      if (params.reset) {
        const existing = sessions.get(sessionId);
        // Persist the reset first; a failed write must leave the live session intact.
        await transcript.appendReset();
        sessions.delete(sessionId);
        ownedSession = undefined;
        if (existing?.pendingApproval) {
          await context.systemAgentApprovalManager?.expire(
            existing.pendingApproval.id,
            "session-reset",
          );
        }
        await existing?.engine.dispose();
      }
      let session = sessions.get(sessionId);
      if ((params.wizardAnswer !== undefined || params.wizardCancel !== undefined) && !session) {
        reject(
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            params.wizardCancel !== undefined
              ? "No active OpenClaw chat session is awaiting that wizard cancel."
              : "No active OpenClaw chat session is awaiting that wizard answer.",
            { details: buildSystemAgentSessionInvalidatedErrorDetails() },
          ),
        );
        return undefined;
      }
      let greetingAuditSequence: number | undefined;
      const welcomeOnly =
        params.wizardAnswer === undefined &&
        params.wizardCancel === undefined &&
        (params.message === undefined || !params.message.trim());
      if (!session) {
        const { verifySystemAgentInferenceWithFallback } =
          await import("../../system-agent/inference-fallback.js");
        const inference = await verifySystemAgentInferenceWithFallback({
          ...(params.delegation ? { requestingAgentId: params.delegation.agentId } : {}),
          runtime: defaultRuntime,
        });
        if (!inference.ok) {
          reject(
            errorShape(
              ErrorCodes.UNAVAILABLE,
              `OpenClaw requires working inference: ${inference.error}`,
              {
                details: buildSystemAgentInferenceUnavailableErrorDetails(),
              },
            ),
          );
          return undefined;
        }
        const engine = new SystemAgentChatEngine({
          surface: "gateway",
          deps: {
            gatewayHostLifecycle: context.hostLifecycle,
            applyPluginRuntime: context.applyPluginLifecycleChange,
          },
          verifiedInference: inference.binding,
          operatorApprovalOnly: params.delegation !== undefined,
          ...(params.delegation?.agentId ? { requesterAgentId: params.delegation.agentId } : {}),
        });
        let persistWelcome = !welcomeOnly;
        let welcome: string;
        let welcomeQuestion: SystemAgentChatQuestion | undefined;
        try {
          // `reset: true` keeps the durable logbook but deliberately starts
          // model context clean; only ordinary fresh sessions receive its tail.
          if (!params.reset) {
            const turns = await transcript.readTail(SYSTEM_AGENT_SEED_HISTORY_LIMIT, true);
            assertCurrent();
            engine.seedHistory(turns.map(({ role, text }) => ({ role, text })));
          }
          const welcomeHistoryStart = engine.historyLength();
          if (params.welcomeVariant === "onboarding") {
            const onboardingWelcome = await buildOnboardingWelcome({
              engine,
              locale: client?.connect.locale,
            });
            welcome = onboardingWelcome.text;
            welcomeQuestion = onboardingWelcome.question;
          } else if (params.welcomeVariant === "new-agent") {
            welcome = await buildNewAgentWelcome({ engine });
          } else {
            const overview = await engine.loadOverview();
            const facts = await loadSystemAgentGreetingFacts({ env, cacheStore: greetingCache });
            assertCurrent();
            greetingAuditSequence = facts.auditSequence;
            persistWelcome ||= facts.recentExternalEdit;
            welcome = (
              await resolveSystemAgentGreeting({
                overview,
                facts,
                planner: (plannerParams) => engine.planGreeting(plannerParams),
                allowInference: welcomeOnly,
                cacheStore: greetingCache,
                cacheOwner: sessions,
              })
            ).text;
            assertCurrent();
            welcomeQuestion = buildSystemAgentGreetingQuestion(overview, facts);
            engine.noteAssistantMessage(welcome);
          }
          // Passive welcomes are ephemeral; an external-edit alert must survive
          // before delivery acknowledges the audit cursor that would hide it.
          if (persistWelcome) {
            await persistSystemAgentEngineHistory(engine, welcomeHistoryStart, transcript);
          }
          await evictOldestSession(sessions, context);
          assertCurrent();
        } catch (error) {
          await engine.dispose().catch(() => undefined);
          if (!isSystemAgentInferenceUnavailableError(error)) {
            throw error;
          }
          reject(errorShape(ErrorCodes.UNAVAILABLE, error.message));
          return undefined;
        }
        session = {
          engine,
          welcome,
          optionalWelcome: params.welcomeVariant === undefined && !persistWelcome,
          ...(params.welcomeVariant === "new-agent" ? { newAgentWelcome: welcome } : {}),
          ...(welcomeQuestion ? { welcomeQuestion } : {}),
          ...(greetingAuditSequence !== undefined
            ? { welcomeAuditSequence: greetingAuditSequence }
            : {}),
          lastUsedAt: Date.now(),
          ownerKey,
        };
        sessions.set(sessionId, session);
        ownedSession = session;
        if (welcomeOnly) {
          respond(
            true,
            {
              sessionId,
              reply: session.welcome,
              optionalWelcome: session.optionalWelcome,
              action: "none",
              ...(session.welcomeQuestion ? { question: session.welcomeQuestion } : {}),
            },
            undefined,
          );
          await acknowledgeDeliveredSystemAgentWelcome(session, greetingCache);
          return undefined;
        }
      }
      session.lastUsedAt = Date.now();
      if (welcomeOnly) {
        if (params.welcomeVariant === "new-agent") {
          const interaction = session.engine.decorateRejoinReply({ text: "", action: "none" });
          if (
            !interaction.wizardInputPending &&
            !interaction.sensitive &&
            !interaction.step &&
            !interaction.question &&
            !session.pendingApproval &&
            !session.engine.getPendingOperatorProposal()
          ) {
            session.newAgentWelcome ??= await buildNewAgentWelcome({ engine: session.engine });
            respond(
              true,
              { sessionId, reply: session.newAgentWelcome, optionalWelcome: false, action: "none" },
              undefined,
            );
            // The caretaker warning was not displayed; its delivery cursor stays pending.
            return undefined;
          }
        }
        respond(
          true,
          buildSystemAgentRejoinResult({
            sessionId,
            welcome: session.welcome,
            optionalWelcome: session.optionalWelcome,
            ...(session.welcomeQuestion ? { welcomeQuestion: session.welcomeQuestion } : {}),
            engine: session.engine,
          }),
          undefined,
        );
        await acknowledgeDeliveredSystemAgentWelcome(session, greetingCache);
        return undefined;
      }
      const historyStart = session.engine.historyLength();
      let reply: Awaited<ReturnType<SystemAgentChatEngine["handle"]>>;
      let resolveProposal:
        | Awaited<ReturnType<typeof prepareDelegatedSystemAgentApproval>>
        | undefined;
      try {
        if (params.delegation) {
          resolveProposal = await prepareDelegatedSystemAgentApproval({
            context,
            sessions,
            session,
            sessionId,
            delegation: params.delegation,
          });
        }
        const turnReply = await runSystemAgentChatInput({
          engine: session.engine,
          input: params,
        });
        if (!turnReply) {
          reject(errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw chat input is missing."));
          return undefined;
        }
        reply = turnReply;
      } catch (error) {
        await persistSystemAgentEngineHistory(session.engine, historyStart, transcript);
        if (error instanceof SystemAgentWizardAnswerError) {
          reject(errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return undefined;
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
        reject(
          errorShape(ErrorCodes.UNAVAILABLE, error.message, {
            details: buildSystemAgentSessionInvalidatedErrorDetails(),
          }),
        );
        return undefined;
      }
      let pendingApproval: SystemAgentChatSession["pendingApproval"];
      if (resolveProposal) {
        const proposal = session.engine.getPendingOperatorProposal();
        if (proposal) {
          const resolution = await resolveProposal(proposal);
          if (resolution.kind === "completed") {
            reply = resolution.reply;
          } else {
            pendingApproval = resolution;
          }
        }
      }
      await persistSystemAgentEngineHistory(session.engine, historyStart, transcript);
      if (pendingApproval) {
        return pendingApproval;
      }
      assertCurrent();
      respond(true, buildSystemAgentChatResult({ sessionId, reply }), undefined);
      return undefined;
    });
    // Human waiting must retain the requesting tool, but release the task queue:
    // the approval owner reenters it to apply the exact proposal. Gateway closure
    // retires this observation without changing the pending decision or its handoff.
    if (pending) {
      const reply = await racePromiseWithAbortSignal(pending.completion, getAsyncWorkSignal());
      assertCurrent();
      respond(true, buildSystemAgentChatResult({ sessionId: params.sessionId, reply }), undefined);
    }
  },
};
