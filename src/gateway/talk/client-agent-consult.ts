import { prepareEmbeddedAgentRunCompletionClaim } from "../../agents/embedded-agent-runner/runs.js";
import type { OperationalRunInstanceRef } from "../../agents/operational-run-instance.js";
import { registerRequesterFinalAttachment } from "../../agents/subagents/requester-final-attachment.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import type { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  GatewayDrainingError,
  tryBeginGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import {
  captureSessionTarget,
  getCurrentSessionControllerOwner,
} from "../../sessions/session-controller.lifecycle.js";
import type { SessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import {
  getRpcSourceLifecycleGeneration,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  getAttachedBackend,
  isCurrentSessionControllerOperation,
  waitForReplyOperationBackend,
} from "../../sessions/session-controller.state.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  buildRealtimeVoiceAgentToolAuthorityOverlay,
  consultRealtimeVoiceAgentInSessionRuntime,
} from "../../talk/agent-consult-runtime.js";
import { parseRealtimeVoiceAgentConsultArgs } from "../../talk/agent-consult-tool.js";
import { controlTalkAgentRun } from "../../talk/agent-run-control.js";
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
import type { TalkClientRunAuthority } from "./client-run-authority.js";
import {
  prepareTalkClientToolContext,
  resolveTalkAgentConsultAuthority,
  type TalkAgentConsultAuthority,
} from "./client-tool-authority.js";
import { isTalkConsultSourceCurrent } from "./run-ownership.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

type TalkRequesterFinalRegistration = ReturnType<typeof registerRequesterFinalAttachment>;

