import { html, nothing } from "lit";
import "./chat-attribution.css";
import { resolveLocalUserName } from "../../../app/user-identity.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { MessageGroup, NormalizedMessage } from "../../../lib/chat/chat-types.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { formatSenderLabel, type SenderIdentity } from "../../../lib/chat/sender-label.ts";
import { persistedMessageEntryId } from "../chat-thread.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { renderReplyConnector } from "./chat-reply-connector.ts";
import type { ReplyPreview, ReplyPreviewLookup } from "./chat-reply-preview.types.ts";

/**
 * One "Replying to" line. `hidden` renders nothing, `reserved` keeps an
 * invisible row while the lookup that can fill it runs, `named` shows the
 * author, and `unavailable` is the placeholder for a missing original (after
 * the snapshot's sender name, when it has one).
 */
export type ReplyLine = {
  state: "hidden" | "reserved" | "named" | "unavailable";
  name?: string;
  sender?: SenderIdentity;
  agentAvatar?: ReplyPreview["agentAvatar"];
  /** The original the name navigates to, loaded or not. */
  openId?: string;
};

export const NO_REPLY_LINE: ReplyLine = { state: "hidden" };

type ReplyContext = Pick<MessageGroup, "replyShared" | "replyTurnSource" | "runId">;

function foundPreview(result: ReturnType<ReplyPreviewLookup>) {
  return result && !("pending" in result || "missing" in result || "oversized" in result)
    ? result
    : undefined;
}

/** A known original: a transcript row the thread already names (automatic or resolved current). */
function resolveSource(
  source: unknown,
  sender: SenderIdentity | undefined,
  lookup: ReplyPreviewLookup | undefined,
): ReplyLine {
  const id = source ? (persistedMessageEntryId(source) ?? undefined) : undefined;
  const preview = id ? foundPreview(lookup?.(id)) : undefined;
  const author = sender ?? preview?.sender;
  const name = preview?.senderLabel || formatSenderLabel(author);
  return name
    ? {
        state: "named",
        name,
        sender: { ...author, name },
        agentAvatar: preview?.agentAvatar,
        openId: id,
      }
    : NO_REPLY_LINE;
}

/** An explicit `replyToId`: never guesses its author; a lookup settles it in place. */
function resolveTarget(
  id: string,
  snapshot: NormalizedMessage["replyPreview"],
  lookup: ReplyPreviewLookup | undefined,
  context?: ReplyContext,
): ReplyLine {
  const result = lookup?.(id);
  const preview = foundPreview(result);
  const oversized = Boolean(result && "oversized" in result);
  // Reserve the row only when the answer can fill it: a 1:1 turn whose prompt
  // is not loaded may be answering that prompt, which stays hidden. Only the
  // fetched original's run ownership can settle that, never a snapshot.
  const reserves = !context || Boolean(context.replyShared || context.replyTurnSource);
  const known = (reserves && snapshot?.senderLabel) || "";
  // A missing original, or an oversized one nothing names, keeps its reserved
  // row as a placeholder: known snapshot facts only, no avatar or link.
  if ((result && "missing" in result) || (reserves && !known && oversized)) {
    return reserves ? { state: "unavailable", name: known } : NO_REPLY_LINE;
  }
  // A source without sender provenance keeps its neutral label in a 1:1 thread;
  // shared, only its snapshot can name it. A shared sender with an id but no
  // name keeps the snapshot's name before its raw id, never the viewer fallback.
  const sender = preview?.sender;
  const label = preview?.senderLabel || formatSenderLabel(sender) || "";
  const idOnly =
    Boolean(sender) &&
    !sender?.name?.trim() &&
    !sender?.username?.trim() &&
    (label === formatSenderLabel(sender) || label === resolveLocalUserName());
  const name =
    (!preview
      ? known
      : !context?.replyShared
        ? label
        : !sender
          ? known
          : idOnly
            ? known || formatSenderLabel(sender)
            : label) || "";
  // A 1:1 turn answering its own prompt adds nothing, even with the prompt paged out.
  const ownPrompt =
    context &&
    !context.replyShared &&
    ((context.replyTurnSource && persistedMessageEntryId(context.replyTurnSource.message) === id) ||
      (context.runId && preview?.turnRunId === context.runId) ||
      // Without the turn's prompt, an original with no author or run may be that prompt.
      (!context.replyTurnSource && preview && !preview.sender && !preview.turnRunId));
  if (name && !ownPrompt) {
    return {
      state: "named",
      name,
      sender: { ...sender, name },
      agentAvatar: preview?.agentAvatar,
      openId: id,
    };
  }
  if (preview || name) {
    return NO_REPLY_LINE;
  }
  return {
    state: result && "pending" in result && reserves ? "reserved" : "hidden",
  };
}

