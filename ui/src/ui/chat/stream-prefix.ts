export type ChatStreamSegment = { text: string; ts: number };

export function committedStreamPrefix(segments: ChatStreamSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

export function trimCommittedStreamPrefix(
  stream: string,
  segments: ChatStreamSegment[] | undefined,
): string {
  if (!segments?.length) {
    return stream;
  }
  const prefix = committedStreamPrefix(segments);
  if (!prefix || !stream.startsWith(prefix)) {
    return stream;
  }
  return stream.slice(prefix.length);
}
