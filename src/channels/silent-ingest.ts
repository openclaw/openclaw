import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { HookRunner } from "../plugins/hooks.js";
import type { PluginHookMessageContext, PluginHookMessageReceivedEvent } from "../plugins/types.js";
import { sanitizeUserText } from "../utils/sanitize.js";

type InflightKey = string;

const ingestInflight = new Map<InflightKey, number>();
let ingestInflightGlobal = 0;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_INFLIGHT = 64;
const DEFAULT_MAX_GLOBAL_INFLIGHT = 256;
const DEFAULT_CONTENT_MAX_LENGTH = 8192;

function makeInflightKey(ctx: PluginHookMessageContext): InflightKey {
  return `${ctx.channelId}:${ctx.accountId ?? ""}:${ctx.conversationId}`;
}

function incrementInflight(key: InflightKey): { local: number; global: number } {
  const local = (ingestInflight.get(key) ?? 0) + 1;
  ingestInflight.set(key, local);
  ingestInflightGlobal += 1;
  return { local, global: ingestInflightGlobal };
}

function decrementInflight(key: InflightKey): void {
  const next = (ingestInflight.get(key) ?? 1) - 1;
  if (next <= 0) {
    ingestInflight.delete(key);
  } else {
    ingestInflight.set(key, next);
  }
  ingestInflightGlobal = Math.max(0, ingestInflightGlobal - 1);
}

export async function runSilentMessageIngest(params: {
  enabled: boolean;
  event: PluginHookMessageReceivedEvent;
  ctx: PluginHookMessageContext;
  timeoutMs?: number;
  maxInflight?: number;
  maxGlobalInflight?: number;
  hookRunner?: HookRunner | null;
  log: (message: string) => void;
  logPrefix: string;
}): Promise<boolean> {
  const content = sanitizeUserText(params.event.content, DEFAULT_CONTENT_MAX_LENGTH);
  if (!params.enabled || !content) {
    return false;
  }

  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_ingest")) {
    return false;
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxInflight = params.maxInflight ?? DEFAULT_MAX_INFLIGHT;
  const maxGlobalInflight = params.maxGlobalInflight ?? DEFAULT_MAX_GLOBAL_INFLIGHT;
  const inflightKey = makeInflightKey(params.ctx);
  const inflight = incrementInflight(inflightKey);
  if (inflight.local > maxInflight) {
    decrementInflight(inflightKey);
    params.log(
      `${params.logPrefix}: ingest skipped (too many inflight hooks in conversation: ${inflight.local})`,
    );
    return false;
  }
  if (inflight.global > maxGlobalInflight) {
    decrementInflight(inflightKey);
    params.log(
      `${params.logPrefix}: ingest skipped (too many inflight hooks globally: ${inflight.global})`,
    );
    return false;
  }

  const safeFrom = sanitizeUserText(params.event.from, 256) ?? "unknown";
  const event: PluginHookMessageReceivedEvent = {
    ...params.event,
    from: safeFrom,
    content,
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const trackedHook = hookRunner
    .runMessageIngest(event, params.ctx)
    .then(() => ({ ok: true as const }))
    .catch((err) => ({ ok: false as const, err }))
    .finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      decrementInflight(inflightKey);
    });

  const timeoutPromise = new Promise<{ ok: false; timeout: true }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ ok: false, timeout: true }), timeoutMs);
  });

  const result = await Promise.race([trackedHook, timeoutPromise]);
  if ("timeout" in result) {
    params.log(
      `${params.logPrefix}: ingest hook timed out while waiting (hook may still complete in background)`,
    );
    return false;
  }
  if (!result.ok) {
    const errorMsg = result.err instanceof Error ? result.err.message : "Unknown error";
    params.log(`${params.logPrefix}: ingest hook failed: ${errorMsg}`);
    return false;
  }
  return true;
}
