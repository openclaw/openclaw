import type { ContentBlock } from "@modelcontextprotocol/client";

/** Named text is an attachment; only untitled text enters the chat command/parser path. */
export function mcpAppMessageText(content: readonly ContentBlock[]): string {
  return content
    .flatMap((block) => {
      if (block.type !== "text") {
        return [];
      }
      const title = block._meta?.["openai/title"];
      return typeof title === "string" && title.trim() ? [] : [block.text];
    })
    .join("\n\n");
}
