export type TrajectoryEventSource = "runtime" | "transcript" | "export";

export type TrajectoryToolDefinition = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type TrajectoryEvent = {
  traceSchema: "openclaw-trajectory";
  schemaVersion: 1;
  traceId: string;
  source: TrajectoryEventSource;
  type: string;
  ts: string;
  seq: number;
  sourceSeq?: number;
  sessionId: string;
  sessionKey?: string;
  runId?: string;
  workspaceDir?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  entryId?: string;
  parentEntryId?: string | null;
  data?: Record<string, unknown>;
};

export type TrajectoryBundleManifest = {
  traceSchema: "openclaw-trajectory";
  schemaVersion: 1;
  generatedAt: string;
  traceId: string;
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  leafId: string | null;
  eventCount: number;
  runtimeEventCount: number;
  transcriptEventCount: number;
  sourceDatabases: {
    session: {
      role: "agent";
      agentId: string;
      table: "transcript_events";
      sessionId: string;
    };
    runtime?: {
      role: "agent";
      agentId: string;
      table: "trajectory_runtime_events";
      sessionId: string;
    };
  };
  contents?: Array<{
    path: string;
    mediaType: string;
    bytes: number;
  }>;
  supplementalFiles?: string[];
};