/** A message's own target: a participant's reply, or your own inside its bubble. */
export function resolveMessageReplyLine(
  message: NormalizedMessage,
  lookup: ReplyPreviewLookup | undefined,
  userId: string | null | undefined,
  shared: boolean | undefined,
): ReplyLine {
  const target = message.replyTarget;
  // A bare reply_to_current names no origin outside its turn context.
  if (target?.kind !== "id") {
    return NO_REPLY_LINE;
  }
  const line = resolveTarget(
    target.id,
    message.replyPreview,
    lookup,
    shared ? { replyShared: true } : undefined,
  );
  const identity = line.sender?.identity;
  if (identity?.type === "profile" && identity.id === userId) {
    line.name = resolveLocalUserName();
  }
  return line;
}

/**
 * An assistant group's line. Only the group's own messages carry the target (a
 * frame passes its final answer's group); `replyMessages` lends their snapshots.
 */
export function resolveGroupReplyLine(
  group: ReplyContext &
    Pick<
      MessageGroup,
      "role" | "messages" | "replyCurrentSource" | "replyToSender" | "replyToMessage"
    >,
  lookup?: ReplyPreviewLookup,
  replyMessages: MessageGroup["messages"] = group.messages,
): ReplyLine {
  if (group.role !== "assistant") {
    return NO_REPLY_LINE;
  }
  const targets = group.messages.map(({ message }) => normalizeMessage(message).replyTarget);
  const explicit = targets.find((target) => target?.kind === "id");
  if (explicit?.kind === "id") {
    const previews = replyMessages
      .map(({ message }) => normalizeMessage(message))
      .filter(({ replyTarget }) => replyTarget?.kind === "id" && replyTarget.id === explicit.id)
      .map(({ replyPreview }) => replyPreview);
    // Prefer a snapshot that names its sender: the name alone paints the line.
    const snapshot =
      previews.find((preview) => preview?.text && preview.senderLabel) ??
      previews.find((preview) => preview?.senderLabel) ??
      previews.find(Boolean);
    return resolveTarget(explicit.id, snapshot, lookup, group);
  }
  if (targets.some((target) => target?.kind === "current")) {
    // reply_to_current resolves only through the prompt that started this run,
    // never the latest prompt; in 1:1 its own turn's prompt adds nothing.
    const source = group.replyCurrentSource;
    const sender = source && normalizeMessage(source.message).sender;
    return source &&
      (sender || !group.replyShared) &&
      (group.replyShared || source.key !== group.replyTurnSource?.key)
      ? resolveSource(source.message, sender, lookup)
      : NO_REPLY_LINE;
  }
  // Automatic attribution: several people share this thread.
  return group.replyToSender
    ? resolveSource(group.replyToMessage?.message, group.replyToSender, lookup)
    : NO_REPLY_LINE;
}

type ReplyLineActions = {
  onOpenReply?: (id: string) => void;
  replyNavigationId?: string | null;
};

/**
 * `inline` renders inside the message bubble; otherwise the line sits above
 * the message beside its avatar. The name navigates to any known original,
 * loaded or not; a missing one stays plain text.
 */
export function renderReplyLine(
  line: ReplyLine,
  { onOpenReply, replyNavigationId }: ReplyLineActions,
  inline = false,
) {
  if (line.state === "hidden") {
    return nothing;
  }
  const rowClass = `chat-reply-attribution chat-reply-attribution--${inline ? "inline" : "reply"}`;
  const label = html`<span class="chat-reply-attribution__label"
    >${inline ? nothing : html`<span class="chat-reply-attribution__mobile-icon" aria-hidden="true">${icons.cornerUpLeft}</span>`}${t("chat.messages.replyingToLabel")}</span
  >`;
  // An in-flight lookup keeps the row so the answer fills it in place.
  if (line.state === "reserved") {
    return html`<div class="${rowClass} chat-reply-attribution--pending" aria-hidden="true">
      ${label}
    </div>`;
  }
  const { name = "", openId } = line;
  const named = line.state === "named";
  const loading = Boolean(openId) && replyNavigationId === openId;
  const person = html`
    ${named ? renderChatAuthorAvatar(line.sender, undefined, line.agentAvatar) : nothing}
    <span class="chat-reply-attribution__name" title=${name}>${name}</span>
  `;
  return html`<div class=${rowClass}>
    ${label}
    ${
      named && openId && onOpenReply
        ? html`<button
            class="chat-reply-attribution__person chat-reply-attribution__target"
            type="button"
            aria-label=${t("chat.messages.replyingTo", { name })}
            ?disabled=${loading}
            aria-busy=${loading ? "true" : "false"}
            @click=${() => onOpenReply(openId)}
          >
            ${person}
          </button>`
        : name
          ? html`<span class="chat-reply-attribution__person">${person}</span>`
          : nothing
    }
    ${
      named
        ? nothing
        : html`<span class="chat-reply-attribution__unavailable"
            >${t("chat.messages.replyOriginalUnavailable")}</span
          >`
    }
  </div>`;
}

/** Beside an avatar, a shown line draws a connector from it. */
export function renderReplyLineConnector(line: ReplyLine, avatar: unknown) {
  return avatar !== nothing && (line.state === "named" || line.state === "unavailable")
    ? renderReplyConnector()
    : nothing;
}
