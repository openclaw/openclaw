import type { MarkdownIt } from "markdown-it";
import emojiDefinitions from "markdown-it-emoji/lib/data/full.mjs";
import { escapeRegExp } from "../../../src/shared/regexp.ts";
import {
  markdownInlineChildren,
  replaceMarkdownTextMatches,
} from "./markdown-text-replacements.ts";

// Match only known names so an unknown shortcode's closing colon can still
// open a known shortcode, as in :unknown:smile:.
const shortcodePattern = new RegExp(
  ":(?:" + Object.keys(emojiDefinitions).map(escapeRegExp).join("|") + "):",
  "g",
);

/** Reader documents expand named emoji in prose while preserving literal URLs. */
export function installMarkdownEmoji(parser: MarkdownIt): void {
  parser.core.ruler.after("linkify", "emoji", (state) => {
    for (const children of markdownInlineChildren(state.tokens)) {
      let autolinkDepth = 0;
      for (let index = 0; index < children.length; index += 1) {
        const token = children[index]!;
        if (token.info === "auto" && (token.type === "link_open" || token.type === "link_close")) {
          autolinkDepth += token.nesting;
        }
        if (token.type !== "text" || autolinkDepth !== 0) {
          continue;
        }
        index = replaceMarkdownTextMatches(state, children, index, shortcodePattern, (match) => {
          const emoji = new state.Token("emoji", "", 0);
          emoji.markup = match[0].slice(1, -1);
          emoji.content = emojiDefinitions[emoji.markup]!;
          return [emoji];
        });
      }
    }
  });
  parser.renderer.rules.emoji = (tokens, index) => tokens[index]!.content;
}
