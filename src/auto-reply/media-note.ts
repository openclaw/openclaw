import type { MsgContext } from "./templating.js";

const MAX_LINE_WIDTH = 80; // Most conservative value, covers all standard terminals
const MAX_TYPE_LEN = 20; // Defensive limit for typePart

/**
 * Truncate path while preserving filename.
 * Handles both Unix (/) and Windows (\) separators.
 */
function truncatePath(path: string, maxLen: number): string {
  // Edge case: very small maxLen
  if (maxLen <= 10) return "...";
  if (path.length <= maxLen) return path;

  // Find last separator (/ or \)
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (lastSlash > 0) {
    const filename = path.slice(lastSlash + 1);
    const dirPart = path.slice(0, lastSlash);
    const available = maxLen - filename.length - 4; // ".../" = 4 chars

    // Only use this strategy if we can show meaningful dir prefix
    if (available >= 10 && filename.length < maxLen - 10) {
      const sep = path[lastSlash] === "\\" ? "\\" : "/";
      return dirPart.slice(0, available) + "..." + sep + filename;
    }
  }

  // Fallback: simple truncation (ensure positive slice)
  const sliceLen = Math.max(1, maxLen - 3);
  return path.slice(0, sliceLen) + "...";
}

function formatMediaAttachedLine(params: {
  path: string;
  url?: string;
  type?: string;
  index?: number;
  total?: number;
}): string {
  const prefix =
    typeof params.index === "number" && typeof params.total === "number"
      ? `[media attached ${params.index}/${params.total}: `
      : "[media attached: ";

  // Truncate type if abnormally long (defensive)
  let typeStr = params.type?.trim() ?? "";
  if (typeStr.length > MAX_TYPE_LEN) {
    typeStr = typeStr.slice(0, MAX_TYPE_LEN - 3) + "...";
  }
  const typePart = typeStr ? ` (${typeStr})` : "";
  const urlRaw = params.url?.trim();

  // Fixed parts: prefix + typePart + "]"
  const fixedLen = prefix.length + typePart.length + 1;
  const available = MAX_LINE_WIDTH - fixedLen;

  // Guard: if no space at all, return minimal output
  if (available <= 10) {
    return `${prefix}...${typePart}]`;
  }

  // Strategy 1: Try to keep full path, truncate/omit URL
  if (params.path.length <= available) {
    // Path fits! Now check if we can include URL
    const urlSpace = available - params.path.length - 3; // " | " = 3 chars
    if (urlRaw && urlSpace >= 20) {
      const truncatedUrl =
        urlRaw.length <= urlSpace ? urlRaw : urlRaw.slice(0, urlSpace - 3) + "...";
      return `${prefix}${params.path}${typePart} | ${truncatedUrl}]`;
    }
    // Path fits, no room for URL
    return `${prefix}${params.path}${typePart}]`;
  }

  // Strategy 2: Path too long, must truncate. No URL.
  const truncatedPath = truncatePath(params.path, available);
  return `${prefix}${truncatedPath}${typePart}]`;
}

export function buildInboundMediaNote(ctx: MsgContext): string | undefined {
  // Attachment indices follow MediaPaths/MediaUrls ordering as supplied by the channel.
  const suppressed = new Set<number>();
  if (Array.isArray(ctx.MediaUnderstanding)) {
    for (const output of ctx.MediaUnderstanding) {
      suppressed.add(output.attachmentIndex);
    }
  }
  if (Array.isArray(ctx.MediaUnderstandingDecisions)) {
    for (const decision of ctx.MediaUnderstandingDecisions) {
      if (decision.outcome !== "success") {
        continue;
      }
      for (const attachment of decision.attachments) {
        if (attachment.chosen?.outcome === "success") {
          suppressed.add(attachment.attachmentIndex);
        }
      }
    }
  }
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : ctx.MediaPath?.trim()
        ? [ctx.MediaPath.trim()]
        : [];
  if (paths.length === 0) {
    return undefined;
  }

  const urls =
    Array.isArray(ctx.MediaUrls) && ctx.MediaUrls.length === paths.length
      ? ctx.MediaUrls
      : undefined;
  const types =
    Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length
      ? ctx.MediaTypes
      : undefined;

  const entries = paths
    .map((entry, index) => ({
      path: entry ?? "",
      type: types?.[index] ?? ctx.MediaType,
      url: urls?.[index] ?? ctx.MediaUrl,
      index,
    }))
    .filter((entry) => !suppressed.has(entry.index));
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    return formatMediaAttachedLine({
      path: entries[0]?.path ?? "",
      type: entries[0]?.type,
      url: entries[0]?.url,
    });
  }

  const count = entries.length;
  const lines: string[] = [`[media attached: ${count} files]`];
  for (const [idx, entry] of entries.entries()) {
    lines.push(
      formatMediaAttachedLine({
        path: entry.path,
        index: idx + 1,
        total: count,
        type: entry.type,
        url: entry.url,
      }),
    );
  }
  return lines.join("\n");
}
