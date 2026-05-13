import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";
import { formatGatewaySummary, formatOutboundDeliverySummary } from "../infra/outbound/format.js";
import type { MessageActionRunResult } from "../infra/outbound/message-action-runner.js";
import { formatTargetDisplay } from "../infra/outbound/target-resolver.js";
import { hasNonEmptyString, normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { isRich, theme } from "../terminal/theme.js";
import { shortenText } from "./text-format.js";

const resolveChannelLabel = (channel: ChannelId) =>
  getLoadedChannelPlugin(channel)?.meta.label ?? channel;

function extractMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const direct = (payload as { messageId?: unknown }).messageId;
  const directId = normalizeOptionalString(direct);
  if (directId) {
    return directId;
  }
  const result = (payload as { result?: unknown }).result;
  if (result && typeof result === "object") {
    const nested = (result as { messageId?: unknown }).messageId;
    const nestedId = normalizeOptionalString(nested);
    if (nestedId) {
      return nestedId;
    }
  }
  return null;
}

type FormatOpts = {
  width: number;
  displayLimit?: number;
};

const DEFAULT_MESSAGE_LIST_LIMIT = 25;

function renderObjectSummary(payload: unknown, opts: FormatOpts): string[] {
  if (!payload || typeof payload !== "object") {
    return [String(payload)];
  }
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return [theme.muted("(empty)")];
  }

  const rows = keys.slice(0, 20).map((k) => {
    const v = obj[k];
    const value =
      v == null
        ? "null"
        : Array.isArray(v)
          ? `${v.length} items`
          : typeof v === "object"
            ? "object"
            : typeof v === "string"
              ? v
              : typeof v === "number"
                ? String(v)
                : typeof v === "boolean"
                  ? v
                    ? "true"
                    : "false"
                  : typeof v === "bigint"
                    ? v.toString()
                    : typeof v === "symbol"
                      ? v.toString()
                      : typeof v === "function"
                        ? "function"
                        : "unknown";
    return { Key: k, Value: shortenText(value, 96) };
  });
  return [
    renderTable({
      width: opts.width,
      columns: [
        { key: "Key", header: "Key", minWidth: 16 },
        { key: "Value", header: "Value", flex: true, minWidth: 24 },
      ],
      rows,
    }).trimEnd(),
  ];
}

type ListRenderResult = {
  lines: string[];
  total: number;
  displayed: number;
  limit: number;
};

function renderMessageList(
  messages: unknown[],
  opts: FormatOpts,
  emptyLabel: string,
): ListRenderResult {
  const limit = opts.displayLimit ?? DEFAULT_MESSAGE_LIST_LIMIT;
  const total = messages.length;
  const displayed = Math.min(total, limit);
  const rows = messages.slice(0, displayed).map((m) => {
    const msg = m as Record<string, unknown>;
    const id =
      (typeof msg.id === "string" && msg.id) ||
      (typeof msg.ts === "string" && msg.ts) ||
      (typeof msg.messageId === "string" && msg.messageId) ||
      "";
    const authorObj = msg.author as Record<string, unknown> | undefined;
    const author =
      (typeof msg.authorTag === "string" && msg.authorTag) ||
      (typeof authorObj?.username === "string" && authorObj.username) ||
      (typeof msg.user === "string" && msg.user) ||
      "";
    const time =
      (typeof msg.timestamp === "string" && msg.timestamp) ||
      (typeof msg.ts === "string" && msg.ts) ||
      "";
    const text =
      (typeof msg.content === "string" && msg.content) ||
      (typeof msg.text === "string" && msg.text) ||
      "";
    return {
      Time: shortenText(time, 28),
      Author: shortenText(author, 22),
      Text: shortenText(text.replace(/\s+/g, " ").trim(), 90),
      Id: shortenText(id, 22),
    };
  });

  if (rows.length === 0) {
    return { lines: [theme.muted(emptyLabel)], total, displayed, limit };
  }

  return {
    lines: [
      renderTable({
        width: opts.width,
        columns: [
          { key: "Time", header: "Time", minWidth: 14 },
          { key: "Author", header: "Author", minWidth: 10 },
          { key: "Text", header: "Text", flex: true, minWidth: 24 },
          { key: "Id", header: "Id", minWidth: 10 },
        ],
        rows,
      }).trimEnd(),
    ],
    total,
    displayed,
    limit,
  };
}

function renderMessagesFromPayload(payload: unknown, opts: FormatOpts): ListRenderResult | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return null;
  }
  return renderMessageList(messages, opts, "No messages.");
}

