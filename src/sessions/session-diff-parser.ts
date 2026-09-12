import { expectDefined } from "@openclaw/normalization-core";
import type { SessionDiffFile } from "../../packages/gateway-protocol/src/index.js";

type FileStatus = SessionDiffFile["status"];
type NameStatusEntry = { path: string; oldPath?: string; status: FileStatus };
type NumstatEntry = { additions: number; deletions: number; binary: boolean };

/** Parses `git diff --name-status -z -M` output; R/C entries consume two paths. */
export function parseNameStatusZ(text: string): NameStatusEntry[] {
  const tokens = text.split("\0");
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
  const tokens = text.split("\0");
  const byPath = new Map<string, NumstatEntry>();
  for (let i = 0; i < tokens.length; i += 1) {
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

function chunkPath(chunk: string): string | null {
  const newFile = /(?:^|\n)\+\+\+ b\/([^\n]+)(?:\n|$)/.exec(chunk);
  if (newFile) {
    return expectDefined(newFile[1], "new file capture group 1");
  }
  // Deleted files have `+++ /dev/null`; key the chunk by the old path.
  const oldFile = /(?:^|\n)--- a\/([^\n]+)(?:\n|$)/.exec(chunk);
  if (oldFile) {
    return expectDefined(oldFile[1], "old file capture group 1");
  }
  // Pure renames and binary chunks have neither marker line.
  const renameTo = /(?:^|\n)rename to ([^\n]+)(?:\n|$)/.exec(chunk);
  if (renameTo) {
    return expectDefined(renameTo[1], "rename to capture group 1");
  }
  const header = /(?:^|\n)diff --git a\/[^\n]+ b\/([^\n]+)(?:\n|$)/.exec(chunk);
  return header ? expectDefined(header[1], "header capture group 1") : null;
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
