import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";

export const WORK_ROUTING_LANES = [
  "direct-codex",
  "codex-superpowers-harness",
  "codex-multi-agent-harness",
  "run-harness",
  "ralph",
] as const;

export type WorkRoutingLane = (typeof WORK_ROUTING_LANES)[number];

export type WorkRoutingExplanation = {
  lane: WorkRoutingLane;
  label: string;
  useWhen: string;
  notFor: string;
  supervision: string;
};

export type RunHarnessTaskSummary = {
  id: string;
  title: string;
  status: string;
  risk?: string;
  dependsOn: string[];
};

export type RunHarnessStageSummary = {
  id: string;
  taskId?: string;
  title: string;
  status: string;
};

export type RunHarnessGateSummary = {
  id: string;
  title: string;
  status: string;
  path?: string;
  requiresExplicitApproval: true;
  canAutoApprove: false;
};

export type RunHarnessEvidenceSummary = {
  receipts: string[];
  reviews: string[];
  verification: string[];
};

export type RunHarnessBlockerSummary = {
  kind: "task" | "stage" | "failure" | "gate";
  id: string;
  title: string;
  status?: string;
  path?: string;
  summary?: string;
};

export type DurableWorkSupervisionSummary = {
  schemaVersion: 1;
  source: "run-harness-safe-artifacts";
  runId: string;
  runRoot: string;
  routing: WorkRoutingExplanation[];
  tasks: RunHarnessTaskSummary[];
  stages: RunHarnessStageSummary[];
  gates: RunHarnessGateSummary[];
  blockers: RunHarnessBlockerSummary[];
  evidence: RunHarnessEvidenceSummary;
  safety: {
    privateArtifactPolicy: string;
    gatesAutoApproved: false;
  };
  sourcesRead: string[];
  loadErrors: string[];
};

type UnknownRecord = Record<string, unknown>;

const ROUTING_EXPLANATIONS: WorkRoutingExplanation[] = [
  {
    lane: "direct-codex",
    label: "Direct Codex",
    useWhen:
      "Small deterministic local work where chat context plus normal verification is enough.",
    notFor:
      "Durable multi-phase jobs, formal gates, reviewer loops, or work that must survive context loss.",
    supervision: "OpenClaw can record local status, but durable state is not the owner.",
  },
  {
    lane: "codex-superpowers-harness",
    label: "codex-superpowers-harness",
    useWhen:
      "Automation-heavy work such as browser/account read-only inspection, visual checks, reports, reviewer loops, or failure recovery.",
    notFor:
      "Long formal task graphs that need Run Harness gates and artifact registry as completion authority.",
    supervision:
      "Harness artifacts and review outputs should be summarized back into OpenClaw status.",
  },
  {
    lane: "codex-multi-agent-harness",
    label: "codex-multi-agent-harness",
    useWhen:
      "Complex work that splits cleanly across worker, reviewer, verifier, or specialist roles.",
    notFor: "Single-agent low-risk edits where direct Codex is simpler.",
    supervision: "OpenClaw should expose worker/reviewer/verifier evidence, not raw transcripts.",
  },
  {
    lane: "run-harness",
    label: "Run Harness",
    useWhen:
      "Durable autonomous runs with formal phases, artifacts, gates, receipts, reviews, verification, and resumable state.",
    notFor: "Small or medium deterministic tasks that do not need durable completion authority.",
    supervision:
      "Run Harness state is summarized only from approved artifacts; pending gates are surfaced and never auto-approved.",
  },
  {
    lane: "ralph",
    label: "Ralph",
    useWhen:
      "A delegated executor or future adapter owns an isolated subtask under a durable supervisor.",
    notFor: "Untracked local side effects or actions that bypass OpenClaw/Run Harness gates.",
    supervision:
      "OpenClaw should treat Ralph as an adapter lane and require registered artifacts, blockers, and gate evidence.",
  },
];

const ROOT_SAFE_FILES = new Set([
  "artifacts.json",
  "environment.json",
  "ENVIRONMENT.md",
  "expert-graph.json",
  "expert-graph.md",
  "GOAL.md",
  "plan.md",
  "PROGRESS.md",
  "request.md",
  "stage-manifest.json",
  "state.json",
  "task-graph.json",
]);

