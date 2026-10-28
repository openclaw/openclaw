import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { extractCanvasShortcodes } from "../../../../src/chat/canvas-render.js";
import type { ChatItem, MessageGroup, NormalizedMessage } from "../../lib/chat/chat-types.ts";
import {
  canvasPreviewsMatch,
  readCanvasContentPreview,
  normalizeRoleForGrouping,
} from "../../lib/chat/message-normalizer.ts";
import type { CanvasToolPreview } from "../../lib/chat/tool-cards.ts";
import { canvasPreviewBaseIdentity, hasRenderableNormalizedMessage } from "./chat-thread-items.ts";
import { transcriptRunId } from "./chat-thread-run-identity.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { copyLiveTerminalIdentity, readLiveTerminalRunId } from "./terminal-message-identity.ts";

export function canvasAssistantItemKey(
  message: unknown,
  source: Parameters<typeof canvasPreviewBaseIdentity>[1],
  fallback: string,
): string {
  const identity = canvasPreviewBaseIdentity(message, source);
  return identity ? `canvas:${identity}` : `${fallback}:canvas`;
}

export function collectCanvasTurns(
  historyItems: Array<Extract<ChatItem, { kind: "message" }>>,
  normalizedHistory: Array<NormalizedMessage | null>,
  matchesSearch: (message: unknown) => boolean,
) {
  let canvasTurn: {
    previews: { preview: CanvasToolPreview; item: (typeof historyItems)[number] }[];
    lastMatchingAssistantIndex: number;
  } = {
    previews: [],
    lastMatchingAssistantIndex: -1,
  };
  // Rows in one turn share these facts so a tool result can see the assistant
  // projection that follows it, without consuming a view from another turn.
  return historyItems.map((item, index) => {
    const message = normalizedHistory[index];
    const role = message && normalizeRoleForGrouping(message.role);
    if (role === "user" || role === "system") {
      canvasTurn = { previews: [], lastMatchingAssistantIndex: -1 };
    }
    if (role === "assistant" && message && matchesSearch(item.message)) {
      canvasTurn.lastMatchingAssistantIndex = index;
      canvasTurn.previews.push(
        ...message.content.flatMap((block) =>
          block.type === "canvas" ? [{ preview: block.preview, item }] : [],
        ),
      );
    }
    return canvasTurn;
  });
}

function collectMessageCanvasPreviews(messages: readonly unknown[]) {
  return messages.flatMap((source) => {
    if (readLiveTerminalRunId(source)) {
      return [];
    }
    const runId = transcriptRunId(source);
    const message = runId ? safeNormalizeMessage(source) : null;
    // Assistant rows can carry tools; normalization classifies those as tool results.
    // Canvas rendering still follows their source role.
    const sourceRole = asRecord(source)?.role;
    if (
      !message ||
      normalizeRoleForGrouping(typeof sourceRole === "string" ? sourceRole : message.role) !==
        "assistant"
    ) {
      return [];
    }
    return message.content.flatMap((block) =>
      block.type === "canvas" ? [{ runId, preview: block.preview }] : [],
    );
  });
}

export function collectOwnedCanvasPreviews(items: readonly (ChatItem | MessageGroup)[]) {
  return collectMessageCanvasPreviews(
    items.flatMap((item) =>
      item.kind === "group"
        ? item.messages.map((entry) => entry.message)
        : item.kind === "message"
          ? [item.message]
          : [],
    ),
  );
}

export function stripOwnedCanvasShortcodes(
  text: string,
  runId: string | null | undefined,
  ownedCanvas: ReturnType<typeof collectOwnedCanvasPreviews>,
): string {
  if (ownedCanvas.length === 0) {
    return text;
  }
  return extractCanvasShortcodes(text, (preview) =>
    ownedCanvas.some(
      (entry) => entry.runId === runId && canvasPreviewsMatch(entry.preview, preview),
    ),
  ).text;
}

function projectTerminalCanvasMessage(
  source: unknown,
  ownedCanvas: ReturnType<typeof collectOwnedCanvasPreviews>,
): unknown {
  const runId = readLiveTerminalRunId(source);
  const terminal = runId ? asRecord(source) : null;
  if (!terminal) {
    return source;
  }
  const sourceContent =
    typeof terminal.content === "string"
      ? [{ type: "text", text: terminal.content }]
      : terminal.content;
  if (!Array.isArray(sourceContent)) {
    return source;
  }
  const isOwned = (preview: Pick<CanvasToolPreview, "viewId" | "url">) =>
    ownedCanvas.some(
      (entry) => entry.runId === runId && canvasPreviewsMatch(entry.preview, preview),
    );
  let changed = false;
  const content = sourceContent.flatMap((value) => {
    const preview = readCanvasContentPreview(value);
    if (preview && isOwned(preview)) {
      changed = true;
      return [];
    }
    const block = asRecord(value);
    if (block?.type === "text" && typeof block.text === "string") {
      const extracted = extractCanvasShortcodes(block.text, isOwned);
      if (extracted.previews.length > 0) {
        changed = true;
        return [{ ...block, text: extracted.text }];
      }
    }
    return [value];
  });
  if (!changed) {
    return source;
  }
  const projection = { ...terminal, content };
  copyLiveTerminalIdentity(terminal, projection);
  return projection;
}

/** Apply the same display projection before a snapshot loses the live run identity. */
export function reconcileTerminalCanvasMessages(messages: unknown[]): unknown[] {
  const ownedCanvas = collectMessageCanvasPreviews(messages);
  let changed = false;
  const projected = messages.flatMap((message) => {
    const next = projectTerminalCanvasMessage(message, ownedCanvas);
    if (next === message) {
      return [message];
    }
    changed = true;
    return hasRenderableNormalizedMessage(next) ? [next] : [];
  });
  return changed ? projected : messages;
}

/** Reconcile live copies after the owned previews and stream rows have been placed. */
export function reconcileLiveCanvasPreviews(
  items: ChatItem[],
  hiddenHistoryKeys: ReadonlySet<string>,
  hiddenInputKeys: ReadonlySet<string>,
): ChatItem[] {
  const ownedCanvas = collectOwnedCanvasPreviews(
    items.filter((item) => !hiddenHistoryKeys.has(item.key) && !hiddenInputKeys.has(item.key)),
  );
  for (const item of items) {
    if (item.kind === "stream") {
      item.text = stripOwnedCanvasShortcodes(item.text, item.runId, ownedCanvas);
    } else if (item.kind === "message") {
      item.message = projectTerminalCanvasMessage(item.message, ownedCanvas);
    }
  }
  return items.filter((item) =>
    item.kind === "stream"
      ? Boolean(item.text.trim() || item.thinking)
      : item.kind !== "message" || hasRenderableNormalizedMessage(item.message),
  );
}
