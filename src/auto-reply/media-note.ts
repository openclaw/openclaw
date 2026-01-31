import path from "node:path";
import type { MsgContext } from "./templating.js";

const MAX_DISPLAY_PATH_LEN = 80;

function truncatePath(filePath: string, maxLen: number = MAX_DISPLAY_PATH_LEN): string {
  if (filePath.length <= maxLen) return filePath;
  const basename = path.basename(filePath);
  if (basename.length >= maxLen - 3) {
    // If basename alone is too long, truncate from the middle
    const half = Math.floor((maxLen - 3) / 2);
    return `${basename.slice(0, half)}...${basename.slice(-half)}`;
  }
  // Keep basename and truncate directory portion
  const remaining = maxLen - basename.length - 4; // 4 for ".../"
  if (remaining <= 0) return `.../${basename}`;
  const dir = path.dirname(filePath);
  return `${dir.slice(0, remaining)}.../${basename}`;
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
  const typePart = params.type?.trim() ? ` (${params.type.trim()})` : "";
  const urlRaw = params.url?.trim();
  // Truncate long paths to prevent TUI rendering issues
  const displayPath = truncatePath(params.path);
  const displayUrl = urlRaw ? truncatePath(urlRaw) : undefined;
  const urlPart = displayUrl ? ` | ${displayUrl}` : "";
  return `${prefix}${displayPath}${typePart}${urlPart}]`;
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
