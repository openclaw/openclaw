// Tmux find-sessions tests cover the session-list field parsing contract.
//
// The skill script parses `tmux list-sessions -F` output by reading one line per
// session and splitting it on the separator present in the format string. These
// tests pin that contract against the real script source:
//
//   1. The separator emitted by the format string must be one tmux can actually
//      emit and that cannot occur in a session name. A literal `\t` inside single
//      quotes reaches tmux as backslash + t (tmux does not interpret escapes in
//      -F output), so it never becomes a tab: the whole line lands in the first
//      field, the attachment field stays empty, and every session renders as
//      "detached". tmux escapes tabs appearing in names, so a real tab byte is
//      the collision-free choice.
//   2. The creation-time variable must exist in tmux. `#{session_created_string}`
//      does not; it expands to the empty string. `#{t:session_created}` is the
//      supported strftime form.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "skills/tmux/scripts/find-sessions.sh";

const script = readFileSync(SCRIPT_PATH, "utf8");

/** The `-F` format string passed to `tmux list-sessions`. */
function readFormatString(): string {
  return readFormatStringFor(script);
}

/**
 * The `IFS=` delimiter the reader splits each emitted line on.
 *
 * Bash allows two spellings here: a plain single-quoted literal (`IFS='|'`) and
 * ANSI-C quoting (`IFS=$'\t'`), where `$'...'` interprets backslash escapes. Both
 * decode to the character the shell would actually use, so a tab written as
 * `$'\t'` is compared as a real tab byte rather than as the two characters `\`
 * and `t`.
 */
function readSplitDelimiter(): string {
  return readSplitDelimiterFor(script);
}

/** Split one emitted line the way the script's `read -r name attached created` does. */
function splitEmittedLine(line: string, delimiter: string): string[] {
  // Mirrors `IFS=<delim> read -r a b c` for a single-character delimiter: at most
  // three fields, remaining content (including the delimiter) stays in the last.
  const parts = line.split(delimiter);
  if (parts.length <= 3) {
    return parts;
  }
  const [first = "", second = "", ...rest] = parts;
  return [first, second, rest.join(delimiter)];
}

/** What bash + tmux actually put on the wire for one session row. */
function emitRow(name: string, attached: string, created: string, format: string): string {
  return format
    .replace("#{session_name}", name)
    .replace("#{session_attached}", attached)
    .replace("#{t:session_created}", created)
    .replace("#{session_created_string}", "");
}

describe("tmux find-sessions.sh session list fields", () => {
  it("splits an emitted session line into name, attached, and created", () => {
    const delimiter = readSplitDelimiter();
    const line = ["alpha", "1", "Sat Sep 12 10:42:07 2026"].join(delimiter);

    expect(splitEmittedLine(line, delimiter)).toEqual(["alpha", "1", "Sat Sep 12 10:42:07 2026"]);
  });

  it("does not use a backslash-t escape as the field separator", () => {
    // A single-quoted `\t` reaches tmux as the two characters `\` and `t`, which
    // tmux does not translate, so the emitted line carries no tab byte at all and
    // a reader splitting on a real tab finds nothing to split on.
    const emitted = String.raw`alpha\t1\tSat Sep 12 10:42:07 2026`;

    expect(emitted).not.toContain("\t");
    expect(splitEmittedLine(emitted, "\t")).toEqual([emitted]);
  });

  it("keeps the format string and the split delimiter in agreement", () => {
    const format = readFormatString();
    const delimiter = readSplitDelimiter();

    // The format must contain the exact character the reader splits on.
    expect(format).toContain(delimiter);

    // And that character must be a real byte, not the two-character escape that
    // tmux passes through untouched.
    expect(format).not.toContain(String.raw`\t`);
    expect(delimiter).not.toBe(String.raw`\t`);
    expect(delimiter.length).toBe(1);
  });

  it("uses a separator that cannot occur in a session name", () => {
    // tmux permits `|` in session names but escapes tabs that appear in names, so
    // a pipe delimiter would corrupt valid sessions while a tab byte is safe.
    expect(readSplitDelimiter()).toBe("\t");
  });

  it("round-trips a session name containing a pipe character", () => {
    const format = readFormatString();
    const delimiter = readSplitDelimiter();

    const row = emitRow("alpha|beta", "1", "Sat Sep 12 10:42:07 2026", format);

    expect(splitEmittedLine(row, delimiter)).toEqual([
      "alpha|beta",
      "1",
      "Sat Sep 12 10:42:07 2026",
    ]);
  });

  it("uses a creation-time variable tmux defines", () => {
    const format = readFormatString();

    expect(format).toContain("#{t:session_created}");
    expect(format).not.toContain("#{session_created_string}");
  });

  it("still emits name, attachment state, and creation time in order", () => {
    const format = readFormatString();
    const delimiter = readSplitDelimiter();

    expect(format.split(delimiter)).toEqual([
      "#{session_name}",
      "#{session_attached}",
      "#{t:session_created}",
    ]);
  });

  it("reports attachment state from the attached field", () => {
    const delimiter = readSplitDelimiter();
    const format = readFormatString();
    const attachedLabel = (row: string): string => {
      const [, attached] = splitEmittedLine(row, delimiter);
      return attached === "1" ? "attached" : "detached";
    };

    // Before the fix the split never happened, so `attached` was always empty and
    // every session rendered as detached even when tmux reported `1`.
    expect(attachedLabel(emitRow("worker", "1", "Sat Sep 12 10:42:07 2026", format))).toBe(
      "attached",
    );
    expect(attachedLabel(emitRow("worker", "0", "Sat Sep 12 10:42:07 2026", format))).toBe(
      "detached",
    );
  });

  it("extracts an ANSI-C quoted delimiter as the character bash would use", () => {
    // Guards the extractor itself: `$'\t'` must decode to a real tab, and the
    // reader lookup must not silently match some other construct.
    expect(readSplitDelimiterFor(`while IFS=$'\\t' read -r name; do`)).toBe("\t");
    expect(readSplitDelimiterFor(`while IFS='|' read -r name; do`)).toBe("|");
    expect(() => readSplitDelimiterFor("list_sessions() { :; }")).toThrow(/IFS=/);
  });
});