const SAFE_MARKDOWN_DIRS = new Set(["failures", "gates", "receipts", "reviews", "verification"]);
const PRIVATE_PATH_SEGMENTS = new Set(["auth", "cache", "logs", "prompts"]);
const PRIVATE_FILE_PATTERNS = [/\.sqlite(?:3)?$/i, /\.db$/i, /\.wal$/i, /\.shm$/i, /transcript/i];
const BLOCKING_TASK_STATUSES = new Set(["blocked", "failed", "needs_decision"]);
const BLOCKING_STAGE_STATUSES = new Set(["blocked", "failed", "needs_decision"]);

export function listWorkRoutingExplanations(): WorkRoutingExplanation[] {
  return ROUTING_EXPLANATIONS.map((entry) => ({ ...entry }));
}

export function explainWorkRouting(lane: WorkRoutingLane): WorkRoutingExplanation {
  return { ...ROUTING_EXPLANATIONS.find((entry) => entry.lane === lane)! };
}

function readString(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readStringArray(record: UnknownRecord, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeRunRoot(runRoot: string): string {
  return resolve(runRoot);
}

function relativeRunPath(runRoot: string, path: string): string {
  return relative(runRoot, path).split(sep).join("/");
}

function isInsideRunRoot(runRoot: string, path: string): boolean {
  const rel = relative(runRoot, path);
  return Boolean(rel) && !rel.startsWith("..") && !rel.startsWith(sep);
}

export function isAllowedRunHarnessArtifactPath(runRootInput: string, pathInput: string): boolean {
  const runRoot = normalizeRunRoot(runRootInput);
  const path = resolve(pathInput);
  if (!isInsideRunRoot(runRoot, path)) {
    return false;
  }
  const rel = relativeRunPath(runRoot, path);
  const parts = rel.split("/");
  if (parts.some((part) => PRIVATE_PATH_SEGMENTS.has(part))) {
    return false;
  }
  if (parts.some((part) => PRIVATE_FILE_PATTERNS.some((pattern) => pattern.test(part)))) {
    return false;
  }
  if (parts.length === 1) {
    return ROOT_SAFE_FILES.has(parts[0]) && isSafePhysicalRunArtifact(runRoot, path);
  }
  return (
    parts.length === 2 &&
    SAFE_MARKDOWN_DIRS.has(parts[0]) &&
    extname(parts[1]) === ".md" &&
    isSafePhysicalRunArtifact(runRoot, path)
  );
}

function isSafePhysicalRunArtifact(runRoot: string, path: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return false;
    }
    const realRoot = realpathSync(runRoot);
    const realPath = realpathSync(path);
    return isInsideRunRoot(realRoot, realPath);
  } catch {
    return false;
  }
}

function readSafeText(params: {
  runRoot: string;
  path: string;
  sourcesRead: string[];
  loadErrors: string[];
}): string | null {
  if (!isAllowedRunHarnessArtifactPath(params.runRoot, params.path)) {
    params.loadErrors.push(
      `${relativeRunPath(params.runRoot, params.path)}: artifact path is not allowed`,
    );
    return null;
  }
  try {
    const text = readFileSync(params.path, "utf8");
    params.sourcesRead.push(relativeRunPath(params.runRoot, params.path));
    return text;
  } catch (error) {
    params.loadErrors.push(
      `${relativeRunPath(params.runRoot, params.path)}: ${
        error instanceof Error ? error.message : "read failed"
      }`,
    );
    return null;
  }
}

function readSafeJson(params: {
  runRoot: string;
  filename: string;
  sourcesRead: string[];
  loadErrors: string[];
}): unknown {
  const path = join(params.runRoot, params.filename);
  if (!existsSync(path)) {
    return undefined;
  }
  const text = readSafeText({
    runRoot: params.runRoot,
    path,
    sourcesRead: params.sourcesRead,
    loadErrors: params.loadErrors,
  });
  if (text === null) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    params.loadErrors.push(
      `${params.filename}: ${error instanceof Error ? error.message : "JSON parse failed"}`,
    );
    return undefined;
  }
}

