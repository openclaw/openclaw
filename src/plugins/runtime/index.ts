import { createRequire } from "node:module";

import { chunkMarkdownText, resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { buildMentionRegexes, matchesMentionPatterns } from "../../auto-reply/reply/mentions.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ReplyDispatchKind, ReplyDispatcherWithTypingOptions } from "../../auto-reply/reply/reply-dispatcher.js";
import { dispatchReplyWithBufferedBlockDispatcher as dispatchReplyWithBufferedBlockDispatcherImpl } from "../../auto-reply/reply/provider-dispatcher.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { resolveEffectiveMessagesConfig, resolveHumanDelayConfig } from "../../agents/identity.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { GroupPolicyChannel } from "../../config/group-policy.js";
import { resolveChannelGroupPolicy, resolveChannelGroupRequireMention } from "../../config/group-policy.js";
import { resolveStateDir } from "../../config/paths.js";
import { shouldLogVerbose } from "../../globals.js";
import { getChildLogger } from "../../logging.js";
import { normalizeLogLevel } from "../../logging/levels.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { saveMediaBuffer } from "../../media/store.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";

import type { PluginRuntime } from "./types.js";

let cachedVersion: string | null = null;

function resolveVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
    return cachedVersion;
  } catch {
    cachedVersion = "unknown";
    return cachedVersion;
  }
}

export function createPluginRuntime(): PluginRuntime {
  return {
    version: resolveVersion(),
    channel: {
      text: {
        chunkMarkdownText,
        resolveTextChunkLimit,
        hasControlCommand,
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (params) => {
          const dispatcherOptions = params.dispatcherOptions;
          const deliver = async (payload: ReplyPayload, _info: { kind: ReplyDispatchKind }) => {
            await dispatcherOptions.deliver(payload);
          };
          const onError = dispatcherOptions.onError
            ? (err: unknown, info: { kind: ReplyDispatchKind }) => {
                dispatcherOptions.onError?.(err, { kind: info.kind });
              }
            : undefined;

          await dispatchReplyWithBufferedBlockDispatcherImpl({
            ctx: params.ctx as FinalizedMsgContext,
            cfg: params.cfg as ClawdbotConfig,
            dispatcherOptions: {
              deliver,
              onError,
            } satisfies ReplyDispatcherWithTypingOptions,
          });
        },
        createReplyDispatcherWithTyping: (...args) =>
          createReplyDispatcherWithTyping(args[0] as ReplyDispatcherWithTypingOptions),
        resolveEffectiveMessagesConfig,
        resolveHumanDelayConfig,
      },
      routing: {
        resolveAgentRoute: (params) => {
          const resolved = resolveAgentRoute({
            cfg: params.cfg as ClawdbotConfig,
            channel: params.channel,
            accountId: params.accountId,
            peer: params.peer,
          });
          return { sessionKey: resolved.sessionKey, accountId: resolved.accountId };
        },
      },
      pairing: {
        buildPairingReply,
        readAllowFromStore: readChannelAllowFromStore,
        upsertPairingRequest: upsertChannelPairingRequest,
      },
      media: {
        fetchRemoteMedia,
        saveMediaBuffer: async (buffer, contentType, direction, maxBytes) => {
          const saved = await saveMediaBuffer(
            Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
            contentType,
            direction,
            maxBytes,
          );
          return { path: saved.path, contentType: saved.contentType };
        },
      },
      mentions: {
        buildMentionRegexes,
        matchesMentionPatterns,
      },
      groups: {
        resolveGroupPolicy: (cfg, channel, accountId, groupId) =>
          resolveChannelGroupPolicy({
            cfg,
            channel: channel as GroupPolicyChannel,
            accountId,
            groupId,
          }),
        resolveRequireMention: (cfg, channel, accountId, groupId, override) =>
          resolveChannelGroupRequireMention({
            cfg,
            channel: channel as GroupPolicyChannel,
            accountId,
            groupId,
            requireMentionOverride: override,
          }),
      },
      debounce: {
        createInboundDebouncer: (opts) => {
          const keys = new Set<string>();
          const debouncer = createInboundDebouncer({
            debounceMs: opts.debounceMs,
            buildKey: opts.buildKey,
            shouldDebounce: opts.shouldDebounce ?? (() => true),
            onFlush: opts.onFlush,
            onError: opts.onError ? (err: unknown) => opts.onError?.(err) : undefined,
          });
          return {
            push: (value) => {
              const key = opts.buildKey(value);
              if (key) keys.add(key);
              void debouncer.enqueue(value);
            },
            flush: async () => {
              const flushKeys = Array.from(keys);
              keys.clear();
              for (const key of flushKeys) await debouncer.flushKey(key);
            },
          };
        },
        resolveInboundDebounceMs: (cfg, channel) => resolveInboundDebounceMs({ cfg, channel }),
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers,
      },
    },
    logging: {
      shouldLogVerbose,
      getChildLogger: (bindings, opts) => {
        const logger = getChildLogger(bindings, {
          level: opts?.level ? normalizeLogLevel(opts.level) : undefined,
        });
        return {
          debug: (message) => logger.debug?.(message),
          info: (message) => logger.info(message),
          warn: (message) => logger.warn(message),
          error: (message) => logger.error(message),
        };
      },
    },
    state: {
      resolveStateDir: () => resolveStateDir(),
    },
  };
}

export type { PluginRuntime } from "./types.js";
