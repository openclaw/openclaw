import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { unwrapToolCallForDisplay } from "../../../../src/agents/tool-display-call.js";
import { resolveExecCode, resolveExecTitle } from "../../../../src/agents/tool-display-exec.js";
import {
  MAX_DIFF_RENDER_LINES,
  buildWriteDiffLines,
  computeLineDiff,
  joinDiffSections,
  parseDiffDetailsString,
  splitDiffLines,
  type DiffFilePaths,
  type DiffLine,
  type DiffLineKind,
  type DiffStat,
} from "./tool-call-diff.ts";
import {
  COMMAND_TOOL_NAMES,
  PATCH_TOOL_NAMES,
  resolveToolCallInput,
  type ToolCallKind,
} from "./tool-call-input.ts";

type PatchOperation = "add" | "delete" | "update";

type PatchFileOperation = DiffFilePaths & {
  operation: PatchOperation;
};

type PatchSection = {
  operation: PatchOperation;
  sourcePath: string;
  path: string;
  lines: DiffLine[];
  stat: DiffStat;
};

type PatchCollector = {
  sections: PatchSection[];
  storedRows: number;
  truncated: boolean;
};

type HunkState = {
  oldLine?: number;
  newLine?: number;
  oldLeft?: number;
  newLeft?: number;
};

type PatchViewData = {
  paths: string[];
  fileOperations: PatchFileOperation[];
  lines: DiffLine[];
  stat: DiffStat;
  move?: { from: string; to: string };
};

function startSection(
  collector: PatchCollector,
  operation: PatchOperation,
  path: string,
): PatchSection {
  const normalizedPath = path.trim();
  const section: PatchSection = {
    operation,
    sourcePath: normalizedPath,
    path: normalizedPath,
    lines: [],
    stat: { added: 0, removed: 0 },
  };
  collector.sections.push(section);
  return section;
}

function pushLine(collector: PatchCollector, section: PatchSection, line: DiffLine): void {
  if (line.kind === "add") {
    section.stat.added += 1;
  } else if (line.kind === "del") {
    section.stat.removed += 1;
  }
  if (collector.storedRows < MAX_DIFF_RENDER_LINES) {
    section.lines.push(line);
    collector.storedRows += 1;
  } else {
    collector.truncated = true;
  }
}

function appendHunk(
  collector: PatchCollector,
  section: PatchSection | null,
  raw: string,
  hunk: HunkState | null,
  allowUnnumbered = false,
): HunkState | null {
  if (raw.startsWith("@@")) {
    if (section && section.lines.length > 0 && section.lines.at(-1)?.kind !== "skip") {
      pushLine(collector, section, { kind: "skip", text: "" });
    }
    const match = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    return match
      ? {
          oldLine: Number.parseInt(match[1] ?? "", 10),
          oldLeft: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
          newLine: Number.parseInt(match[3] ?? "", 10),
          newLeft: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
        }
      : {};
  }
  if (
    section &&
    (hunk || allowUnnumbered) &&
    (raw.startsWith("+") ||
      raw.startsWith("-") ||
      raw.startsWith(" ") ||
      (allowUnnumbered && raw === ""))
  ) {
    const kind: DiffLineKind = raw.startsWith("+") ? "add" : raw.startsWith("-") ? "del" : "ctx";
    const lineNo = kind === "del" ? hunk?.oldLine : hunk?.newLine;
    // Context consumes both sides together; unnumbered patch hunks keep both absent.
    if (hunk && (kind !== "ctx" || (hunk.oldLine !== undefined && hunk.newLine !== undefined))) {
      if (kind !== "add" && hunk.oldLine !== undefined) {
        hunk.oldLine += 1;
        hunk.oldLeft = Math.max(0, (hunk.oldLeft ?? 0) - 1);
      }
      if (kind !== "del" && hunk.newLine !== undefined) {
        hunk.newLine += 1;
        hunk.newLeft = Math.max(0, (hunk.newLeft ?? 0) - 1);
      }
    }
    pushLine(collector, section, {
      kind,
      ...(lineNo !== undefined ? { lineNo } : {}),
      text: raw.slice(1),
    });
    return hunk?.oldLeft === 0 && hunk.newLeft === 0 ? null : hunk;
  }
  return hunk;
}

