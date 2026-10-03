// Default CLI dependency surface with lazy outbound channel send adapters.
import { normalizeChatChannelId } from "../channels/registry.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import type { CliDeps } from "./deps.types.js";
import type { RuntimeSendOpts } from "./send-runtime/channel-outbound-send.js";

export type { CliDeps } from "./deps.types.js";
const loadSendRuntime = createLazyPromise(() => import("./send-runtime/channel-outbound-send.js"));

const NON_CHANNEL_DEP_KEYS = new Set([
  "__proto__",
  "constructor",
  "cron",
  "cronConfig",
  "cronEnabled",
  "captureSessionEventTarget",
  "defaultAgentId",
  "deferSessionEvent",
  "enqueueSessionEvent",
  "getQueueSize",
  "hasOwnProperty",
  "inspect",
  "isExecutionIdle",
  "log",
  "migrateOrphanedSessionKeys",
  "nowMs",
  "onEvent",
  "resolveSessionEventTarget",
  "resolveSessionStorePath",
  "resolveUserTimezone",
  "runIsolatedAgentJob",
  "runSessionEvent",
  "runtime",
  "sendCronFailureAlert",
  "sessionStorePath",
  "storePath",
  "then",
  "toJSON",
  "toString",
  "valueOf",
]);

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
      return async (to: string, text: string, opts?: RuntimeSendOpts) =>
        await (await loadSendRuntime()).sendChannelOutboundMessage(channelId, to, text, opts);
    },
  });
}

export { createOutboundSendDeps } from "./outbound-send-deps.js";
