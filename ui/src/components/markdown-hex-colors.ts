import type { MarkdownIt } from "markdown-it";
import { hasMarkdownLinkBoundaries } from "./markdown-link-boundary.ts";
import {
  markdownInlineChildren,
  replaceMarkdownTextMatches,
} from "./markdown-text-replacements.ts";

const HEX_COLOR_RE = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\da-f])/gi;

export function installMarkdownHexColors(parser: MarkdownIt): void {
  // Link owners run first; preserve reference metadata before text tokens are joined.
  parser.core.ruler.before("text_join", "hex-colors", (state) => {
    if (state.env.mode !== "message") {
      return;
    }
    for (const children of markdownInlineChildren(state.tokens)) {
      let linkDepth = 0;
      for (let index = 0; index < children.length; index += 1) {
        const token = children[index]!;
        if (token.type === "link_open" || token.type === "link_close") {
          linkDepth += token.nesting;
        }
        if (
          token.type !== "text" ||
          token.meta?.githubItemReference ||
          linkDepth !== 0 ||
          !token.content.includes("#")
        ) {
          continue;
        }
        index = replaceMarkdownTextMatches(state, children, index, HEX_COLOR_RE, (match) => {
          const end = match.index + match[0].length;
          if (
            !hasMarkdownLinkBoundaries(token.content, match.index, end) ||
            /^[.-]\w/u.test(token.content.slice(end))
          ) {
            return null;
          }
          const color = new state.Token("hex_color", "", 0);
          color.content = match[0];
          return [color];
        });
      }
    }
  });
  parser.renderer.rules.hex_color = (tokens, index) => {
    const color = tokens[index]!.content;
    // Only the validated hex token enters this image; no style or HTML allowlist expansion.
    const image = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="${color}" d="M0 0h16v16H0z"/></svg>`,
    );
    return `<span class="markdown-hex-color"><img class="markdown-hex-color__swatch" src="data:image/svg+xml,${image}" alt="" aria-hidden="true">${color}</span>`;
  };
}