function sectionLabel(section: PatchSection): string {
  if (section.operation === "update" && section.path !== section.sourcePath) {
    return `Move ${section.sourcePath} → ${section.path}`;
  }
  const verb =
    section.operation === "add" ? "Add" : section.operation === "delete" ? "Delete" : "Update";
  return `${verb} ${section.path}`;
}

function finish(collector: PatchCollector): PatchViewData | null {
  if (collector.sections.length === 0) {
    return null;
  }
  const paths = [...new Set(collector.sections.map((section) => section.path).filter(Boolean))];
  const fileOperations = collector.sections.map(({ operation, path, sourcePath }) => ({
    operation,
    path,
    ...(operation === "update" && sourcePath !== path ? { oldPath: sourcePath } : {}),
  }));
  const stat = collector.sections.reduce(
    (sum, section) => ({
      added: sum.added + section.stat.added,
      removed: sum.removed + section.stat.removed,
    }),
    { added: 0, removed: 0 },
  );
  const lines: DiffLine[] = [];
  let clipped = collector.truncated;
  const append = (line: DiffLine) => {
    if (lines.length < MAX_DIFF_RENDER_LINES) {
      lines.push(line);
    } else {
      clipped = true;
    }
  };
  for (const [index, section] of collector.sections.entries()) {
    if (collector.sections.length > 1) {
      if (lines.length > 0 && lines.at(-1)?.kind !== "skip") {
        append({ kind: "skip", text: "" });
      }
      append({
        kind: "file",
        path: section.path,
        ...("oldPath" in fileOperations[index]! ? { oldPath: section.sourcePath } : {}),
        text: sectionLabel(section),
      });
    }
    for (const line of section.lines) {
      append(line);
    }
  }
  if (clipped && lines.at(-1)?.kind !== "skip") {
    lines.push({ kind: "skip", text: "" });
  }
  const only = collector.sections.length === 1 ? collector.sections.at(0) : undefined;
  const move =
    only && only.operation === "update" && only.sourcePath !== only.path
      ? { from: only.sourcePath, to: only.path }
      : undefined;
  return { paths, fileOperations, lines, stat, ...(move ? { move } : {}) };
}

