import type { ChatFileSelection, ChatSelectionSource } from "../../../lib/chat/chat-types.ts";

export type CommentPreview = {
  text: string;
  comment: string;
  file?: ChatFileSelection;
  pdf?: ChatSelectionSource["pdf"];
};

/** Rendered selection length disambiguates headings without assuming DOM offsets include line breaks. */
export function parseCommentAttachment(value: string): CommentPreview | null {
  const footer =
    /\n\nSource session: [^\n]+\n(?:Source message: [^\n]+\n)?(?:Source entry: [^\n]+\n)?(?:Source file: ("(?:[^"\\]|\\.)*")\nSource lines: (\d+)-(\d+)\n(?:Source diff side: (old|new)\n)?)?(?:Source PDF: ("(?:[^"\\]|\\.)*")\nSource page: (\d+)\n)?(?:Selected text UTF-16 length: (\d+)\n)?DOM text UTF-16 range: \[(\d+), (\d+)\)$/.exec(
      value,
    );
  const prefix = "Selected text:\n";
  if (!footer || !value.startsWith(prefix)) {
    return null;
  }
  const start = Number(footer[8]);
  const end = Number(footer[9]);
  // Previously sent files only recorded the DOM span; keep their validated boundary.
  const length = footer[7] === undefined ? end - start : Number(footer[7]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    !Number.isSafeInteger(length) ||
    length <= 0
  ) {
    return null;
  }
  const body = value.slice(prefix.length, footer.index);
  const text = body.slice(0, length);
  const rest = body.slice(length);
  const commentPrefix = "\n\nUser comment:\n";
  if (text.length !== length || (rest && !rest.startsWith(commentPrefix))) {
    return null;
  }
  let file: ChatFileSelection | undefined;
  if (footer[1] !== undefined) {
    const startLine = Number(footer[2]);
    const endLine = Number(footer[3]);
    if (
      !Number.isSafeInteger(startLine) ||
      startLine < 1 ||
      !Number.isSafeInteger(endLine) ||
      endLine < startLine
    ) {
      return null;
    }
    let path: unknown;
    try {
      path = JSON.parse(footer[1]);
    } catch {
      return null;
    }
    if (typeof path !== "string") {
      return null;
    }
    const side = footer[4];
    file = { path, startLine, endLine, ...(side === "old" || side === "new" ? { side } : {}) };
  }
  let pdf: ChatSelectionSource["pdf"];
  if (footer[5] !== undefined) {
    const page = Number(footer[6]);
    let name: unknown;
    try {
      name = JSON.parse(footer[5]);
    } catch {
      return null;
    }
    if (typeof name !== "string" || !Number.isSafeInteger(page) || page < 1) {
      return null;
    }
    pdf = { name, page };
  }
  return {
    text,
    comment: rest ? rest.slice(commentPrefix.length) : "",
    ...(file ? { file } : {}),
    ...(pdf ? { pdf } : {}),
  };
}
