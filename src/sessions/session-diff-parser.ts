import { expectDefined } from "@openclaw/normalization-core";
import type { SessionDiffFile } from "../../packages/gateway-protocol/src/index.js";

type FileStatus = SessionDiffFile["status"];
type NameStatusEntry = { path: string; oldPath?: string; status: FileStatus };
type NumstatEntry = { additions: number; deletions: number; binary: boolean };

/** Parses `git diff --name-status -z -M` output; R/C entries consume two paths. */
export function parseNameStatusZ(text: string): NameStatusEntry[] {
  return parseNameStatusTokens(text.split("\0"));
}

function parseNameStatusTokens(tokens: readonly string[]): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    if (!code) {
      continue;
    }
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i + 1];
      const path = tokens[i + 2];
      i += 2;
      if (path) {
        entries.push({ path, oldPath, status: letter === "R" ? "renamed" : "added" });
      }
      continue;
    }
    const path = tokens[i + 1];
    i += 1;
    if (!path) {
      continue;
    }
    const status: FileStatus = letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
    entries.push({ path, status });
  }
  return entries;
}

/** Parses `git diff --numstat -z -M`; rename entries put paths in follow-up tokens. */
export function parseNumstatZ(text: string): Map<string, NumstatEntry> {
  return parseNumstatTokens(text.split("\0"), 0);
}

function parseNumstatTokens(tokens: readonly string[], start: number): Map<string, NumstatEntry> {
  const byPath = new Map<string, NumstatEntry>();
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    const [added, deleted, ...pathParts] = token.split("\t");
    const inlinePath = pathParts.join("\t");
    if (added === undefined || deleted === undefined) {
      continue;
    }
    const binary = added === "-";
    const entry: NumstatEntry = {
      additions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      binary,
    };
    if (inlinePath) {
      byPath.set(inlinePath, entry);
      continue;
    }
    // Rename: `a\tb\t` token, then old and new path tokens; key by new path.
    const path = tokens[i + 2];
    i += 2;
    if (path) {
      byPath.set(path, entry);
    }
  }
  return byPath;
}

/** Git emits all raw records before the numstat records in `--raw --numstat -z`. */
export function parseDiffInventoryZ(text: string): {
  entries: NameStatusEntry[];
  numstat: Map<string, NumstatEntry>;
} {
  const tokens = text.split("\0");
  const nameStatus: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const header = tokens[index];
    if (!header?.startsWith(":")) {
      break;
    }
    const code = header.slice(header.lastIndexOf(" ") + 1);
    const pathCount = code[0] === "R" || code[0] === "C" ? 2 : 1;
    nameStatus.push(code, ...tokens.slice(index + 1, index + pathCount + 1));
    index += pathCount + 1;
  }
  return {
    entries: parseNameStatusTokens(nameStatus),
    numstat: parseNumstatTokens(tokens, index),
  };
}

const GIT_PATH_ESCAPES: Record<string, string> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

function decodeGitPath(value: string): string {
  if (!value.startsWith('"')) {
    return value;
  }
  // Git's octal escapes encode bytes, including individual UTF-8 bytes.
  const bytes = Buffer.from(value.slice(1, -1)).toString("latin1");
  const decoded = bytes.replace(/\\([0-3][0-7]{2}|[abfnrtv"\\])/g, (_, escape: string) =>
    escape.length === 3
      ? String.fromCharCode(Number.parseInt(escape, 8))
      : (GIT_PATH_ESCAPES[escape] ?? escape),
  );
  return Buffer.from(decoded, "latin1").toString("utf8");
}

function chunkPath(chunk: string): string | null {
  const newFile = /(?:^|\n)\+\+\+ (b\/[^\t\n]+|"b\/[^\n]+")\t?(?:\n|$)/.exec(chunk);
  if (newFile) {
    return decodeGitPath(expectDefined(newFile[1], "new file capture group 1")).slice(2);
  }
  // Deleted files have `+++ /dev/null`; key the chunk by the old path.
  const oldFile = /(?:^|\n)--- (a\/[^\t\n]+|"a\/[^\n]+")\t?(?:\n|$)/.exec(chunk);
  if (oldFile) {
    return decodeGitPath(expectDefined(oldFile[1], "old file capture group 1")).slice(2);
  }
  // Pure renames and binary chunks have neither marker line.
  const renameTo = /(?:^|\n)rename to ([^\n]+)(?:\n|$)/.exec(chunk);
  if (renameTo) {
    return decodeGitPath(expectDefined(renameTo[1], "rename to capture group 1"));
  }
  // Header-only changes keep the same path; renames were handled above.
  const header =
    /(?:^|\n)diff --git (?:"a\/((?:\\.|[^"\\\n])*)" "b\/\1"|a\/([^\n]+) b\/\2)(?:\n|$)/.exec(chunk);
  if (!header) {
    return null;
  }
  return header[1] === undefined
    ? expectDefined(header[2], "header capture group 2")
    : decodeGitPath(`"${header[1]}"`);
}

/** Splits a multi-file `git diff --patch` into per-file chunks keyed by path. */
export function splitPatchByFile(patch: string): Map<string, string> {
  const byPath = new Map<string, string>();
  if (!patch.trim()) {
    return byPath;
  }
  // Git records end at LF; JavaScript multiline anchors also match content CRs.
  const parts = patch.split(/(?<=\n)(?=diff --git )/);
  for (const part of parts) {
    if (!part.startsWith("diff --git ")) {
      continue;
    }
    const path = chunkPath(part);
    if (path) {
      byPath.set(path, part);
    }
  }
  return byPath;
}