function normalizeUnifiedPath(raw: string): string {
  const path = raw.split("\t", 1)[0]?.trim() ?? "";
  return path.replace(/^[ab]\//, "");
}

function parsePatchView(args: unknown): PatchViewData | null {
  const record = asRecord(args);
  if (!record) {
    return null;
  }
  if (Array.isArray(record.changes)) {
    const structuredCollector: PatchCollector = { sections: [], storedRows: 0, truncated: false };
    for (const value of record.changes) {
      const change = asRecord(value);
      const sourcePath = readNonBlankString(change?.path)?.trim();
      if (!change || !sourcePath) {
        continue;
      }
      const operationValue = change.kind;
      const rawKind =
        typeof operationValue === "string" ? operationValue : asRecord(operationValue)?.type;
      const operation: PatchOperation =
        rawKind === "add" || rawKind === "delete" ? rawKind : "update";
      const section = startSection(structuredCollector, operation, sourcePath);
      const movePath = readNonBlankString(
        asRecord(change.kind)?.move_path ?? asRecord(change.kind)?.movePath,
      );
      if (movePath) {
        section.path = movePath.trim();
      }
      if (typeof change.diff === "string") {
        if (operation === "update") {
          let hunk: HunkState | null = null;
          for (const raw of splitDiffLines(change.diff)) {
            hunk = appendHunk(structuredCollector, section, raw, hunk);
          }
        } else {
          const kind = operation === "add" ? "add" : "del";
          for (const [index, text] of splitDiffLines(change.diff).entries()) {
            pushLine(structuredCollector, section, { kind, lineNo: index + 1, text });
          }
        }
      }
      const statRecord = asRecord(change.stat);
      const added = statRecord?.added;
      const removed = statRecord?.removed;
      const exactStat =
        typeof added === "number" && typeof removed === "number" && added >= 0 && removed >= 0
          ? { added: Math.trunc(added), removed: Math.trunc(removed) }
          : null;
      if (exactStat) {
        section.stat = exactStat;
      }
      structuredCollector.truncated ||= change.diffTruncated === true;
    }
    const structured = finish(structuredCollector);
    if (structured) {
      return structured;
    }
  }
  const text =
    readNonBlankString(record.patch) ??
    readNonBlankString(record.input) ??
    readNonBlankString(record.diff);
  if (!text) {
    return null;
  }
  const codex = /(?:^|\n)\s*\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:)/.test(text);
  const collector: PatchCollector = { sections: [], storedRows: 0, truncated: false };
  const rawLines = splitDiffLines(text);
  let current: PatchSection | null = null;
  let hunk: HunkState | null = null;
  let awaitingGitHeaders = false;
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index]!;
    if (codex) {
      const structural = current?.operation === "update" ? raw.trimEnd() : raw.trim();
      const fileMatch = structural.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
      if (fileMatch) {
        current = startSection(
          collector,
          // SAFETY: The header regex only matches Update, Add, or Delete.
          fileMatch[1]!.toLowerCase() as PatchOperation,
          fileMatch[2]!,
        );
        hunk = null;
        continue;
      }
      const moveMatch =
        current?.operation === "update" ? structural.match(/^\*\*\* Move to: (.+)$/) : null;
      if (moveMatch && current) {
        current.path = moveMatch[1]?.trim() ?? current.path;
        continue;
      }
      if (
        structural === "*** Begin Patch" ||
        structural === "*** End Patch" ||
        structural === "*** End of File" ||
        structural.startsWith("*** Environment ID:") ||
        !current
      ) {
        continue;
      }
      if (current.operation === "add" && raw.startsWith("+")) {
        pushLine(collector, current, {
          kind: "add",
          lineNo: current.stat.added + 1,
          text: raw.slice(1),
        });
      }
      if (current.operation !== "update") {
        continue;
      }
    } else {
      const gitHeader = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (gitHeader) {
        current = startSection(collector, "update", gitHeader[2]!);
        current.sourcePath = gitHeader[1]!;
        hunk = null;
        awaitingGitHeaders = true;
        continue;
      }
      const next = rawLines[index + 1];
      if (!hunk && raw.startsWith("--- ") && next?.startsWith("+++ ")) {
        const oldPath = normalizeUnifiedPath(raw.slice(4));
        const newPath = normalizeUnifiedPath(next.slice(4));
        const operation: PatchOperation =
          oldPath === "/dev/null" ? "add" : newPath === "/dev/null" ? "delete" : "update";
        const targetPath = newPath === "/dev/null" ? oldPath : newPath;
        const section: PatchSection =
          awaitingGitHeaders && current ? current : startSection(collector, operation, targetPath);
        section.operation = operation;
        section.sourcePath = oldPath || section.sourcePath;
        section.path = targetPath || section.path;
        current = section;
        awaitingGitHeaders = false;
        index += 1;
        continue;
      }
      if (raw.startsWith("@@")) {
        awaitingGitHeaders = false;
      }
      if (/^index |^new file mode |^deleted file mode |^similarity index /.test(raw)) {
        continue;
      }
    }
    hunk = appendHunk(collector, current, raw, hunk, codex);
  }
  return finish(collector);
}

type ToolCallViewSource = {
  name: string;
  args?: unknown;
  details?: unknown;
};

