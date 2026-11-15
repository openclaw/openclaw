import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { findMarkdownCodeSpans } from "../../packages/markdown-core/src/markdown-code-regions.js";
import { decodeRequesterOrigin } from "../agents/requester-origin.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelDisplayMention } from "../channels/plugins/types.core.js";
import { escapeHtml } from "../shared/html-escape.js";
import { readCanonicalUserChannelIdentityProfileId } from "../state/user-channel-identity-operations.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

const MAX_LINK_LOOKUPS = 20;

function readDisplayMentionsOutsideCode(
  text: string,
  parse: (text: string) => readonly ChannelDisplayMention[],
) {
  const code = findMarkdownCodeSpans(text);
  return parse(text).filter(
    (ref) => !code.some(([start, end]) => ref.start < end && ref.end > start),
  );
}

function readChannelMentionSource(value: unknown) {
  const message = asOptionalRecord(value);
  const metadata = asOptionalRecord(message?.["__openclaw"]);
  const origin = decodeRequesterOrigin(metadata?.requesterOrigin);
  const transport = asOptionalRecord(metadata?.transport);
  const channelId = transport?.channel;
  const accountId = origin
    ? origin.messageProvider === channelId
      ? origin.accountId
      : undefined
    : transport?.accountId;
  const provenance = asOptionalRecord(message?.provenance);
  // These are captured source facts, never text or the mutable session reply route.
  if (
    message?.role !== "user" ||
    message.display === false ||
    (provenance && provenance.kind !== "external_user") ||
    typeof channelId !== "string" ||
    typeof accountId !== "string" ||
    !accountId ||
    (Array.isArray(metadata?.humanMentions) && metadata.humanMentions.length > 0)
  ) {
    return undefined;
  }
  const parse = getChannelPlugin(channelId)?.mentions?.readDisplayMentions;
  if (!parse) {
    return undefined;
  }
  return { message, channelId, accountId, parse };
}

/** Shared live fanout must defer person labels to each reader's authorized history view. */
export function requiresChannelMentionDisplayRead(value: unknown): boolean {
  const source = readChannelMentionSource(value);
  if (!source) {
    return false;
  }
  const content = source.message.content;
  if (typeof content === "string") {
    return readDisplayMentionsOutsideCode(content, source.parse).length > 0;
  }
  return (
    Array.isArray(content) &&
    content.some((part) => {
      const block = asOptionalRecord(part);
      return (
        block?.type === "text" &&
        typeof block.text === "string" &&
        readDisplayMentionsOutsideCode(block.text, source.parse).length > 0
      );
    })
  );
}

/** A presentation snapshot only: no transcript writes, recipients, or authority. */
export function createChannelMentionProjector(
  context: Pick<GatewayRequestContext, "mentionInbox">,
  client: GatewayClient | null,
  sessionKey: string,
) {
  return {
    project: async (messages: unknown[]): Promise<unknown[]> => {
      const reads = new Map<string, Promise<string | undefined>>();
      let profiles = new Map<string, string | undefined>();
      const names = new Map<string, string>();
      const render = messages.map((value): (() => unknown) => {
        const source = readChannelMentionSource(value);
        if (!source) {
          return () => value;
        }
        const { message, channelId, accountId, parse } = source;
        const prepareText = (text: string) => {
          const refs = readDisplayMentionsOutsideCode(text, parse).map((ref) => {
            const key = JSON.stringify([channelId, accountId, ref.senderId]);
            if (!reads.has(key) && reads.size < MAX_LINK_LOOKUPS) {
              reads.set(
                key,
                readCanonicalUserChannelIdentityProfileId({
                  channelId,
                  accountId,
                  senderId: ref.senderId,
                }),
              );
            }
            return { ref, key };
          });
          return () => {
            let displayed = text;
            for (const { ref, key } of refs.toReversed()) {
              const profileId = profiles.get(key);
              const label = (profileId ? names.get(profileId) : undefined) ?? ref.fallbackLabel;
              if (label) {
                // The label is literal text even when it contains HTML or Markdown.
                const literal = "@" + escapeHtml(label.replace(/[\\`*_{}[\]()#+.!|~-]/gu, "\\$&"));
                displayed = displayed.slice(0, ref.start) + literal + displayed.slice(ref.end);
              }
            }
            return displayed;
          };
        };
        const content = message.content;
        if (typeof content === "string") {
          const display = prepareText(content);
          return () => {
            const text = display();
            return text === content ? value : { ...message, content: text };
          };
        }
        if (!Array.isArray(content)) {
          return () => value;
        }
        const parts = content.map((part) => {
          const block = asOptionalRecord(part);
          if (block?.type !== "text" || typeof block.text !== "string") {
            return () => part;
          }
          const display = prepareText(block.text);
          return () => {
            const text = display();
            return text === block.text ? part : { ...block, text };
          };
        });
        return () => {
          const blocks = parts.map((display) => display());
          return blocks.every((part, index) => part === content[index])
            ? value
            : { ...message, content: blocks };
        };
      });
      if (!reads.size) {
        return messages;
      }
      profiles = new Map(
        await Promise.all([...reads].map(async ([key, read]) => [key, await read] as const)),
      );
      const profileIds = [
        ...new Set([...profiles.values()].filter((id): id is string => Boolean(id))),
      ];
      // The directory owner checks this viewer and session. This read does not record
      // involvement or notify anyone; an invisible/unlinked person keeps the source fallback.
      if (profileIds.length && context.mentionInbox) {
        await context.mentionInbox.mentionable(
          client,
          { sessionKey },
          (result) => {
            if (result.ok) {
              for (const user of result.value.users) {
                names.set(user.profileId, user.displayName);
              }
            }
            return undefined;
          },
          profileIds,
        );
      }
      return render.map((display) => display());
    },
  };
}
