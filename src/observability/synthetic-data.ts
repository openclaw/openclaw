import fs from "node:fs/promises";
import path from "node:path";

export type SyntheticDatasetOptions = {
  channels?: string[];
  messagesPerChannel?: number;
  sessionId?: string;
  agentId?: string;
  startTs?: string;
};

export type SyntheticObservabilityDataset = {
  sessionLines: string[];
  cacheTraceLines: string[];
  systemLogLines: string[];
  sessionId: string;
  agentId: string;
};

const DEFAULT_CHANNELS = ["discord", "slack", "telegram"];

function addSeconds(isoTs: string, seconds: number): string {
  return new Date(Date.parse(isoTs) + seconds * 1_000).toISOString();
}

export function buildSyntheticObservabilityDataset(
  options: SyntheticDatasetOptions = {},
): SyntheticObservabilityDataset {
  const channels = options.channels ?? DEFAULT_CHANNELS;
  const messagesPerChannel = options.messagesPerChannel ?? 2;
  const startTs = options.startTs ?? "2026-01-01T00:00:00.000Z";
  const sessionId = options.sessionId ?? "session-synthetic-001";
  const agentId = options.agentId ?? "agent-synthetic";

  const sessionHeader = {
    type: "session",
    version: 1,
    id: sessionId,
    timestamp: startTs,
    cwd: "/workspace/openclaw",
  };

  const sessionLines: string[] = [JSON.stringify(sessionHeader)];
  const cacheTraceLines: string[] = [];
  const systemLogLines: string[] = [];
  let offset = 1;

  for (const channel of channels) {
    for (let index = 0; index < messagesPerChannel; index += 1) {
      const ts = addSeconds(startTs, offset);
      const message = {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `[${channel}] synthetic message #${index + 1}` }],
          provider: "openai",
          model: "gpt-5.4",
          timestamp: Date.parse(ts),
        },
      };
      sessionLines.push(JSON.stringify(message));

      cacheTraceLines.push(
        JSON.stringify({
          ts,
          seq: offset,
          stage: "session:after",
          runId: `run-${channel}-${index + 1}`,
          sessionId,
          provider: "openai",
          modelId: "gpt-5.4",
          messageCount: offset,
        }),
      );

      systemLogLines.push(
        JSON.stringify({
          _meta: {
            date: ts,
            logLevelId: 3,
            logLevelName: "INFO",
            name: `channel-${channel}`,
          },
          0: `Forwarded ${channel} message ${index + 1}`,
        }),
      );

      offset += 1;
    }
  }

  return {
    sessionLines,
    cacheTraceLines,
    systemLogLines,
    sessionId,
    agentId,
  };
}

export async function writeSyntheticObservabilityFiles(params: {
  rootDir: string;
  agentId?: string;
  sessionFileName?: string;
  systemFileName?: string;
  dataset?: SyntheticObservabilityDataset;
}): Promise<{
  sessionFile: string;
  cacheTraceFile: string;
  systemLogFile: string;
  dataset: SyntheticObservabilityDataset;
}> {
  const dataset = params.dataset ?? buildSyntheticObservabilityDataset({ agentId: params.agentId });
  const agentId = params.agentId ?? dataset.agentId;

  const sessionDir = path.join(params.rootDir, "agents", agentId, "sessions");
  const logsDir = path.join(params.rootDir, "logs");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });

  const sessionFile = path.join(
    params.rootDir,
    "agents",
    agentId,
    "sessions",
    params.sessionFileName ?? "synthetic-session.jsonl",
  );
  const cacheTraceFile = path.join(params.rootDir, "logs", "cache-trace.jsonl");
  const systemLogFile = path.join(
    params.rootDir,
    "logs",
    params.systemFileName ?? "openclaw-synthetic.log",
  );

  await fs.writeFile(sessionFile, `${dataset.sessionLines.join("\n")}\n`, "utf8");
  await fs.writeFile(cacheTraceFile, `${dataset.cacheTraceLines.join("\n")}\n`, "utf8");
  await fs.writeFile(systemLogFile, `${dataset.systemLogLines.join("\n")}\n`, "utf8");

  return { sessionFile, cacheTraceFile, systemLogFile, dataset };
}
