import {
  ALLOWED_INGEST_HOOKS,
  type AllowedIngestHook,
  type IngestConfig,
} from "../config/ingest-hooks.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookMessageContext, PluginHookMessageReceivedEvent } from "../plugins/hooks.js";

const INGEST_HOOK_TIMEOUT_MS = 5_000;
const MAX_INGEST_INFLIGHT_GLOBAL = 64;
const MAX_INGEST_INFLIGHT_PER_CONVERSATION = 8;

const inflightByConversation = new Map<string, number>();
let inflightGlobal = 0;

function incrementInflight(conversationId: string): void {
  inflightGlobal += 1;
  inflightByConversation.set(conversationId, (inflightByConversation.get(conversationId) ?? 0) + 1);
}

function decrementInflight(conversationId: string): void {
  inflightGlobal = Math.max(0, inflightGlobal - 1);
  const next = Math.max(0, (inflightByConversation.get(conversationId) ?? 1) - 1);
  if (next === 0) {
    inflightByConversation.delete(conversationId);
    return;
  }
  inflightByConversation.set(conversationId, next);
}

function resolveConfiguredIngestHooks(ingest: unknown): AllowedIngestHook[] {
  if (!ingest || typeof ingest !== "object") {
    return [];
  }
  const candidate = ingest as Partial<IngestConfig>;
  if (
    candidate.enabled !== true ||
    !Array.isArray(candidate.hooks) ||
    candidate.hooks.length === 0
  ) {
    return [];
  }
  return candidate.hooks.filter((hook): hook is AllowedIngestHook =>
    ALLOWED_INGEST_HOOKS.includes(hook),
  );
}

export async function dispatchSilentMessageIngest(params: {
  ingest: unknown;
  event: PluginHookMessageReceivedEvent;
  ctx: PluginHookMessageContext;
  channelLabel: string;
  logVerbose: (message: string) => void;
}): Promise<void> {
  const validHooks = resolveConfiguredIngestHooks(params.ingest);
  if (validHooks.length === 0) {
    return;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner) {
    return;
  }

  const conversationId = params.ctx.conversationId;
  if (!conversationId) {
    return;
  }

  const convInflight = inflightByConversation.get(conversationId) ?? 0;
  if (inflightGlobal >= MAX_INGEST_INFLIGHT_GLOBAL) {
    params.logVerbose(
      `${params.channelLabel}: ingest skipped (global inflight cap reached ${MAX_INGEST_INFLIGHT_GLOBAL})`,
    );
    return;
  }
  if (convInflight >= MAX_INGEST_INFLIGHT_PER_CONVERSATION) {
    params.logVerbose(
      `${params.channelLabel}: ingest skipped for ${conversationId} (conversation inflight cap reached ${MAX_INGEST_INFLIGHT_PER_CONVERSATION})`,
    );
    return;
  }

  for (const pluginId of validHooks) {
    if (!hookRunner.hasHooksForPlugin("message_ingest", pluginId)) {
      params.logVerbose(
        `${params.channelLabel}: ingest plugin "${pluginId}" not registered, skipping`,
      );
      continue;
    }

    incrementInflight(conversationId);
    const runPromise = hookRunner
      .runMessageIngestForPlugin(pluginId, params.event, params.ctx)
      .finally(() => decrementInflight(conversationId));

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("Hook timeout")), INGEST_HOOK_TIMEOUT_MS);
    });

    void Promise.race([runPromise, timeoutPromise])
      .catch((err: unknown) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        params.logVerbose(`${params.channelLabel}: ingest hook "${pluginId}" failed: ${errorMsg}`);
      })
      .finally(() => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
      });
  }
}