export type ToolCallView = {
  kind: ToolCallKind;
  /** Agent-supplied purpose for execution tools; does not describe their outcome. */
  title?: string;
  /** Full command text for `command` rows (first line shown collapsed). */
  command?: string;
  /** JavaScript source for code-mode execution, rendered without shell highlighting. */
  code?: string;
  /** File basename or primary target shown bold in the row. */
  target?: string;
  /** Dimmed secondary detail (directory, query scope, URL host…). */
  targetDetail?: string;
  diff?: DiffLine[];
  stat?: DiffStat;
  /** Producer-recorded operations for patch rows. */
  fileOperations?: PatchFileOperation[];
};

function splitPathForDisplay(path: string): { base: string; dir?: string } {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) {
    return { base: normalized || path };
  }
  return { base: normalized.slice(slash + 1), dir: normalized.slice(0, slash) };
}

type ResolvedEditDiff = { diff: DiffLine[]; stat?: DiffStat };

const MAX_LOCAL_DIFF_PAIRS = 8;
const MAX_LOCAL_DIFF_INPUT_CHARS = 120_000;

function resolveEditDiff(args: Record<string, unknown> | null): ResolvedEditDiff | null {
  if (!args) {
    return null;
  }
  const pairs: { oldText: string; newText: string }[] = [];
  let inputChars = 0;
  let truncated = false;
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  for (const [index, entry] of edits.entries()) {
    if (index >= MAX_LOCAL_DIFF_PAIRS) {
      truncated = true;
      break;
    }
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const oldText = record.oldText ?? record.old_string ?? record.oldString ?? record.old_str;
    const newText = record.newText ?? record.new_string ?? record.newString ?? record.new_str;
    if (typeof oldText === "string" && typeof newText === "string") {
      const pairChars = oldText.length + newText.length;
      if (inputChars + pairChars > MAX_LOCAL_DIFF_INPUT_CHARS) {
        truncated = true;
        break;
      }
      inputChars += pairChars;
      pairs.push({ oldText, newText });
    }
  }
  if (pairs.length === 0) {
    return truncated ? { diff: [{ kind: "skip", text: "" }] } : null;
  }
  const sections = pairs.map((pair) => computeLineDiff(pair.oldText, pair.newText));
  const result = joinDiffSections(sections, { truncated });
  if (result.lines.length === 0) {
    return null;
  }
  return {
    diff: result.lines,
    ...(result.kind === "complete" ? { stat: result.stat } : {}),
  };
}

function readDetailsDiff(details: unknown): ResolvedEditDiff | null {
  const record = asRecord(details);
  const diffText = readNonBlankString(record?.diff);
  if (!diffText) {
    return null;
  }
  const lines = parseDiffDetailsString(diffText);
  if (!lines) {
    return null;
  }
  return {
    diff: lines.lines,
    ...(lines.kind === "complete" ? { stat: lines.stat } : {}),
  };
}

function resolveInsertionDiff(args: Record<string, unknown> | null): ResolvedEditDiff | null {
  const insertText = readNonBlankString(args?.insert_text);
  if (!insertText) {
    return null;
  }
  const lines = computeLineDiff("", insertText).lines;
  // The text is known, but its surrounding file context is not. Omit an exact
  // stat rather than implying this preview represents the final placement.
  return lines.length > 0 ? { diff: lines } : null;
}

// Cache entries remember which details object they were built from: live tool
// rows first render with args only and gain result `details` (e.g. the edit
// diff) later on the same args identity, which must invalidate the cache.
const toolCallViewCache = new WeakMap<
  object,
  { details: unknown; name: string; view: ToolCallView }
>();

