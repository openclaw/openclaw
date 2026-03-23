import type { Server } from "node:http";
import type { TrajectoryV1 } from "../../research/contracts/index.js";

export type ReplayMode = "recorded";

export type ReplayRunStatus = "created" | "running" | "completed" | "closed";

export type ReplayLimits = {
  maxSteps: number;
  maxToolCalls: number;
  timeoutMs: number;
};

export type ReplayToolResult = {
  toolCallId: string;
  toolName: string;
  ok?: boolean;
  resultSummary?: string;
};

export type ReplayStepResult = {
  runId: string;
  status: "running" | "completed";
  stepIdx: number;
  done: boolean;
  assistantText?: string;
  replayedToolCalls: ReplayToolResult[];
};

export type ReplayRunState = {
  runId: string;
  mode: ReplayMode;
  status: ReplayRunStatus;
  trajectory: TrajectoryV1;
  stepIdx: number;
  toolCallCount: number;
  createdAtMs: number;
  updatedAtMs: number;
  closedAtMs?: number;
  limits: ReplayLimits;
  toolAllowlist: Set<string>;
};

export type ReplayControlServer = {
  server: Server;
  token: string;
  host: "127.0.0.1";
  port: number;
  close: () => Promise<void>;
};
