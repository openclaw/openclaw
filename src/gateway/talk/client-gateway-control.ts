import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { retireUnadoptedReplySource } from "../../auto-reply/reply/reply-source-binding.js";
import { formatErrorMessage as formatError, readErrorName } from "../../infra/errors.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  type SessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { waitForAgentInputRecovery } from "../../state/agent-input-recovery-context.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../talk/agent-consult-tool.js";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  controlRealtimeVoiceAgentRun,
  parseRealtimeVoiceAgentControlToolArgs,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
} from "../../talk/agent-run-control.js";
import { createClientVoiceTranscriptReadiness } from "../../talk/client-voice-transcript-readiness.js";
import {
  buildRealtimeVoiceSpeakExactMessage,
  readRealtimeVoicePlaybackEcho,
} from "../../talk/exact-speech-protocol.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceCloseDisposition,
  RealtimeVoiceToolCallEvent,
} from "../../talk/provider-types.js";
import {
  createRealtimeVoiceSessionHarness,
  handleRealtimeVoiceHarnessBridgeEvent,
} from "../../talk/realtime-session-harness.js";
import type { TalkEvent } from "../../talk/talk-events.js";
import type {
  TalkClientGatewayControlOptions,
  ReusableTalkAgentConsult,
  GatewayControlCommands,
  GatewayControlOwner,
  TalkAgentConsultRequest,
} from "./client-agent-consult.types.js";
import { createTalkRealtimeRunControlOwner, createTalkRunCancel } from "./realtime-run-control.js";
import { resolveOwnedActiveTalkRunTarget } from "./run-ownership.js";
import { registerTalkConnectionCleanup } from "./session-registry.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";
import { isTalkVoiceSessionReplacing } from "./voice-selection.js";

const owners = new Map<string, GatewayControlOwner>();
const pendingOwners = new Set<GatewayControlOwner>();
// Preserve the call's active-plus-eight-waiting admission bound; the controller owns order.
const MAX_ACCEPTED_TALK_CONSULTS = 9;

