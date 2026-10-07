import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { type HookAgentDispatchPayload, normalizeHookDispatchSessionKey } from "../hooks.js";
import type { HookAgentDispatchResult } from "../hooks.types.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "../server-constants.js";

type PluginHookDispatch = PluginRuntime["hooks"]["dispatchHookAgentTurn"];
type PluginHookDispatchParams = Parameters<PluginHookDispatch>[0];
type PluginHookDispatchResult = Awaited<ReturnType<PluginHookDispatch>>;

export function createPluginHookDispatcher(
  dispatchAgentHook: (
    value: HookAgentDispatchPayload,
    pluginId?: string,
  ) => Promise<HookAgentDispatchResult>,
) {
  const pluginHookReplays = new Map<
    string,
    { createdAt: number; result: Promise<PluginHookDispatchResult> }
  >();
  const dispatchHookAgentTurn = async (
    value: PluginHookDispatchParams,
    pluginId: string,
  ): Promise<PluginHookDispatchResult> => {
    const agentId = normalizeOptionalString(value.agentId);
    if (!agentId) {
      return { ok: false, reason: "agentId is required" };
    }
    const sessionKey = normalizeHookDispatchSessionKey({
      sessionKey: value.sessionKey,
      targetAgentId: agentId,
    });
    if (
      sessionKey !== value.sessionKey ||
      !sessionKey.startsWith("hook:") ||
      sessionKey.length <= 5 ||
      /[\s\p{Cc}]/u.test(sessionKey)
    ) {
      return {
        ok: false,
        reason: "sessionKey must start with hook: and contain no whitespace or control characters",
      };
    }
    if (value.externalContentSource !== "email") {
      return { ok: false, reason: "externalContentSource must be email" };
    }
    const run = async (): Promise<PluginHookDispatchResult> => {
      const result = await dispatchAgentHook(
        {
          name: value.name,
          agentId,
          effectiveAgentId: agentId,
          sessionKey,
          message: value.message,
          deliver: value.deliver,
          model: value.model,
          thinking: value.thinking,
          timeoutSeconds: value.timeoutSeconds,
          idempotencyKey: value.idempotencyKey,
          sessionMode: "isolated",
          sourcePath: `plugin:${pluginId}`,
          wakeMode: "now",
          channel: "last",
          delivery: value.deliver ? { mode: "announce", channel: "last" } : { mode: "none" },
          externalContentSource: "email",
        },
        pluginId,
      );
      return result.ok ? { ok: true, runId: result.runId } : { ok: false, reason: result.error };
    };
    const idempotencyKey = normalizeOptionalString(value.idempotencyKey);
    if (!idempotencyKey) {
      return await run();
    }
    const now = Date.now();
    for (const [key, entry] of pluginHookReplays) {
      if (entry.createdAt < now - DEDUPE_TTL_MS) {
        pluginHookReplays.delete(key);
      }
    }
    const replayKey = JSON.stringify({
      pluginId,
      idempotencyKey,
      name: value.name,
      agentId,
      sessionKey,
      message: value.message,
      externalContentSource: value.externalContentSource,
      deliver: value.deliver,
      model: value.model,
      thinking: value.thinking,
      timeoutSeconds: value.timeoutSeconds,
    });
    const replay = pluginHookReplays.get(replayKey);
    if (replay) {
      return await replay.result;
    }
    const result = run().then(
      (outcome) => {
        if (!outcome.ok) {
          pluginHookReplays.delete(replayKey);
        }
        return outcome;
      },
      (error: unknown) => {
        pluginHookReplays.delete(replayKey);
        throw error;
      },
    );
    pluginHookReplays.set(replayKey, { createdAt: now, result });
    pruneMapToMaxSize(pluginHookReplays, DEDUPE_MAX);
    return await result;
  };

  return dispatchHookAgentTurn;
}
