import MarkdownIt, { type MarkdownIt as MarkdownParser } from "markdown-it";
import emojiDefinitions from "markdown-it-emoji/lib/data/full.mjs";

export type EmojiTarget = { start: number; end: number; query: string };
const emojiNames = Object.keys(emojiDefinitions).toSorted();
const maxShortcodeLength = emojiNames.reduce((longest, name) => Math.max(longest, name.length), 0);

// Markdown owns block indentation, nesting, and fence rules. The draft may still
// contain unfinished inline code or a link destination, which stays literal too.
let contextParser: MarkdownParser | undefined;
function isLiteralContext(value: string, start: number, caret: number): boolean {
  if (value.trimStart().startsWith("/")) {
    return true;
  }
  const draft = value.slice(0, caret);
  const line = draft.split("\n").length - 1;
  let activeLine = false;
  let inline: string | undefined;
  // Only block maps and raw inline text are needed, not inline rendering of earlier paragraphs.
  contextParser ??= new MarkdownIt().disable([
    "inline",
    "linkify",
    "replacements",
    "smartquotes",
    "text_join",
  ]);
  for (const token of contextParser.parse(draft, {})) {
    if (token.map) {
      activeLine = token.map[0] <= line && token.map[1] > line;
    }
    if (!activeLine) {
      continue;
    }
    if (["fence", "code_block", "html_block"].includes(token.type)) {
      return true;
    }
    // Table cells inherit their row map; parser-filled empty cells are not the caret cell.
    if (token.type === "inline" && token.content) {
      inline = token.content;
    }
  }
  if (inline === undefined) {
    return true;
  }
  let ticks = 0;
  let labels = 0;
  let destination = 0;
  let quote = "";
  let angleDestination = false;
  let tag = false;
  let autolink = false;
  let literalEnd = 0;
  for (let index = 0; index < inline.length;) {
    const character = inline[index++];
    if (ticks) {
      if (character !== "`") {
        continue;
      }
      let length = 1;
      while (inline[index] === "`") {
        length += 1;
        index += 1;
      }
      if (ticks === length) {
        ticks = 0;
        literalEnd = index;
      }
      continue;
    }
    if (tag) {
      if (autolink) {
        if (character === ">") {
          tag = false;
          literalEnd = index;
        }
      } else if (quote) {
        if (character === quote) {
          quote = "";
        }
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        tag = false;
        literalEnd = index;
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (destination) {
      if (angleDestination) {
        if (character === ">") {
          angleDestination = false;
        }
      } else if (quote) {
        if (character === quote) {
          quote = "";
        }
      } else if ((character === '"' || character === "'") && /\s/u.test(inline[index - 2] ?? "")) {
        quote = character;
      } else if (character === "<" && inline[index - 2] === "(") {
        angleDestination = true;
      } else if (character === "(") {
        destination += 1;
      } else if (character === ")" && --destination === 0) {
        literalEnd = index;
      }
      continue;
    }
    if (character === "`") {
      ticks = 1;
      while (inline[index] === "`") {
        ticks += 1;
        index += 1;
      }
    } else if (character === "[") {
      labels += 1;
    } else if (character === "]" && labels > 0) {
      labels -= 1;
      if (inline[index] === "(") {
        destination = 1;
        index += 1;
      }
    } else if (character === "<") {
      const rest = inline.slice(index);
      autolink = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(rest) || /^[^\s<>]*@/u.test(rest);
      tag = autolink || /^[a-zA-Z!?/]/u.test(rest);
    }
  }
  if (ticks || destination || tag) {
    return true;
  }
  const end = inline.length - (caret - start);
  let begin = end;
  const whitespace = /\s/u;
  while (begin > literalEnd && !whitespace.test(inline[begin - 1]!)) {
    begin -= 1;
  }
  const tail = inline.slice(begin, end);
  if (tail.toLowerCase().includes("www.")) {
    return true;
  }
  // A single pass avoids regex retries at every letter in long pasted tokens.
  let scheme = false;
  for (let index = 0; index < tail.length; index += 1) {
    const code = tail.charCodeAt(index);
    if (code === 58 && scheme && index + 1 < tail.length) {
      return true;
    }
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      scheme = true;
    } else if (
      !(scheme && ((code >= 48 && code <= 57) || code === 43 || code === 45 || code === 46))
    ) {
      scheme = false;
    }
  }
  return false;
}

function emojiPrefixIndex(query: string): number {
  let lower = 0;
  let upper = emojiNames.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (emojiNames[middle]! < query) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return lower;
}

/** One active draft context; changing its preceding text invalidates Markdown work. */
export class EmojiTargetResolver {
  private context: { prefix: string; literal: boolean } | null = null;
  private snapshot: { value: string; caret: number; target: EmojiTarget | null } | null = null;

  reset() {
    this.context = null;
    this.snapshot = null;
  }

  find(value: string, caret: number): EmojiTarget | null {
    if (this.snapshot?.value === value && this.snapshot.caret === caret) {
      return this.snapshot.target;
    }
    const target = this.resolve(value, caret);
    this.snapshot = { value, caret, target };
    return target;
  }

  private resolve(value: string, caret: number): EmojiTarget | null {
    // Only a catalog-sized tail can be an emoji name, even in a megabyte draft.
    const before = value.slice(Math.max(0, caret - maxShortcodeLength - 1), caret);
    const match = /:([a-z0-9_+-]+)$/u.exec(before);
    if (!match || !emojiNames[emojiPrefixIndex(match[1]!)]?.startsWith(match[1]!)) {
      this.context = null;
      return null;
    }
    const start = caret - match[0].length;
    if (/[\p{L}\p{N}_/:\\]$/u.test(value.slice(Math.max(0, start - 2), start))) {
      return null;
    }
    let end = caret;
    while (end - start <= maxShortcodeLength && /[a-z0-9_+-]/u.test(value[end] ?? "")) {
      end += 1;
    }
    if (/[a-z0-9_+-]/u.test(value[end] ?? "")) {
      return null;
    }
    if (value[end] === ":") {
      end += 1;
    }
    const prefix = value.slice(0, start);
    // Extending a shortcode name does not change its preceding code/URL context.
    if (this.context?.prefix !== prefix) {
      this.context = { prefix, literal: isLiteralContext(value, start, caret) };
    }
    if (this.context.literal) {
      return null;
    }
    return { start, end, query: match[1]! };
  }
}

export function emojiForShortcode(name: string): string | undefined {
  return Object.hasOwn(emojiDefinitions, name) ? emojiDefinitions[name] : undefined;
}

export function suggestEmoji(query: string): string[] {
  const names: string[] = [];
  for (
    let index = emojiPrefixIndex(query);
    index < emojiNames.length && names.length < 12;
    index += 1
  ) {
    const name = emojiNames[index]!;
    if (!name.startsWith(query)) {
      break;
    }
    names.push(name);
  }
  return names;
}
