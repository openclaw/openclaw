import type { Block, KnownBlock } from "@slack/web-api";
import type { SlackBlock } from "./types.js";

type PlainTextObject = { text?: string };

type SlackBlockWithFields = {
  type?: string;
  text?: PlainTextObject & { type?: string };
  title?: PlainTextObject;
  alt_text?: string;
  elements?: Array<{ text?: string; type?: string }>;
};

function cleanCandidate(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readSectionText(block: SlackBlockWithFields): string | undefined {
  return cleanCandidate(block.text?.text);
}

function readHeaderText(block: SlackBlockWithFields): string | undefined {
  return cleanCandidate(block.text?.text);
}

function readImageText(block: SlackBlockWithFields): string | undefined {
  return cleanCandidate(block.alt_text) ?? cleanCandidate(block.title?.text);
}

function readVideoText(block: SlackBlockWithFields): string | undefined {
  return cleanCandidate(block.title?.text) ?? cleanCandidate(block.alt_text);
}

function readContextText(block: SlackBlockWithFields): string | undefined {
  if (!Array.isArray(block.elements)) {
    return undefined;
  }
  const textParts = block.elements
    .map((element) => cleanCandidate(element.text))
    .filter((value): value is string => Boolean(value));
  return textParts.length > 0 ? textParts.join(" ") : undefined;
}

function readRichTextBlock(block: Record<string, unknown>): string | undefined {
  // rich_text blocks have: elements[] -> each has elements[] -> each has { type, text }
  const sections = block.elements as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(sections)) return undefined;
  const lines: string[] = [];
  for (const section of sections) {
    const elements = section.elements as Array<{ type?: string; text?: string }> | undefined;
    if (!Array.isArray(elements)) continue;
    const line = elements
      .map((el) => el.text ?? "")
      .join("");
    if (line) lines.push(line);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function extractFullTextFromBlocks(blocks: SlackBlock[]): string | undefined {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "rich_text": {
        const text = readRichTextBlock(block as unknown as Record<string, unknown>);
        if (text) {
          parts.push(text);
        }
        break;
      }
      case "section":
      case "header": {
        const text = block.text?.text?.replace(/\s+/g, " ").trim();
        if (text) {
          parts.push(text);
        }
        break;
      }
      case "context": {
        if (Array.isArray(block.elements)) {
          const contextParts = block.elements
            .map((el) => el.text?.replace(/\s+/g, " ").trim())
            .filter(Boolean);
          if (contextParts.length > 0) {
            parts.push(contextParts.join(" "));
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function buildSlackBlocksFallbackText(blocks: (Block | KnownBlock)[]): string {
  const parts: string[] = [];
  for (const raw of blocks) {
    const block = raw as SlackBlockWithFields;
    switch (block.type) {
      case "header": {
        const text = readHeaderText(block);
        if (text) {
          parts.push(text);
        }
        break;
      }
      case "section": {
        const text = readSectionText(block);
        if (text) {
          parts.push(text);
        }
        break;
      }
      case "image": {
        const text = readImageText(block);
        parts.push(text ?? "Shared an image");
        break;
      }
      case "video": {
        const text = readVideoText(block);
        parts.push(text ?? "Shared a video");
        break;
      }
      case "file": {
        parts.push("Shared a file");
        break;
      }
      case "context": {
        const text = readContextText(block);
        if (text) {
          parts.push(text);
        }
        break;
      }
      default:
        break;
    }
  }

  return parts.length > 0 ? parts.join("\n") : "Shared a Block Kit message";
}
