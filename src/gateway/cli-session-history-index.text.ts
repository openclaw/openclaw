// Normalized comparison text for the temporary CLI history index.
// Stored transcript bytes stay unchanged; this view only proves a redundant import.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { readCliImageTurnContext } from "../agents/cli-image-turn-correlation.js";
import { isOpenClawCliImageCachePath } from "../agents/embedded-agent-runner/run/images.media-refs.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import {
  readRoutedPromptView,
  stripCliPromptDecorations,
} from "./cli-session-history.prompt-text.js";

// Claude records CLI-injected @cache-path suffixes as user text. Keep the
// stored content intact; this normalized view is only for proving a redundant
// imported row against the local turn that owns the durable media facts.
function stripTrailingCliImageMentions(text: string): {
  text: string;
  stripped: boolean;
} {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1]?.trim() ?? "";
    if (!line.startsWith("@") || !isOpenClawCliImageCachePath(line.slice(1))) {
      break;
    }
    end -= 1;
  }
  return end === lines.length
    ? { text, stripped: false }
    : { text: lines.slice(0, end).join("\n").trimEnd(), stripped: true };
}

export function extractComparableText(
  record: Record<string, unknown>,
  role: string | undefined,
  imported: boolean,
): {
  hasCliImageMentions: boolean;
  cliImageTurnKey?: string;
  text?: string;
  undecoratedText?: string;
  scopedKey?: string;
  cleanedRoutedKey?: string;
} {
  const parts: string[] = [];
  const text = readStringValue(record.text);
  if (text !== undefined) {
    parts.push(text);
  }
  const rawContent = record.content;
  const content = readStringValue(rawContent);
  if (content !== undefined) {
    parts.push(content);
  } else if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (block && typeof block === "object" && "text" in block) {
        const blockText = readStringValue(block.text);
        if (blockText !== undefined) {
          parts.push(blockText);
        }
      }
    }
  }
  if (parts.length === 0) {
    return { hasCliImageMentions: false };
  }
  const rawText = parts.join("\n");
  const joined = rawText.trim();
  if (!joined) {
    return { hasCliImageMentions: false };
  }
  const meta = asOptionalRecord(record["__openclaw"]);
  const isClaudeImport =
    imported && role === "user" && normalizeOptionalString(meta?.importedFrom) === "claude-cli";
  const stripResult = isClaudeImport
    ? stripTrailingCliImageMentions(joined)
    : { text: joined, stripped: false };
  const normalizeText = (value: string) => {
    const visible = stripInlineDirectiveTagsForDisplay(value).text;
    return visible.replace(/\s+/g, " ").trim();
  };
  const normalized = normalizeText(stripResult.text);
  const withoutDecorations = isClaudeImport ? stripCliPromptDecorations(rawText) : rawText;
  const cleanText = normalizeText(
    role === "user"
      ? stripInboundMetadata(
          isClaudeImport
            ? stripTrailingCliImageMentions(withoutDecorations.trim()).text
            : withoutDecorations,
        )
      : withoutDecorations,
  );
  const undecoratedText = cleanText !== normalized ? cleanText : undefined;
  const routed =
    role === "user" ? readRoutedPromptView(record.provenance, joined, isClaudeImport) : undefined;
  const routedBody =
    routed &&
    normalizeText(
      stripInboundMetadata(
        isClaudeImport ? stripTrailingCliImageMentions(routed.body.trim()).text : routed.body,
      ),
    );
  const originalRoutedBody = routed && normalizeText(routed.originalBody);
  const storedImageTurnKey = normalizeOptionalString(meta?.cliImageTurnKey);
  return {
    hasCliImageMentions: stripResult.stripped,
    ...(stripResult.stripped && isClaudeImport
      ? { cliImageTurnKey: storedImageTurnKey ?? readCliImageTurnContext(joined) }
      : {}),
    ...(normalized ? { text: normalized } : {}),
    ...(undecoratedText && !routed ? { undecoratedText } : {}),
    ...(routed && routedBody && routedBody !== originalRoutedBody
      ? { cleanedRoutedKey: JSON.stringify([routed.sender, routedBody]) }
      : {}),
    // Null scope compares ordinary text; routed bodies retain their sender boundary.
    ...(role === "user" && (routedBody || cleanText)
      ? { scopedKey: JSON.stringify([routed?.sender ?? null, originalRoutedBody ?? cleanText]) }
      : {}),
  };
}
