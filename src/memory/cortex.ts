import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExec } from "../process/exec.js";

export type CortexPolicy = "full" | "professional" | "technical" | "minimal";

export type CortexStatus = {
  available: boolean;
  workspaceDir: string;
  graphPath: string;
  graphExists: boolean;
  error?: string;
};

export type CortexPreview = {
  workspaceDir: string;
  graphPath: string;
  policy: CortexPolicy;
  maxChars: number;
  context: string;
};

export type CortexMemoryConflict = {
  id: string;
  type: string;
  severity: number;
  summary: string;
  nodeLabel?: string;
  oldValue?: string;
  newValue?: string;
};

export type CortexMemoryResolveAction = "accept-new" | "keep-old" | "merge" | "ignore";

export type CortexMemoryResolveResult = {
  status: string;
  conflictId: string;
  action: CortexMemoryResolveAction;
  nodesUpdated?: number;
  nodesRemoved?: number;
  commitId?: string;
  message?: string;
};

export type CortexCodingSyncResult = {
  workspaceDir: string;
  graphPath: string;
  policy: CortexPolicy;
  platforms: string[];
};

export type CortexMemoryIngestResult = {
  workspaceDir: string;
  graphPath: string;
  stored: boolean;
};

export type CortexMemoryEvent = {
  actor: "user" | "assistant" | "tool";
  text: string;
  agentId?: string;
  sessionId?: string;
  channelId?: string;
  provider?: string;
  timestamp?: string;
};

const DEFAULT_GRAPH_RELATIVE_PATH = path.join(".cortex", "context.json");
const DEFAULT_POLICY: CortexPolicy = "technical";
const DEFAULT_MAX_CHARS = 1_500;
export const DEFAULT_CORTEX_CODING_PLATFORMS = ["claude-code", "cursor", "copilot"] as const;
const EMPTY_CORTEX_GRAPH = {
  schema_version: "5.0",
  graph: {
    nodes: [],
    edges: [],
  },
  meta: {},
} as const;