export function createTalkClientGatewayControlOwner(
  params: TalkClientGatewayControlOptions,
): GatewayControlOwner {
  let commands: GatewayControlCommands | undefined;
  let ready = false;
  let retainedExactSpeechTexts: string[] = [];
  let closeProvider: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let transcriptSequence = 0;
  let acceptingProviderTranscripts = true;
  let appendTranscript = params.appendTranscript;
  const transcriptReadiness = createClientVoiceTranscriptReadiness({
    flushTranscript: params.flushTranscript,
  });
  const entryPrefix = `gateway-${randomUUID()}`;
  const consults = new Set<Promise<void>>();
  let consultAdmission: Promise<void> | undefined;
  let consultAdmissionSealed = false;
  const consultControllers = new Map<
    string | symbol,
    { controller: AbortController; closeDisposition: RealtimeVoiceCloseDisposition }
  >();
  const warn = (message: string) => params.context.logGateway.warn(message);
  const talkPayload = () => ({ voiceSessionId: params.voiceSessionId });
  const harness = createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: params.voiceSessionId,
      mode: "realtime",
      transport: "webrtc",
      brain: "agent-consult",
      provider: params.providerId,
    },
    talkPayloads: {
      turnStarted: talkPayload,
      turnEnded: (reason) => ({ ...talkPayload(), reason }),
      inputAudioDelta: (audio) => ({ ...talkPayload(), byteLength: audio.byteLength }),
      outputAudioStarted: talkPayload,
      outputAudioDelta: (audio) => ({ ...talkPayload(), byteLength: audio.byteLength }),
      outputAudioDone: (reason) => ({ ...talkPayload(), reason }),
    },
    onTalkEvent: (talkEvent: TalkEvent) =>
      params.context.broadcastToConnIds(
        "talk.event",
        { voiceSessionId: params.voiceSessionId, talkEvent },
        new Set([params.connId]),
        { dropIfSlow: talkEvent.final !== true },
      ),
    captureBridgeEvents: false,
  });

  const assertActive = () => {
    owner.assertOpen();
    if (owners.get(params.voiceSessionId) !== owner) {
      throw new Error("Realtime voice session is not active");
    }
  };
  const readSpeechEcho = (args: unknown) =>
    readRealtimeVoicePlaybackEcho(args, {
      retainedExactSpeechTexts,
      surfaceLabel: "the caller",
    });
  const admitConsult = async (
    runner: ReusableTalkAgentConsult,
    args: unknown,
    sourceInput: SessionControllerInput,
  ) => {
    // The reserved input's signal joins this call's controller and session Stop.
    const consultSignal = sourceInput.abortSignal;
    assertActive();
    consultSignal.throwIfAborted();
    await params.flushTranscript();
    // Admit in the same continuation as the liveness check: another await
    // would let flush-completion teardown close the owner before the run starts.
    assertActive();
    consultSignal.throwIfAborted();
    return runner(args, consultSignal, assertActive, "tool-call", sourceInput);
  };
  const awaitProviderConsultReadiness = async (consultSignal: AbortSignal): Promise<void> => {
    assertActive();
    consultSignal.throwIfAborted();
    const recovery = waitForAgentInputRecovery(params.sessionTarget.agentId, {
      signal: AbortSignal.any([signal, consultSignal]),
      owner: params.context.inputRecovery,
    });
    if (recovery) {
      await recovery;
      assertActive();
      consultSignal.throwIfAborted();
    }
    await transcriptReadiness.wait(consultSignal);
    // Keep accepted work detached, but reject pending admission if either owner
    // changed while transcript writes were draining.
    assertActive();
    consultSignal.throwIfAborted();
  };
  const bindControl = (nextCommands: GatewayControlCommands) => {
    owner.assertOpen();
    if (!pendingOwners.has(owner) && owners.get(params.voiceSessionId) !== owner) {
      throw new Error("Realtime voice session is not active");
    }
    commands = nextCommands;
  };
  const submit = async (callId: string, result: unknown): Promise<void> => {
    assertActive();
    if (!commands?.submitToolResult) {
      throw new Error("Realtime voice tool control is not available");
    }
    await commands.submitToolResult(callId, result);
  };
  const rejectToolCall = (callId: string, message: string) => {
    void submit(callId, { error: message }).catch((error: unknown) => {
      warn(`talk Gateway control rejection failed: ${formatError(error)}`);
    });
  };

  const resolveRunTarget = () =>
    resolveOwnedActiveTalkRunTarget({
      clientConnId: params.connId,
      sessionTarget: params.sessionTarget,
      scope: { kind: "voice-session", voiceSessionId: params.voiceSessionId },
      assertCurrent: assertActive,
    });

  const cancelRun = createTalkRunCancel({
    context: params.context,
    sessionTarget: params.sessionTarget,
    connId: params.connId,
    assertCurrent: assertActive,
  });
  const prepareControl = (args: unknown) => {
    assertActive();
    const parsed = parseRealtimeVoiceAgentControlToolArgs(args);
    const runTarget = resolveRunTarget();
    const admittedConsults = [...consultControllers.values()];
    const getToolAuthorityOverlay = params.getToolAuthorityOverlay;
    return async () => {
      assertActive();
      const result = await (params.controlAgentRun ?? controlRealtimeVoiceAgentRun)({
        sessionKey: params.sessionTarget.canonicalKey,
        runTarget,
        getToolAuthorityOverlay: getToolAuthorityOverlay
          ? () => getToolAuthorityOverlay(runTarget?.toolAuthoritySource)
          : undefined,
        text: parsed.text,
        mode: parsed.mode,
        cancelRun,
      });
      assertActive();
      if (result.mode === "cancel" && result.ok) {
        for (const { controller } of admittedConsults) {
          controller.abort(new Error("Realtime voice consult cancelled"));
        }
      }
      return result;
    };
  };

  const runConsult = async (
    event: RealtimeVoiceToolCallEvent,
    controller: AbortController,
    reservedInput: SessionControllerInput | Promise<SessionControllerInput>,
  ): Promise<void> => {
    let input: SessionControllerInput | undefined;
    try {
      input = await reservedInput;
      const result = await admitConsult(params.runToolAgentConsult, event.args, input);
      if (signal.aborted) {
        return;
      }
      await submit(event.callId, { result: result.text });
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      const result =
        (input?.abortSignal ?? controller.signal).aborted || readErrorName(error) === "AbortError"
          ? buildRealtimeVoiceAgentCancelProviderResult()
          : { error: formatError(error) };
      await submit(event.callId, result);
    } finally {
      retireUnadoptedReplySource(input);
      if (consultControllers.get(event.callId)?.controller === controller) {
        consultControllers.delete(event.callId);
      }
    }
  };

  const runControl = createTalkRealtimeRunControlOwner({
    controlSource: params.controlSource,
    supportsToolCalls: params.supportsToolCalls,
    hasActiveRun: () => consultControllers.size > 0 || resolveRunTarget() !== null,
    prepare: prepareControl,
    speak: (message) => {
      assertActive();
      if (!commands?.sendUserMessage) {
        throw new Error("Realtime voice speech control is not available");
      }
      commands.sendUserMessage(message);
    },
    warn,
  });
  let completionClaimsAdopted = false;
  const claimForCurrentOwner = (claim: "claimAppend" | "claimFailureAppend"): boolean => {
    let current = true;
    try {
      assertActive();
    } catch {
      current = false;
    }
    const claimed = params.runAgentConsult[claim]?.() === true;
    return current && claimed;
  };
  const runAgentConsult = Object.assign(
    async ({
      prompt,
      signal: consultSignal = new AbortController().signal,
      requesterFinal,
    }: TalkAgentConsultRequest) => {
      assertActive();
      const consultId = Symbol("provider-consult");
      const controller = new AbortController();
      const delegatedSignal = AbortSignal.any([consultSignal, controller.signal]);
      // Spoken controls see both kinds of consult. Transport detachment still
      // leaves accepted provider work under its own cancellation owner.
      consultControllers.set(consultId, { controller, closeDisposition: "detach" });
      // A retained final outlives this consult promise, so every append must
      // revalidate the exact Gateway owner immediately before provider I/O.
      const ownerBoundRequesterFinal = requesterFinal
        ? {
            append: (text: string) => {
              try {
                assertActive();
              } catch {
                return false;
              }
              return requesterFinal.append(text);
            },
          }
        : undefined;
      try {
        if (completionClaimsAdopted) {
          return await params.runAgentConsult(
            { question: prompt },
            delegatedSignal,
            () => awaitProviderConsultReadiness(delegatedSignal),
            assertActive,
            ownerBoundRequesterFinal,
            "native-delegation",
          );
        }
        await awaitProviderConsultReadiness(delegatedSignal);
        return await params.runToolAgentConsult(
          { question: prompt },
          delegatedSignal,
          assertActive,
          "native-delegation",
        );
      } finally {
        consultControllers.delete(consultId);
      }
    },
    {
      // Completion ownership extends beyond the released callback promise, so
      // only controllers that consume the matching claims may opt into it.
      adoptCompletionClaims: () => {
        completionClaimsAdopted = true;
      },
      claimAppend: () => claimForCurrentOwner("claimAppend"),
      claimFailureAppend: () => claimForCurrentOwner("claimFailureAppend"),
      revokeRequesterFinal: () => params.runAgentConsult.revokeRequesterFinal?.(),
      steer: params.runAgentConsult.steer
        ? async (request: Parameters<RealtimeVoiceAgentConsultRunner>[0]) => {
            await awaitProviderConsultReadiness(request.signal ?? signal);
            return await params.runAgentConsult.steer!(request);
          }
        : undefined,
    },
  );

  const handleToolCall = (event: RealtimeVoiceToolCallEvent): void => {
    if (signal.aborted) {
      return;
    }
    if (event.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      const echo = readSpeechEcho(event.args);
      if (echo !== undefined) {
        void submit(event.callId, { result: echo }).catch((error: unknown) => {
          warn(`talk Gateway speech echo failed: ${formatError(error)}`);
        });
        return;
      }
      if (consultAdmissionSealed || consults.size >= MAX_ACCEPTED_TALK_CONSULTS) {
        consultAdmissionSealed = true;
        rejectToolCall(event.callId, "Realtime Talk consult queue is full");
        return;
      }
      const controller = new AbortController();
      const admissionSignal = AbortSignal.any([signal, controller.signal]);
      const reserve = () => {
        assertActive();
        admissionSignal.throwIfAborted();
        return reserveSessionControllerSource(params.sessionTarget.canonicalKey, {
          policy: { mode: "followup" },
          target: captureSessionTarget({
            storeScope: params.sessionTarget.storePath,
            sessionKey: params.sessionTarget.canonicalKey,
            agentId: params.sessionTarget.agentId,
          }),
          adapter: { signal: controller.signal },
        });
      };
      const waitForRecovery = () =>
        waitForAgentInputRecovery(params.sessionTarget.agentId, {
          signal: admissionSignal,
          owner: params.context.inputRecovery,
        });
      const pendingAdmission = consultAdmission
        ? consultAdmission.then(async () => {
            const recovery = waitForRecovery();
            if (recovery) {
              await recovery;
            }
            return reserve();
          })
        : waitForRecovery()?.then(reserve);
      // Keep arrival order through recovery without holding the next reservation
      // behind the preceding model run. Ready agents still reserve synchronously.
      const input = pendingAdmission ?? reserve();
      if (pendingAdmission) {
        const tail = pendingAdmission.then(
          () => undefined,
          () => undefined,
        );
        consultAdmission = tail;
        void tail.then(() => {
          if (consultAdmission === tail) {
            consultAdmission = undefined;
          }
        });
      }
      consultControllers.set(event.callId, { controller, closeDisposition: "abort" });
      const consult = runConsult(event, controller, input)
        .catch((error: unknown) => {
          warn(`talk Gateway control consult failed: ${formatError(error)}`);
        })
        .finally(() => consults.delete(consult));
      consults.add(consult);
      return;
    }
    if (event.name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
      if (
        !runControl.enqueue(event.args, {
          onResult: (result) => submit(event.callId, result),
          onError: (error) => submit(event.callId, { error: formatError(error) }),
        })
      ) {
        rejectToolCall(event.callId, "Realtime Talk control queue is full");
      }
      return;
    }
    rejectToolCall(event.callId, `Unsupported realtime Talk tool: ${event.name}`);
  };

  const handleTranscript = (role: "user" | "assistant", text: string, final: boolean): void => {
    if (!acceptingProviderTranscripts || (signal.aborted && !final)) {
      return;
    }
    if (!text.trim()) {
      return;
    }
    if (!signal.aborted) {
      const turnId = harness.ensureTurn();
      harness.emit({
        type:
          role === "assistant"
            ? final
              ? "output.text.done"
              : "output.text.delta"
            : final
              ? "transcript.done"
              : "transcript.delta",
        turnId,
        payload: role === "assistant" ? { text } : { role, text },
        final,
      });
    }
    if (!final || !acceptingProviderTranscripts) {
      return;
    }
    transcriptSequence += 1;
    const entryId = `${entryPrefix}-${transcriptSequence}`;
    void appendTranscript({
      entryId,
      role,
      text,
    }).then(undefined, (error: unknown) => {
      transcriptReadiness.fail(error);
      warn(`talk Gateway control transcript failed: ${formatError(error)}`);
    });
    if (role === "user" && !signal.aborted) {
      runControl.handleSpoken(text, params.flushTranscript);
    }
  };

  const owner: GatewayControlOwner = {
    signal,
    connId: params.connId,
    sessionTarget: params.sessionTarget,
    voiceSessionId: params.voiceSessionId,
    assertOpen: () => {
      signal.throwIfAborted();
      params.assertConnectionOpen?.();
    },
    runAgentConsult,
    sendSpeech: (text) => {
      assertActive();
      if (!ready || !commands?.sendUserMessage) {
        throw new Error("Realtime voice speech control is not ready");
      }
      const previous = retainedExactSpeechTexts;
      // Retain before dispatch because a provider can echo synchronously.
      retainedExactSpeechTexts = [...previous, text].slice(-8);
      try {
        commands.sendUserMessage(
          buildRealtimeVoiceSpeakExactMessage({ text, surfaceLabel: "the caller" }),
        );
      } catch (error) {
        retainedExactSpeechTexts = previous;
        throw error;
      }
    },
    control: {
      bindControl,
      bindBridge: bindControl,
      onEvent: (event) => {
        if (signal.aborted) {
          return;
        }
        const legacyOutcome = handleRealtimeVoiceHarnessBridgeEvent(harness, event);
        if (
          legacyOutcome &&
          (legacyOutcome.status === "failed" || legacyOutcome.status === "incomplete")
        ) {
          warn(`talk Gateway control ${legacyOutcome.message}`);
        }
        if (
          event.direction === "server" &&
          (event.type === "conversation.output_audio.delta" ||
            event.type === "response.audio.delta" ||
            event.type === "response.output_audio.delta")
        ) {
          const turnId = harness.ensureTurn();
          harness.talk.startOutputAudio({ turnId, payload: talkPayload() });
        }
      },
      onTranscript: handleTranscript,
      ...(runControl.handleDelegationInput
        ? {
            handleDelegationInput: (text, respond) => {
              assertActive();
              const echo = readSpeechEcho(text);
              if (echo !== undefined) {
                respond(echo);
                return "control";
              }
              return runControl.handleDelegationInput!(
                text,
                (message) => {
                  // The call owns this reply even when cancellation ended its backing task.
                  assertActive();
                  respond(message);
                },
                params.flushTranscript,
              );
            },
          }
        : {}),
      onToolCall: handleToolCall,
      onResponseDone: (outcome) => {
        if (signal.aborted) {
          return;
        }
        const terminal = harness.finishResponse(outcome);
        if (terminal.ok && (outcome.status === "failed" || outcome.status === "incomplete")) {
          warn(`talk Gateway control ${outcome.message}`);
        }
      },
      onReady: () => {
        if (!signal.aborted) {
          ready = true;
          harness.emit({ type: "session.ready", payload: talkPayload() });
        }
      },
      onError: (error) => {
        if (signal.aborted) {
          return;
        }
        warn(`talk Gateway control provider error: ${error.message}`);
        harness.emit({
          type: "session.error",
          payload: { ...talkPayload(), message: error.message },
          final: true,
        });
      },
      onClose: () => {
        if (signal.aborted) {
          return;
        }
        harness.emit({ type: "session.closed", payload: talkPayload(), final: true });
        harness.close();
        void owner.close({ skipProvider: true }).catch((error: unknown) => {
          warn(`talk Gateway control close failed: ${formatError(error)}`);
        });
      },
    },
    adoptProvider: async (nextCloseProvider) => {
      if (signal.aborted) {
        await nextCloseProvider();
        signal.throwIfAborted();
      }
      closeProvider = nextCloseProvider;
      owner.assertOpen();
    },
    activate: () => {
      owner.assertOpen();
      pendingOwners.delete(owner);
      const previous = owners.get(params.voiceSessionId);
      owners.set(params.voiceSessionId, owner);
      if (previous && previous !== owner) {
        void previous
          .close({ preserveLogicalSession: true, preserveRuns: true })
          .catch((error: unknown) => {
            warn(`talk replaced Gateway transport close failed: ${formatError(error)}`);
          });
      }
    },
    close: (options) => {
      if (closing) {
        return closing;
      }
      ready = false;
      retainedExactSpeechTexts = [];
      const preserveRuns =
        options?.preserveRuns ??
        isTalkVoiceSessionReplacing(
          params.voiceSessionId,
          params.connId,
          params.sessionTarget.agentId,
        );
      acceptingProviderTranscripts = !options?.skipProvider && closeProvider !== undefined;
      // Disconnect and restart must still join retired transports while teardown drains.
      pendingOwners.add(owner);
      // Fence admission synchronously, then defer teardown so provider callbacks
      // can re-enter close after the closing promise has been assigned.
      closing = (params.withCloseSettlement ?? ((run) => run()))(() => {
        // Provider callbacks can arrive in their original async context after close.
        appendTranscript = AsyncLocalStorage.bind(params.appendTranscript);
        return Promise.resolve()
          .then(async () => {
            harness.close();
            if (owners.get(params.voiceSessionId) === owner) {
              owners.delete(params.voiceSessionId);
            }
            if (!preserveRuns) {
              for (const { controller, closeDisposition } of consultControllers.values()) {
                if (closeDisposition === "abort") {
                  controller.abort(new Error("Realtime voice session closed"));
                }
              }
            }
            const providerClose = Promise.resolve()
              .then(() => (options?.skipProvider ? undefined : closeProvider?.()))
              .finally(() => {
                acceptingProviderTranscripts = false;
              });
            // A voice-change consult awaits its replacement; its own run admission keeps it alive.
            const controlCleanup = Promise.allSettled([
              runControl.close(),
              preserveRuns ? undefined : Promise.all(consults),
            ]);
            const [providerResult] = await Promise.allSettled([providerClose, controlCleanup]);
            // Provider shutdown can append final speech; its complete write prefix owns this barrier.
            const [transcriptResult] = await Promise.allSettled([params.flushTranscript()]);
            if (!options?.preserveLogicalSession) {
              await params.closeLogicalSession();
            }
            if (providerResult?.status === "rejected") {
              throw providerResult.reason;
            }
            if (transcriptResult?.status === "rejected") {
              throw transcriptResult.reason;
            }
          })
          .finally(() => {
            pendingOwners.delete(owner);
          });
      });
      // preserveRuns keeps accepted work alive, not a retired transport's presentation authority.
      params.runAgentConsult.revokeRequesterFinal?.();
      lifetime.abort(new Error("Realtime voice session closed"));
      transcriptReadiness.close();
      return closing;
    },
  };
  // Track creation before the provider resolves. Replacement activates only after
  // startup succeeds, so a failed new transport cannot evict the current one.
  owner.assertOpen();
  pendingOwners.add(owner);
  registerTalkConnectionCleanup(params.connId, "browser-control", async () => {
    const pendingCloses: Promise<void>[] = [];
    for (const current of [...pendingOwners, ...owners.values()]) {
      if (current.connId === params.connId) {
        pendingCloses.push(
          current.close().catch((error: unknown) => {
            warn(`talk disconnected Gateway control close failed: ${formatError(error)}`);
          }),
        );
      }
    }
    await Promise.all(pendingCloses);
  });
  return owner;
}

