import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { AGENT_LANE_NESTED } from "../../agents/lanes.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  appendAssistantMessageToSessionTranscript,
  resolveMirroredTranscriptText,
} from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { buildOutboundResultEnvelope } from "../../infra/outbound/envelope.js";
import {
  formatOutboundPayloadLog,
  type NormalizedOutboundPayload,
  normalizeOutboundPayloads,
  normalizeOutboundPayloadsForJson,
} from "../../infra/outbound/payloads.js";
import type { OutboundSessionContext } from "../../infra/outbound/session-context.js";
import { classifySessionKeyShape } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import { isInterSessionInputProvenance } from "../../sessions/input-provenance.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { AgentCommandOpts } from "./types.js";

type RunResult = Awaited<
  ReturnType<(typeof import("../../agents/pi-embedded.js"))["runEmbeddedPiAgent"]>
>;

const NESTED_LOG_PREFIX = "[agent:nested]";
const MAX_NESTED_TRANSCRIPT_TEXT_CHARS = 8_000;
const MAX_NESTED_TRANSCRIPT_MEDIA_URLS = 16;

function formatNestedLogPrefix(opts: AgentCommandOpts, sessionKey?: string): string {
  const parts = [NESTED_LOG_PREFIX];
  const session = sessionKey ?? opts.sessionKey ?? opts.sessionId;
  if (session) {
    parts.push(`session=${session}`);
  }
  if (opts.runId) {
    parts.push(`run=${opts.runId}`);
  }
  const channel = opts.messageChannel ?? opts.channel;
  if (channel) {
    parts.push(`channel=${channel}`);
  }
  if (opts.to) {
    parts.push(`to=${opts.to}`);
  }
  if (opts.accountId) {
    parts.push(`account=${opts.accountId}`);
  }
  return parts.join(" ");
}

function logNestedOutput(
  runtime: RuntimeEnv,
  opts: AgentCommandOpts,
  output: string,
  sessionKey?: string,
) {
  const prefix = formatNestedLogPrefix(opts, sessionKey);
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    runtime.log(`${prefix} ${line}`);
  }
}

function logNestedTranscriptMirrorWarning(
  runtime: RuntimeEnv,
  opts: AgentCommandOpts,
  message: string,
) {
  if (opts.json) {
    runtime.error(message);
    return;
  }
  runtime.log(message);
}

function logNestedTranscriptMirrorError(
  runtime: RuntimeEnv,
  opts: AgentCommandOpts,
  message: string,
) {
  if (opts.json) {
    runtime.error(message);
    return;
  }
  runtime.error?.(message);
  if (!runtime.error) {
    runtime.log(message);
  }
}

function resolveNestedTranscriptAgentId(params: {
  cfg: OpenClawConfig;
  outboundSession: OutboundSessionContext | undefined;
  sessionKey?: string;
  opts: AgentCommandOpts;
}): string | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (params.outboundSession?.agentId?.trim()) {
    return params.outboundSession.agentId;
  }
  if (sessionKey && classifySessionKeyShape(sessionKey) !== "legacy_or_alias") {
    return resolveSessionAgentId({ config: params.cfg, sessionKey });
  }
  return params.opts.agentId;
}

function buildNestedTranscriptMirror(payloads: NormalizedOutboundPayload[]): {
  text?: string;
  mediaUrls?: string[];
} {
  const textLimit = MAX_NESTED_TRANSCRIPT_TEXT_CHARS - "\n\n[truncated]".length;
  const textParts: string[] = [];
  const mediaUrls: string[] = [];
  let textChars = 0;
  let hasMoreText = false;
  let hasText = false;

  for (const payload of payloads) {
    if (mediaUrls.length < MAX_NESTED_TRANSCRIPT_MEDIA_URLS && payload.mediaUrls?.length) {
      for (const url of payload.mediaUrls) {
        if (!url) {
          continue;
        }
        mediaUrls.push(url);
        if (mediaUrls.length >= MAX_NESTED_TRANSCRIPT_MEDIA_URLS) {
          break;
        }
      }
    }

    if (hasMoreText) {
      continue;
    }
    const chunk = payload.text;
    if (!chunk) {
      continue;
    }
    if (hasText) {
      if (textChars >= textLimit) {
        hasMoreText = true;
        continue;
      }
      const separator = "\n\n";
      const separatorSlice = separator.slice(0, textLimit - textChars);
      textParts.push(separatorSlice);
      textChars += separatorSlice.length;
      if (separatorSlice.length < separator.length) {
        hasMoreText = true;
        continue;
      }
    }
    hasText = true;
    if (textChars >= textLimit) {
      hasMoreText = true;
      continue;
    }
    const available = textLimit - textChars;
    if (chunk.length <= available) {
      textParts.push(chunk);
      textChars += chunk.length;
      continue;
    }
    textParts.push(chunk.slice(0, available));
    textChars += available;
    hasMoreText = true;
  }

  const baseText = textParts.join("");
  const text = baseText.trim()
    ? hasMoreText
      ? `${baseText.trim()}\n\n[truncated]`
      : baseText.trim()
    : undefined;

  return {
    ...(text ? { text } : {}),
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
  };
}

