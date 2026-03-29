import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { validateJsonSchemaValue } from "../../plugins/schema-validator.js";
import { resolveConfigDir } from "../../utils.js";
import {
  TrajectoryV1Schema,
  type TrajectoryMessage,
  type TrajectoryToolCall,
  type TrajectoryV1,
} from "../contracts/index.js";
import { redactEvent } from "../events/redaction.js";
import { ResearchEventV1Schema, type ResearchEventV1 } from "../events/types.js";

type TranscriptMessage = Omit<TrajectoryMessage, "idx">;

function normalizeText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeText(content);
    return normalized.length > 0 ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const maybeBlock = block as { type?: unknown; text?: unknown };
    if (maybeBlock.type !== "text" || typeof maybeBlock.text !== "string") {
      continue;
    }
    const normalized = normalizeText(maybeBlock.text);
    if (normalized.length > 0) {
      chunks.push(normalized);
    }
  }
  if (chunks.length === 0) {
    return null;
  }
  return chunks.join(" ");
}

function stableSortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSortObject(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted((a, b) => a.localeCompare(b));
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = stableSortObject(record[key]);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  const stable = stableSortObject(value);
  return `${JSON.stringify(stable, null, 2)}\n`;
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip malformed lines so export can still proceed deterministically.
    }
  }
  return out;
}

function parseTranscriptMessages(lines: unknown[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || typeof line !== "object") {
      continue;
    }
    const entry = line as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (entry.type !== "message") {
      continue;
    }
    const role = typeof entry.message?.role === "string" ? entry.message.role : null;
    if (!role) {
      continue;
    }
    const text = extractMessageText(entry.message?.content);
    if (!text) {
      continue;
    }
    out.push({
      jsonlLine: i + 1,
      role,
      text: redactSensitiveText(text, { mode: "tools" }),
    });
  }
  return out;
}

/**
 * Deterministic ordering for research events at equal `ts`. Replaces `kind.localeCompare` so
 * e.g. `tool.end` never sorts before `tool.start` when timestamps collide (ms resolution).
 */
export function researchEventKindTieRank(kind: string): number {
  switch (kind) {
    case "run.start":
      return 0;
    case "llm.request":
      return 10;
    case "tool.start":
      return 20;
    case "tool.end":
      return 30;
    case "llm.response":
      return 40;
    case "approval.request":
      return 50;
    case "approval.allow":
      return 55;
    case "approval.deny":
      return 56;
    case "run.end":
      return 100;
    default:
      return 1000;
  }
}

function parseResearchEvents(lines: unknown[]): ResearchEventV1[] {
  const out: ResearchEventV1[] = [];
  for (const line of lines) {
    const parsed = ResearchEventV1Schema.safeParse(line);
    if (!parsed.success) {
      continue;
    }
    out.push(redactEvent(parsed.data));
  }
  out.sort((a, b) => {
    if (a.ts !== b.ts) {
      return a.ts - b.ts;
    }
    const ra = researchEventKindTieRank(a.kind);
    const rb = researchEventKindTieRank(b.kind);
    if (ra !== rb) {
      return ra - rb;
    }
    const aId =
      typeof a.payload === "object" && a.payload
        ? (a.payload as { toolCallId?: string }).toolCallId
        : "";
    const bId =
      typeof b.payload === "object" && b.payload
        ? (b.payload as { toolCallId?: string }).toolCallId
        : "";
    const idCmp = String(aId ?? "").localeCompare(String(bId ?? ""));
    if (idCmp !== 0) {
      return idCmp;
    }
    return a.kind.localeCompare(b.kind);
  });
  return out;
}

/**
 * Derive tool call rows for TrajectoryV1.toolCalls.
 *
 * Invariant: `stepIdx` is the **assistant / model turn index** for replay pairing: all tools
 * invoked in the same assistant turn share one `stepIdx`. Boundaries come from `llm.response`
 * events (increment per assistant completion). Events before the first `llm.response` use
 * step `0` so tool-only fixtures remain stable.
 */