function renderPinsFromPayload(payload: unknown, opts: FormatOpts): ListRenderResult | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const pins = (payload as { pins?: unknown }).pins;
  if (!Array.isArray(pins)) {
    return null;
  }
  return renderMessageList(pins, opts, "No pins.");
}

function renderPaginationHint(payload: unknown, rendered: ListRenderResult): string | null {
  const { displayed, total, limit } = rendered;
  if (total > displayed) {
    return `Showing ${displayed} of ${total}; raise --limit to see more`;
  }
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const hasCursor =
      p.hasMore === true ||
      hasNonEmptyString(p.nextBatch) ||
      hasNonEmptyString(p["@odata.nextLink"]);
    if (hasCursor) {
      return "More results available beyond this page; use --json for the raw cursor";
    }
  }
  // Heuristic: a full page implies older history may exist beyond it
  if (displayed > 0 && displayed === limit) {
    return `Reached --limit (${limit}); raise it to fetch older history if any`;
  }
  return null;
}

function extractDiscordSearchResultsMessages(results: unknown): unknown[] | null {
  if (!results || typeof results !== "object") {
    return null;
  }
  const raw = (results as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) {
    return null;
  }
  // Discord search returns messages as array-of-array; first element is the message.
  const flattened: unknown[] = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length > 0) {
      flattened.push(entry[0]);
    } else if (entry && typeof entry === "object") {
      flattened.push(entry);
    }
  }
  return flattened.length ? flattened : null;
}

function renderReactions(payload: unknown, opts: FormatOpts): string[] | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const reactions = (payload as { reactions?: unknown }).reactions;
  if (!Array.isArray(reactions)) {
    return null;
  }

  const rows = reactions.slice(0, 50).map((r) => {
    const entry = r as Record<string, unknown>;
    const emojiObj = entry.emoji as Record<string, unknown> | undefined;
    const emoji =
      (typeof emojiObj?.raw === "string" && emojiObj.raw) ||
      (typeof entry.name === "string" && entry.name) ||
      (typeof entry.emoji === "string" && entry.emoji) ||
      "";
    const count = typeof entry.count === "number" ? String(entry.count) : "";
    const userList = Array.isArray(entry.users)
      ? (entry.users as unknown[])
          .slice(0, 8)
          .map((u) => {
            if (typeof u === "string") {
              return u;
            }
            if (!u || typeof u !== "object") {
              return "";
            }
            const user = u as Record<string, unknown>;
            return (
              (typeof user.tag === "string" && user.tag) ||
              (typeof user.username === "string" && user.username) ||
              (typeof user.id === "string" && user.id) ||
              ""
            );
          })
          .filter(Boolean)
      : [];
    return {
      Emoji: emoji,
      Count: count,
      Users: shortenText(userList.join(", "), 72),
    };
  });

  if (rows.length === 0) {
    return [theme.muted("No reactions.")];
  }

  return [
    renderTable({
      width: opts.width,
      columns: [
        { key: "Emoji", header: "Emoji", minWidth: 8 },
        { key: "Count", header: "Count", align: "right", minWidth: 6 },
        { key: "Users", header: "Users", flex: true, minWidth: 20 },
      ],
      rows,
    }).trimEnd(),
  ];
}

export type FormatMessageCliTextOpts = {
  displayLimit?: number;
};

