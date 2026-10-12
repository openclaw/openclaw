import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { stripUserEnvelopeForDisplay } from "../auto-reply/reply/user-envelope-display.js";
import { isToolCallContentType } from "../chat/tool-content.js";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sleep } from "../utils/sleep.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { isSessionCostUsageRefreshRunning } from "./session-cost-usage-cache.sqlite.js";
import {
  readTranscriptRecords,
  readTranscriptRecordsBestEffort,
  resolveUsageSessionSource,
} from "./session-cost-usage-collection.js";
import {
  withUsageCostIncognitoScope,
  captureUsageCostIncognitoBinding,
  type UsageCostIncognitoBinding,
} from "./session-cost-usage-incognito.js";
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
const USAGE_COST_DIRECT_REFRESH_MAX_WAIT_MS = 5_000;

type SessionUsageDiagnosticParams = {
  sessionId?: string;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId: string;
  incognito?: UsageCostIncognitoBinding;
};

function withSessionUsageDiagnosticSource<Params extends SessionUsageDiagnosticParams, Result>(
  params: Params,
  read: (scoped: Params, sessionFile: string) => Promise<Result>,
): Promise<Result | null> {
  return withUsageCostIncognitoScope(
    captureUsageCostIncognitoBinding(params),
    async (incognito) => {
      const scoped = { ...params, incognito };
      const source = await resolveUsageSessionSource(scoped);
      if (
        !source ||
        (!parseSqliteSessionFileMarker(source.sessionFile) && !fs.existsSync(source.sessionFile))
      ) {
        return null;
      }
      return read(scoped, source.sessionFile);
    },
  );
}

export async function discoverAllSessions(params: {
  agentId: string;
  incognito?: UsageCostIncognitoBinding;
  startMs?: number;
  endMs?: number;
}): Promise<DiscoveredSession[]> {
  const result = await runUsageCostWorker(
    prepareUsageCostWorker({
      ...params,
      storePath: params.incognito?.actor.path,
    }),
    {
      kind: "inventory",
      minMtimeMs: params.startMs,
    },
    params.incognito,
  );
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

  return Array.from(discovered.values()).toSorted((a, b) => b.mtime - a.mtime);
}