function deriveToolCalls(events: ResearchEventV1[]): TrajectoryToolCall[] {
  const starts = new Map<
    string,
    {
      stepIdx: number;
      toolName: string;
      startTs: number;
      argsSummary?: string;
    }
  >();
  const out: TrajectoryToolCall[] = [];
  let assistantTurnIdx = -1;
  for (const event of events) {
    if (event.kind === "llm.response") {
      assistantTurnIdx += 1;
      continue;
    }
    if (event.kind === "tool.start") {
      const stepIdx = Math.max(0, assistantTurnIdx);
      starts.set(event.payload.toolCallId, {
        stepIdx,
        toolName: event.payload.toolName,
        startTs: event.ts,
        argsSummary: event.payload.argsSummary,
      });
      continue;
    }
    if (event.kind !== "tool.end") {
      continue;
    }
    const start = starts.get(event.payload.toolCallId);
    out.push({
      stepIdx: start?.stepIdx ?? Math.max(0, assistantTurnIdx),
      toolCallId: event.payload.toolCallId,
      toolName: event.payload.toolName,
      startTs: start?.startTs ?? event.ts,
      endTs: event.ts,
      ok: event.payload.ok,
      argsSummary: start?.argsSummary,
      resultSummary: event.payload.resultSummary,
    });
  }
  out.sort((a, b) => {
    if (a.stepIdx !== b.stepIdx) {
      return a.stepIdx - b.stepIdx;
    }
    if (a.toolCallId !== b.toolCallId) {
      return a.toolCallId.localeCompare(b.toolCallId);
    }
    return a.toolName.localeCompare(b.toolName);
  });
  return out;
}

export async function exportTrajectoryV1(params: {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  transcriptPath?: string;
  eventsPath?: string;
  outputPath?: string;
}): Promise<{ trajectory: TrajectoryV1; outputPath: string; bytes: string }> {
  const transcriptPath =
    params.transcriptPath ??
    path.join(resolveSessionTranscriptsDirForAgent(params.agentId), `${params.sessionId}.jsonl`);
  const eventsPath =
    params.eventsPath ??
    path.join(
      resolveConfigDir(),
      "research",
      "events",
      params.agentId,
      `${params.sessionId}.events.jsonl`,
    );
  const outputPath =
    params.outputPath ??
    path.join(
      resolveConfigDir(),
      "research",
      "trajectories",
      params.agentId,
      `${params.sessionId}.trajectory.v1.json`,
    );

  const [transcriptLines, eventLines] = await Promise.all([
    readJsonl(transcriptPath),
    readJsonl(eventsPath).catch(() => []),
  ]);
  const messages = parseTranscriptMessages(transcriptLines).map((message, idx) => ({
    ...message,
    idx,
  }));
  const events = parseResearchEvents(eventLines);
  const toolCalls = deriveToolCalls(events);
  const trajectory: TrajectoryV1 = {
    v: 1,
    session: {
      agentId: params.agentId,
      sessionId: params.sessionId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    },
    messages,
    events,
    toolCalls,
    summary: {
      messageCount: messages.length,
      eventCount: events.length,
      toolCallCount: toolCalls.length,
    },
  };

  const validated = validateJsonSchemaValue({
    schema: TrajectoryV1Schema,
    cacheKey: "research.contracts.trajectory.v1",
    value: trajectory,
  });
  if (!validated.ok) {
    const message = validated.errors.map((error) => error.text).join("; ");
    throw new Error(`TrajectoryV1 export validation failed: ${message}`);
  }

  const bytes = canonicalJson(trajectory);
  await writeTextAtomic(outputPath, bytes, {
    mode: 0o600,
    ensureDirMode: 0o700,
    appendTrailingNewline: false,
  });
  return { trajectory, outputPath, bytes };
}
