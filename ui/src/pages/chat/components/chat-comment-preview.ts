export type CommentPreview = { text: string; comment: string };

/** Rendered selection length disambiguates headings without assuming DOM offsets include line breaks. */
export function parseCommentAttachment(value: string): CommentPreview | null {
  const footer =
    /\n\nSource session: [^\n]+\n(?:Source message: [^\n]+\n)?(?:Source entry: [^\n]+\n)?(?:Selected text UTF-16 length: (\d+)\n)?DOM text UTF-16 range: \[(\d+), (\d+)\)$/.exec(
      value,
    );
  const prefix = "Selected text:\n";
  if (!footer || !value.startsWith(prefix)) {
    return null;
  }
  const start = Number(footer[2]);
  const end = Number(footer[3]);
  // Previously sent files only recorded the DOM span; keep their validated boundary.
  const length = footer[1] === undefined ? end - start : Number(footer[1]);
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
  return { text, comment: rest ? rest.slice(commentPrefix.length) : "" };
}