function classifyNestedTranscriptMirrorFailure(reason?: string): string {
  switch (reason) {
    case "missing sessionKey":
      return "missing session";
    case "empty text":
      return "empty mirror";
    default:
      return "transcript unavailable";
  }
}

async function mirrorNestedTranscriptToChildSession(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  opts: AgentCommandOpts;
  outboundSession: OutboundSessionContext | undefined;
  sessionKey?: string;
  payloads: NormalizedOutboundPayload[];
}) {
  const { cfg, runtime, opts, outboundSession, payloads, sessionKey } = params;
  if (!sessionKey || payloads.length === 0) {
    return;
  }
  if (!isInterSessionInputProvenance(opts.inputProvenance)) {
    const message = `${formatNestedLogPrefix(opts, sessionKey)} transcript mirror skipped (unauthorized nested mirror)`;
    logNestedTranscriptMirrorWarning(runtime, opts, message);
    return;
  }

  const { text, mediaUrls } = buildNestedTranscriptMirror(payloads);
  const agentId = resolveNestedTranscriptAgentId({
    cfg,
    outboundSession,
    sessionKey,
    opts,
  });

  if (!text && !mediaUrls) {
    return;
  }

  try {
    const hasMirrorText = Boolean(text?.trim());
    const sanitizedMediaText = mediaUrls?.length
      ? resolveMirroredTranscriptText({ mediaUrls })
      : null;
    const mirrorText = hasMirrorText
      ? sanitizedMediaText
        ? `${text}\n\nAttached media: ${sanitizedMediaText}`
        : text
      : undefined;
    const mirror = await appendAssistantMessageToSessionTranscript({
      agentId,
      sessionKey,
      text: mirrorText ?? text,
      mediaUrls: hasMirrorText ? undefined : mediaUrls,
    });
    if (!mirror.ok) {
      const message = `${formatNestedLogPrefix(opts, sessionKey)} transcript mirror skipped (${classifyNestedTranscriptMirrorFailure(mirror.reason)})`;
      logNestedTranscriptMirrorError(runtime, opts, message);
    }
  } catch {
    const message = `${formatNestedLogPrefix(opts, sessionKey)} transcript mirror skipped (unexpected transcript error)`;
    logNestedTranscriptMirrorError(runtime, opts, message);
  }
}