type CortexStatusParams = {
  workspaceDir: string;
  graphPath?: string;
  status?: CortexStatus;
};

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Cortex ${label} returned invalid JSON`, { cause: error });
  }
}

export function resolveCortexGraphPath(workspaceDir: string, graphPath?: string): string {
  const trimmed = graphPath?.trim();
  if (!trimmed) {
    return path.join(workspaceDir, DEFAULT_GRAPH_RELATIVE_PATH);
  }
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  return path.normalize(path.resolve(workspaceDir, trimmed));
}

export async function ensureCortexGraphInitialized(params: {
  workspaceDir: string;
  graphPath?: string;
}): Promise<{ graphPath: string; created: boolean }> {
  const graphPath = resolveCortexGraphPath(params.workspaceDir, params.graphPath);
  if (await pathExists(graphPath)) {
    return { graphPath, created: false };
  }
  await fs.mkdir(path.dirname(graphPath), { recursive: true });
  await fs.writeFile(graphPath, `${JSON.stringify(EMPTY_CORTEX_GRAPH, null, 2)}\n`, "utf8");
  return { graphPath, created: true };
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.access(pathname);
    return true;
  } catch {
    return false;
  }
}

function formatCortexExecError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  const stderr =
    typeof error === "object" && error && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr
      : "";
  const combined = stderr.trim() || message.trim();
  return combined || "unknown error";
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export async function getCortexStatus(params: {
  workspaceDir: string;
  graphPath?: string;
}): Promise<CortexStatus> {
  const graphPath = resolveCortexGraphPath(params.workspaceDir, params.graphPath);
  const graphExists = await pathExists(graphPath);
  try {
    await runExec("cortex", ["context-export", "--help"], {
      timeoutMs: 5_000,
      cwd: params.workspaceDir,
      maxBuffer: 512 * 1024,
    });
    return {
      available: true,
      workspaceDir: params.workspaceDir,
      graphPath,
      graphExists,
    };
  } catch (error) {
    return {
      available: false,
      workspaceDir: params.workspaceDir,
      graphPath,
      graphExists,
      error: formatCortexExecError(error),
    };
  }
}

async function resolveCortexStatus(params: CortexStatusParams): Promise<CortexStatus> {
  return params.status ?? getCortexStatus(params);
}

function requireCortexStatus(status: CortexStatus): CortexStatus {
  if (!status.available) {
    throw new Error(`Cortex CLI unavailable: ${status.error ?? "unknown error"}`);
  }
  if (!status.graphExists) {
    throw new Error(`Cortex graph not found: ${status.graphPath}`);
  }
  return status;
}

export async function previewCortexContext(params: {
  workspaceDir: string;
  graphPath?: string;
  policy?: CortexPolicy;
  maxChars?: number;
  status?: CortexStatus;
}): Promise<CortexPreview> {
  const status = requireCortexStatus(
    await resolveCortexStatus({
      workspaceDir: params.workspaceDir,
      graphPath: params.graphPath,
      status: params.status,
    }),
  );
  const policy = params.policy ?? DEFAULT_POLICY;
  const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
  try {
    const { stdout } = await runExec(
      "cortex",
      ["context-export", status.graphPath, "--policy", policy, "--max-chars", String(maxChars)],
      {
        timeoutMs: 10_000,
        cwd: params.workspaceDir,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return {
      workspaceDir: params.workspaceDir,
      graphPath: status.graphPath,
      policy,
      maxChars,
      context: stdout.trim(),
    };
  } catch (error) {
    throw new Error(`Cortex preview failed: ${formatCortexExecError(error)}`, { cause: error });
  }
}

export async function listCortexMemoryConflicts(params: {
  workspaceDir: string;
  graphPath?: string;
  minSeverity?: number;
  status?: CortexStatus;
}): Promise<CortexMemoryConflict[]> {
  const status = requireCortexStatus(
    await resolveCortexStatus({
      workspaceDir: params.workspaceDir,
      graphPath: params.graphPath,
      status: params.status,
    }),
  );
  const args = ["memory", "conflicts", status.graphPath, "--format", "json"];
  if (typeof params.minSeverity === "number" && Number.isFinite(params.minSeverity)) {
    args.push("--severity", String(params.minSeverity));
  }
  try {
    const { stdout } = await runExec("cortex", args, {
      timeoutMs: 10_000,
      cwd: params.workspaceDir,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = parseJson<{ conflicts?: Array<Record<string, unknown>> }>(stdout, "conflicts");
    return (parsed.conflicts ?? []).map((entry) => ({
      id: asString(entry.id),
      type: asString(entry.type),
      severity: asNumber(entry.severity),
      summary: asString(entry.summary, asString(entry.description)),
      nodeLabel: asOptionalString(entry.node_label),
      oldValue: asOptionalString(entry.old_value),
      newValue: asOptionalString(entry.new_value),
    }));
  } catch (error) {
    throw new Error(`Cortex conflicts failed: ${formatCortexExecError(error)}`, { cause: error });
  }
}

export async function resolveCortexMemoryConflict(params: {
  workspaceDir: string;
  graphPath?: string;
  conflictId: string;
  action: CortexMemoryResolveAction;
  commitMessage?: string;
  status?: CortexStatus;
}): Promise<CortexMemoryResolveResult> {
  const status = requireCortexStatus(
    await resolveCortexStatus({
      workspaceDir: params.workspaceDir,
      graphPath: params.graphPath,
      status: params.status,
    }),
  );
  const args = [
    "memory",
    "resolve",
    status.graphPath,
    "--conflict-id",
    params.conflictId,
    "--action",
    params.action,
    "--format",
    "json",
  ];
  if (params.commitMessage?.trim()) {
    args.push("--commit-message", params.commitMessage.trim());
  }
  try {
    const { stdout } = await runExec("cortex", args, {
      timeoutMs: 10_000,
      cwd: params.workspaceDir,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = parseJson<Record<string, unknown>>(stdout, "resolve");
    return {
      status: asString(parsed.status, "unknown"),
      conflictId: asString(parsed.conflict_id, params.conflictId),
      action: params.action,
      nodesUpdated: typeof parsed.nodes_updated === "number" ? parsed.nodes_updated : undefined,
      nodesRemoved: typeof parsed.nodes_removed === "number" ? parsed.nodes_removed : undefined,
      commitId: asOptionalString(parsed.commit_id),
      message: asOptionalString(parsed.message),
    };
  } catch (error) {
    throw new Error(`Cortex resolve failed: ${formatCortexExecError(error)}`, { cause: error });
  }
}

export async function syncCortexCodingContext(params: {
  workspaceDir: string;
  graphPath?: string;
  policy?: CortexPolicy;
  platforms?: string[];
  status?: CortexStatus;
}): Promise<CortexCodingSyncResult> {
  const status = requireCortexStatus(
    await resolveCortexStatus({
      workspaceDir: params.workspaceDir,
      graphPath: params.graphPath,
      status: params.status,
    }),
  );
  const policy = params.policy ?? DEFAULT_POLICY;
  const requestedPlatforms = params.platforms?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  const platforms =
    requestedPlatforms.length > 0 ? requestedPlatforms : [...DEFAULT_CORTEX_CODING_PLATFORMS];
  try {
    await runExec(
      "cortex",
      ["context-write", status.graphPath, "--platforms", ...platforms, "--policy", policy],
      {
        timeoutMs: 15_000,
        cwd: params.workspaceDir,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return {
      workspaceDir: params.workspaceDir,
      graphPath: status.graphPath,
      policy,
      platforms,
    };
  } catch (error) {
    throw new Error(`Cortex coding sync failed: ${formatCortexExecError(error)}`, {
      cause: error,
    });
  }
}

function formatCortexMemoryEvent(event: CortexMemoryEvent): string {
  const metadata = {
    source: "openclaw",
    actor: event.actor,
    agentId: event.agentId,
    sessionId: event.sessionId,
    channelId: event.channelId,
    provider: event.provider,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
  return [
    "Source: OpenClaw conversation",
    `Actor: ${event.actor}`,
    event.agentId ? `Agent: ${event.agentId}` : "",
    event.sessionId ? `Session: ${event.sessionId}` : "",
    event.channelId ? `Channel: ${event.channelId}` : "",
    event.provider ? `Provider: ${event.provider}` : "",
    `Timestamp: ${metadata.timestamp}`,
    "",
    "Metadata:",
    JSON.stringify(metadata, null, 2),
    "",
    "Message:",
    event.text.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

export async function ingestCortexMemoryFromText(params: {
  workspaceDir: string;
  graphPath?: string;
  event: CortexMemoryEvent;
  status?: CortexStatus;
}): Promise<CortexMemoryIngestResult> {
  const text = params.event.text.trim();
  if (!text) {
    throw new Error("Cortex memory ingest requires non-empty text");
  }
  const status = requireCortexStatus(
    await resolveCortexStatus({
      workspaceDir: params.workspaceDir,
      graphPath: params.graphPath,
      status: params.status,
    }),
  );
  await fs.mkdir(path.dirname(status.graphPath), { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-ingest-"));
  const inputPath = path.join(tmpDir, "memory.txt");
  const payload = formatCortexMemoryEvent(params.event);
  try {
    await fs.writeFile(inputPath, payload, "utf8");
    await runExec(
      "cortex",
      ["extract", inputPath, "-o", status.graphPath, "--merge", status.graphPath],
      {
        timeoutMs: 15_000,
        cwd: params.workspaceDir,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return {
      workspaceDir: params.workspaceDir,
      graphPath: status.graphPath,
      stored: true,
    };
  } catch (error) {
    throw new Error(`Cortex ingest failed: ${formatCortexExecError(error)}`, { cause: error });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
