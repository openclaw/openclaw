import type { ReplyPayload } from "../../auto-reply/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { createIMessageRpcClient } from "../client.js";
import { chunkTextWithMode, resolveChunkMode } from "../../auto-reply/chunk.js";
import { loadConfig } from "../../config/config.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { sendMessageIMessage } from "../send.js";

type SentMessageCache = {
  remember: (scope: string, text: string) => void;
};

const VISIBLE_UNTRUSTED_METADATA_BLOCK_RE =
  /(?:^|\n)(?:(?:user|system|assistant)\s*:\s*)?(?:Conversation info \(untrusted metadata\):|Sender \(untrusted metadata\):|Thread starter \(untrusted, for context\):|Replied message \(untrusted, for context\):|Forwarded message context \(untrusted metadata\):|Chat history since last reply \(untrusted, for context\):|Location \(untrusted metadata\):)\n```json\n[\s\S]*?\n```(?=\n|$)/g;

export function stripVisibleUntrustedMetadataBlocks(text: string): string {
  if (!text) {
    return text;
  }
  return text
    .replace(VISIBLE_UNTRUSTED_METADATA_BLOCK_RE, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  client: Awaited<ReturnType<typeof createIMessageRpcClient>>;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
  sentMessageCache?: SentMessageCache;
}) {
  const { replies, target, client, runtime, maxBytes, textLimit, accountId, sentMessageCache } =
    params;
  const scope = `${accountId ?? ""}:${target}`;
  const cfg = loadConfig();
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "imessage",
    accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "imessage", accountId);
  for (const payload of replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const rawText = stripVisibleUntrustedMetadataBlocks(payload.text ?? "");
    const text = convertMarkdownTables(rawText, tableMode);
    if (!text && mediaList.length === 0) {
      continue;
    }
    if (mediaList.length === 0) {
      sentMessageCache?.remember(scope, text);
      for (const chunk of chunkTextWithMode(text, textLimit, chunkMode)) {
        await sendMessageIMessage(target, chunk, {
          maxBytes,
          client,
          accountId,
        });
        sentMessageCache?.remember(scope, chunk);
      }
    } else {
      let first = true;
      for (const url of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageIMessage(target, caption, {
          mediaUrl: url,
          maxBytes,
          client,
          accountId,
        });
        if (caption) {
          sentMessageCache?.remember(scope, caption);
        }
      }
    }
    runtime.log?.(`imessage: delivered reply to ${target}`);
  }
}
