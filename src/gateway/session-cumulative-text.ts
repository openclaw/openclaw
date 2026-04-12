/**
 * Utility for stripping cumulative assistant text from session messages.
 *
 * Some LLM providers send cumulative content in assistant messages that follow
 * tool calls.  For example, if the assistant said "checking google..." before
 * a tool call and then "checking google...ok it opens" after, the second
 * message's text includes the first message's text as a prefix.
 *
 * The functions here detect this pattern and strip the duplicated prefix so
 * each assistant message only contains its own new text.
 */

const TOOL_USE_TYPES = new Set(["toolUse", "toolCall", "tool_use", "tool_call", "functionCall"]);

const TOOL_RESULT_TYPES = new Set(["tool_result", "toolResult"]);

type ContentBlock = Record<string, unknown>;

function extractTextFromBlocks(content: unknown[]): string {
  return content
    .filter(
      (b): b is ContentBlock =>
        !!b &&
        typeof b === "object" &&
        (b as ContentBlock).type === "text" &&
        typeof (b as ContentBlock).text === "string",
    )
    .map((b) => b.text as string)
    .join("");
}

function contentHasToolUse(content: unknown[]): boolean {
  return content.some(
    (b) =>
      !!b &&
      typeof b === "object" &&
      typeof (b as ContentBlock).type === "string" &&
      TOOL_USE_TYPES.has((b as ContentBlock).type as string),
  );
}

function isToolResultMessage(msg: Record<string, unknown>): boolean {
  const role = msg.role;
  if (role === "toolResult" || role === "tool") {
    return true;
  }
  if (role === "user" && Array.isArray(msg.content) && msg.content.length > 0) {
    return (msg.content as ContentBlock[]).every(
      (b) =>
        !!b && typeof b === "object" && typeof b.type === "string" && TOOL_RESULT_TYPES.has(b.type),
    );
  }
  return false;
}

function replaceTextBlocks(content: unknown[], newText: string): unknown[] {
  const nonText = content.filter(
    (b) => !!b && typeof b === "object" && (b as ContentBlock).type !== "text",
  );
  if (!newText) {
    return nonText.length > 0 ? nonText : [{ type: "text", text: "" }];
  }
  return [{ type: "text", text: newText }, ...nonText];
}

/**
 * Create a stateful processor that strips cumulative assistant text prefixes.
 * Feed messages sequentially; the processor tracks the prior assistant text
 * from messages that contained tool-use blocks and strips the prefix from
 * subsequent assistant messages.
 */
export function createCumulativeTextStripper(): (msg: unknown) => unknown {
  let priorAssistantText: string | undefined;

  return (msg: unknown): unknown => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    const record = msg as Record<string, unknown>;
    const role = record.role;
    const content = record.content;

    if (role === "assistant" && Array.isArray(content)) {
      const fullText = extractTextFromBlocks(content);
      const hasToolUse = contentHasToolUse(content);

      let resultMsg: unknown = msg;
      if (priorAssistantText && fullText && fullText.startsWith(priorAssistantText)) {
        const stripped = fullText.slice(priorAssistantText.length);
        resultMsg = { ...record, content: replaceTextBlocks(content, stripped) };
      }

      // Track the full (original, pre-strip) text when tool-use blocks are present
      // so that chained tool calls accumulate correctly.
      if (hasToolUse) {
        priorAssistantText = fullText || priorAssistantText;
      } else {
        priorAssistantText = undefined;
      }

      return resultMsg;
    }

    // Tool result messages (explicit role or user-wrapping) do not reset tracking.
    if (isToolResultMessage(record)) {
      return msg;
    }

    // Real user messages (not tool results) start a new turn → reset.
    if (role === "user") {
      priorAssistantText = undefined;
    }

    return msg;
  };
}

/**
 * Strip cumulative assistant text prefixes from an array of messages.
 * Returns a new array with modified messages where applicable.
 */
export function stripCumulativeAssistantText(messages: unknown[]): unknown[] {
  const process = createCumulativeTextStripper();
  return messages.map(process);
}

/**
 * Check whether an assistant message's content array contains tool-use blocks.
 */
export function messageContentHasToolUse(content: unknown): boolean {
  return Array.isArray(content) && contentHasToolUse(content);
}

/**
 * Extract concatenated text from content blocks of a message.
 */
export function extractMessageTextContent(content: unknown): string {
  return Array.isArray(content) ? extractTextFromBlocks(content) : "";
}