function recordArray(value: unknown, key: string): UnknownRecord[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const records = (value as UnknownRecord)[key];
  return Array.isArray(records)
    ? records.filter(
        (item): item is UnknownRecord =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

function parseTasks(taskGraph: unknown): RunHarnessTaskSummary[] {
  return recordArray(taskGraph, "tasks").map((task) => {
    const id = readString(task, "id").trim();
    const risk = readString(task, "risk").trim();
    const summary: RunHarnessTaskSummary = {
      id,
      title: readString(task, "title").trim() || id,
      status: readString(task, "status").trim() || "unknown",
      dependsOn: readStringArray(task, "depends_on"),
    };
    if (risk) {
      summary.risk = risk;
    }
    return summary;
  });
}

function parseStages(stageManifest: unknown): RunHarnessStageSummary[] {
  return recordArray(stageManifest, "stages").map((stage) => {
    const id = readString(stage, "id").trim();
    const taskId = readString(stage, "task_id").trim();
    const summary: RunHarnessStageSummary = {
      id,
      title: readString(stage, "title").trim() || id,
      status: readString(stage, "status").trim() || "unknown",
    };
    if (taskId) {
      summary.taskId = taskId;
    }
    return summary;
  });
}

function parseRunId(runRoot: string, stageManifest: unknown): string {
  if (
    typeof stageManifest === "object" &&
    stageManifest !== null &&
    !Array.isArray(stageManifest)
  ) {
    const id = readString(stageManifest as UnknownRecord, "run_id").trim();
    if (id) {
      return id;
    }
  }
  return basename(runRoot);
}

function firstMarkdownHeading(text: string, fallback: string): string {
  const heading = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"));
  return heading ? heading.replace(/^#+\s*/, "").trim() || fallback : fallback;
}

function firstUsefulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !/^[-*]\s*$/.test(line));
}

function parseStatusLine(text: string): string | undefined {
  const match = text.match(/(?:^|\n)\s*(?:status|gate status)\s*:\s*([^\n]+)/i);
  return match?.[1]?.trim();
}

function listSafeMarkdownFiles(runRoot: string, dirName: string): string[] {
  const dir = join(runRoot, dirName);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => extname(name) === ".md")
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return lstatSync(path).isFile() && isAllowedRunHarnessArtifactPath(runRoot, path);
      } catch {
        return false;
      }
    })
    .toSorted();
}

function parseGateIdFromPath(path: string): string {
  return basename(path, ".md");
}

