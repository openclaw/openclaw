import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import { resolveSessionFilePath } from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveTrajectoryFilePath } from "../trajectory/paths.js";
import type { TrajectoryEvent } from "../trajectory/types.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";
import { shortenText } from "./text-format.js";

type SessionsTailOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
  sessionKey?: string;
  follow?: boolean;
  tail?: string | number;
};

type TailSelection = {
  agentId: string;
  key: string;
  entry: SessionEntry;
  storePath: string;
  trajectoryPath: string;
};

type FollowState = {
  offset: number;
  pending: string;
  selection: TailSelection;
};

type TrajectorySnapshot = {
  lines: string[];
  offset: number;
};

const DEFAULT_TAIL_COUNT = 80;
const SESSION_KEY_PAD = 30;
const EVENT_TYPE_PAD = 16;
const FOLLOW_INTERVAL_MS = 1_000;

function parseTailCount(value: string | number | undefined): number | null {
  if (value === undefined) {
    return DEFAULT_TAIL_COUNT;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return Number.parseInt(trimmed, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isTrajectoryEvent(value: unknown): value is TrajectoryEvent {
  return (
    isRecord(value) &&
    value.traceSchema === "openclaw-trajectory" &&
    value.schemaVersion === 1 &&
    typeof value.type === "string" &&
    typeof value.ts === "string" &&
    typeof value.sessionId === "string"
  );
}

function parseTrajectoryEventLine(line: string): TrajectoryEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isTrajectoryEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return date.toISOString().slice(11, 19);
}

function modelLabel(event: TrajectoryEvent): string | undefined {
  const provider = event.provider?.trim();
  const model = event.modelId?.trim();
  if (provider && model) {
    return `${provider}/${model}`;
  }
  return model || provider || undefined;
}

function toolName(data: Record<string, unknown> | undefined): string {
  return toOptionalString(data?.name) ?? toOptionalString(data?.toolName) ?? "tool";
}

function resultStatus(data: Record<string, unknown> | undefined): string {
  if (data?.success === true) {
    return "ok";
  }
  if (data?.success === false || data?.isError === true) {
    return "error";
  }
  return toOptionalString(data?.status) ?? "done";
}

function modelCompletionStatus(data: Record<string, unknown> | undefined): string {
  if (data?.timedOut === true) {
    return "timeout";
  }
  if (data?.aborted === true) {
    return "aborted";
  }
  if (toOptionalString(data?.promptError)) {
    return "error";
  }
  return "done";
}

function safePreview(event: TrajectoryEvent): string {
  const data = event.data;
  switch (event.type) {
    case "session.started":
      return "session started";
    case "context.compiled": {
      const tools = Array.isArray(data?.tools) ? data.tools.length : undefined;
      return tools === undefined ? "context compiled" : `context compiled (${tools} tools)`;
    }
    case "prompt.submitted":
      return "prompt submitted";
    case "prompt.skipped": {
      const reason = toOptionalString(data?.reason);
      return `prompt skipped${reason ? `: ${reason}` : ""}`;
    }
    case "tool.call":
      return `${toolName(data)} {...redacted...}`;
    case "tool.timeout":
      return `${toolName(data)} timeout`;
    case "tool.result":
      return `${toolName(data)} ${resultStatus(data)}`;
    case "model.completed": {
      const model = modelLabel(event);
      const status = modelCompletionStatus(data);
      return model ? `${model} ${status}` : status;
    }
    case "session.ended":
      return toOptionalString(data?.status) ?? "ended";
    case "trace.truncated":
      return "trajectory truncated";
    default:
      return toOptionalString(data?.status) ?? toOptionalString(data?.name) ?? "";
  }
}

function formatProgressLine(event: TrajectoryEvent): string {
  const sessionLabel = shortenText(event.sessionKey ?? event.sessionId, SESSION_KEY_PAD).padEnd(
    SESSION_KEY_PAD,
  );
  const typeLabel = shortenText(event.type, EVENT_TYPE_PAD).padEnd(EVENT_TYPE_PAD);
  const preview = safePreview(event);
  return [formatTimestamp(event.ts), typeLabel, sessionLabel, preview].join(" ").trimEnd();
}

function readTrajectorySnapshot(filePath: string): TrajectorySnapshot {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return {
      lines: text.split(/\r?\n/u).filter((line) => line.trim().length > 0),
      offset: Buffer.byteLength(text, "utf8"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lines: [], offset: 0 };
    }
    throw error;
  }
}

function renderLines(lines: string[], runtime: RuntimeEnv): void {
  for (const line of lines) {
    const event = parseTrajectoryEventLine(line);
    if (event) {
      runtime.log(formatProgressLine(event));
    }
  }
}

function isRunningSession(entry: SessionEntry): boolean {
  return entry.status === "running" || entry.acp?.state === "running";
}

function compareSelectionsByUpdatedAt(a: TailSelection, b: TailSelection): number {
  return (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0);
}

function buildTailSelection(params: {
  agentId: string;
  entry: SessionEntry;
  key: string;
  storePath: string;
}): TailSelection {
  const sessionsDir = path.dirname(params.storePath);
  const sessionFile = resolveSessionFilePath(params.entry.sessionId, params.entry, {
    agentId: params.agentId,
    sessionsDir,
  });
  return {
    agentId: params.agentId,
    entry: params.entry,
    key: params.key,
    storePath: params.storePath,
    trajectoryPath: resolveTrajectoryFilePath({
      sessionFile,
      sessionId: params.entry.sessionId,
    }),
  };
}

function selectSessionsToTail(selections: TailSelection[], sessionKey?: string): TailSelection[] {
  const requested = sessionKey?.trim();
  if (requested) {
    return selections.filter((selection) => selection.key === requested);
  }

  const running = selections.filter((selection) => isRunningSession(selection.entry));
  if (running.length > 0) {
    return running.toSorted(compareSelectionsByUpdatedAt);
  }

  const latest = selections.toSorted(compareSelectionsByUpdatedAt)[0];
  return latest ? [latest] : [];
}

function statFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function readNewFollowLines(state: FollowState): string[] {
  let size: number;
  try {
    size = fs.statSync(state.selection.trajectoryPath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  if (size < state.offset) {
    state.offset = 0;
    state.pending = "";
  }
  if (size === state.offset) {
    return [];
  }
  const fd = fs.openSync(state.selection.trajectoryPath, "r");
  try {
    const buffer = Buffer.alloc(size - state.offset);
    fs.readSync(fd, buffer, 0, buffer.length, state.offset);
    state.offset = size;
    const combined = `${state.pending}${buffer.toString("utf8")}`;
    const lines = combined.split(/\r?\n/u);
    state.pending = lines.pop() ?? "";
    return lines.filter((line) => line.trim().length > 0);
  } finally {
    fs.closeSync(fd);
  }
}

async function followSelections(
  selections: TailSelection[],
  runtime: RuntimeEnv,
  initialOffsets: Map<string, number>,
): Promise<void> {
  const states = selections.map((selection) => ({
    offset: initialOffsets.get(selection.trajectoryPath) ?? statFileSize(selection.trajectoryPath),
    pending: "",
    selection,
  }));

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      for (const state of states) {
        try {
          renderLines(readNewFollowLines(state), runtime);
        } catch (error) {
          runtime.error(
            `Failed to read trajectory progress for ${state.selection.key}: ${formatErrorMessage(
              error,
            )}`,
          );
        }
      }
    }, FOLLOW_INTERVAL_MS);

    const stop = () => {
      clearInterval(interval);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function resolveTailTargetAgent(opts: SessionsTailOptions): string | undefined {
  if (opts.agent?.trim() || opts.store?.trim() || opts.allAgents === true) {
    return opts.agent;
  }
  return opts.sessionKey?.trim() ? resolveAgentIdFromSessionKey(opts.sessionKey) : undefined;
}

export async function sessionsTailCommand(
  opts: SessionsTailOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const tailCount = parseTailCount(opts.tail);
  if (tailCount === null) {
    runtime.error("--tail must be a non-negative integer, for example --tail 25.");
    runtime.exit(1);
    return;
  }

  const cfg = getRuntimeConfig();
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: resolveTailTargetAgent(opts),
      allAgents: opts.allAgents,
    },
    runtime,
  });
  if (!targets) {
    return;
  }

  const selections = targets.flatMap((target) => {
    const store = loadSessionStore(target.storePath);
    return Object.entries(store).map(([key, entry]) =>
      buildTailSelection({
        agentId: target.agentId,
        entry,
        key,
        storePath: target.storePath,
      }),
    );
  });
  const selected = selectSessionsToTail(selections, opts.sessionKey);
  if (selected.length === 0) {
    const suffix = opts.sessionKey ? ` for ${opts.sessionKey}` : "";
    runtime.log(`No sessions found${suffix}.`);
    return;
  }

  const followOffsets = new Map<string, number>();
  for (const selection of selected) {
    const snapshot = readTrajectorySnapshot(selection.trajectoryPath);
    followOffsets.set(selection.trajectoryPath, snapshot.offset);
    const lines = snapshot.lines;
    renderLines(tailCount > 0 ? lines.slice(-tailCount) : [], runtime);
  }

  if (opts.follow) {
    await followSelections(selected, runtime, followOffsets);
  }
}
