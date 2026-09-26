// Default CLI dependency surface with lazy outbound channel send adapters.
import { normalizeChatChannelId } from "../channels/registry.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import type { CliDeps } from "./deps.types.js";

export type { CliDeps } from "./deps.types.js";
type RuntimeSend = ReturnType<
  typeof import("./send-runtime/channel-outbound-send.js").createChannelOutboundRuntimeSend
>;

const NON_CHANNEL_DEP_KEYS = new Set([
  "__proto__",
  "constructor",
  "cron",
  "cronConfig",
  "cronEnabled",
  "defaultAgentId",
  "enqueueSystemEvent",
  "getQueueSize",
  "hasOwnProperty",
  "inspect",
  "log",
  "migrateOrphanedSessionKeys",
  "nowMs",
  "onEvent",
  "requestHeartbeat",
  "resolveSessionStorePath",
  "runHeartbeatOnce",
  "runIsolatedAgentJob",
  "runtime",
  "sendCronFailureAlert",
  "sessionStorePath",
  "storePath",
  "then",
  "toJSON",
  "toString",
  "valueOf",
]);

const senderCache = new Map<string, Promise<RuntimeSend>>();

function createLazySender(channelId: string): RuntimeSend["sendMessage"] {
  return async (...args) => {
    const runtimeSend = await getOrCreatePromise(
      senderCache,
      channelId,
      async () => {
        const { createChannelOutboundRuntimeSend } =
          await import("./send-runtime/channel-outbound-send.js");
        return createChannelOutboundRuntimeSend({
          channelId,
          unavailableMessage: `${channelId} outbound adapter is unavailable.`,
        });
      },
      { cacheRejections: false },
    );
    return await runtimeSend.sendMessage(...args);
  };
}

export function createDefaultDeps(): CliDeps {
  // Proxy lookup preserves the historic deps.channelName shape without eagerly importing plugins.
  const deps: CliDeps = {};
  return new Proxy(deps, {
    get(target, property, receiver) {
      if (typeof property !== "string") {
        return Reflect.get(target, property, receiver);
      }
      const existing = Reflect.get(target, property, receiver);
      if (existing !== undefined || NON_CHANNEL_DEP_KEYS.has(property)) {
        return existing;
      }
      const channelId = normalizeChatChannelId(property);
      if (!channelId) {
        return existing;
      }
      // Synthesized senders re-enter the full channel adapter. Keep them off the
      // enumerable target so transport dependency mapping cannot inject them back into it.
      return createLazySender(channelId);
    },
  });
}

export { createOutboundSendDeps } from "./outbound-send-deps.js";
