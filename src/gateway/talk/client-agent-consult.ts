import type { EmbeddedRunCompletionRegistration } from "../../agents/embedded-agent-runner/run-state.js";
import { prepareEmbeddedAgentRunCompletionClaim } from "../../agents/embedded-agent-runner/runs.js";
import { registerRequesterFinalAttachment } from "../../agents/subagents/requester-final-attachment.js";
import { normalizeTalkSection } from "../../config/talk.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import type { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  GatewayDrainingError,
  runOutsideGatewayRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  buildRealtimeVoiceAgentToolAuthorityOverlay,
  consultRealtimeVoiceAgent,
} from "../../talk/agent-consult-runtime.js";
import { parseRealtimeVoiceAgentConsultArgs } from "../../talk/agent-consult-tool.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { assertClientVoiceSessionOpen } from "../../talk/client-voice-session-read.js";
import type { ClientVoiceSessionSource } from "../../talk/client-voice-session-source.js";
import { registerClientVoiceConsultRun } from "../../talk/client-voice-session.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import { registerChatAbortController } from "../chat-abort.js";
import type { GatewayRequestContext } from "../server-methods/shared-types.js";
import type {
  TalkAgentConsultRequest,
  TalkAgentConsultSource,
  TalkRequesterFinalBinding,
} from "./client-agent-consult.types.js";
import { createTalkClientAgentRuntime } from "./client-agent-runtime.js";
import {
  resolveTalkAgentConsultAuthority,
  type TalkAgentConsultAuthority,
} from "./client-gateway-control.js";
import type { TalkClientRunAuthority } from "./client-run-authority.js";
import { prepareTalkClientToolContext } from "./client-tool-authority.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

type TalkRequesterFinalRegistration = ReturnType<typeof registerRequesterFinalAttachment>;

export function prepareTalkClientControlAuthority(params: {
  config: OpenClawConfig;
  sessionTarget: PreparedTalkSessionTarget;
  authority: TalkAgentConsultAuthority;
  source?: "reply" | "attempt";
  agentRuntime: ReturnType<typeof createPluginRuntime>["agent"];
}) {
  if (params.source === "reply" && !params.authority.replyCaller) {
    throw new Error("Talk chat caller authority is unavailable");
  }
  // The control callback reads current policy immediately before the execution effect.
  const sessionEntry = params.agentRuntime.session.getSessionEntry({
    agentId: params.sessionTarget.agentId,
    sessionKey: params.sessionTarget.canonicalKey,
    storePath: params.sessionTarget.storePath,
    readConsistency: "latest",
  });
  const overlay =
    prepareTalkClientToolContext({
      config: params.config,
      agentId: params.sessionTarget.agentId,
      authority: params.authority,
      sessionEntry,
    })?.toolAuthorityOverlay ??
    buildRealtimeVoiceAgentToolAuthorityOverlay({
      sessionEntry,
      deliveryContext: deliveryContextFromSession(sessionEntry),
      messageProvider: "webchat",
      senderIsOwner: params.authority.senderIsOwner,
      toolsAllow: params.authority.toolsAllow,
    });
  // Direct attempts do not implement reply tracing; permission/reviewer facts are shared.
  return params.source === "reply" ? overlay : { ...overlay, traceAuthorized: false };
}