export function formatMessageCliText(
  result: MessageActionRunResult,
  textOpts: FormatMessageCliTextOpts = {},
): string[] {
  const rich = isRich();
  const ok = (text: string) => (rich ? theme.success(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);
  const heading = (text: string) => (rich ? theme.heading(text) : text);

  const width = getTerminalTableWidth();
  const opts: FormatOpts = { width, displayLimit: textOpts.displayLimit };

  if (result.handledBy === "dry-run") {
    return [muted(`[dry-run] would run ${result.action} via ${result.channel}`)];
  }

  if (result.kind === "broadcast") {
    const results = result.payload.results ?? [];
    const rows = results.map((entry) => ({
      Channel: resolveChannelLabel(entry.channel),
      Target: shortenText(formatTargetDisplay({ channel: entry.channel, target: entry.to }), 36),
      Status: entry.ok ? "ok" : "error",
      Error: entry.ok ? "" : shortenText(entry.error ?? "unknown error", 48),
    }));
    const okCount = results.filter((entry) => entry.ok).length;
    const total = results.length;
    const headingLine = ok(
      `✅ Broadcast complete (${okCount}/${total} succeeded, ${total - okCount} failed)`,
    );
    return [
      headingLine,
      renderTable({
        width: opts.width,
        columns: [
          { key: "Channel", header: "Channel", minWidth: 10 },
          { key: "Target", header: "Target", minWidth: 12, flex: true },
          { key: "Status", header: "Status", minWidth: 6 },
          { key: "Error", header: "Error", minWidth: 20, flex: true },
        ],
        rows: rows.slice(0, 50),
      }).trimEnd(),
    ];
  }

  if (result.kind === "send") {
    if (result.handledBy === "core" && result.sendResult) {
      const send = result.sendResult;
      if (send.via === "direct") {
        const directResult = send.result as OutboundDeliveryResult | undefined;
        return [ok(formatOutboundDeliverySummary(send.channel, directResult))];
      }
      const gatewayResult = send.result as { messageId?: string } | undefined;
      return [
        ok(
          formatGatewaySummary({
            channel: send.channel,
            messageId: gatewayResult?.messageId ?? null,
          }),
        ),
      ];
    }

    const label = resolveChannelLabel(result.channel);
    const msgId = extractMessageId(result.payload);
    return [ok(`✅ Sent via ${label}.${msgId ? ` Message ID: ${msgId}` : ""}`)];
  }

  if (result.kind === "poll") {
    if (result.handledBy === "core" && result.pollResult) {
      const poll = result.pollResult;
      const pollId = (poll.result as { pollId?: string } | undefined)?.pollId;
      const msgId = poll.result?.messageId ?? null;
      const lines = [
        ok(
          formatGatewaySummary({
            action: "Poll sent",
            channel: poll.channel,
            messageId: msgId,
          }),
        ),
      ];
      if (pollId) {
        lines.push(ok(`Poll id: ${pollId}`));
      }
      return lines;
    }

    const label = resolveChannelLabel(result.channel);
    const msgId = extractMessageId(result.payload);
    return [ok(`✅ Poll sent via ${label}.${msgId ? ` Message ID: ${msgId}` : ""}`)];
  }

  // channel actions (non-send/poll)
  const payload = result.payload;
  const lines: string[] = [];

  if (result.action === "react") {
    const added = (payload as { added?: unknown }).added;
    const removed = (payload as { removed?: unknown }).removed;
    if (typeof added === "string" && added.trim()) {
      lines.push(ok(`✅ Reaction added: ${added.trim()}`));
      return lines;
    }
    if (typeof removed === "string" && removed.trim()) {
      lines.push(ok(`✅ Reaction removed: ${removed.trim()}`));
      return lines;
    }
    if (Array.isArray(removed)) {
      const list = normalizeStringEntries(removed).join(", ");
      lines.push(ok(`✅ Reactions removed${list ? `: ${list}` : ""}`));
      return lines;
    }
    lines.push(ok("✅ Reaction updated."));
    return lines;
  }

  const reactionsTable = renderReactions(payload, opts);
  if (reactionsTable && result.action === "reactions") {
    lines.push(heading("Reactions"));
    lines.push(reactionsTable[0] ?? "");
    return lines;
  }

  const pushSection = (rendered: ListRenderResult, headingText: string): string[] => {
    lines.push(heading(headingText));
    lines.push(rendered.lines[0] ?? "");
    const hint = renderPaginationHint(payload, rendered);
    if (hint) {
      lines.push(muted(hint));
    }
    return lines;
  };

  if (result.action === "read") {
    const rendered = renderMessagesFromPayload(payload, opts);
    if (rendered) {
      return pushSection(rendered, "Messages");
    }
  }

  if (result.action === "list-pins") {
    const rendered = renderPinsFromPayload(payload, opts);
    if (rendered) {
      return pushSection(rendered, "Pinned messages");
    }
  }

  if (result.action === "search") {
    const results = (payload as { results?: unknown }).results;
    const list = extractDiscordSearchResultsMessages(results);
    if (list) {
      return pushSection(renderMessageList(list, opts, "No results."), "Search results");
    }
  }

  // Generic success + compact details table.
  lines.push(ok(`✅ ${result.action} via ${resolveChannelLabel(result.channel)}.`));
  const summary = renderObjectSummary(payload, opts);
  if (summary.length) {
    lines.push("");
    lines.push(...summary);
    lines.push("");
    lines.push(muted("Tip: use --json for full output."));
  }
  return lines;
}