/** Same extraction as {@link readFormatString}, against an arbitrary source. */
function readFormatStringFor(source: string): string {
  // The -F argument may concatenate quoting forms, e.g.
  //   -F '#{session_name}'$'\t''#{session_attached}'
  // which bash joins into a single word. Collect every adjacent segment after -F
  // up to the end of the argument (first unquoted whitespace) and decode each.
  const match = /list-sessions\s+-F\s+((?:'[^']*'|\$'(?:[^'\\]|\\.)*'|[^\s'"\\])+)/.exec(source);
  const word = match?.[1];
  if (word === undefined) {
    throw new Error(`no tmux list-sessions -F format string found in ${SCRIPT_PATH}`);
  }
  return decodeShellWord(word);
}

/** Join adjacent bash quoting segments into the single word the shell would pass. */
function decodeShellWord(word: string): string {
  let out = "";
  let i = 0;
  while (i < word.length) {
    const rest = word.slice(i);
    const ansiC = /^\$'((?:[^'\\]|\\.)*)'/.exec(rest);
    if (ansiC?.[1] !== undefined) {
      out += decodeAnsiC(ansiC[1]);
      i += ansiC[0].length;
      continue;
    }
    const single = /^'([^']*)'/.exec(rest);
    if (single?.[1] !== undefined) {
      out += single[1];
      i += single[0].length;
      continue;
    }
    const bare = /^[^\s'"\\]/.exec(rest);
    if (bare) {
      out += bare[0];
      i += 1;
      continue;
    }
    throw new Error(`unparsable -F argument segment: ${JSON.stringify(rest)}`);
  }
  return out;
}

/** Decode the escapes bash interprets inside `$'...'`. */
function decodeAnsiC(body: string): string {
  return body.replace(/\\(.)/g, (_all, ch: string) => {
    switch (ch) {
      case "t":
        return "\t";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      default:
        return ch;
    }
  });
}

/** Same extraction as {@link readSplitDelimiter}, against an arbitrary source. */
function readSplitDelimiterFor(source: string): string {
  const match = /\bIFS=(\$'((?:[^'\\]|\\.)*)'|'([^']*)')/.exec(source);
  const ansiC = match?.[2];
  const literal = match?.[3];
  if (ansiC === undefined && literal === undefined) {
    throw new Error(`no IFS= session reader found in ${SCRIPT_PATH}`);
  }
  return ansiC !== undefined ? decodeAnsiC(ansiC) : (literal ?? "");
}
