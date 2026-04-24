import fs from "node:fs/promises";
import path from "node:path";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";

/**
 * Strip chat-template tokens, housekeeping conventions, and other model-output
 * artifacts that must not be persisted to session memory files.
 *
 * Artifacts removed:
 * - Chat-template control tokens: <|im_start|>, <|im_end|>, </s>, <|eot_id|>,
 *   <|end_of_text|>, and similar
 * - Housekeeping tokens: NO_REPLY, NO_REPLY_TOKENS, and variants
 * - Metadata markers: [AUDIO_AS_VOICE], [MEDIA:...], reply_to_current / reply_to:...
 * - Thinking/reasoning blocks: <reasoning>, </reasoning>, <think>, </think> and variants
 * - Tool-call XML blocks: <tool_call>...</tool_call>, <tool-result>...</tool-result>
 * - RAG markers: <<[Document...]>>, <retrieved_context>, <!--.doc--> etc.
 * - Orphaned role markers: user:, assistant:, system: at line start
 * - System instruction leakage: lines starting with ## System, ## Instructions, etc.
 */
export function sanitizeModelOutput(rawText: string): string {
  if (!rawText || typeof rawText !== "string") {
    return "";
  }

  let text = rawText;

  // ── 1. Chat-template control tokens ────────────────────────────────────────
  // These appear in quantized / chat-tuned model output that has not been
  // post-processed by the model's inference stack.
  const templateTokens = [
    "<|im_start|>",
    "<|im_end|>",
    "<|im_sep|>",
    "<|end_of_turn|>",
    "<|eot_id|>",
    "<|end_of_text|>",
    "<|reserved_", // <|reserved_xxx|> — prefix match below
    "[REMOVED_SPECIAL_TOKEN]",
    "</s>",
    "<s>",
    "<TOOL_CALL>",
    "</TOOL_CALL>",
    "<|message|>",
    "<|batch|>",
  ];
  for (const token of templateTokens) {
    if (token === "<|reserved_") {
      // Prefix match for <|reserved_xxx|>
      text = text.replace(/<\|reserved_[^|>]*\|>/gi, "");
    } else {
      text = text.split(token).join("");
    }
  }

  // ── 2. NO_REPLY and housekeeping tokens ───────────────────────────────────
  // Remove all variants regardless of case or word boundaries. This is safe
  // because NO_REPLY is an in-band control token that should never appear in
  // legitimate assistant output.
  text = text.replace(/NO_REPLY/gi, "");
  text = text.replace(/NO_REPLY_TOKENS/gi, "");
  text = text.replace(/\[NO_REPLY[_\s]*(TOKEN|COUNT)?[^\]]*\]/gi, "");
  text = text.replace(/\[AUDIO_AS_VOICE\]/gi, "");
  text = text.replace(/\[MEDIA:[^\]]*\]/g, "");
  text = text.replace(/\[reply_to[_:]?(current|[\w-]+)\]/gi, "");

  // ── 3. Thinking / reasoning blocks ─────────────────────────────────────────
  // Replace with "" (empty string) rather than " " so that runs of newlines
  // collapse naturally in step 8. Do NOT replace with a space.
  text = text.replace(/<(reasoning|think|thought|reflection)[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<(reasoning|think|thought|reflection)[^>]*\/>/gi, "");
  // Also strip markdown-style ## reasoning/think/thought sections that some
  // models emit (standalone header + continuation lines).
  text = text.replace(
    /##\s*(reasoning|thought|thinking|reflection)\s*\n[\s\S]*?(?=^##\s|^\*\*|\n\d+\.|$)/gim,
    "",
  );

  // ── 4. Tool-call XML blocks ────────────────────────────────────────────────
  text = text.replace(/<tool_call\s+name=[^>]*>[\s\S]*?<\/tool_call>/gi, "");
  text = text.replace(/<tool-call\s+name=[^>]*>[\s\S]*?<\/tool-call>/gi, "");
  text = text.replace(/<tool-result\s+id=[^>]*>[\s\S]*?<\/tool-result>/gi, "");
  text = text.replace(/<tool_call\s*\/>/gi, "");
  text = text.replace(/<tool-call\s*\/>/gi, "");
  text = text.replace(/<\/tool_call>/gi, "");
  text = text.replace(/<\/tool-call>/gi, "");

  // ── 5. RAG / retrieved-context markers ─────────────────────────────────────
  text = text.replace(/<<\[Document[^\]]*\]>>/g, "");
  text = text.replace(/<retrieved_context[\s\S]*?<\/retrieved_context>/gi, "");
  text = text.replace(/<!--\.doc[^>]*-->/gi, "");
  text = text.replace(/\[DOCUMENT[\s\S]*?\]/gi, "");

  // ── 6. Orphaned role markers at line start ────────────────────────────────
  // Model sometimes drops role Begin/End markers but leaves a stray prefix.
  // Handles both `role:` (with colon) and `role\n` (role followed by newline,
  // which happens when <|im_start|>role gets split and role is left orphaned).
  text = text.replace(/^\s*(user|assistant|system|tool)\s*:[\s\S]*?$/gim, "");
  text = text.replace(/^\s*(user|assistant|system|tool)\s*$/gim, "");

  // ── 7. System instruction leakage ──────────────────────────────────────────
  // Strips ## System/Instructions/... blocks. Two structural patterns:
  //   (a) indented continuation lines (header + indented content + trailing blank)
  //   (b) non-indented content (header + all following lines until blank or end)
  // Use [ \t]+ (not \s+) after ## to avoid consuming the newline as whitespace.
  // The lookahead (?=\n\n|$) consumes the trailing blank line after the block.
  // Indented content pattern.
  text = text.replace(
    /^##[ \t]+(system|instructions?|directives?|protocol)[ \t]*\n(?:[ \t]+[^\n]*\n)*/gim,
    "",
  );
  // Non-indented content pattern.
  text = text.replace(
    /^##[ \t]+(system|instructions?|directives?|protocol)[ \t]*\n[\s\S]*?(?=\n\n|$)/gim,
    "",
  );
  // Bold **System** style.
  text = text.replace(/^\*\*System\s*[^\n]*\*\*[\s\S]*?(?=^\*\*|$)/gim, "");

  // ── 8. Collapse whitespace ────────────────────────────────────────────────
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  // Collapse consecutive spaces left by token removal (e.g. "Hello  world").
  text = text.replace(/  +/g, " ");
  text = text.trim();

  return text;
}

function extractTextMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      return candidate.text;
    }
  }
  return undefined;
}

export async function getRecentSessionContent(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    const allMessages: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          const msg = entry.message as {
            role?: unknown;
            content?: unknown;
            provenance?: unknown;
          };
          const role = msg.role;
          if ((role === "user" || role === "assistant") && "content" in msg && msg.content) {
            if (role === "user" && hasInterSessionUserProvenance(msg)) {
              continue;
            }
            const rawText = extractTextMessageContent(msg.content);
            if (!rawText || rawText.startsWith("/")) {
              continue;
            }
            // Sanitize assistant output to strip template tokens, housekeeping
            // markers, thinking blocks, and tool-call XML before saving to memory.
            const text = role === "assistant" ? sanitizeModelOutput(rawText) : rawText;
            if (text) {
              allMessages.push(`${role}: ${text}`);
            }
          }
        }
      } catch {
        // Skip invalid JSON lines.
      }
    }

    return allMessages.slice(-messageCount).join("\n");
  } catch {
    return null;
  }
}

export async function getRecentSessionContentWithResetFallback(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<string | null> {
  const primary = await getRecentSessionContent(sessionFilePath, messageCount);
  if (primary) {
    return primary;
  }

  try {
    const dir = path.dirname(sessionFilePath);
    const base = path.basename(sessionFilePath);
    const resetPrefix = `${base}.reset.`;
    const files = await fs.readdir(dir);
    const resetCandidates = files.filter((name) => name.startsWith(resetPrefix)).toSorted();

    if (resetCandidates.length === 0) {
      return primary;
    }

    const latestResetPath = path.join(dir, resetCandidates[resetCandidates.length - 1]);
    return (await getRecentSessionContent(latestResetPath, messageCount)) || primary;
  } catch {
    return primary;
  }
}

export function stripResetSuffix(fileName: string): string {
  const resetIndex = fileName.indexOf(".reset.");
  return resetIndex === -1 ? fileName : fileName.slice(0, resetIndex);
}

export async function findPreviousSessionFile(params: {
  sessionsDir: string;
  currentSessionFile?: string;
  sessionId?: string;
}): Promise<string | undefined> {
  try {
    const files = await fs.readdir(params.sessionsDir);
    const fileSet = new Set(files);

    const baseFromReset = params.currentSessionFile
      ? stripResetSuffix(path.basename(params.currentSessionFile))
      : undefined;
    if (baseFromReset && fileSet.has(baseFromReset)) {
      return path.join(params.sessionsDir, baseFromReset);
    }

    const trimmedSessionId = params.sessionId?.trim();
    if (trimmedSessionId) {
      const canonicalFile = `${trimmedSessionId}.jsonl`;
      if (fileSet.has(canonicalFile)) {
        return path.join(params.sessionsDir, canonicalFile);
      }

      const topicVariants = files
        .filter(
          (name) =>
            name.startsWith(`${trimmedSessionId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        )
        .toSorted()
        .toReversed();
      if (topicVariants.length > 0) {
        return path.join(params.sessionsDir, topicVariants[0]);
      }
    }

    if (!params.currentSessionFile) {
      return undefined;
    }

    const nonResetJsonl = files
      .filter((name) => name.endsWith(".jsonl") && !name.includes(".reset."))
      .toSorted()
      .toReversed();
    if (nonResetJsonl.length > 0) {
      return path.join(params.sessionsDir, nonResetJsonl[0]);
    }
  } catch {
    // Ignore directory read errors.
  }
  return undefined;
}
