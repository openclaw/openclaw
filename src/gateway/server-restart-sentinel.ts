import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { CliDeps } from "../cli/deps.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { parseSessionThreadInfo } from "../config/sessions/delivery-info.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import {
  consumeRestartSentinel,
  formatRestartSentinelMessage,
  summarizeRestartSentinel,
  type RestartSentinelPayload,
} from "../infra/restart-sentinel.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { defaultRuntime } from "../runtime.js";
import { deliveryContextFromSession, mergeDeliveryContext } from "../utils/delivery-context.js";
import { loadSessionEntry } from "./session-utils.js";

const DEFAULT_AUTO_CONTINUE_PROMPT =
  "Gateway restarted. Continue the interrupted task in this session from existing context and send the next useful update.";

export function resolveRestartAutoContinuePrompt(
  payload: Pick<RestartSentinelPayload, "autoContinuePrompt">,
): string | null {
  const raw = payload.autoContinuePrompt;
  if (typeof raw !== "string") {
    return DEFAULT_AUTO_CONTINUE_PROMPT;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_AUTO_CONTINUE_PROMPT;
  }
  return trimmed;
}

function maybeStartRestartAutoContinue(params: {
  deps: CliDeps;
  payload: RestartSentinelPayload;
  sessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
  agentId?: string;
}) {
  if (!params.payload.autoContinue) {
    return;
  }

  const message = resolveRestartAutoContinuePrompt(params.payload);
  if (!message) {
    return;
  }

  console.info(
    `[restart-sentinel] auto-continue: firing agentCommand (sessionKey=${params.sessionKey}, message=${message.slice(0, 80)}...)`,
  );

  // Fire-and-forget: don't block startup or sentinel wake
  import("../commands/agent.js")
    .then(({ agentCommand }) =>
      agentCommand(
        {
          message,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          deliver: true,
          channel: params.channel,
          to: params.to,
          accountId: params.accountId,
          threadId: params.threadId,
          bestEffortDeliver: true,
          messageChannel: params.channel,
          runId: `restart-auto-${Date.now().toString(36)}`,
          inputProvenance: {
            kind: "internal_system",
            sourceChannel: params.channel,
            sourceTool: "gateway.restart.auto-continue",
          },
        },
        defaultRuntime,
        params.deps,
      ),
    )
    .then(() => {
      console.info("[restart-sentinel] auto-continue: agentCommand completed");
    })
    .catch((err) => {
      console.error(`[restart-sentinel] auto-continue failed: ${String(err)}`);
    });
}

export async function scheduleRestartSentinelWake(_params: { deps: CliDeps }) {
  console.info("[restart-sentinel] scheduleRestartSentinelWake called");
  const sentinel = await consumeRestartSentinel();
  if (!sentinel) {
    console.info("[restart-sentinel] no sentinel found — skipping");
    return;
  }
  const payload = sentinel.payload;
  console.info(
    `[restart-sentinel] consumed sentinel: kind=${payload.kind} sessionKey=${payload.sessionKey ?? "none"} autoContinue=${payload.autoContinue ?? false}`,
  );
  const sessionKey = payload.sessionKey?.trim();
  const message = formatRestartSentinelMessage(payload);
  const summary = summarizeRestartSentinel(payload);

  if (!sessionKey) {
    console.info("[restart-sentinel] no sessionKey — routing to main session");
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(message, { sessionKey: mainSessionKey });
    return;
  }

  const { baseSessionKey, threadId: sessionThreadId } = parseSessionThreadInfo(sessionKey);

  const { cfg, entry } = loadSessionEntry(sessionKey);
  const parsedTarget = resolveAnnounceTargetFromKey(baseSessionKey ?? sessionKey);

  // Prefer delivery context from sentinel (captured at restart) over session store
  // Handles race condition where store wasn't flushed before restart
  const sentinelContext = payload.deliveryContext;
  let sessionDeliveryContext = deliveryContextFromSession(entry);
  if (!sessionDeliveryContext && baseSessionKey && baseSessionKey !== sessionKey) {
    const { entry: baseEntry } = loadSessionEntry(baseSessionKey);
    sessionDeliveryContext = deliveryContextFromSession(baseEntry);
  }

  const origin = mergeDeliveryContext(
    sentinelContext,
    mergeDeliveryContext(sessionDeliveryContext, parsedTarget ?? undefined),
  );

  const channelRaw = origin?.channel;
  const channel = channelRaw ? normalizeChannelId(channelRaw) : null;
  const to = origin?.to;
  if (!channel || !to) {
    console.info(`[restart-sentinel] missing channel/to — fallback to system event`);
    enqueueSystemEvent(message, { sessionKey });
    return;
  }

  const resolved = resolveOutboundTarget({
    channel,
    to,
    cfg,
    accountId: origin?.accountId,
    mode: "implicit",
  });
  if (!resolved.ok) {
    console.info(`[restart-sentinel] outbound target unresolved — fallback to system event`);
    enqueueSystemEvent(message, { sessionKey });
    return;
  }

  const threadId =
    payload.threadId ??
    parsedTarget?.threadId ?? // From resolveAnnounceTargetFromKey (extracts :topic:N)
    sessionThreadId ??
    (origin?.threadId != null ? String(origin.threadId) : undefined);
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });

  console.info(
    `[restart-sentinel] delivering to channel=${channel} to=${resolved.to} thread=${threadId ?? "none"} agent=${agentId ?? "none"}`,
  );
  try {
    await deliverOutboundPayloads({
      cfg,
      channel,
      to: resolved.to,
      accountId: origin?.accountId,
      threadId,
      payloads: [{ text: message }],
      agentId,
      bestEffort: true,
    });
    console.info("[restart-sentinel] delivery ok");
  } catch (err) {
    console.info(`[restart-sentinel] delivery failed: ${String(err)}`);
    enqueueSystemEvent(`${summary}\n${String(err)}`, { sessionKey });
  }

  console.info(
    `[restart-sentinel] calling maybeStartRestartAutoContinue (autoContinue=${payload.autoContinue ?? false})`,
  );
  maybeStartRestartAutoContinue({
    deps: _params.deps,
    payload,
    sessionKey,
    channel,
    to: resolved.to,
    accountId: origin?.accountId,
    threadId,
    agentId,
  });
}

export function shouldWakeFromRestartSentinel() {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}
