import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { resolveProgressFilePath } from "../subagent-progress.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const PROGRESS_LEVELS = ["L0_operational", "L1_plan_update", "L2_detail"] as const;
const RATE_LIMIT_MS = 30_000;

const ReportProgressSchema = Type.Object({
  phase: Type.String({ minLength: 1 }),
  percentComplete: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  level: optionalStringEnum(PROGRESS_LEVELS),
  metrics: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]))),
});

type ProgressRecord = {
  runId: string;
  phase: string;
  percentComplete?: number;
  level?: (typeof PROGRESS_LEVELS)[number];
  metrics?: Record<string, string | number>;
  updatedAt: string;
};

const reportProgressState = {
  lastUpdateByRunId: new Map<string, number>(),
  writeQueues: new Map<string, Promise<void>>(),
};

function normalizeMetrics(raw: unknown): Record<string, string | number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const entries = Object.entries(raw)
    .map(([key, value]) => {
      if (typeof key !== "string" || !key.trim()) {
        return undefined;
      }
      if (typeof value === "string") {
        return [key, value] as const;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return [key, value] as const;
      }
      return undefined;
    })
    .filter(
      (entry): entry is readonly [string, string] | readonly [string, number] =>
        entry !== undefined,
    );

  return entries.length > 0
    ? (Object.fromEntries(entries) as Record<string, string | number>)
    : undefined;
}

function getWriterQueue(filePath: string): Promise<void> {
  const existing = reportProgressState.writeQueues.get(filePath);
  if (existing) {
    return existing;
  }

  const ready = Promise.resolve(
    fs
      .mkdir(path.dirname(filePath), {
        recursive: true,
      })
      .then(() => undefined)
      .catch(() => undefined),
  );
  reportProgressState.writeQueues.set(filePath, ready);
  return ready;
}

function appendProgressUpdate(filePath: string, line: string): void {
  const nextQueue = getWriterQueue(filePath)
    .then(() => fs.appendFile(filePath, line, "utf-8"))
    .catch(() => undefined);
  reportProgressState.writeQueues.set(filePath, nextQueue);
}

function isRateLimited(runId: string, nowMs: number): boolean {
  const lastUpdate = reportProgressState.lastUpdateByRunId.get(runId);
  if (lastUpdate === undefined) {
    reportProgressState.lastUpdateByRunId.set(runId, nowMs);
    return false;
  }
  if (nowMs - lastUpdate < RATE_LIMIT_MS) {
    return true;
  }
  reportProgressState.lastUpdateByRunId.set(runId, nowMs);
  return false;
}

export function createReportProgressTool(opts?: {
  runId?: string;
  stateDir?: string;
}): AnyAgentTool {
  return {
    label: "Report Progress",
    name: "report_progress",
    description: "Report progress updates for a long-running subagent task.",
    parameters: ReportProgressSchema,
    execute: async (_toolCallId, args) => {
      const runId = opts?.runId?.trim();
      if (!runId) {
        return jsonResult({
          status: "error",
          error: "runId is required to record progress updates.",
        });
      }

      const params = args as Record<string, unknown>;
      const phase = readStringParam(params, "phase", { required: true, label: "phase" });
      const level = params.level;
      const percentComplete = readNumberParam(params, "percentComplete");
      const metrics = normalizeMetrics(params.metrics);
      const nowMs = Date.now();

      if (percentComplete !== undefined && (percentComplete < 0 || percentComplete > 100)) {
        return jsonResult({
          status: "error",
          error: "percentComplete must be between 0 and 100.",
        });
      }

      if (isRateLimited(runId, nowMs)) {
        const lastUpdate = reportProgressState.lastUpdateByRunId.get(runId);
        const nextAllowed = lastUpdate === undefined ? nowMs : lastUpdate + RATE_LIMIT_MS;
        return jsonResult({
          status: "rate_limited",
          runId,
          reason: "progress updates are rate limited to 1 every 30 seconds",
          nextAllowedAt: new Date(nextAllowed).toISOString(),
        });
      }

      const update: ProgressRecord = {
        runId,
        phase,
        updatedAt: new Date(nowMs).toISOString(),
      };

      if (percentComplete !== undefined) {
        update.percentComplete = percentComplete;
      }
      if (typeof level === "string" && level.length > 0) {
        update.level = level as (typeof PROGRESS_LEVELS)[number];
      }
      if (metrics && Object.keys(metrics).length > 0) {
        update.metrics = metrics;
      }

      const outputLine = `${JSON.stringify(update)}\n`;
      appendProgressUpdate(resolveProgressFilePath(runId, opts?.stateDir), outputLine);

      return jsonResult({
        status: "accepted",
        runId,
        phase,
      });
    },
  };
}
