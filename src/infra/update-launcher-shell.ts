/**
 * POSIX shell words as pnpm writes them into launcher shims. Paths in a shim can be
 * spelled through any quoting form (`"$basedir/x"`, `"$basedir"/'x'`, `'a'\''b'`, ...),
 * so relocation reads each word's value, rewrites the value, and writes the word back.
 */

type Piece =
  | { kind: "literal"; text: string }
  | { kind: "variable"; name: string }
  | { kind: "opaque" };

type ShellWord = { start: number; end: number; pieces: Piece[] };

const OPERATOR = new Set([";", "|", "&", "(", ")", "<", ">"]);
const SPECIAL_PARAMETER = /^[@*#?$!0-9-]$/u;
const NAME_START = /^[A-Za-z_]$/u;
const NAME_CHAR = /^[A-Za-z0-9_]$/u;
// Placeholders for expansions while a word's value is rewritten as text.
const MARK = "\u0000";

function scanBalanced(line: string, index: number, open: string, close: string): number {
  // `index` points at the opening character; returns the index after its match.
  let depth = 0;
  for (let i = index; i < line.length; i++) {
    const char = line[i];
    if (char === "\\") {
      i++;
    } else if (char === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) {
        return -1;
      }
      i = end;
    } else if (char === open) {
      depth++;
    } else if (char === close && --depth === 0) {
      return i + 1;
    }
  }
  return -1;
}

