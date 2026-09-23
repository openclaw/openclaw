import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { stripUserEnvelopeForDisplay } from "../auto-reply/reply/user-envelope-display.js";
import { isToolCallContentType } from "../chat/tool-content.js";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  refreshCostUsageCacheForAgent,
  resolveUsageCostAgentDir,
} from "./session-cost-usage-aggregation.js";
import {
  readTranscriptRecords,
  readTranscriptRecordsBestEffort,
  resolveExistingUsageSessionFile,
} from "./session-cost-usage-collection.js";
import {
  createUsageCostResolver,
  parseUsageCostTranscriptEntryAsync,
  resolveUsageCostPricingFingerprint,
} from "./session-cost-usage-pricing-context.js";
import { computeUsageTokenTotals } from "./session-cost-usage-pricing.js";
import {
  prepareUsageCostWorker,
  resolveUsageCostWorkerDayBucket,
  runUsageCostWorker,
} from "./session-cost-usage-worker-runtime.js";
import type {
  DiscoveredSession,
  SessionCostSummary,
  SessionLogEntry,
  SessionUsageTimePoint,
  SessionUsageTimeSeries,
  UsageDailyBucket,
} from "./session-cost-usage.types.js";

const USAGE_COST_DIRECT_REFRESH_RETRY_MS = 25;

/**
 * Scan all transcript files to discover sessions not in the session store.
 * Returns basic metadata for each discovered session.
 */
export async function discoverAllSessions(params: {
  agentId: string;
  startMs?: number;
  endMs?: number;
}): Promise<DiscoveredSession[]> {
  const result = await runUsageCostWorker(prepareUsageCostWorker(params), {
    kind: "inventory",
    minMtimeMs: params.startMs,
  });
  if (result.kind !== "inventory") {
    throw new Error("Usage worker returned an invalid session inventory");
  }

  const discovered = new Map<string, DiscoveredSession>();

  for (const file of result.files) {
    // Do not exclude by endMs: a session can have activity in range even if it continued later.
    const { sourcePath: sessionFile, sessionId } = file;
    if (!sessionId) {
      continue;
    }
    const isPrimaryTranscript =
      file.kind === "sqlite" || isPrimarySessionTranscriptFileName(path.basename(sessionFile));

    const existing = discovered.get(sessionId);
    const existingIsPrimary = existing
      ? isPrimarySessionTranscriptFileName(path.basename(existing.sessionFile))
      : false;
    const shouldReplace =
      !existing ||
      (isPrimaryTranscript && !existingIsPrimary) ||
      (isPrimaryTranscript === existingIsPrimary && file.mtimeMs >= existing.mtime);

    if (shouldReplace) {
      discovered.set(sessionId, {
        sessionId,
        sessionFile,
        mtime: file.mtimeMs,
      });
    }
  }

  // Sort by mtime descending (most recent first)
  const sessions = Array.from(discovered.values());
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

export async function loadSessionCostSummary(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId: string;
  sessionTarget?: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };
  startMs?: number;
  endMs?: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
}): Promise<SessionCostSummary | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile) {
    return null;
  }
  const prepared = prepareUsageCostWorker({ ...params, sessionFiles: [sessionFile] });
  const inventory = await runUsageCostWorker(prepared, {
    kind: "inventory",
    sessionFiles: [sessionFile],
  });
  if (inventory.kind !== "inventory") {
    throw new Error("Usage worker returned an invalid session inventory");
  }
  if (inventory.files.length === 0) {
    return null;
  }
  while (
    (await refreshCostUsageCacheForAgent({
      config: params.config,
      agentId: params.agentId,
      agentDir: prepared.agentDir,
      databasePath: prepared.location.databasePath,
      sessionFiles: [sessionFile],
    })) === "busy"
  ) {
    // Direct detail callers require the requested session, unlike background
    // summary refreshes. Wait for the agent-wide writer to release, then retry.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, USAGE_COST_DIRECT_REFRESH_RETRY_MS);
    });
  }
  const pricingFingerprint = await resolveUsageCostPricingFingerprint(
    prepared.config,
    prepared.agentDir,
  );
  const result = await runUsageCostWorker(prepared, {
    kind: "sessions",
    pricingFingerprint,
    sessions: [{ sessionId: params.sessionId, sessionFile }],
    startMs: params.startMs,
    endMs: params.endMs,
    includeUntimestamped: params.includeUntimestamped,
    dayBucket: resolveUsageCostWorkerDayBucket(params.dayBucket),
  });
  if (result.kind !== "sessions") {
    throw new Error("Usage worker returned an invalid session summary");
  }
  return result.summaries[0] ?? null;
}

