import { AsyncLocalStorage } from "node:async_hooks";
import { stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { stripMixedSilentReplyTokens } from "../auto-reply/reply/mixed-silent-reply-tokens.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyPayloadText,
  SILENT_REPLY_TOKEN,
} from "../auto-reply/tokens.js";
import { resolveMirroredTranscriptText } from "../config/sessions/transcript-mirror.js";
import { runOncePerAgentRun } from "../infra/agent-events.js";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { resolveOutboundPayloadMirrorText } from "../infra/outbound/payloads.js";
import { resolveOutboundMediaUrls } from "../infra/outbound/reply-payload-parts.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readClaimingHookAdmission, withClaimingHookAdmission } from "./hook-claim-admission.js";
import { getGlobalHookRunner } from "./hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentReplyEvent,
  PluginHookBeforeAgentReplyResult,
} from "./hook-types.js";
import { isPluginHookAgentTrigger } from "./hook-types.js";

const BEFORE_AGENT_REPLY_OBSERVER_KEY = Symbol.for("openclaw.beforeAgentReply.observer");

type BeforeAgentReplyObserver = {
  beforeDispatch: () => Promise<boolean | void>;
  afterDispatch: (
    result: PluginHookBeforeAgentReplyResult | undefined,
  ) => Promise<PluginHookBeforeAgentReplyResult | undefined>;
};

type BeforeAgentReplyObserverScope = BeforeAgentReplyObserver & { runId?: string };

const beforeAgentReplyObserver = resolveGlobalSingleton<
  AsyncLocalStorage<BeforeAgentReplyObserverScope>
>(BEFORE_AGENT_REPLY_OBSERVER_KEY, () => new AsyncLocalStorage());

/** Attaches durable admission bookkeeping without moving hook ownership out of the runner. */
export function withBeforeAgentReplyObserver<T>(
  observer: BeforeAgentReplyObserver,
  run: () => T,
): T {
  return beforeAgentReplyObserver.run({ ...observer }, run);
}

/** Preserves the full plugin reply contract, including private payload metadata. */
export function buildHandledBeforeAgentReplyPayloads(reply?: ReplyPayload): ReplyPayload[] {
  return [reply ?? { text: SILENT_REPLY_TOKEN }];
}

/** Preserve the routed-delivery content mirror before claiming transcript ownership. */
export function resolveHandledBeforeAgentReplyTranscriptText(reply?: ReplyPayload): string | null {
  const mediaUrls = resolveOutboundMediaUrls(reply ?? {});
  const rawText = reply?.text;
  const heartbeatReply = reply && getReplyPayloadMetadata(reply)?.heartbeatReply === true;
  const text =
    reply && rawText && !heartbeatReply
      ? isSilentReplyPayloadText(rawText)
        ? undefined
        : (stripMixedSilentReplyTokens(rawText) ?? rawText)
      : rawText;
  const heartbeat =
    text?.includes(HEARTBEAT_TOKEN) && !heartbeatReply
      ? stripHeartbeatToken(text, { mode: "message" })
      : null;
  const mirroredText = resolveOutboundPayloadMirrorText({
    ...reply,
    text: heartbeat?.text ?? text,
  });
  if (mediaUrls.length > 0) {
    return resolveMirroredTranscriptText({ text: mirroredText, mediaUrls }) ?? SILENT_REPLY_TOKEN;
  }
  return mirroredText || (heartbeat ? heartbeat.text : text) || null;
}

/** Runs the reply claim hook once for one admitted turn, across model fallbacks. */
export function runBeforeAgentReplyForTurn(params: {
  runId: string;
  trigger?: string;
  event: PluginHookBeforeAgentReplyEvent;
  context: PluginHookAgentContext;
  assertCurrent?: () => void;
  onDispatch?: () => void;
  onDeclined?: () => void;
}): Promise<PluginHookBeforeAgentReplyResult | undefined> {
  const trigger = params.trigger;
  if (!isPluginHookAgentTrigger(trigger)) {
    return Promise.resolve(undefined);
  }
  const context = { ...params.context, trigger };
  const inherited = readClaimingHookAdmission(context);
  const assertCurrent = params.assertCurrent
    ? () => {
        inherited?.assertCurrent?.();
        params.assertCurrent?.();
      }
    : inherited?.assertCurrent;
  if (assertCurrent) {
    withClaimingHookAdmission(context, { ...inherited, assertCurrent });
  }
  const run = () =>
    runOncePerAgentRun(params.runId, "before_agent_reply", async () => {
      const hookRunner = getGlobalHookRunner();
      if (!hookRunner?.hasHooks("before_agent_reply", context)) {
        return undefined;
      }
      const observerScope = beforeAgentReplyObserver.getStore();
      // Nested agent runs inherit async context. Bind recovery to the first runner
      // so a hook-spawned child cannot checkpoint its parent's admitted turn.
      const observer =
        observerScope && (!observerScope.runId || observerScope.runId === params.runId)
          ? observerScope
          : undefined;
      if (observer && !observer.runId) {
        observer.runId = params.runId;
      }
      if ((await observer?.beforeDispatch()) === false) {
        return undefined;
      }
      assertCurrent?.();
      params.onDispatch?.();
      assertCurrent?.();
      let result = await hookRunner.runBeforeAgentReply(params.event, context);
      assertCurrent?.();
      if (!result?.handled) {
        params.onDeclined?.();
      }
      assertCurrent?.();
      if (observer) {
        result = await observer.afterDispatch(result);
      }
      assertCurrent?.();
      return result;
    });
  return assertCurrent
    ? withGuardedFetchRequestAuthority(assertCurrent, async () => {
        const result = await run();
        assertCurrent();
        return result;
      })
    : run();
}
