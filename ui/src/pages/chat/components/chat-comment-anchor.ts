import type { ChatSelectionSource } from "../../../lib/chat/chat-types.ts";

/** Resolve the saved DOM text offsets without changing the transcript's text nodes. */
export function resolveChatCommentAnchor(root: HTMLElement, source: ChatSelectionSource) {
  const bubble = Array.from(root.querySelectorAll<HTMLElement>(".chat-bubble")).find((element) =>
    source.entryId
      ? element.dataset.entryId === source.entryId
      : Boolean(source.messageId) && element.dataset.messageId === source.messageId,
  );
  if (!bubble) {
    return null;
  }
  const walker = bubble.ownerDocument.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    if (walker.currentNode instanceof Text) {
      nodes.push(walker.currentNode);
    }
  }
  const range = bubble.ownerDocument.createRange();
  let offset = 0;
  let started = false;
  let ended = false;
  for (const node of nodes) {
    const next = offset + node.length;
    if (!started && source.start >= offset && source.start <= next) {
      range.setStart(node, source.start - offset);
      started = true;
    }
    if (started && source.end >= offset && source.end <= next) {
      range.setEnd(node, source.end - offset);
      ended = true;
      break;
    }
    offset = next;
  }
  // Rendered selections include line breaks that DOM Range text can omit. Never
  // pin a stale offset to different content after a message is replaced.
  if (!ended || range.toString().replace(/\s/gu, "") !== source.text.replace(/\s/gu, "")) {
    return null;
  }
  return { bubble, range, nodes };
}

export function chatCommentLineEnd(
  anchor: NonNullable<ReturnType<typeof resolveChatCommentAnchor>>,
) {
  const rect = Array.from(anchor.range.getClientRects()).findLast(
    (item) => item.width && item.height,
  );
  if (!rect) {
    return null;
  }
  let right = rect.right;
  const line = anchor.bubble.ownerDocument.createRange();
  for (const node of anchor.nodes) {
    if (!node.textContent?.trim()) {
      continue;
    }
    line.selectNodeContents(node);
    for (const part of line.getClientRects()) {
      if (Math.abs(part.top - rect.top) < Math.min(part.height, rect.height) / 2) {
        right = Math.max(right, part.right);
      }
    }
  }
  return { right, top: rect.top, height: rect.height };
}