export async function loadSessionUsageTimeSeries(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId: string;
  maxPoints?: number;
}): Promise<SessionUsageTimeSeries | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile) {
    return null;
  }
  if (!parseSqliteSessionFileMarker(sessionFile) && !fs.existsSync(sessionFile)) {
    return null;
  }

  if (params.maxPoints !== undefined && params.maxPoints !== null) {
    if (!Number.isFinite(params.maxPoints) || params.maxPoints <= 0) {
      return { sessionId: params.sessionId, points: [] };
    }
  }

  let points: Array<Omit<SessionUsageTimePoint, "cumulativeTokens" | "cumulativeCost">> = [];
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const resolveCost = createUsageCostResolver({ config: params.config, agentDir });

  for await (const record of readTranscriptRecords(sessionFile)) {
    const entry = await parseUsageCostTranscriptEntryAsync(record, resolveCost, params.config);
    const timestamp = entry?.timestamp?.getTime();
    if (!entry?.usage || !timestamp) {
      continue;
    }
    const { input, output, cacheRead, cacheWrite, totalTokens } = computeUsageTokenTotals(
      entry.usage,
    );
    points.push({
      timestamp,
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost: entry.costTotal ?? 0,
    });
  }

  points.sort((a, b) => a.timestamp - b.timestamp);

  const maxPoints = params.maxPoints ?? 100;
  if (points.length > maxPoints) {
    const step = Math.ceil(points.length / maxPoints);
    const downsampled: typeof points = [];
    let bucket: (typeof points)[number] | undefined;
    let bucketSize = 0;
    for (const point of points) {
      if (!bucket || bucketSize === step) {
        bucket = {
          timestamp: point.timestamp,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: 0,
        };
        downsampled.push(bucket);
        bucketSize = 0;
      }
      bucket.timestamp = point.timestamp;
      bucket.input += point.input;
      bucket.output += point.output;
      bucket.cacheRead += point.cacheRead;
      bucket.cacheWrite += point.cacheWrite;
      bucket.totalTokens += point.totalTokens;
      bucket.cost += point.cost;
      bucketSize += 1;
    }
    points = downsampled;
  }

  // Accumulate after sampling to preserve the bucket-based floating-point sums.
  let cumulativeTokens = 0;
  let cumulativeCost = 0;
  return {
    sessionId: params.sessionId,
    points: points.map((point) => {
      cumulativeTokens += point.totalTokens;
      cumulativeCost += point.cost;
      return Object.assign(point, { cumulativeTokens, cumulativeCost });
    }),
  };
}