/** Parse the words of one line; undefined when its quoting cannot be read safely. */
function parseShellWords(line: string): ShellWord[] | undefined {
  const words: ShellWord[] = [];
  let i = 0;
  const pushLiteral = (pieces: Piece[], text: string) => {
    const last = pieces.at(-1);
    if (last?.kind === "literal") {
      last.text += text;
    } else {
      pieces.push({ kind: "literal", text });
    }
  };
  const readExpansion = (pieces: Piece[]): boolean => {
    // `line[i]` is `$`.
    const next = line[i + 1] ?? "";
    if (next === "(") {
      const end = scanBalanced(line, i + 1, "(", ")");
      if (end < 0) {
        return false;
      }
      pieces.push({ kind: "opaque" });
      i = end;
    } else if (next === "{") {
      const end = line.indexOf("}", i + 2);
      if (end < 0) {
        return false;
      }
      const name = line.slice(i + 2, end);
      pieces.push(
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ? { kind: "variable", name } : { kind: "opaque" },
      );
      i = end + 1;
    } else if (NAME_START.test(next)) {
      let end = i + 2;
      while (end < line.length && NAME_CHAR.test(line[end]!)) {
        end++;
      }
      pieces.push({ kind: "variable", name: line.slice(i + 1, end) });
      i = end;
    } else if (SPECIAL_PARAMETER.test(next)) {
      pieces.push({ kind: "variable", name: next });
      i += 2;
    } else {
      pushLiteral(pieces, "$");
      i++;
    }
    return true;
  };
  while (i < line.length) {
    const char = line[i]!;
    if (char === " " || char === "\t" || OPERATOR.has(char)) {
      i++;
      continue;
    }
    if (char === "#") {
      break;
    }
    const start = i;
    const pieces: Piece[] = [];
    while (i < line.length) {
      const c = line[i]!;
      if (c === " " || c === "\t" || OPERATOR.has(c)) {
        break;
      }
      if (c === "'") {
        const end = line.indexOf("'", i + 1);
        if (end < 0) {
          return undefined;
        }
        pushLiteral(pieces, line.slice(i + 1, end));
        i = end + 1;
      } else if (c === '"') {
        i++;
        while (i < line.length && line[i] !== '"') {
          const d = line[i]!;
          if (d === "\\" && /^[$`"\\]$/u.test(line[i + 1] ?? "")) {
            pushLiteral(pieces, line[i + 1]!);
            i += 2;
          } else if (d === "$") {
            if (!readExpansion(pieces)) {
              return undefined;
            }
          } else if (d === "`") {
            const end = line.indexOf("`", i + 1);
            if (end < 0) {
              return undefined;
            }
            pieces.push({ kind: "opaque" });
            i = end + 1;
          } else {
            pushLiteral(pieces, d);
            i++;
          }
        }
        if (line[i] !== '"') {
          return undefined;
        }
        i++;
      } else if (c === "\\") {
        if (i + 1 >= line.length) {
          return undefined;
        }
        pushLiteral(pieces, line[i + 1]!);
        i += 2;
      } else if (c === "$") {
        if (!readExpansion(pieces)) {
          return undefined;
        }
      } else if (c === "`") {
        const end = line.indexOf("`", i + 1);
        if (end < 0) {
          return undefined;
        }
        pieces.push({ kind: "opaque" });
        i = end + 1;
      } else {
        pushLiteral(pieces, c);
        i++;
      }
    }
    words.push({ start, end: i, pieces });
  }
  return words;
}

const SAFE = /^[A-Za-z0-9_./:=,@+%-]$/u;

/** Spell literal text as one shell word fragment that the shell reads back unchanged. */
function encodeLiteral(text: string): string {
  let out = "";
  let quoted = "";
  const flush = () => {
    if (quoted) {
      out += `'${quoted}'`;
      quoted = "";
    }
  };
  for (const char of text) {
    if (SAFE.test(char)) {
      flush();
      out += char;
    } else if (char === "'") {
      flush();
      out += "\\'";
    } else {
      quoted += char;
    }
  }
  flush();
  return out;
}

function toTemplate(pieces: Piece[]): string | undefined {
  let template = "";
  for (const [index, piece] of pieces.entries()) {
    if (piece.kind === "opaque") {
      return undefined;
    }
    template += piece.kind === "literal" ? piece.text : `${MARK}${index}${MARK}`;
  }
  return template;
}

function encodeTemplate(template: string, pieces: Piece[]): string {
  return template
    .split(MARK)
    .map((part, index) => {
      if (index % 2 === 0) {
        return encodeLiteral(part);
      }
      const piece = pieces[Number(part)];
      if (piece?.kind !== "variable") {
        throw new Error("Shell word placeholder lost its expansion");
      }
      return /^[A-Za-z_]/u.test(piece.name) ? `"\${${piece.name}}"` : `"$${piece.name}"`;
    })
    .join("");
}

export type ShellWordValue = {
  /** The word's value with each expansion as a `$name` placeholder. */
  value: string;
};

/**
 * Rewrite every word of a shell launcher by value. `rewrite` returns the new value
 * (placeholders preserved) or undefined to leave the word byte-for-byte unchanged.
 * Comment lines keep their literal text and pass through `rewriteComment`.
 */
export function rewriteShellLauncher(
  content: string,
  rewrite: (word: ShellWordValue) => string | undefined,
  rewriteComment: (line: string) => string = (line) => line,
): string {
  return content
    .split("\n")
    .map((line) => {
      if (/^\s*#/u.test(line)) {
        return rewriteComment(line);
      }
      const words = parseShellWords(line);
      if (!words) {
        return line;
      }
      let result = line;
      for (const word of words.toReversed()) {
        const template = toTemplate(word.pieces);
        if (template === undefined) {
          continue;
        }
        // Expose `$name` placeholders to the caller and map them back afterwards.
        const names = word.pieces.map((piece) => (piece.kind === "variable" ? piece.name : ""));
        const value = template.replace(
          new RegExp(`${MARK}(\\d+)${MARK}`, "gu"),
          (_match, index: string) => `${MARK}$${names[Number(index)]}${MARK}`,
        );
        const next = rewrite({ value });
        if (next === undefined || next === value) {
          continue;
        }
        const back = next.replace(
          new RegExp(`${MARK}\\$([^${MARK}]*)${MARK}`, "gu"),
          (_m, name: string) => {
            const index = names.indexOf(name);
            if (index < 0) {
              throw new Error("Shell word rewrite introduced an unknown expansion");
            }
            return `${MARK}${index}${MARK}`;
          },
        );
        result = `${result.slice(0, word.start)}${encodeTemplate(back, word.pieces)}${result.slice(word.end)}`;
      }
      return result;
    })
    .join("\n");
}

/** Values of the words in a shell launcher, for inspection without rewriting. */
export function readShellLauncherWords(content: string): ShellWordValue[] {
  const values: ShellWordValue[] = [];
  rewriteShellLauncher(content, (word) => {
    values.push(word);
    return undefined;
  });
  return values;
}

/** Split a word value that starts with an expansion into the expansion and the rest. */
export function splitLeadingExpansion(value: string): { name: string; rest: string } | undefined {
  const match = new RegExp(`^${MARK}\\$([^${MARK}]*)${MARK}`, "u").exec(value);
  return match ? { name: match[1]!, rest: value.slice(match[0].length) } : undefined;
}

/** Rebuild a word value from a leading expansion and the rest. */
export function joinLeadingExpansion(name: string, rest: string): string {
  return `${MARK}$${name}${MARK}${rest}`;
}

/** True when a word value has an expansion after its leading one. */
export function hasInnerExpansion(rest: string): boolean {
  return rest.includes(MARK);
}