export function createTalkClientAgentConsultRunner(params: {
  config: OpenClawConfig;
  context: Pick<GatewayRequestContext, "chatAbortControllers" | "logGateway"> &
    Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;
  sessionTarget: PreparedTalkSessionTarget;
  ownerConnId?: string;
  authority?: TalkAgentConsultAuthority;
  runAuthority?: TalkClientRunAuthority;
  getVoiceSessionId: () => string | undefined;
  getVoiceSessionSource?: () => ClientVoiceSessionSource | undefined;
  initialItems: Array<{ role: "user" | "assistant"; text: string }>;
  runIdPrefix?: string;
  surface?: string;
  registerRun?: (params: {
    runId: string;
    assertCurrent: () => void;
  }) => Promise<{ release: () => void; isCurrent: () => boolean }>;
}) {
  const { agentId, sessionKey, canonicalKey, storePath } = params.sessionTarget;
  const getConfig = () => params.context.getRuntimeConfig?.() ?? params.config;
  const authority: TalkAgentConsultAuthority = {
    ...(params.authority ?? resolveTalkAgentConsultAuthority(undefined)),
    operatorAuthority:
      params.runAuthority?.operatorAuthority ?? params.authority?.operatorAuthority,
  };
  let agentRuntime: ReturnType<typeof createPluginRuntime>["agent"] | undefined;
  const getAgentRuntime = () =>
    (agentRuntime ??= createTalkClientAgentRuntime({
      config: getConfig(),
      runAuthority: params.runAuthority,
      ...(params.ownerConnId ? { rawSourceRef: params.ownerConnId } : {}),
    }));
  type PromptOwner = {
    completionClaim?: ReturnType<typeof prepareEmbeddedAgentRunCompletionClaim>;
    cleanup?: () => void;
    identity?: { runId: string; sessionId: string };
    isCurrent?: (sessionId?: string) => boolean;
    lifecycleGeneration: string;
    registered: Promise<EmbeddedRunCompletionRegistration | undefined>;
    requestSignal?: AbortSignal;
    requesterFinal?: TalkRequesterFinalBinding;
    requesterFinalRegistration?: TalkRequesterFinalRegistration;
    resolveRegistration: (registration: EmbeddedRunCompletionRegistration | undefined) => void;
    signal?: AbortSignal;
    voiceSessionId?: string;
    source: TalkAgentConsultSource;
  };
  let promptOwner: PromptOwner | undefined;
  let requesterFinalRegistration: TalkRequesterFinalRegistration | undefined;
  const createOwnedAgentRuntime = (owner: PromptOwner, assertCurrent?: () => void) =>
    createTalkClientAgentRuntime({
      config: getConfig(),
      runAuthority: params.runAuthority,
      ...(params.ownerConnId ? { rawSourceRef: params.ownerConnId } : {}),
      assertCurrent,
      bindOperationalRunInstance: (instance) => {
        const identity = owner.identity;
        if (
          promptOwner !== owner ||
          !identity ||
          identity.runId !== instance.runId ||
          owner.isCurrent?.(identity.sessionId) !== true ||
          owner.completionClaim?.bindOperationalRunInstance(instance) !== true
        ) {
          throw new Error("The active Talk consult admission is no longer current");
        }
      },
    });
  const runArgs = async (
    args: unknown,
    signal?: AbortSignal,
    owner?: PromptOwner,
    ready?: () => Promise<void>,
    assertCurrent?: () => void,
    _source: TalkAgentConsultSource = "tool-call",
  ) => {
    const config = getConfig();
    const parsedArgs = parseRealtimeVoiceAgentConsultArgs(args);
    const voiceSessionId = params.getVoiceSessionId();
    if (!voiceSessionId) {
      throw new Error("Realtime browser voice session is not ready for agent consult");
    }
    if (owner) {
      owner.voiceSessionId = voiceSessionId;
    }
    await ready?.();
    signal?.throwIfAborted();
    const physicalSource = params.getVoiceSessionSource?.();
    if (params.getVoiceSessionSource && !physicalSource) {
      throw new Error("Realtime browser voice session is not ready for agent consult");
    }
    let assertRunRegistrationCurrent: (() => void) | undefined;
    const assertConsultCurrent = () => {
      assertCurrent?.();
      physicalSource?.assertCurrent();
      assertRunRegistrationCurrent?.();
    };
    // Readiness can outlive its physical browser owner. Recheck after that
    // suspension and keep this path synchronous until backend admission.
    assertConsultCurrent();
    // Relays own admission before their lazy record registration. Browser callbacks
    // must validate the durable call before accepting a new run.
    if (!params.registerRun) {
      assertClientVoiceSessionOpen({ agentId, sessionKey, voiceSessionId }, physicalSource);
    }
    const runtime = owner
      ? createOwnedAgentRuntime(owner, assertConsultCurrent)
      : assertCurrent || physicalSource || params.ownerConnId || params.registerRun
        ? createTalkClientAgentRuntime({
            config: getConfig(),
            runAuthority: params.runAuthority,
            ...(params.ownerConnId ? { rawSourceRef: params.ownerConnId } : {}),
            assertCurrent: assertConsultCurrent,
          })
        : getAgentRuntime();
    const talkConfig = normalizeTalkSection(config.talk);
    // A voice turn outlives offer setup and must drain under its own root,
    // while new turns still respect suspension and restart admission.
    const admission = runOutsideGatewayRootWorkAdmission(tryBeginGatewayRootWorkAdmission);
    if (!admission) {
      throw new GatewayDrainingError();
    }
    return await admission
      .run(() =>
        consultRealtimeVoiceAgent({
          cfg: config,
          agentRuntime: runtime,
          logger: params.context.logGateway,
          agentId,
          sessionKey: canonicalKey,
          storePath,
          messageProvider: "webchat",
          lane: "talk",
          runIdPrefix: params.runIdPrefix ?? "talk-realtime-consult",
          args: parsedArgs,
          transcript: params.initialItems,
          surface: params.surface ?? "a browser Talk session",
          userLabel: "User",
          questionSourceLabel: "user",
          thinkLevel: talkConfig?.consultThinkingLevel,
          fastMode: talkConfig?.consultFastMode,
          senderIsOwner: authority.senderIsOwner,
          toolsAllow: authority.toolsAllow,
          prepareToolContext: (sessionEntry) => {
            const toolContext = prepareTalkClientToolContext({
              config,
              agentId,
              authority,
              sessionEntry,
            });
            if (!toolContext) {
              return {};
            }
            // Source authority belongs to prepared admission, not loose runtime
            // params. Direct attempts also do not implement reply tracing.
            const {
              operatorAuthority: _operatorAuthority,
              traceAuthorized: _traceAuthorized,
              originatingChannel: _originatingChannel,
              ...executionContext
            } = toolContext.toolAuthorityOverlay;
            return {
              ...executionContext,
              execOverrides: toolContext.execOverrides,
              bashElevated: toolContext.bashElevated,
              currentChannelId: undefined,
              currentThreadTs: undefined,
            };
          },
          abortSignal: signal,
          onRunStarted: async ({ runId, sessionId, timeoutMs }) => {
            let registeredRun: { release: () => void; isCurrent: () => boolean } | undefined;
            const assertRunCurrent = () => {
              signal?.throwIfAborted();
              if (registeredRun && !registeredRun.isCurrent()) {
                throw new Error("The active Talk consult admission is no longer current");
              }
              if (
                owner &&
                (promptOwner !== owner ||
                  owner.requestSignal?.aborted === true ||
                  !isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration) ||
                  params.getVoiceSessionId() !== voiceSessionId)
              ) {
                throw new Error("The active Talk consult admission is no longer current");
              }
            };
            assertConsultCurrent();
            assertRunCurrent();
            const registration = params.ownerConnId
              ? registerChatAbortController({
                  chatAbortControllers: params.context.chatAbortControllers,
                  runId,
                  sessionId,
                  sessionKey: canonicalKey,
                  agentId,
                  timeoutMs,
                  ownerConnId: params.ownerConnId,
                  controlUiVisible: false,
                  kind: "chat-send",
                })
              : undefined;
            const entry = registration?.entry;
            const generation = entry?.lifecycleGeneration;
            const isChatRegistrationCurrent = () =>
              !params.ownerConnId ||
              (params.context.chatAbortControllers.get(runId) === entry &&
                entry?.controller.signal.aborted === false &&
                entry.ownerConnId === params.ownerConnId &&
                entry.sessionId === sessionId &&
                entry.sessionKey === canonicalKey &&
                entry.registrationCleanupRequested !== true &&
                generation !== undefined &&
                entry.lifecycleGeneration === generation &&
                isAgentEventLifecycleGenerationCurrent(generation));
            assertRunRegistrationCurrent = () => {
              assertRunCurrent();
              if (!isChatRegistrationCurrent()) {
                throw new Error("The active Talk consult admission is no longer current");
              }
            };
            let releaseVoice: void | (() => void) = undefined;
            try {
              assertRunRegistrationCurrent();
              if (params.registerRun) {
                registeredRun = await params.registerRun({
                  runId,
                  assertCurrent: assertConsultCurrent,
                });
                releaseVoice = registeredRun.release;
              } else {
                releaseVoice = await registerClientVoiceConsultRun({
                  agentId,
                  sessionKey,
                  voiceSessionId,
                  runId,
                  config: getConfig(),
                  physicalSource,
                  assertCurrent: assertConsultCurrent,
                });
              }
              assertConsultCurrent();
              if (owner) {
                assertConsultCurrent();
                owner.identity = { runId, sessionId };
                owner.completionClaim = prepareEmbeddedAgentRunCompletionClaim(sessionId, runId);
                if (owner.requesterFinal) {
                  const requesterFinal = owner.requesterFinal;
                  const finalRegistration = registerRequesterFinalAttachment({
                    requesterAgentId: agentId,
                    requesterSessionKey: canonicalKey,
                    requesterSessionId: sessionId,
                    requesterTurnRunId: runId,
                    lifecycleGeneration: owner.lifecycleGeneration,
                    timeoutMs,
                    append: (text) => requesterFinal.append(text),
                  });
                  owner.requesterFinalRegistration = finalRegistration;
                  requesterFinalRegistration = finalRegistration;
                }
                void owner.completionClaim.registered.then(owner.resolveRegistration);
              }
              if (owner) {
                owner.cleanup = registration?.cleanup;
                owner.signal = entry?.controller.signal;
                owner.isCurrent = (resolvedSessionId) =>
                  params.getVoiceSessionId() === voiceSessionId &&
                  isChatRegistrationCurrent() &&
                  (resolvedSessionId === undefined || resolvedSessionId === sessionId) &&
                  (registeredRun?.isCurrent() ?? true);
              }
              return {
                cleanupBeforeRun: releaseVoice || undefined,
                ...(registration
                  ? {
                      abortSignal: registration.controller.signal,
                      cleanup: owner ? undefined : registration.cleanup,
                    }
                  : {}),
              };
            } catch (error) {
              try {
                releaseVoice?.();
              } finally {
                registration?.cleanup();
              }
              throw error;
            }
          },
        }),
      )
      .finally(() => {
        admission.release();
      });
  };
  const isOwnerCurrent = (owner: PromptOwner, sessionId?: string): boolean =>
    promptOwner === owner && owner.isCurrent?.(sessionId) === true;
  const clearOwner = (owner: PromptOwner): void => {
    if (promptOwner === owner) {
      promptOwner = undefined;
    }
    owner.cleanup?.();
  };
  const clearRequesterFinalRegistration = (
    owner: PromptOwner,
    disposition: "release" | "revoke",
  ): void => {
    const registration = owner.requesterFinalRegistration;
    if (!registration) {
      return;
    }
    if (disposition === "release") {
      registration.releaseProvisional();
    } else {
      registration.revoke();
      if (requesterFinalRegistration === registration) {
        requesterFinalRegistration = undefined;
      }
    }
    owner.requesterFinalRegistration = undefined;
  };
  const claimAppend = (): boolean => {
    const owner = promptOwner;
    if (!owner) {
      return false;
    }
    const current = isOwnerCurrent(owner);
    const completed = owner.completionClaim?.claimCompletion() === true;
    clearRequesterFinalRegistration(owner, current && completed ? "release" : "revoke");
    clearOwner(owner);
    return current && completed;
  };
  const claimFailureAppend = (): boolean => {
    const owner = promptOwner;
    if (!owner) {
      return false;
    }
    const identity = owner.identity;
    const current =
      owner.requestSignal?.aborted !== true &&
      isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration) &&
      params.getVoiceSessionId() === owner.voiceSessionId &&
      (identity ? isOwnerCurrent(owner, identity.sessionId) : promptOwner === owner);
    const claimed = owner.completionClaim
      ? owner.completionClaim.claimFailure()
      : identity === undefined &&
        owner.voiceSessionId !== undefined &&
        isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration);
    owner.resolveRegistration(undefined);
    clearRequesterFinalRegistration(owner, "revoke");
    clearOwner(owner);
    return current && claimed;
  };
  const revokeRequesterFinal = (): void => {
    requesterFinalRegistration?.revoke();
    requesterFinalRegistration = undefined;
    if (promptOwner) {
      promptOwner.requesterFinalRegistration = undefined;
    }
  };
  const steer = async ({ prompt, signal }: { prompt: string; signal?: AbortSignal }) => {
    signal?.throwIfAborted();
    const owner = promptOwner;
    if (!owner) {
      throw new Error("No active Talk consult is available to steer");
    }
    await owner.registered;
    signal?.throwIfAborted();
    const identity = owner.identity;
    const ownerSignal = owner.signal;
    const completionClaim = owner.completionClaim;
    if (
      !completionClaim ||
      !identity ||
      !ownerSignal ||
      !isOwnerCurrent(owner, identity.sessionId)
    ) {
      throw new Error("The active Talk consult is no longer current");
    }
    const result = await controlRealtimeVoiceAgentRun({
      sessionKey: canonicalKey,
      runTarget: {
        runId: identity.runId,
        signal: ownerSignal,
        isCurrent: (sessionId) =>
          isOwnerCurrent(owner, sessionId) &&
          completionClaim.resolveCurrentRegistration() !== undefined,
      },
      getToolAuthorityOverlay: () => {
        if (!isOwnerCurrent(owner, identity.sessionId)) {
          throw new Error("The active Talk consult is no longer current");
        }
        const registration = completionClaim.resolveCurrentRegistration();
        if (!registration) {
          throw new Error("The active Talk consult backend is no longer current");
        }
        return prepareTalkClientControlAuthority({
          config: getConfig(),
          sessionTarget: params.sessionTarget,
          authority,
          source: registration.toolAuthority.source,
          agentRuntime: getAgentRuntime(),
        });
      },
      prepareToolAuthorityOverlay: async (overlay) => {
        const registration = completionClaim.resolveCurrentRegistration();
        if (!registration) {
          throw new Error("The active Talk consult backend is no longer current");
        }
        const projected = await registration.toolAuthority.projectAsync(overlay);
        if (
          !projected ||
          !isOwnerCurrent(owner, identity.sessionId) ||
          completionClaim.resolveCurrentRegistration()?.toolAuthority !== registration.toolAuthority
        ) {
          throw new Error("The active Talk consult caller authority no longer matches");
        }
      },
      text: prompt,
      createUserTurnTranscriptRecorder:
        owner.source === "native-delegation"
          ? (text) =>
              createUserTurnTranscriptRecorder({
                input: { text, display: false },
                target: {
                  agentId,
                  sessionId: identity.sessionId,
                  sessionKey: canonicalKey,
                  storePath,
                  expectedSessionId: identity.sessionId,
                  sessionEntry: undefined,
                  config: getConfig(),
                },
              })
          : undefined,
      mode: "steer",
    });
    if (!result.ok || result.queued !== true || !isOwnerCurrent(owner, identity.sessionId)) {
      throw new Error(result.message);
    }
    return { text: "" };
  };
  const runOwnedArgs = async (
    args: unknown,
    signal?: AbortSignal,
    ready?: () => Promise<void>,
    assertCurrent?: () => void,
    requesterFinal?: TalkRequesterFinalBinding,
    source: TalkAgentConsultSource = "tool-call",
  ) => {
    if (promptOwner) {
      throw new Error("A Talk consult is already active");
    }
    const { promise: registered, resolve: resolveRegistration } = createDeferredCore<
      EmbeddedRunCompletionRegistration | undefined
    >();
    const owner: PromptOwner = {
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      registered,
      requestSignal: signal,
      requesterFinal,
      source,
      resolveRegistration,
    };
    const revokeRegistrationOnAbort = () => resolveRegistration(undefined);
    promptOwner = owner;
    signal?.addEventListener("abort", revokeRegistrationOnAbort, { once: true });
    try {
      return await runArgs(args, signal, owner, ready, assertCurrent, source);
    } catch (error) {
      resolveRegistration(undefined);
      throw error;
    } finally {
      signal?.removeEventListener("abort", revokeRegistrationOnAbort);
    }
  };
  const lifecycleMethods = params.ownerConnId
    ? { claimAppend, claimFailureAppend, revokeRequesterFinal, steer }
    : { claimAppend, claimFailureAppend, revokeRequesterFinal };
  const lifecycleBoundRunArgs = Object.assign(runOwnedArgs, lifecycleMethods);
  let completionClaimsAdopted = false;
  const runPrompt = Object.assign(
    async ({ prompt, signal, requesterFinal }: TalkAgentConsultRequest) => {
      if (completionClaimsAdopted) {
        return await lifecycleBoundRunArgs(
          { question: prompt },
          signal,
          undefined,
          undefined,
          requesterFinal,
          "native-delegation",
        );
      }
      return await runArgs(
        { question: prompt },
        signal,
        undefined,
        undefined,
        undefined,
        "native-delegation",
      );
    },
    {
      ...lifecycleMethods,
      // The released provider callback is reusable. Providers must explicitly
      // adopt delayed completion claims before the host retains an owner past settlement.
      adoptCompletionClaims: () => {
        completionClaimsAdopted = true;
      },
    },
  );
  return {
    getToolAuthorityOverlay: (currentAuthority = authority, source?: "reply" | "attempt") =>
      prepareTalkClientControlAuthority({
        config: getConfig(),
        sessionTarget: params.sessionTarget,
        authority: currentAuthority,
        source,
        agentRuntime: getAgentRuntime(),
      }),
    runArgs: (
      args: unknown,
      signal?: AbortSignal,
      assertCurrent?: () => void,
      source?: TalkAgentConsultSource,
    ) => runArgs(args, signal, undefined, undefined, assertCurrent, source),
    runOwnedArgs: lifecycleBoundRunArgs,
    runPrompt,
  };
}
