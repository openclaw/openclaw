import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  resolveExplicitSessionStorePathForScope,
  resolveSessionStorePathCore,
} from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  bindSessionControllerSource,
  reserveSessionControllerSource,
  retargetSessionControllerSource,
  retireSessionControllerInput,
  type SessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { TurnAdoptionLifecycle } from "../get-reply-options.types.js";
import type { MsgContext } from "../templating.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { resolveQueueSettingsCore } from "./queue/settings.js";
import type { FollowupRun } from "./queue/types.js";
import { replySource, type ReplySourceBinding } from "./reply-source-binding.types.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";

const sourcePreparationRetry = Symbol("openclaw.replySourcePreparationRetry");
type ReplySourcePreparationRetry = <T>(work: () => Promise<T>) => Promise<T>;
type SourceWithPreparationRetry = SessionControllerInput & {
  [sourcePreparationRetry]?: ReplySourcePreparationRetry;
};

/** Gateway-owned retry policy follows its exact source without expanding public option types. */
export function bindReplySourcePreparationRetry(
  input: SessionControllerInput,
  retry: ReplySourcePreparationRetry,
): void {
  Object.assign(input, { [sourcePreparationRetry]: retry });
}

export function readReplySourcePreparationRetry(
  input: SessionControllerInput | undefined,
): ReplySourcePreparationRetry | undefined {
  const source: SourceWithPreparationRetry | undefined = input;
  return source?.[sourcePreparationRetry];
}

export function bindReplySourceInput<T extends object>(
  carrier: T,
  input: SessionControllerInput,
): T & ReplySourceBinding {
  return Object.assign(carrier, { [replySource]: input });
}

/** Participants reserve their own physical source rather than inheriting the group root. */
export function clearReplySourceInput<T extends object>(carrier: T & ReplySourceBinding): T {
  delete carrier[replySource];
  return carrier;
}

export function readReplySourceInput(
  carrier: (ReplySourceBinding & { turnAdoptionLifecycle?: TurnAdoptionLifecycle }) | undefined,
): SessionControllerInput | undefined {
  if (!carrier) {
    return undefined;
  }
  const direct: ReplySourceBinding = carrier;
  const lifecycle: (TurnAdoptionLifecycle & ReplySourceBinding) | undefined =
    carrier.turnAdoptionLifecycle;
  return direct[replySource] ?? lifecycle?.[replySource];
}

/** Capture only an actual physical source scope, before asynchronous preparation. */
export async function prepareReplySourceInput(
  ctx: MsgContext,
  cfg: OpenClawConfig,
  options: InternalGetReplyOptions | undefined,
): Promise<{ options: InternalGetReplyOptions; input?: SessionControllerInput; created: boolean }> {
  const prepared = { ...options };
  const sessionKey = ctx.SessionKey?.trim() || ctx.CommandTargetSessionKey?.trim();
  const existing = readReplySourceInput(prepared);
  if (existing) {
    const signal = existing.claim?.operation?.abortSignal ?? existing.abortSignal;
    prepared.abortSignal =
      prepared.abortSignal && prepared.abortSignal !== signal
        ? AbortSignal.any([prepared.abortSignal, signal])
        : signal;
    return { options: bindReplySourceInput(prepared, existing), input: existing, created: false };
  }
  if (!sessionKey) {
    return { options: prepared, created: false };
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg, fallbackAgentId: ctx.AgentId });
  const storePath =
    resolveExplicitSessionStorePathForScope({ agentId, sessionKey }) ??
    resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const policy = resolveQueueSettingsCore({ cfg, channel: ctx.Provider ?? ctx.Surface });
  // Ambient events may not preempt a user turn. Full directive
  // resolution refines policy on this same input before queue publication.
  if (ctx.InboundEventKind === "room_event") {
    policy.mode = "followup";
  }
  const signals = [options?.abortSignal, options?.turnAdoptionLifecycle?.abortSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  if (signal?.aborted) {
    // Dispatch owns the skipped outcome for input cancelled before admission.
    return { options: { ...prepared, abortSignal: signal }, created: false };
  }
  signal?.throwIfAborted();
  options?.operatorAuthority?.assertCurrent();
  const input = reserveSessionControllerSource(sessionKey, {
    sourceTurnId: readChannelSourceTurnId(ctx),
    protocolRunId: options?.runId,
    policy,
    target: captureSessionTarget({
      storeScope: storePath,
      sessionKey,
      agentId,
      incarnation: options?.expectedExistingSessionId,
    }),
    adapter: {
      signal,
      authority: options?.operatorAuthority,
    },
  });
  prepared.abortSignal = input.abortSignal;
  return { options: bindReplySourceInput(prepared, input), input, created: true };
}

export function bindReplySourceToFollowup(
  options: InternalGetReplyOptions | undefined,
  source: FollowupRun,
): SessionControllerInput | undefined {
  const input =
    readReplySourceInput(options) ??
    readReplySourceInput({ turnAdoptionLifecycle: source.turnAdoptionLifecycle });
  if (input) {
    bindSessionControllerSource(input, source);
  }
  return input;
}

/** Only a resolved native/explicit command continuation may leave its source. */
export function retargetReplySourceForExecution(params: {
  ctx: MsgContext;
  options: InternalGetReplyOptions | undefined;
  sessionKey?: string;
  sessionId?: string;
  storePath: string;
  agentId: string;
}): void {
  const input = readReplySourceInput(params.options);
  if (!input || !params.sessionKey) {
    return;
  }
  const target = input.mailbox.owner.target;
  if (
    target?.storeScope === params.storePath &&
    input.mailbox.owner.aliases.has(params.sessionKey)
  ) {
    return;
  }
  if (resolveCommandTurnTargetSessionKey(params.ctx) !== params.sessionKey) {
    throw new Error("Reply execution target differs from its captured source");
  }
  retargetSessionControllerSource(
    input,
    captureSessionTarget({
      storeScope: params.storePath,
      sessionKey: params.sessionKey,
      incarnation: params.sessionId,
      agentId: params.agentId,
    }),
    "command-target",
  );
}

/** Non-turn/failed preparation retires only its source, never a queued or raw owner. */
export function retireUnadoptedReplySource(input: SessionControllerInput | undefined): void {
  if (input && !input.claim && !input.custody.enqueued && !input.injection) {
    retireSessionControllerInput(input);
  }
}
