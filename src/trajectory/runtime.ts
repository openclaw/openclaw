import path from "node:path";
import { sanitizeDiagnosticPayload } from "../agents/payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "../agents/queued-file-writer.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import type { TrajectoryEvent, TrajectoryToolDefinition } from "./types.js";

type TrajectoryRuntimeInit = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  writer?: QueuedFileWriter;
};

type TrajectoryRuntimeRecorder = {
  enabled: true;
  filePath: string;
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

const writers = new Map<string, QueuedFileWriter>();

export function resolveTrajectoryFilePath(params: {
  env?: NodeJS.ProcessEnv;
  sessionFile?: string;
  sessionId: string;
}): string {
  const env = params.env ?? process.env;
  const dirOverride = env.OPENCLAW_TRAJECTORY_DIR?.trim();
  if (dirOverride) {
    return path.join(resolveUserPath(dirOverride), `${params.sessionId}.jsonl`);
  }
  if (!params.sessionFile) {
    return path.join(process.cwd(), `${params.sessionId}.trajectory.jsonl`);
  }
  return params.sessionFile.endsWith(".jsonl")
    ? `${params.sessionFile.slice(0, -".jsonl".length)}.trajectory.jsonl`
    : `${params.sessionFile}.trajectory.jsonl`;
}

export function toTrajectoryToolDefinitions(
  tools: ReadonlyArray<{ name?: string; description?: string; parameters?: unknown }>,
): TrajectoryToolDefinition[] {
  return tools
    .flatMap((tool) => {
      const name = tool.name?.trim();
      if (!name) {
        return [];
      }
      return [
        {
          name,
          description: tool.description,
          parameters: sanitizeDiagnosticPayload(tool.parameters),
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function createTrajectoryRuntimeRecorder(
  params: TrajectoryRuntimeInit,
): TrajectoryRuntimeRecorder | null {
  const env = params.env ?? process.env;
  // Trajectory capture is now default-on. The env var remains as an explicit
  // override so operators can still disable recording with OPENCLAW_TRAJECTORY=0.
  const enabled = parseBooleanValue(env.OPENCLAW_TRAJECTORY) ?? true;
  if (!enabled) {
    return null;
  }

  const filePath = resolveTrajectoryFilePath({
    env,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
  });
  const writer = params.writer ?? getQueuedFileWriter(writers, filePath);
  let seq = 0;
  const traceId = params.sessionId;

  return {
    enabled: true,
    filePath,
    recordEvent: (type, data) => {
      const event: TrajectoryEvent = {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId,
        source: "runtime",
        type,
        ts: new Date().toISOString(),
        seq: (seq += 1),
        sourceSeq: seq,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        workspaceDir: params.workspaceDir,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.modelApi,
        data: data ? (sanitizeDiagnosticPayload(data) as Record<string, unknown>) : undefined,
      };
      const line = safeJsonStringify(event);
      if (!line) {
        return;
      }
      writer.write(`${line}\n`);
    },
    flush: async () => {
      await writer.flush();
    },
  };
}