function parseGates(params: {
  runRoot: string;
  stageManifest: unknown;
  sourcesRead: string[];
  loadErrors: string[];
}): RunHarnessGateSummary[] {
  const manifestGateIds =
    typeof params.stageManifest === "object" &&
    params.stageManifest !== null &&
    !Array.isArray(params.stageManifest) &&
    Array.isArray((params.stageManifest as UnknownRecord).gates)
      ? ((params.stageManifest as UnknownRecord).gates as unknown[]).filter(
          (gate): gate is string => typeof gate === "string",
        )
      : [];
  const gateFiles = listSafeMarkdownFiles(params.runRoot, "gates");
  const fileGates: RunHarnessGateSummary[] = gateFiles.map((path) => {
    const text = readSafeText({ ...params, path }) ?? "";
    const id = parseGateIdFromPath(path);
    return {
      id,
      title: firstMarkdownHeading(text, id),
      status: parseStatusLine(text) ?? "pending",
      path: relativeRunPath(params.runRoot, path),
      requiresExplicitApproval: true,
      canAutoApprove: false,
    } satisfies RunHarnessGateSummary;
  });
  const gatesById = new Map(fileGates.map((gate) => [gate.id, gate]));
  for (const id of manifestGateIds) {
    if (!gatesById.has(id)) {
      gatesById.set(id, {
        id,
        title: id,
        status: "pending",
        requiresExplicitApproval: true,
        canAutoApprove: false,
      });
    }
  }
  return [...gatesById.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

function summarizeEvidence(runRoot: string): RunHarnessEvidenceSummary {
  return {
    receipts: listSafeMarkdownFiles(runRoot, "receipts").map((path) =>
      relativeRunPath(runRoot, path),
    ),
    reviews: listSafeMarkdownFiles(runRoot, "reviews").map((path) =>
      relativeRunPath(runRoot, path),
    ),
    verification: listSafeMarkdownFiles(runRoot, "verification").map((path) =>
      relativeRunPath(runRoot, path),
    ),
  };
}

function summarizeFailures(params: {
  runRoot: string;
  sourcesRead: string[];
  loadErrors: string[];
}): RunHarnessBlockerSummary[] {
  return listSafeMarkdownFiles(params.runRoot, "failures").map((path) => {
    const text = readSafeText({ ...params, path }) ?? "";
    const summaryLine = firstUsefulLine(text);
    const summary: RunHarnessBlockerSummary = {
      kind: "failure",
      id: basename(path, ".md"),
      title: firstMarkdownHeading(text, basename(path, ".md")),
      path: relativeRunPath(params.runRoot, path),
    };
    if (summaryLine) {
      summary.summary = summaryLine;
    }
    return summary;
  });
}

function summarizeBlockers(params: {
  runRoot: string;
  tasks: RunHarnessTaskSummary[];
  stages: RunHarnessStageSummary[];
  gates: RunHarnessGateSummary[];
  sourcesRead: string[];
  loadErrors: string[];
}): RunHarnessBlockerSummary[] {
  const taskBlockers = params.tasks
    .filter((task) => BLOCKING_TASK_STATUSES.has(task.status))
    .map((task) => ({
      kind: "task" as const,
      id: task.id,
      title: task.title,
      status: task.status,
    }));
  const stageBlockers = params.stages
    .filter((stage) => BLOCKING_STAGE_STATUSES.has(stage.status))
    .map((stage) => ({
      kind: "stage" as const,
      id: stage.id,
      title: stage.title,
      status: stage.status,
    }));
  const gateBlockers = params.gates
    .filter((gate) => gate.status !== "approved")
    .map((gate) => {
      const blocker: RunHarnessBlockerSummary = {
        kind: "gate",
        id: gate.id,
        title: gate.title,
        status: gate.status,
        summary: "Gate requires explicit user approval; OpenClaw must not auto-approve it.",
      };
      if (gate.path) {
        blocker.path = gate.path;
      }
      return blocker;
    });
  return [...taskBlockers, ...stageBlockers, ...summarizeFailures(params), ...gateBlockers];
}

export function summarizeDurableRunFromArtifacts(params: {
  runRoot: string;
}): DurableWorkSupervisionSummary {
  const runRoot = normalizeRunRoot(params.runRoot);
  const sourcesRead: string[] = [];
  const loadErrors: string[] = [];
  const taskGraph = readSafeJson({ runRoot, filename: "task-graph.json", sourcesRead, loadErrors });
  const stageManifest = readSafeJson({
    runRoot,
    filename: "stage-manifest.json",
    sourcesRead,
    loadErrors,
  });
  const tasks = parseTasks(taskGraph);
  const stages = parseStages(stageManifest);
  const gates = parseGates({ runRoot, stageManifest, sourcesRead, loadErrors });
  return {
    schemaVersion: 1,
    source: "run-harness-safe-artifacts",
    runId: parseRunId(runRoot, stageManifest),
    runRoot,
    routing: listWorkRoutingExplanations(),
    tasks,
    stages,
    gates,
    blockers: summarizeBlockers({ runRoot, tasks, stages, gates, sourcesRead, loadErrors }),
    evidence: summarizeEvidence(runRoot),
    safety: {
      privateArtifactPolicy:
        "Reads task graph, stage manifest, gates, failures, receipts, reviews, and verification only; skips logs, prompts, sqlite/db, auth, cache, and raw transcript paths.",
      gatesAutoApproved: false,
    },
    sourcesRead,
    loadErrors,
  };
}
