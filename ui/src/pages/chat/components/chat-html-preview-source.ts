export type HtmlPreviewEdit = { start: number; end: number; text: string };

export function applyHtmlPreviewEdits(source: string, edits: HtmlPreviewEdit[]): string {
  let position = 0;
  const parts: string[] = [];
  // Recovery can duplicate elements; whole-element edits supersede their attributes.
  const unique = new Map(edits.map((edit) => [edit.start, edit]));
  for (const edit of [...unique.values()].toSorted((a, b) => a.start - b.start)) {
    if (edit.start < position) {
      continue;
    }
    parts.push(source.slice(position, edit.start), edit.text);
    position = edit.end;
  }
  parts.push(source.slice(position));
  return parts.join("");
}