export async function loadSessionCostSummary(params: {
  sessionId?: string;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId: string;
  incognito?: UsageCostIncognitoBinding;
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
  const binding = captureUsageCostIncognitoBinding(params);
  const captured = binding ? prepareUsageCostWorker({ ...params, incognito: binding }) : undefined;
  return withUsageCostIncognitoScope(binding, async (incognito) => {
    const scoped = { ...params, incognito };
    const source = await resolveUsageSessionSource(scoped);
    if (!source) {
      return null;
    }
    const { sessionFile } = source;
    const prepared = captured ?? prepareUsageCostWorker({ ...scoped, sessionFiles: [sessionFile] });
    const refreshWaitStartedAt = Date.now();
    let refreshResult: "refreshed" | "busy" = "busy";
    while (Date.now() - refreshWaitStartedAt < USAGE_COST_DIRECT_REFRESH_MAX_WAIT_MS) {
      if (
        await isSessionCostUsageRefreshRunning(
          scoped.incognito?.actor.agentId ?? scoped.agentId,
          scoped.incognito?.actor.path ?? prepared.location.databasePath,
          scoped.incognito,
        )
      ) {
        await sleep(USAGE_COST_DIRECT_REFRESH_RETRY_MS);
        continue;
      }
      refreshResult = await refreshCostUsageCacheForAgent({
        config: scoped.config,
        agentId: scoped.agentId,
        agentDir: prepared.agentDir,
        databasePath: prepared.location.databasePath,
        storePath: prepared.location.storePath,
        env: prepared.location.env,
        sessionFiles: [sessionFile],
        incognito: scoped.incognito,
      });
      if (refreshResult !== "busy") {
        break;
      }
    }
    // A held lock means the cache can lag the transcript. Return no total
    // instead of projecting that checkpoint.
    if (refreshResult === "busy") {
      return null;
    }
    const inventory = await runUsageCostWorker(
      prepared,
      {
        kind: "inventory",
        sessionFiles: [sessionFile],
      },
      scoped.incognito,
    );
    if (inventory.kind !== "inventory") {
      throw new Error("Usage worker returned an invalid session inventory");
    }
    if (inventory.files.length === 0) {
      return null;
    }
    const pricingFingerprint = await resolveUsageCostPricingFingerprint(
      prepared.config,
      prepared.agentDir,
    );
    const result = await runUsageCostWorker(
      prepared,
      {
        kind: "sessions",
        pricingFingerprint,
        sessions: [{ sessionId: scoped.sessionId, sessionFile }],
        startMs: scoped.startMs,
        endMs: scoped.endMs,
        includeUntimestamped: scoped.includeUntimestamped,
        dayBucket: resolveUsageCostWorkerDayBucket(scoped.dayBucket),
      },
      scoped.incognito,
    );
    if (result.kind !== "sessions") {
      throw new Error("Usage worker returned an invalid session summary");
    }
    return result.summaries[0] ?? null;
  });
}

export async function loadSessionUsageTimeSeries(
  params: SessionUsageDiagnosticParams & { maxPoints?: number },
): Promise<SessionUsageTimeSeries | null> {
  return withSessionUsageDiagnosticSource(params, async (scoped, sessionFile) => {
    if (scoped.maxPoints !== undefined && scoped.maxPoints !== null) {
      if (!Number.isFinite(scoped.maxPoints) || scoped.maxPoints <= 0) {
        return { sessionId: scoped.sessionId, points: [] };
      }
    }

    let points: Array<Omit<SessionUsageTimePoint, "cumulativeTokens" | "cumulativeCost">> = [];
    const agentDir = resolveAgentDir(scoped.config ?? {}, scoped.agentId);
    const resolveCost = createUsageCostResolver({ config: scoped.config, agentDir });

    for await (const record of readTranscriptRecords(sessionFile, scoped.incognito)) {
      const entry = await parseUsageCostTranscriptEntryAsync(record, resolveCost, scoped.config);
      const timestamp = entry?.timestamp?.getTime();
      if (!entry?.usage || !timestamp) {
        continue;
      }
      points.push({
        timestamp,
        ...computeUsageTokenTotals(entry.usage),
        cost: entry.costTotal ?? 0,
      });
    }

    points.sort((a, b) => a.timestamp - b.timestamp);

    const maxPoints = scoped.maxPoints ?? 100;
    if (points.length > maxPoints) {
      const step = Math.ceil(points.length / maxPoints);
      const downsampled: typeof points = [];
      let bucket: (typeof points)[number] | undefined;
      for (const [index, point] of points.entries()) {
        if (!bucket || index % step === 0) {
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
        }
        bucket.timestamp = point.timestamp;
        bucket.input += point.input;
        bucket.output += point.output;
        bucket.cacheRead += point.cacheRead;
        bucket.cacheWrite += point.cacheWrite;
        bucket.totalTokens += point.totalTokens;
        bucket.cost += point.cost;
      }
      points = downsampled;
    }

    // Accumulate after sampling to preserve the bucket-based floating-point sums.
    let cumulativeTokens = 0;
    let cumulativeCost = 0;
    return {
      sessionId: scoped.sessionId,
      points: points.map((point) => {
        cumulativeTokens += point.totalTokens;
        cumulativeCost += point.cost;
        return Object.assign(point, { cumulativeTokens, cumulativeCost });
      }),
    };
  });
}

export async function loadSessionLogs(
  params: SessionUsageDiagnosticParams & { limit?: number },
): Promise<SessionLogEntry[] | null> {
  return withSessionUsageDiagnosticSource(params, async (scoped, sessionFile) => {
    const logs: SessionLogEntry[] = [];
    if (scoped.limit !== undefined && scoped.limit !== null) {
      if (!Number.isFinite(scoped.limit) || scoped.limit <= 0) {
        return [];
      }
    }
    const limit = scoped.limit ?? 50;
    const boundedLimit = Number.isInteger(limit);
    const retentionLimit = limit * 2;
    const agentDir = resolveAgentDir(scoped.config ?? {}, scoped.agentId);
    const resolveCost = createUsageCostResolver({ config: scoped.config, agentDir });

    for await (const parsed of readTranscriptRecordsBestEffort(sessionFile, scoped.incognito)) {
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

        const rawContent = message.content;
        if (typeof rawContent === "string") {
          contentParts.push(rawContent);
        } else if (Array.isArray(rawContent)) {
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
        for (const call of toolCalls) {
          const callObj = call as Record<string, unknown>;
          const directName = typeof callObj.name === "string" ? callObj.name : undefined;
          const fn = callObj.function as Record<string, unknown> | undefined;
          const fnName = typeof fn?.name === "string" ? fn.name : undefined;
          const name = directName ?? fnName ?? "unknown";
          contentParts.push(`[Tool: ${name}]`);
        }

        const rawText = contentParts.join("\n");
        content =
          role === "user"
            ? stripUserEnvelopeForDisplay(rawText).trim()
            : stripInboundMetadata(rawText.trim());
        if (!content) {
          continue;
        }

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
      const entry = await parseUsageCostTranscriptEntryAsync(parsed, resolveCost, scoped.config);
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

    logs.sort((a, b) => a.timestamp - b.timestamp);
    return logs.length > limit ? logs.slice(-limit) : logs;
  });
}
