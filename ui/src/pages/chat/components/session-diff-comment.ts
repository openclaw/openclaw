import type { ChatSelectionSource } from "../../../lib/chat/chat-types.ts";

/** Ignore gutters and reject selections mixing revisions or crossing omitted rows. */
export function readDiffCommentSelection(
  root: HTMLElement,
  path: string,
  oldPath?: string,
): { selection: ChatSelectionSource; range: Range } | undefined {
  const selected = root.ownerDocument.getSelection();
  if (!selected || selected.isCollapsed || selected.rangeCount !== 1) {
    return undefined;
  }
  const range = selected.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return undefined;
  }
  const cells: HTMLElement[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof HTMLElement && node.dataset.commentLine !== undefined) {
      cells.push(node);
    }
  }
  const included = cells.filter((cell) => range.intersectsNode(cell));
  if (!included.length) {
    return undefined;
  }
  const side = included[0]!.dataset.commentSide === "old" ? "old" : "new";
  const startLine = Number(included[0]!.dataset.commentLine);
  if (
    included.some(
      (cell, index) =>
        cell.dataset.commentSide !== side || Number(cell.dataset.commentLine) !== startLine + index,
    )
  ) {
    return undefined;
  }
  const text = included
    .map((cell) => {
      const part = range.cloneRange();
      if (!cell.contains(part.startContainer)) {
        part.setStart(cell, 0);
      }
      if (!cell.contains(part.endContainer)) {
        part.setEnd(cell, cell.childNodes.length);
      }
      return part.toString();
    })
    .join("\n");
  if (!text.trim()) {
    return undefined;
  }
  return {
    selection: {
      text,
      start: 0,
      end: text.length,
      file: {
        path: side === "old" ? (oldPath ?? path) : path,
        startLine,
        endLine: startLine + included.length - 1,
        side,
      },
    },
    range: range.cloneRange(),
  };
}
