import type { MarkdownIt, Token } from "markdown-it";
import { ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE } from "../../../packages/markdown-core/src/assistant-transcript.js";
import { stripUnsupportedCitationControlMarkers } from "../../../src/shared/text/citation-control-markers.js";
import { prepareMarkdownHumanMentions } from "./markdown-human-mentions.ts";
import { parseMarkdownJson } from "./markdown-json.ts";
import { createMarkdownParser } from "./markdown-parser.ts";
import {
  MARKDOWN_PARSE_LIMIT,
  normalizeMarkdownRenderOptions,
  type MarkdownRenderOptions,
} from "./markdown-render-options.ts";
import { normalizeMarkdownLineBreaks } from "./markdown-text.ts";

// Transcript search compares what a reader sees, not the syntax around it:
// `Title: \`fix\`` must match "title: fix". Parse with the transcript's own
// rules so raw HTML stays literal and disclosure summaries keep their inline text.
let parser: MarkdownIt | undefined;
// Letter-led prose lines have no Markdown structure to remove. Keep punctuation
// narrow: list markers, internal dots, colons, slashes, and markup need the parser.
const PLAIN_PROSE = /^(?:\p{L}[\p{L}\p{N} ,!?]*\.?(?:\n|$)|\n)*$/u;
type VisibleTextOptions = Pick<
  MarkdownRenderOptions,
  "mode" | "humanMentions" | "assistantTranscriptRoleHeaders"
>;
const visibleTexts = new WeakMap<
  object,
  {
    markdown: string;
    document: boolean;
    roleHeaders: boolean;
    humanMentions: VisibleTextOptions["humanMentions"];
    text: string;
  }
>();

function collectVisibleText(tokens: readonly Token[], parts: string[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "inline":
        collectVisibleText(token.children ?? [], parts);
        break;
      case "text":
      case "hex_color":
      case ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE:
      case "code_inline":
      case "code_block":
      case "fence":
        parts.push(token.content);
        break;
      case "human_mention":
        parts.push(token.content.startsWith("@") ? token.content.slice(1) : token.content);
        break;
      case "html_block":
      case "html_inline":
        // Raw HTML renders escaped; generated task-list checkboxes have no text.
        if (token.meta?.taskListPlugin !== true) {
          parts.push(/^<br\s*\/?>$/iu.test(token.content.trim()) ? "\n" : token.content);
        }
        break;
      case "softbreak":
      case "hardbreak":
        parts.push("\n");
        break;
      case "image":
        // Images render as media or a notice; a phrase must not match across them.
        parts.push("￼");
        break;
      default:
        if (token.block && token.nesting === -1) {
          parts.push("\n");
        }
    }
  }
}

/** Plain text of rendered Markdown, cached on the immutable owner of `markdown`. */
export function markdownVisibleText(
  owner: unknown,
  markdown: string,
  options: VisibleTextOptions = {},
): string {
  const cacheOwner = owner !== null && typeof owner === "object" ? owner : undefined;
  const document = options.mode === "document";
  const roleHeaders = options.assistantTranscriptRoleHeaders === true;
  const cached = cacheOwner && visibleTexts.get(cacheOwner);
  const mentions = options.humanMentions ?? [];
  const sameMentions =
    cached &&
    (cached.humanMentions?.length ?? 0) === mentions.length &&
    mentions.every((mention, index) => {
      const previous = cached.humanMentions?.[index];
      return (
        previous?.profileId === mention.profileId &&
        previous.start === mention.start &&
        previous.end === mention.end
      );
    });
  if (
    cached &&
    cached.markdown === markdown &&
    cached.document === document &&
    cached.roleHeaders === roleHeaders &&
    sameMentions
  ) {
    return cached.text;
  }
  let text = markdown;
  // Selected mention offsets belong to the same immutable message as this cache.
  // Recovered document-mode messages use the renderer's full parse path.
  if (
    (document || markdown.length <= MARKDOWN_PARSE_LIMIT) &&
    !PLAIN_PROSE.test(markdown) &&
    !parseMarkdownJson(markdown)
  ) {
    const parts: string[] = [];
    try {
      parser ??= createMarkdownParser();
      const prepared = prepareMarkdownHumanMentions(
        markdown,
        options.humanMentions ?? [],
        parser.utils.normalizeReference,
      );
      const source = normalizeMarkdownLineBreaks(
        stripUnsupportedCitationControlMarkers(prepared.source),
      );
      const environment = normalizeMarkdownRenderOptions({
        fileLinks: true,
        sessionLinks: true,
        ...options,
      });
      environment.humanMentionTokens = prepared.tokens;
      collectVisibleText(parser.parse(source, environment), parts);
      text = parts.join("");
    } catch {
      // As in the renderer, failed parses keep literal source. Cache that result too.
    }
  }
  text = text.normalize("NFC");
  if (cacheOwner) {
    visibleTexts.set(cacheOwner, {
      markdown,
      document,
      roleHeaders,
      humanMentions: mentions,
      text,
    });
  }
  return text;
}
