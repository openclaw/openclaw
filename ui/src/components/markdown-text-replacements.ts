import type { StateCore, Token } from "markdown-it";

/** Yield each mutable inline token list without copying or precollecting blocks. */
export function* markdownInlineChildren(tokens: readonly Token[]): Generator<Token[]> {
  for (const token of tokens) {
    if (token.type === "inline" && token.children) {
      yield token.children;
    }
  }
}

/** Replace accepted prose matches once; generated tokens are not scanned again. */
export function replaceMarkdownTextMatches(
  state: Pick<StateCore, "Token">,
  children: Token[],
  index: number,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => Token[] | null,
): number {
  const content = children[index]!.content;
  const replacements: Token[] = [];
  let cursor = 0;
  const text = (value: string) => {
    if (value) {
      const token = new state.Token("text", "", 0);
      token.content = value;
      replacements.push(token);
    }
  };
  for (const match of content.matchAll(pattern)) {
    const tokens = replace(match);
    if (!tokens) {
      continue;
    }
    text(content.slice(cursor, match.index));
    replacements.push(...tokens);
    cursor = match.index + match[0].length;
  }
  if (cursor) {
    text(content.slice(cursor));
    children.splice(index, 1, ...replacements);
    return index + replacements.length - 1;
  }
  return index;
}
