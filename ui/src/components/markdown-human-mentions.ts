import type { HumanMention } from "@openclaw/gateway-protocol";
import type { MarkdownIt, Token } from "markdown-it";
import { findMarkdownCodeSpans } from "../../../packages/markdown-core/src/reasoning-tags.js";
import { readHumanMentions } from "../lib/chat/human-mentions.ts";
import type { MarkdownHumanMentionToken, MarkdownRenderEnv } from "./markdown-render-options.ts";
import { escapeMarkdownHtml } from "./markdown-text.ts";

/** Protect selected labels before Markdown/line-ending normalization changes source offsets. */
export function prepareMarkdownHumanMentions(
  source: string,
  value: readonly HumanMention[],
  normalizeReference: (label: string) => string,
) {
  const mentions = readHumanMentions(source, value);
  const tokens: MarkdownHumanMentionToken[] = [];
  if (!mentions) {
    return { source, tokens };
  }
  const code = findMarkdownCodeSpans(source);
  const referenceSource = normalizeReference(source);
  let serial = 0;
  let prefix: string;
  do {
    prefix = "openclawhumanmention" + serial++ + "x";
  } while (referenceSource.includes(normalizeReference(prefix)));
  let cursor = 0;
  let masked = "";
  for (const mention of mentions) {
    // Code enclosing a selection stays code; delimiters inside the selected name are literal.
    if (
      code.some(
        ([start, end]) =>
          mention.start < end &&
          mention.end > start &&
          (start < mention.start || end > mention.end),
      )
    ) {
      continue;
    }
    const marker = prefix + tokens.length + "end";
    tokens.push({
      marker,
      profileId: mention.profileId,
      label: source.slice(mention.start, mention.end),
    });
    masked += source.slice(cursor, mention.start) + marker;
    cursor = mention.end;
  }
  return { source: masked + source.slice(cursor), tokens };
}

export function restoreMarkdownHumanMentions(
  value: string,
  tokens: readonly MarkdownHumanMentionToken[] = [],
): string {
  let restored = value;
  for (const token of tokens) {
    restored = restored.replaceAll(token.marker, () => token.label);
  }
  return restored;
}

export function installMarkdownHumanMentions(parser: MarkdownIt): void {
  parser.core.ruler.before("inline", "human-mention-references", (state) => {
    // SAFETY: markdown.ts owns the normalized mention tokens in the parser environment.
    const mentions = (state.env as Partial<MarkdownRenderEnv>).humanMentionTokens;
    const references = state.env.references;
    if (!mentions?.length || !references) {
      return;
    }
    const normalize = parser.utils.normalizeReference;
    const markers = mentions.map(({ marker, label }) => ({ marker: normalize(marker), label }));
    const referenceKey = (key: string) => {
      let restored = key;
      for (const { marker, label } of markers) {
        restored = restored.replaceAll(marker, () => label);
      }
      return normalize(restored);
    };
    const canonical = new Map<string, (typeof references)[string]>();
    // Block parsing owns valid definitions and their first-definition-wins order.
    for (const [key, reference] of Object.entries(references)) {
      const restored = referenceKey(key);
      if (!canonical.has(restored)) {
        canonical.set(restored, reference);
      }
    }
    // Inline link/image parsing still decides whether brackets form a reference.
    // Translate its masked lookup key instead of reimplementing Markdown syntax
    // or enumerating combinations when one label contains several selections.
    state.env.references = new Proxy(references, {
      get(target, key) {
        return typeof key === "string"
          ? canonical.get(referenceKey(key))
          : Reflect.get(target, key);
      },
    });
  });
  // Existing link owners classify URL/email/file boundaries first. No label
  // inside a link, image, code span, or HTML attribute becomes a second control.
  parser.core.ruler.after("file-links", "human-mentions", (state) => {
    // SAFETY: markdown.ts supplies normalized render options through markdown-it's untyped env.
    const env = state.env as Partial<MarkdownRenderEnv> | undefined;
    const mentions = env?.humanMentionTokens;
    if (!mentions?.length) {
      return;
    }
    const restore = (value: string) => restoreMarkdownHumanMentions(value, mentions);
    const restoreToken = (token: Token) => {
      token.content = restore(token.content);
      token.attrs =
        token.attrs?.map(([name, value]) => [
          name,
          typeof value === "string" ? restore(value) : value,
        ]) ?? null;
      token.children?.forEach(restoreToken);
    };
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) {
        restoreToken(block);
        continue;
      }
      let linkDepth = 0;
      block.children = block.children.flatMap((token) => {
        if (token.type === "link_open") {
          linkDepth += 1;
        } else if (token.type === "link_close") {
          linkDepth = Math.max(0, linkDepth - 1);
        }
        if (token.type !== "text" || linkDepth > 0) {
          restoreToken(token);
          return [token];
        }
        const matches = mentions
          .flatMap((mention) => {
            const index = token.content.indexOf(mention.marker);
            return index < 0 ? [] : [{ ...mention, index }];
          })
          .toSorted((left, right) => left.index - right.index);
        if (!matches.length) {
          return [token];
        }
        const replacements: Token[] = [];
        let cursor = 0;
        for (const mention of matches) {
          const leading = new state.Token("text", "", 0);
          leading.content = token.content.slice(cursor, mention.index);
          const reference = new state.Token("human_mention", "", 0);
          reference.content = mention.label;
          reference.attrSet("profile-id", mention.profileId);
          replacements.push(leading, reference);
          cursor = mention.index + mention.marker.length;
        }
        const trailing = new state.Token("text", "", 0);
        trailing.content = token.content.slice(cursor);
        return [...replacements, trailing];
      });
      block.content = restore(block.content);
    }
  });
  parser.renderer.rules.human_mention = (tokens, index) => {
    const token = tokens[index];
    const profileId = token?.attrGet("profile-id");
    return token && typeof profileId === "string" && profileId
      ? '<openclaw-person-reference profile-id="' +
          escapeMarkdownHtml(profileId) +
          '" label="' +
          escapeMarkdownHtml(token.content) +
          '">' +
          escapeMarkdownHtml(token.content) +
          "</openclaw-person-reference>"
      : "";
  };
}
