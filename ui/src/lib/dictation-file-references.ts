export type DictatedFileCommand = {
  start: number;
  end: number;
  query: string;
  kind: "file" | "current";
};

export type DictatedFilePlan = {
  text: string;
  commands: readonly DictatedFileCommand[];
  status: "ready" | "literal" | "unsupported-locale" | "too-large";
};

const MAX_TRANSCRIPT_BYTES = 32 * 1024;
const MAX_COMMANDS = 16;
const MAX_QUERY_BYTES = 2048;

function spokenFilename(value: string): string {
  return value
    .trim()
    .replace(/\s+(?:forward slash|slash)\s+/giu, "/")
    .replace(/\s+backslash\s+/giu, "\\")
    .replace(/\s+dot\s+/giu, ".")
    .replace(/\s+underscore\s+/giu, "_")
    .replace(/\s+(?:dash|hyphen)\s+/giu, "-");
}

/** Offsets are half-open UTF-16 ranges in the original, unmodified transcript. */
export function recognizeDictatedFileReferences(
  text: string,
  options: {
    locale?: string;
    literal?: boolean;
    commandMode?: boolean;
    protectedRanges?: readonly { start: number; end: number }[];
  } = {},
): DictatedFilePlan {
  const result = (status: DictatedFilePlan["status"], commands: DictatedFileCommand[] = []) => ({
    text,
    commands,
    status,
  });
  if (options.literal) {
    return result("literal");
  }
  if (options.locale !== "en-US") {
    return result("unsupported-locale");
  }
  if (new TextEncoder().encode(text).length > MAX_TRANSCRIPT_BYTES) {
    return result("too-large");
  }
  const protectedRanges = [...(options.protectedRanges ?? [])];
  // Quoted/code text and explicit literal scopes are data, even if they contain commands.
  for (const match of text.matchAll(
    /`[^`]*`|"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|\bliteral\b[\s\S]*?(?:\bend literal\b|$)/giu,
  )) {
    protectedRanges.push({ start: match.index, end: match.index + match[0].length });
  }
  const commands: DictatedFileCommand[] = [];
  const pattern = /\breference (file\s+([\s\S]*?)|current file)\s+end reference\b/giu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (protectedRanges.some((range) => start < range.end && end > range.start)) {
      continue;
    }
    const kind = match[1]?.toLowerCase() === "current file" ? "current" : "file";
    const query = kind === "file" ? spokenFilename(match[2] ?? "") : "";
    if (kind === "file" && (!query || new TextEncoder().encode(query).length > MAX_QUERY_BYTES)) {
      continue;
    }
    commands.push({ start, end, query, kind });
    if (commands.length > MAX_COMMANDS) {
      return result("too-large");
    }
  }
  // A separate explicit command control admits the shorthand only as the whole utterance.
  if (options.commandMode && !commands.length && !protectedRanges.length) {
    const shorthand = /^reference (?:file\s+(.+)|current file)$/iu.exec(text.trim());
    if (shorthand) {
      const query = spokenFilename(shorthand[1] ?? "");
      if (new TextEncoder().encode(query).length <= MAX_QUERY_BYTES) {
        const start = text.indexOf(text.trim());
        commands.push({
          start,
          end: start + text.trim().length,
          query,
          kind: query ? "file" : "current",
        });
      }
    }
  }
  return result("ready", commands);
}
