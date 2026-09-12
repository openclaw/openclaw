// Tmux find-sessions tests cover the session-list field parsing contract.
//
// The skill script parses `tmux list-sessions -F` output by reading one line per
// session and splitting it on the delimiter present in the format string. These
// tests pin that contract in two layers:
//
//   1. The separator actually emitted by the format string must be the same
//      separator the reader splits on. A literal `\t` inside single quotes is
//      passed to tmux as backslash + t (tmux does not interpret escapes in -F
//      output), so it never becomes a tab and the whole line lands in the first
//      field. This is asserted by a real read/split, not by string comparison.
//   2. The creation-time variable must exist in tmux. `#{session_created_string}`
//      does not; it expands to the empty string. `#{t:session_created}` is the
//      supported strftime form.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "skills/tmux/scripts/find-sessions.sh";

const script = readFileSync(SCRIPT_PATH, "utf8");

/** The `-F` format string passed to `tmux list-sessions`. */
function readFormatString(): string {
  const match = /list-sessions -F '([^']*)'/.exec(script);
  const captured = match?.[1];
  if (captured === undefined) {
    throw new Error(`no tmux list-sessions -F format string found in ${SCRIPT_PATH}`);
  }
  return captured;
}

/**
 * The `IFS=` delimiter the reader splits each emitted line on.
 * Matches both `IFS='|'` and `IFS=$'\t'` spellings.
 */
function readSplitDelimiter(): string {
  const match = /while IFS=(\$\?'[^']*'|'[^']*') read -r/.exec(script);
  const raw = match?.[1];
  if (raw === undefined) {
    throw new Error(`no IFS= read -r session reader found in ${SCRIPT_PATH}`);
  }
  const quoted = raw.startsWith("$?") ? raw.slice(2) : raw;
  const literal = quoted.slice(1, -1);
  if (raw.startsWith("$?")) {
    // ANSI-C quoting: interpret the one escape form the script is expected to use.
    return literal.replace(/\\t/g, "\t").replace(/\\n/g, "\n");
  }
  return literal;
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

describe("tmux find-sessions.sh session list fields", () => {
  it("splits an emitted session line into name, attached, and created", () => {
    const delimiter = readSplitDelimiter();
    const line = ["alpha", "1", "Sat Sep 12 10:42:07 2026"].join(delimiter);

    expect(splitEmittedLine(line, delimiter)).toEqual(["alpha", "1", "Sat Sep 12 10:42:07 2026"]);
  });

  it("does not use a backslash-t escape as the field separator", () => {
    // A single-quoted `\t` reaches tmux as the two characters `\` and `t`, which
    // tmux does not translate, so the emitted line contains no tab byte at all.
    // The reader would then split on a real tab and find nothing to split on.
    const emitted = String.raw`alpha\t1\tSat Sep 12 10:42:07 2026`;

    expect(emitted).not.toContain("\t");
    expect(splitEmittedLine(emitted, "\t")).toEqual([emitted]);
    expect(splitEmittedLine(emitted, "\t")).toHaveLength(1);
  });

  it("keeps the format string and the split delimiter in agreement", () => {
    const format = readFormatString();
    const delimiter = readSplitDelimiter();

    // The format string must actually contain the delimiter the reader splits on.
    expect(format).toContain(delimiter);

    // And that delimiter must be a real character, not the two-character escape.
    expect(format).not.toContain("\\t");
    expect(delimiter).not.toBe("\\t");
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
    const attachedLabel = (line: string): string => {
      const [, attached] = splitEmittedLine(line, delimiter);
      return attached === "1" ? "attached" : "detached";
    };

    // Before the fix the split never happened, so `attached` was always empty and
    // every session rendered as detached even when tmux reported `1`.
    expect(attachedLabel(["worker", "1", "Sat Sep 12 10:42:07 2026"].join(delimiter))).toBe(
      "attached",
    );
    expect(attachedLabel(["worker", "0", "Sat Sep 12 10:42:07 2026"].join(delimiter))).toBe(
      "detached",
    );
  });
});