export function resolveToolCallView(source: ToolCallViewSource): ToolCallView {
  const call = unwrapToolCallForDisplay(source);
  const args = asRecord(call.args);
  const cacheKey = args ?? asRecord(source.details);
  const name = call.name.trim().toLowerCase();
  if (cacheKey) {
    const cached = toolCallViewCache.get(cacheKey);
    if (cached && cached.details === source.details && cached.name === name) {
      return cached.view;
    }
  }
  const view = buildToolCallView(source, args, name);
  if (cacheKey) {
    toolCallViewCache.set(cacheKey, { details: source.details, name, view });
  }
  return view;
}

function buildToolCallView(
  source: ToolCallViewSource,
  args: Record<string, unknown> | null,
  key: string,
): ToolCallView {
  const input = resolveToolCallInput(key, args);
  const { kind, editorCommand } = input;

  if (kind === "command") {
    const command = readNonBlankString(args?.command);
    // Display the inner command from a harness's sh -lc wrapper.
    const shellWrapper = command?.match(
      /^\s*(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]+)\1\s*$/,
    );
    return {
      kind,
      title: COMMAND_TOOL_NAMES.has(key) ? resolveExecTitle(args) : undefined,
      command: shellWrapper?.[2] ?? command,
      code: resolveExecCode(args),
    };
  }

  if (kind === "edit" && PATCH_TOOL_NAMES.has(key)) {
    const patch = parsePatchView(args);
    if (!patch) {
      return { kind: "generic" };
    }
    const view: ToolCallView = {
      kind: "edit",
      fileOperations: patch.fileOperations,
      diff: patch.lines,
      stat: patch.stat,
    };
    if (patch.paths.length > 1) {
      return { ...view, target: `${patch.paths.length} files` };
    }
    if (patch.move) {
      const from = splitPathForDisplay(patch.move.from);
      const to = splitPathForDisplay(patch.move.to);
      const commonDir = from.dir === to.dir ? from.dir : undefined;
      return {
        ...view,
        target: commonDir ? `${from.base} → ${to.base}` : `${patch.move.from} → ${patch.move.to}`,
        targetDetail: commonDir,
      };
    }
    const pathParts = patch.paths[0] ? splitPathForDisplay(patch.paths[0]) : null;
    return {
      ...view,
      target: pathParts?.base,
      targetDetail: pathParts?.dir,
    };
  }

  if (kind === "read" || kind === "edit" || kind === "write") {
    const path = input.path;
    if (!path) {
      return { kind: "generic" };
    }
    const { base, dir } = splitPathForDisplay(path);
    const view: ToolCallView = { kind, target: base, targetDetail: dir };
    if (kind === "read") {
      return view;
    }

    const authoritativeDiff = readDetailsDiff(source.details);
    if (authoritativeDiff) {
      return { ...view, ...authoritativeDiff };
    }
    if (kind === "edit") {
      const diff =
        editorCommand === "insert"
          ? resolveInsertionDiff(args)
          : editorCommand === "undo_edit"
            ? null
            : resolveEditDiff(args);
      return { ...view, ...diff };
    }
    const details = asRecord(source.details);
    if (details?.changed === false) {
      return view;
    }
    const content = readNonBlankString(
      args?.[editorCommand === "create" ? "file_text" : "content"],
    );
    if (!content) {
      return view;
    }
    const diff = buildWriteDiffLines(content);
    return {
      ...view,
      diff,
      // Present details need created=true before zero removals are authoritative.
      ...(details && details.created !== true
        ? {}
        : { stat: { added: splitDiffLines(content).length, removed: 0 } }),
    };
  }

  if (kind === "search") {
    const pattern =
      readNonBlankString(args?.pattern) ??
      readNonBlankString(args?.query) ??
      readNonBlankString(args?.glob);
    const path = input.path;
    if (!pattern && !path) {
      return { kind: "generic" };
    }
    return { kind, target: pattern ?? path, targetDetail: pattern ? path : undefined };
  }

  if (kind === "fetch") {
    const url = readNonBlankString(args?.url);
    if (!url) {
      return { kind: "generic" };
    }
    return { kind, target: url };
  }

  return { kind: "generic" };
}