export async function prepareTalkClientControlAuthority(params: {
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
  const sessionEntry = await params.agentRuntime.session.getSessionEntryAsync({
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
  context: Pick<GatewayRequestContext, "logGateway"> &
    Partial<Pick<GatewayRequestContext, "getRuntimeConfig" | "resolveGatewayContext">>;
  sessionTarget: PreparedTalkSessionTarget;
  ownerConnId?: string;
  authority?: TalkAgentConsultAuthority;
  runAuthority?: TalkClientRunAuthority;
  getVoiceSessionId: () => string | undefined;
  getVoiceSessionSource?: () => ClientVoiceSessionSource | undefined;
  initialItems: Array<{ role: "user" | "assistant"; text: string }>;
  runIdPrefix?: string;
  surface?: string;
  registerRun?: (params: { runId: string; assertCurrent: () => void }) => Promise<{
    release: () => void;
    isCurrent: (phase?: "active" | "completion") => boolean;
    onSessionIdChanged?: (sessionId: string) => void;
  }>;
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
      resolveGatewayContext: params.context.resolveGatewayContext,
      runAuthority: params.runAuthority,
      ...(params.ownerConnId ? { rawSourceRef: params.ownerConnId } : {}),
    }));
  type PromptOwner = {
    completionClaim?: ReturnType<typeof prepareEmbeddedAgentRunCompletionClaim>;
    commandInstance?: OperationalRunInstanceRef;
    commandCompleted?: true;
    operation?: ReplyOperation;
    backendOwnerReady: Promise<void>;
    resolveBackendOwner: () => void;
    cleanup?: () => void;
    identity?: { runId: string; sessionId: string };
    isCurrent?: (sessionId?: string, phase?: "active" | "completion") => boolean;
    lifecycleGeneration: string;
    requestSignal?: AbortSignal;
    requesterFinal?: TalkRequesterFinalBinding;
    requesterFinalRegistration?: TalkRequesterFinalRegistration;
    signal?: AbortSignal;
    voiceSessionId?: string;
    source: TalkAgentConsultSource;
  };
  let promptOwner: PromptOwner | undefined;
  let requesterFinalRegistration: TalkRequesterFinalRegistration | undefined;
  const runArgs = async (
    args: unknown,
    signal?: AbortSignal,
    owner?: PromptOwner,
    ready?: () => Promise<void>,
    assertCurrent?: () => void,
    _source: TalkAgentConsultSource = "tool-call",
    sourceInput?: SessionControllerInput,
  ) => {
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
    const config = getConfig();
    const physicalSource = params.getVoiceSessionSource?.();
    if (params.getVoiceSessionSource && !physicalSource) {
      throw new Error("Realtime browser voice session is not ready for agent consult");
    }
    let assertRunRegistrationCurrent: (() => void) | undefined;
    const assertConsultCurrent = () => {
      params.sessionTarget.assertCurrent(getConfig());
      assertCurrent?.();
      physicalSource?.assertCurrent();
      assertRunRegistrationCurrent?.();
    };
    // Relays own admission before their lazy record registration. Browser callbacks
    // must validate the durable call before accepting a new run.
    if (!params.registerRun) {
      await assertClientVoiceSessionOpen({ agentId, sessionKey, voiceSessionId }, physicalSource);
      signal?.throwIfAborted();
    }
    // Readiness and the call read can outlive their physical browser owner. Recheck
    // after those suspensions and keep this path synchronous until backend admission.
    assertConsultCurrent();
    // Provider callbacks can inherit another ambient Gateway. Keep the source
    // under the captured owner, and release this binding when the consultation ends.
    let preparedSessionEntry: SessionEntry | undefined;
    let currentSessionId: string | undefined;
    let registeredSource: RpcSourceRef | undefined;
    let advanceRelaySession: ((sessionId: string) => void) | undefined;
    const resolveGatewayContext = params.context.resolveGatewayContext;
    const runtime = createTalkClientAgentRuntime({
      config,
      getPreparedSessionEntry: () => preparedSessionEntry,
      onSessionIdChanged: (sessionId) => {
        advanceRelaySession?.(sessionId);
        currentSessionId = sessionId;
        if (owner?.identity) {
          owner.identity = { ...owner.identity, sessionId };
        }
      },
      resolveGatewayContext,
      runAuthority: params.runAuthority,
      ...(params.ownerConnId
        ? {
            rawSourceRef: params.ownerConnId,
            getRegisteredSource: () => registeredSource,
          }
        : {}),
      assertCurrent: assertConsultCurrent,
      ...(owner
        ? {
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
              owner.commandInstance = instance;
              const operation = getCurrentSessionControllerOwner();
              if (
                operation?.key === canonicalKey &&
                (!registeredSource || registeredSource.input.claim?.operation === operation)
              ) {
                owner.operation = operation;
              }
              owner.resolveBackendOwner();
            },
            onCommandCompleted: (instance) => {
              if (
                promptOwner === owner &&
                owner.commandInstance === instance &&
                owner.requestSignal?.aborted !== true &&
                isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration) &&
                owner.isCurrent?.(owner.identity?.sessionId, "completion") === true
              ) {
                owner.commandCompleted = true;
              }
            },
          }
        : {}),
    });
    const talkConfig = config.talk;
    // A voice turn outlives offer setup and must drain under its own root,
    // while new turns still respect suspension and restart admission.
    const admission = tryBeginGatewayIndependentRootWorkAdmission("talk-agent-consult", {
      detachedWork: true,
    });
    if (!admission) {
      throw new GatewayDrainingError();
    }
    return await admission
      .run(() =>
        consultRealtimeVoiceAgentInSessionRuntime({
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
            preparedSessionEntry = sessionEntry;
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
              sessionKey: _sessionKey,
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
            currentSessionId = sessionId;
            let registeredRun:
              | {
                  release: () => void;
                  isCurrent: (phase?: "active" | "completion") => boolean;
                  onSessionIdChanged?: (sessionId: string) => void;
                }
              | undefined;
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
            const target = captureSessionTarget({
              storeScope: storePath,
              sessionKey: canonicalKey,
              agentId,
              incarnation: sessionId,
            });
            const registration = params.ownerConnId
              ? withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
                  registerChatAbortController({
                    target,
                    runId,
                    sessionId,
                    sessionKey: canonicalKey,
                    agentId,
                    timeoutMs,
                    ownerConnId: params.ownerConnId,
                    controlUiVisible: false,
                    kind: "chat-send",
                    sourceInput,
                  }),
                )
              : undefined;
            const entry = registration?.entry;
            const generation = entry ? getRpcSourceLifecycleGeneration(entry) : undefined;
            const isChatRegistrationCurrent = (phase: "active" | "completion" = "active") =>
              !params.ownerConnId ||
              isTalkConsultSourceCurrent({
                entry,
                connectionId: params.ownerConnId,
                sessionId: currentSessionId ?? sessionId,
                sessionKey: canonicalKey,
                lifecycleGeneration: generation,
                phase,
              });
            assertRunRegistrationCurrent = () => {
              assertRunCurrent();
              if (!isChatRegistrationCurrent()) {
                throw new Error("The active Talk consult admission is no longer current");
              }
            };
            let releaseVoice: void | (() => void) = undefined;
            try {
              assertRunRegistrationCurrent();
              registeredSource = entry;
              if (params.registerRun) {
                registeredRun = await params.registerRun({
                  runId,
                  assertCurrent: assertConsultCurrent,
                });
                releaseVoice = registeredRun.release;
                advanceRelaySession = registeredRun.onSessionIdChanged;
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
                owner.identity = { runId, sessionId };
                owner.completionClaim = prepareEmbeddedAgentRunCompletionClaim(
                  sessionId,
                  runId,
                  target,
                );
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
              }
              if (owner) {
                owner.cleanup = () => {
                  try {
                    releaseVoice?.();
                  } finally {
                    registration?.cleanup();
                  }
                };
                owner.signal = entry?.input.abortSignal;
                owner.isCurrent = (resolvedSessionId, phase = "active") =>
                  params.getVoiceSessionId() === voiceSessionId &&
                  isChatRegistrationCurrent(phase) &&
                  (resolvedSessionId === undefined || resolvedSessionId === currentSessionId) &&
                  (registeredRun?.isCurrent(phase) ?? true);
              }
              return {
                // Owned failures keep their registration until the existing failure claim settles.
                cleanupBeforeRun: owner ? undefined : releaseVoice || undefined,
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
        registeredSource = undefined;
        admission.release();
      });
  };
  const isOwnerCurrent = (
    owner: PromptOwner,
    sessionId?: string,
    phase: "active" | "completion" = "active",
  ): boolean => promptOwner === owner && owner.isCurrent?.(sessionId, phase) === true;
  const clearOwner = (owner: PromptOwner): void => {
    if (promptOwner === owner) {
      promptOwner = undefined;
    }
    owner.resolveBackendOwner();
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
    const current =
      owner.requestSignal?.aborted !== true &&
      isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration) &&
      isOwnerCurrent(owner, undefined, "completion");
    const embeddedCompleted = owner.completionClaim?.claimCompletion() === true;
    const completed = owner.commandCompleted === true || embeddedCompleted;
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
      (identity ? isOwnerCurrent(owner, identity.sessionId, "completion") : promptOwner === owner);
    const claimed = owner.completionClaim
      ? owner.completionClaim.claimFailure()
      : identity === undefined &&
        owner.voiceSessionId !== undefined &&
        isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration);
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
    await racePromiseWithAbortSignal(owner.backendOwnerReady, signal);
    signal?.throwIfAborted();
    const identity = owner.identity;
    const ownerSignal = owner.signal;
    const operation = owner.operation;
    if (!operation || !identity || !ownerSignal || !isOwnerCurrent(owner, identity.sessionId)) {
      throw new Error("The active Talk consult is no longer current");
    }
    // Embedded retries may share a turn and run ID, but not a command admission.
    // CLI backends retain source/operation ownership, not an embedded claim.
    const isBackendCurrent = () =>
      isOwnerCurrent(owner, identity.sessionId) &&
      (getAttachedBackend(operation)?.kind !== "embedded" ||
        owner.completionClaim?.resolveCurrentRegistration() !== undefined);
    if (!(await waitForReplyOperationBackend(operation, signal)) || !isBackendCurrent()) {
      throw new Error("The active Talk consult backend is no longer current");
    }
    const result = await controlTalkAgentRun({
      sessionKey: canonicalKey,
      runTarget: {
        runId: identity.runId,
        signal: ownerSignal,
        isCurrent: (sessionId) =>
          isOwnerCurrent(owner, sessionId) &&
          isBackendCurrent() &&
          owner.operation === operation &&
          isCurrentSessionControllerOperation(operation) &&
          !operation.result,
      },
      getToolAuthorityOverlayAsync: async () => {
        if (!isOwnerCurrent(owner, identity.sessionId)) {
          throw new Error("The active Talk consult is no longer current");
        }
        return await prepareTalkClientControlAuthority({
          config: getConfig(),
          sessionTarget: params.sessionTarget,
          authority,
          source: "reply",
          agentRuntime: getAgentRuntime(),
        });
      },
      // The controller owns fresh caller projection (including collaborative input)
      // and the source-bound authority fence at the backend write.
      text: prompt,
      createUserTurnTranscriptRecorder:
        owner.source === "native-delegation"
          ? (text) =>
              createUserTurnTranscriptRecorder({
                sessionLifecyclePatch: { lastInteractionAt: Date.now() },
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
    const backendOwner = createDeferredCore();
    const owner: PromptOwner = {
      backendOwnerReady: backendOwner.promise,
      resolveBackendOwner: () => backendOwner.resolve(),
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      requestSignal: signal,
      requesterFinal,
      source,
    };
    const revokeRegistrationOnAbort = () => owner.resolveBackendOwner();
    promptOwner = owner;
    signal?.addEventListener("abort", revokeRegistrationOnAbort, { once: true });
    try {
      return await runArgs(args, signal, owner, ready, assertCurrent, source);
    } catch (error) {
      owner.resolveBackendOwner();
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
      sourceInput?: SessionControllerInput,
    ) => runArgs(args, signal, undefined, undefined, assertCurrent, source, sourceInput),
    runOwnedArgs: lifecycleBoundRunArgs,
    runPrompt,
  };
}
