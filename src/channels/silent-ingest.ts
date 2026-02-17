import type { HookRunner } from "../plugins/hooks.js";
import type { PluginHookMessageContext, PluginHookMessageReceivedEvent } from "../plugins/types.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { sanitizeUserText } from "../utils/sanitize.js";

type InflightKey = string;

const ingestInflight = new Map<InflightKey, number>();
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_INFLIGHT = 64;

function makeInflightKey(ctx: PluginHookMessageContext): InflightKey {
  return `${ctx.channelId}:${ctx.accountId ?? ""}:${ctx.conversationId}`;
}

function incrementInflight(key: InflightKey): number {
  const next = (ingestInflight.get(key) ?? 0) + 1;
  ingestInflight.set(key, next);
  return next;
}

function decrementInflight(key: InflightKey): void {
  const next = (ingestInflight.get(key) ?? 1) - 1;
  if (next <= 0) {
    ingestInflight.delete(key);
    return;
  }
  ingestInflight.set(key, next);
}

export async function runSilentMessageIngest(params: {
  enabled: boolean;
  event: PluginHookMessageReceivedEvent;
  ctx: PluginHookMessageContext;
  timeoutMs?: number;
  maxInflight?: number;
  hookRunner?: HookRunner | null;
  log: (message: string) => void;
  logPrefix: string;
}): Promise<boolean> {
  const content = params.event.content?.trim();
  if (!params.enabled || !content) {
    return false;
  }

  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_ingest")) {
    return false;
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxInflight = params.maxInflight ?? DEFAULT_MAX_INFLIGHT;
  const inflightKey = makeInflightKey(params.ctx);
  const inflight = incrementInflight(inflightKey);
  if (inflight > maxInflight) {
    decrementInflight(inflightKey);
    params.log(`${params.logPrefix}: ingest skipped (too many inflight hooks: ${inflight})`);
    return false;
  }

  const safeFrom = sanitizeUserText(params.event.from, 256) ?? "unknown";
  const event: PluginHookMessageReceivedEvent = {
    ...params.event,
    from: safeFrom,
    content,
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<void>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Hook timeout")), timeoutMs);
    });

    await Promise.race([hookRunner.runMessageIngest(event, params.ctx), timeoutPromise]);
    return true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    params.log(`${params.logPrefix}: ingest hook failed: ${errorMsg}`);
    return false;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    decrementInflight(inflightKey);
  }
}