export async function deliverAgentCommandResult(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  runtime: RuntimeEnv;
  opts: AgentCommandOpts;
  outboundSession: OutboundSessionContext | undefined;
  sessionEntry: SessionEntry | undefined;
  result: RunResult;
  payloads: RunResult["payloads"];
}) {
  const { cfg, deps, runtime, opts, outboundSession, sessionEntry, payloads, result } = params;
  const effectiveSessionKey = outboundSession?.key ?? opts.sessionKey;
  const deliver = opts.deliver === true;
  const bestEffortDeliver = opts.bestEffortDeliver === true;
  const turnSourceChannel = opts.runContext?.messageChannel ?? opts.messageChannel;
  const turnSourceTo = opts.runContext?.currentChannelId ?? opts.to;
  const turnSourceAccountId = opts.runContext?.accountId ?? opts.accountId;
  const turnSourceThreadId = opts.runContext?.currentThreadTs ?? opts.threadId;
  const deliveryPlan = resolveAgentDeliveryPlan({
    sessionEntry,
    requestedChannel: opts.replyChannel ?? opts.channel,
    explicitTo: opts.replyTo ?? opts.to,
    explicitThreadId: opts.threadId,
    accountId: opts.replyAccountId ?? opts.accountId,
    wantsDelivery: deliver,
    turnSourceChannel,
    turnSourceTo,
    turnSourceAccountId,
    turnSourceThreadId,
  });
  let deliveryChannel = deliveryPlan.resolvedChannel;
  const explicitChannelHint = (opts.replyChannel ?? opts.channel)?.trim();
  if (deliver && isInternalMessageChannel(deliveryChannel) && !explicitChannelHint) {
    try {
      const selection = await resolveMessageChannelSelection({ cfg });
      deliveryChannel = selection.channel;
    } catch {
      // Keep the internal channel marker; error handling below reports the failure.
    }
  }
  const effectiveDeliveryPlan =
    deliveryChannel === deliveryPlan.resolvedChannel
      ? deliveryPlan
      : {
          ...deliveryPlan,
          resolvedChannel: deliveryChannel,
        };
  // Channel docking: delivery channels are resolved via plugin registry.
  const deliveryPlugin = !isInternalMessageChannel(deliveryChannel)
    ? getChannelPlugin(normalizeChannelId(deliveryChannel) ?? deliveryChannel)
    : undefined;

  const isDeliveryChannelKnown =
    isInternalMessageChannel(deliveryChannel) || Boolean(deliveryPlugin);

  const targetMode =
    opts.deliveryTargetMode ??
    effectiveDeliveryPlan.deliveryTargetMode ??
    (opts.to ? "explicit" : "implicit");
  const resolvedAccountId = effectiveDeliveryPlan.resolvedAccountId;
  const resolved =
    deliver && isDeliveryChannelKnown && deliveryChannel
      ? resolveAgentOutboundTarget({
          cfg,
          plan: effectiveDeliveryPlan,
          targetMode,
          validateExplicitTarget: true,
        })
      : {
          resolvedTarget: null,
          resolvedTo: effectiveDeliveryPlan.resolvedTo,
          targetMode,
        };
  const resolvedTarget = resolved.resolvedTarget;
  const deliveryTarget = resolved.resolvedTo;
  const resolvedThreadId = deliveryPlan.resolvedThreadId ?? opts.threadId;
  const resolvedReplyToId =
    deliveryChannel === "slack" && resolvedThreadId != null ? String(resolvedThreadId) : undefined;
  const resolvedThreadTarget = deliveryChannel === "slack" ? undefined : resolvedThreadId;

  const logDeliveryError = (err: unknown) => {
    const message = `Delivery failed (${deliveryChannel}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
    runtime.error?.(message);
    if (!runtime.error) {
      runtime.log(message);
    }
  };

  if (deliver) {
    if (isInternalMessageChannel(deliveryChannel)) {
      const err = new Error(
        "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
      );
      if (!bestEffortDeliver) {
        throw err;
      }
      logDeliveryError(err);
    } else if (!isDeliveryChannelKnown) {
      const err = new Error(`Unknown channel: ${deliveryChannel}`);
      if (!bestEffortDeliver) {
        throw err;
      }
      logDeliveryError(err);
    } else if (resolvedTarget && !resolvedTarget.ok) {
      if (!bestEffortDeliver) {
        throw resolvedTarget.error;
      }
      logDeliveryError(resolvedTarget.error);
    }
  }

  const normalizedPayloads = normalizeOutboundPayloadsForJson(payloads ?? []);
  const deliveryPayloads = payloads?.length ? normalizeOutboundPayloads(payloads) : [];
  if (!deliver && opts.lane === AGENT_LANE_NESTED) {
    await mirrorNestedTranscriptToChildSession({
      cfg,
      runtime,
      opts,
      outboundSession,
      sessionKey: effectiveSessionKey,
      payloads: deliveryPayloads,
    });
  }
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        buildOutboundResultEnvelope({
          payloads: normalizedPayloads,
          meta: result.meta,
        }),
        null,
        2,
      ),
    );
    if (!deliver) {
      return { payloads: normalizedPayloads, meta: result.meta };
    }
  }

  if (!payloads || payloads.length === 0) {
    runtime.log("No reply from agent.");
    return { payloads: [], meta: result.meta };
  }

  const logPayload = (payload: NormalizedOutboundPayload) => {
    if (opts.json) {
      return;
    }
    const output = formatOutboundPayloadLog(payload);
    if (!output) {
      return;
    }
    if (opts.lane === AGENT_LANE_NESTED) {
      logNestedOutput(runtime, opts, output, effectiveSessionKey);
      return;
    }
    runtime.log(output);
  };
  if (!deliver) {
    for (const payload of deliveryPayloads) {
      logPayload(payload);
    }
  }
  if (deliver && deliveryChannel && !isInternalMessageChannel(deliveryChannel)) {
    if (deliveryTarget) {
      await deliverOutboundPayloads({
        cfg,
        channel: deliveryChannel,
        to: deliveryTarget,
        accountId: resolvedAccountId,
        payloads: deliveryPayloads,
        session: outboundSession,
        replyToId: resolvedReplyToId ?? null,
        threadId: resolvedThreadTarget ?? null,
        bestEffort: bestEffortDeliver,
        onError: (err) => logDeliveryError(err),
        onPayload: logPayload,
        deps: createOutboundSendDeps(deps),
      });
    }
  }

  return { payloads: normalizedPayloads, meta: result.meta };
}
