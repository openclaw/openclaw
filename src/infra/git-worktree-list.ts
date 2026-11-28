import path from "node:path";
import { unquoteGitPath } from "./git-path-quote.js";

const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const WORKTREE_LIST_ARGS = ["worktree", "list", "--porcelain", "-z"];
const LEGACY_WORKTREE_LIST_ARGS = ["worktree", "list", "--porcelain"];

type WorktreeListResult = {
  termination: string;
  code: number | null;
  stdout: string;
};

function invalidLegacyOutput(): never {
  throw new Error(
    "git worktree list --porcelain fallback returned ambiguous output; use Git 2.36 or newer",
  );
}

function decodeLegacyReason(value: string): string {
  if (!value.startsWith('"')) {
    return value;
  }
  const encoded = Buffer.from(value);
  const decoded = unquoteGitPath(encoded);
  if (!decoded || decoded.end !== encoded.length) {
    return invalidLegacyOutput();
  }
  return decoded.bytes.toString("utf8");
}

function normalizeLegacyRecord(lines: string[], index: number): string[] {
  const fields: string[] = [];
  const worktree = lines[0];
  if (!worktree?.startsWith("worktree ")) {
    return invalidLegacyOutput();
  }
  const worktreePath = worktree.slice("worktree ".length);
  if (!path.isAbsolute(worktreePath)) {
    return invalidLegacyOutput();
  }
  fields.push(worktree);

  let cursor = 1;
  if (lines[cursor] === "bare") {
    if (index !== 0 || lines.length !== 2) {
      return invalidLegacyOutput();
    }
    fields.push("bare");
    return fields;
  }

  const head = lines[cursor++];
  if (!head?.startsWith("HEAD ") || !OID.test(head.slice("HEAD ".length))) {
    return invalidLegacyOutput();
  }
  fields.push(head);

  const state = lines[cursor++];
  if (state === "detached" || state?.startsWith("branch refs/")) {
    fields.push(state);
  } else {
    return invalidLegacyOutput();
  }

  const locked = lines[cursor];
  if (locked === "locked") {
    fields.push(locked);
    cursor += 1;
  } else if (locked?.startsWith("locked ")) {
    fields.push(`locked ${decodeLegacyReason(locked.slice("locked ".length))}`);
    cursor += 1;
  }

  const prunable = lines[cursor];
  if (prunable === "prunable") {
    fields.push(prunable);
    cursor += 1;
  } else if (prunable?.startsWith("prunable ")) {
    fields.push(`prunable ${decodeLegacyReason(prunable.slice("prunable ".length))}`);
    cursor += 1;
  }

  if (cursor !== lines.length) {
    return invalidLegacyOutput();
  }
  return fields;
}

function normalizeLegacyWorktreeList(output: string): string {
  if (!output || output.includes("\0") || !output.endsWith("\n")) {
    return invalidLegacyOutput();
  }
  const records: string[][] = [];
  let record: string[] = [];
  for (const rawLine of output.slice(0, -1).split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line) {
      record.push(line);
      continue;
    }
    if (record.length === 0) {
      return invalidLegacyOutput();
    }
    records.push(normalizeLegacyRecord(record, records.length));
    record = [];
  }
  if (record.length > 0 || records.length === 0) {
    return invalidLegacyOutput();
  }
  return records.map((fields) => `${fields.join("\0")}\0\0`).join("");
}

export async function readCompatibleGitWorktreeList<Result extends WorktreeListResult>(
  run: (args: string[]) => Promise<Result>,
  requireOutput: (command: string, result: Result) => string,
): Promise<string> {
  const result = await run([...WORKTREE_LIST_ARGS]);
  if (result.termination !== "exit" || result.code !== 129) {
    return requireOutput("git worktree list", result);
  }
  const fallback = await run([...LEGACY_WORKTREE_LIST_ARGS]);
  return normalizeLegacyWorktreeList(requireOutput("git worktree list --porcelain", fallback));
}