export async function loadSessionLogs(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId: string;
  limit?: number;
}): Promise<SessionLogEntry[] | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile) {
    return null;
  }
  if (!parseSqliteSessionFileMarker(sessionFile) && !fs.existsSync(sessionFile)) {
    return null;
  }

  const logs: SessionLogEntry[] = [];
  if (params.limit !== undefined && params.limit !== null) {
    if (!Number.isFinite(params.limit) || params.limit <= 0) {
      return [];
    }
  }
  const limit = params.limit ?? 50;
  const boundedLimit = Number.isInteger(limit);
  const retentionLimit = limit * 2;
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const resolveCost = createUsageCostResolver({ config: params.config, agentDir });

  for await (const parsed of readTranscriptRecordsBestEffort(sessionFile)) {
    let role: SessionLogEntry["role"];
    let content: string;
    try {
      const message = parsed.message as Record<string, unknown> | undefined;
      if (!message) {
        continue;
      }

      const recordRole = message.role as string | undefined;
      if (
        recordRole !== "user" &&
        recordRole !== "assistant" &&
        recordRole !== "tool" &&
        recordRole !== "toolResult"
      ) {
        continue;
      }
      role = recordRole;

      const contentParts: string[] = [];
      const rawToolName = message.toolName ?? message.tool_name ?? message.name ?? message.tool;
      const toolName = normalizeOptionalString(rawToolName);
      if (role === "tool" || role === "toolResult") {
        contentParts.push(`[Tool: ${toolName ?? "tool"}]`);
        contentParts.push("[Tool Result]");
      }

      // Extract content
      const rawContent = message.content;
      if (typeof rawContent === "string") {
        contentParts.push(rawContent);
      } else if (Array.isArray(rawContent)) {
        // Handle content blocks (text, tool_use, etc.)
        const contentText = rawContent
          .map((block: unknown) => {
            if (typeof block === "string") {
              return block;
            }
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              return b.text;
            }
            if (isToolCallContentType(normalizeOptionalString(b.type))) {
              const name = typeof b.name === "string" ? b.name : "unknown";
              return `[Tool: ${name}]`;
            }
            if (b.type === "tool_result") {
              return "[Tool Result]";
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
        if (contentText) {
          contentParts.push(contentText);
        }
      }

      // OpenAI-style tool calls stored outside the content array.
      const rawToolCalls =
        message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
      const toolCalls = Array.isArray(rawToolCalls)
        ? rawToolCalls
        : rawToolCalls
          ? [rawToolCalls]
          : [];
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          const callObj = call as Record<string, unknown>;
          const directName = typeof callObj.name === "string" ? callObj.name : undefined;
          const fn = callObj.function as Record<string, unknown> | undefined;
          const fnName = typeof fn?.name === "string" ? fn.name : undefined;
          const name = directName ?? fnName ?? "unknown";
          contentParts.push(`[Tool: ${name}]`);
        }
      }

      const rawText = contentParts.join("\n");
      content =
        role === "user"
          ? stripUserEnvelopeForDisplay(rawText).trim()
          : stripInboundMetadata(rawText.trim());
      if (!content) {
        continue;
      }

      // Truncate very long content.
      const maxLen = 2000;
      if (content.length > maxLen) {
        content = truncateUtf16Safe(content, maxLen) + "…";
      }
    } catch {
      // Ignore malformed records.
      continue;
    }

    // Logs share pricing and timestamp interpretation with summaries and charts.
    // Recomputing here can turn unknown prices into zero or ignore tiered rates.
    const entry = await parseUsageCostTranscriptEntryAsync(parsed, resolveCost, params.config);
    const usage = role === "assistant" ? entry?.usage : undefined;

    logs.push({
      timestamp: entry?.timestamp?.getTime() ?? 0,
      role,
      content,
      tokens: usage ? computeUsageTokenTotals(usage).totalTokens : undefined,
      cost: usage ? entry?.costTotal : undefined,
    });
    // Timestamps can arrive out of order, so keep a bounded sorted window instead
    // of relying on transcript append order or retaining the whole file.
    if (boundedLimit && logs.length > retentionLimit) {
      logs.sort((a, b) => a.timestamp - b.timestamp);
      logs.splice(0, logs.length - limit);
    }
  }

  // Sort by timestamp and limit
  if (boundedLimit) {
    logs.sort((a, b) => a.timestamp - b.timestamp);
    return logs.length > limit ? logs.slice(-limit) : logs;
  }

  // Return most recent logs
  const sortedLogs = logs.toSorted((a, b) => a.timestamp - b.timestamp);
  if (sortedLogs.length > limit) {
    return sortedLogs.slice(-limit);
  }

  return sortedLogs;
}
