import { BoundedSerialQueue } from "../../shared/bounded-serial-queue.js";
import { REALTIME_VOICE_AGENT_CONTROL_FAILURE_MESSAGE } from "../../talk/agent-run-control-shared.js";
import {
  buildRealtimeVoiceAgentControlSpeechMessage,
  resolveRealtimeVoiceAgentControlIntent,
  type RealtimeVoiceAgentControlResult,
} from "../../talk/agent-run-control.js";
import { formatError } from "../server-utils.js";

const REALTIME_CONTROL_MAX_PENDING = 8;

export function createRealtimeControlQueue(): BoundedSerialQueue {
  return new BoundedSerialQueue({
    maxPendingCount: REALTIME_CONTROL_MAX_PENDING,
    maxPendingWeight: REALTIME_CONTROL_MAX_PENDING,
  });
}

export function createTalkRealtimeRunControlOwner(params: {
  controlSource?: "delegation" | "transcript";
  supportsToolCalls?: boolean;
  hasActiveRun: () => boolean;
  prepare: (args: unknown) => () => Promise<RealtimeVoiceAgentControlResult>;
  speak: (message: string) => void;
  warn: (message: string) => void;
}) {
  const queue = createRealtimeControlQueue();
  const enqueue = (
    args: unknown,
    options: {
      ready?: () => Promise<void>;
      onResult?: (result: RealtimeVoiceAgentControlResult) => void | Promise<void>;
      onError?: (error: unknown) => void | Promise<void>;
    } = {},
  ): boolean => {
    // Capture the owner (including absence) before any FIFO/readiness wait.
    let execute: () => Promise<RealtimeVoiceAgentControlResult>;
    try {
      execute = params.prepare(args);
    } catch (error) {
      execute = async () => {
        throw error;
      };
    }
    const admission = queue.enqueue(
      async () => {
        let result: RealtimeVoiceAgentControlResult;
        try {
          await options.ready?.();
          result = await execute();
        } catch (error) {
          if (!options.onError) {
            throw error;
          }
          await options.onError(error);
          return;
        }
        // Reply failures are transport failures, not another execution failure to answer twice.
        await options.onResult?.(result);
      },
      { sealOnOverflow: false },
    );
    if (!admission.accepted) {
      params.warn(`realtime Talk control queue rejected work: ${admission.reason}`);
      return false;
    }
    void admission.completion.catch((error: unknown) => {
      params.warn(`realtime Talk control failed: ${formatError(error)}`);
    });
    return true;
  };
  const handleInput = (
    text: string,
    respond: (message: string) => void,
    ready?: () => Promise<void>,
  ): "control" | "consult" => {
    const intent = resolveRealtimeVoiceAgentControlIntent({ text });
    const intrinsic = intent.mode === "status" || intent.mode === "cancel";
    const allowIdle = params.controlSource === "delegation" || params.supportsToolCalls === false;
    if (!intent.shouldAutoControl || (!params.hasActiveRun() && !(allowIdle && intrinsic))) {
      return "consult";
    }
    const reply = (message: string) =>
      respond(buildRealtimeVoiceAgentControlSpeechMessage(message));
    if (
      !enqueue(
        { text, mode: intent.mode },
        {
          ready,
          onResult: (result) => {
            if (result.speak && !result.suppress && result.message.trim()) {
              reply(result.message);
            }
          },
          onError: () => reply(REALTIME_VOICE_AGENT_CONTROL_FAILURE_MESSAGE),
        },
      )
    ) {
      reply(
        "OpenClaw's voice control queue is full. Please try again after the pending controls finish.",
      );
    }
    return "control";
  };
  return {
    enqueue,
    handleDelegationInput: params.controlSource === "delegation" ? handleInput : undefined,
    handleSpoken: (text: string, ready?: () => Promise<void>): boolean =>
      params.controlSource !== "delegation" && handleInput(text, params.speak, ready) === "control",
    close: () => {
      queue.seal();
      return queue.flush();
    },
  };
}