export function sendTalkClientGatewayControlSpeech(params: {
  voiceSessionId: string;
  sessionTarget: PreparedTalkSessionTarget;
  connId?: string;
  text: string;
}): void {
  const owner = owners.get(params.voiceSessionId);
  if (!owner) {
    throw new Error("Gateway-controlled voice session is not active");
  }
  const target = params.sessionTarget;
  if (
    owner.connId !== params.connId ||
    owner.sessionTarget.sessionKey !== target.sessionKey ||
    owner.sessionTarget.canonicalKey !== target.canonicalKey ||
    owner.sessionTarget.agentId !== target.agentId ||
    owner.sessionTarget.storePath !== target.storePath
  ) {
    throw new Error("Gateway-controlled voice session is not owned by this client");
  }
  owner.sendSpeech(params.text);
}

export async function closeTalkClientGatewayControlSession(params: {
  voiceSessionId: string;
  sessionKey: string;
  connId?: string;
}): Promise<boolean> {
  const matching = [...pendingOwners, ...owners.values()].filter(
    (owner) => owner.voiceSessionId === params.voiceSessionId,
  );
  if (matching.length === 0) {
    return false;
  }
  const owned = matching.filter(
    (owner) =>
      owner.sessionTarget.sessionKey === params.sessionKey.trim() && owner.connId === params.connId,
  );
  if (owned.length === 0) {
    throw new Error("Gateway-controlled voice session is not owned by this client");
  }
  await Promise.all(owned.map((owner) => owner.close()));
  return true;
}
