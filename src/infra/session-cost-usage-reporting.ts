import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { stripUserEnvelopeForDisplay } from "../auto-reply/reply/user-envelope-display.js";
import { isToolCallContentType } from "../chat/tool-content.js";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import {
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  parseSessionArchiveTimestamp,
} from "../config/sessions/artifacts.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import {
  resolveSessionFilePathCore,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { loadSessionTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import { selectVisibleTranscriptEvents } from "../config/sessions/transcript-visible-events.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
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

type SessionUsageDiagnosticParams = {
  sessionId?: string;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId: string;
};

async function withSessionUsageDiagnosticSource<
  Params extends SessionUsageDiagnosticParams,
  Result,
>(
  params: Params,
  read: (scoped: Params, sessionFile: string) => Promise<Result>,
): Promise<Result | null> {
  const source = await resolveUsageSessionSource(params);
  const marker = source && parseSqliteSessionFileMarker(source.sessionFile);
  if (!source || (!marker && !fs.existsSync(source.sessionFile))) {
    return null;
  }
  const signal = getAsyncWorkSignal();
  const memory =
    marker &&
    captureSessionActorStorageOwner(marker, {
      assertCurrent: () => signal?.throwIfAborted(),
      authorize() {},
    });
  const result = await read(params, source.sessionFile);
  // Recheck the live caller at disclosure, after awaited pricing and transcript work.
  memory?.owner?.assertCurrent();
  memory?.authority.assertCurrent();
  return result;
}

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
        ...(file.transcriptFile ? { transcriptFile: file.transcriptFile } : {}),
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
  const source = await resolveUsageSessionSource(params);
  if (!source) {
    return null;
  }
  const { sessionFile } = source;
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
  await refreshCostUsageCacheForAgent({
    config: params.config,
    agentId: params.agentId,
    agentDir: prepared.agentDir,
    databasePath: prepared.location.databasePath,
    storePath: prepared.location.storePath,
    env: prepared.location.env,
    sessionFiles: [sessionFile],
    sessionActor: prepared.sessionActor,
    waitForRefresh: true,
  });
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
    let usageUnavailable = false;
    const agentDir = resolveAgentDir(scoped.config ?? {}, scoped.agentId);
    const resolveCost = createUsageCostResolver({ config: scoped.config, agentDir });

    for await (const record of readTranscriptRecords(sessionFile)) {
      const entry = await parseUsageCostTranscriptEntryAsync(record, resolveCost, scoped.config);
      const timestamp = entry?.timestamp?.getTime();
      if (!entry?.usage || !timestamp) {
        continue;
      }
      if (entry.usage.usageReport?.state === "unavailable") {
        usageUnavailable = true;
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
      ...(usageUnavailable ? { usageReport: { state: "unavailable" as const } } : {}),
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
      if (!Number.isInteger(scoped.limit) || scoped.limit <= 0) {
        return [];
      }
    }
    const limit = scoped.limit ?? 50;
    const retentionLimit = limit * 2;
    const agentDir = resolveAgentDir(scoped.config ?? {}, scoped.agentId);
    const resolveCost = createUsageCostResolver({ config: scoped.config, agentDir });

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
        continue;
      }

      // Logs share pricing and timestamp interpretation with summaries and charts.
      // Recomputing here can turn unknown prices into zero or ignore tiered rates.
      const entry = await parseUsageCostTranscriptEntryAsync(parsed, resolveCost, scoped.config);
      const usage =
        role === "assistant" && entry?.usage?.usageReport?.state !== "unavailable"
          ? entry?.usage
          : undefined;

      logs.push({
        timestamp: entry?.timestamp?.getTime() ?? 0,
        role,
        content,
        tokens: usage ? computeUsageTokenTotals(usage).totalTokens : undefined,
        cost: usage ? entry?.costTotal : undefined,
      });
      // Timestamps can arrive out of order, so keep a bounded sorted window instead
      // of relying on transcript append order or retaining the whole file.
      if (logs.length > retentionLimit) {
        logs.sort((a, b) => a.timestamp - b.timestamp);
        logs.splice(0, logs.length - limit);
      }
    }

    logs.sort((a, b) => a.timestamp - b.timestamp);
    return logs.length > limit ? logs.slice(-limit) : logs;
  });
}

async function* readTranscriptRecords(filePath: string): AsyncGenerator<Record<string, unknown>> {
  const marker = parseSqliteSessionFileMarker(filePath);
  if (marker) {
    const signal = getAsyncWorkSignal();
    const authority = {
      assertCurrent: () => signal?.throwIfAborted(),
      authorize() {},
    };
    const memory = captureSessionActorStorageOwner(marker, authority);
    let events: unknown[];
    if (memory) {
      events =
        (await withSessionActorStorage(
          marker,
          {
            authority: memory.authority,
            lifetime: {
              assertCurrent: () => memory.authority.assertCurrent(),
              assertReadable: () => memory.authority.assertCurrent(),
            },
          },
          async (binding) => {
            const rows = await binding.actor.storage.read(
              {
                type: "session.usage.snapshot",
                input: { sessionIds: [marker.sessionId], includeEvents: true },
              },
              binding.authority,
            );
            return (rows[0]?.events ?? []).map(({ eventJson }): unknown => JSON.parse(eventJson));
          },
        )) ?? [];
    } else {
      events = await loadSessionTranscriptEvents(marker);
    }
    for (const event of selectVisibleTranscriptEvents(events)) {
      if (isRecord(event)) {
        yield event;
      }
    }
    return;
  }
  // Durable byte-offset scans own their checkpoint reader. Diagnostic history
  // shares the canonical transcript stream and materializes archive bytes once.
  const transcriptPath = materializeSessionArchiveForRead(filePath);
  for await (const line of streamSessionTranscriptLines(transcriptPath)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) {
        yield parsed;
      }
    } catch {
      // Historical transcripts can contain malformed records.
    }
  }
}

async function* readTranscriptRecordsBestEffort(
  filePath: string,
): AsyncGenerator<Record<string, unknown>> {
  try {
    yield* readTranscriptRecords(filePath);
  } catch (error) {
    if (parseSqliteSessionFileMarker(filePath)) {
      throw error;
    }
    // Diagnostic readers return the records available before a stream failure.
    // Durable cache scans use the strict reader so partial data is never marked fresh.
  }
}

export async function resolveUsageSessionSource(input: {
  sessionId?: string;
  sessionFile?: string;
  agentId: string;
  sessionTarget?: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };
}): Promise<{ sessionFile: string; entry?: SessionEntry } | undefined> {
  const params = input;
  const signal = getAsyncWorkSignal();
  const assertCurrent = () => signal?.throwIfAborted();
  assertCurrent();
  const sessionId = normalizeOptionalString(params.sessionId);
  const target = params.sessionTarget;
  if (target) {
    const agentId = normalizeOptionalString(target.agentId);
    const targetSessionId = normalizeOptionalString(target.sessionId);
    const sessionKey = normalizeOptionalString(target.sessionKey);
    const storePath = normalizeOptionalString(target.storePath);
    if (!agentId || !targetSessionId || !sessionKey || !storePath) {
      return undefined;
    }
    const targetKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
    if (
      (sessionId !== undefined && targetSessionId !== sessionId) ||
      agentId !== params.agentId ||
      (targetKeyAgentId && targetKeyAgentId !== agentId)
    ) {
      return undefined;
    }
    const authority = { assertCurrent, authorize() {} };
    const memory = captureSessionActorStorageOwner({ agentId, sessionKey, storePath }, authority);
    if (memory) {
      return withSessionActorStorage(
        { agentId, sessionKey, storePath },
        {
          authority: memory.authority,
          lifetime: { assertCurrent, assertReadable: assertCurrent },
        },
        async (binding) => {
          const entry = await binding.actor.storage.read(
            { type: "session.entry.read", input: {} },
            binding.authority,
          );
          if (entry && entry.sessionId !== targetSessionId) {
            return undefined;
          }
          return {
            entry,
            sessionFile: formatSqliteSessionFileMarker({
              agentId,
              sessionId: targetSessionId,
              storePath: binding.path,
            }),
          };
        },
      );
    }
    return withSessionEntryReadOnlyInWorker(
      { agentId, sessionKey, storePath, projection: "list" },
      assertCurrent,
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        // A retained transcript can outlive its metadata row, but never its successor.
        if (read.value && read.value.sessionId !== targetSessionId) {
          return undefined;
        }
        const physicalPath =
          owner.scope?.storePath ??
          (await prepareSqliteTargetFromSessionStorePath(storePath, { agentId }, signal)).path;
        owner.assertCurrent();
        return {
          entry: read.value,
          sessionFile: formatSqliteSessionFileMarker({
            agentId,
            sessionId: targetSessionId,
            storePath: physicalPath,
          }),
        };
      },
    );
  }
  const sqliteMarker = parseSqliteSessionFileMarker(params.sessionFile);
  if (sqliteMarker) {
    if (
      sqliteMarker.agentId !== params.agentId ||
      (sessionId && sqliteMarker.sessionId !== sessionId)
    ) {
      return undefined;
    }
    return { sessionFile: formatSqliteSessionFileMarker(sqliteMarker) };
  }

  const candidate =
    params.sessionFile ??
    (sessionId
      ? resolveSessionFilePathCore(sessionId, undefined, {
          agentId: params.agentId,
        })
      : undefined);

  if (candidate && fs.existsSync(candidate)) {
    return { sessionFile: candidate };
  }
  if (!sessionId) {
    return candidate ? { sessionFile: candidate } : undefined;
  }

  try {
    const sessionsDir = candidate
      ? path.dirname(candidate)
      : resolveSessionTranscriptsDirForAgent(params.agentId);
    const baseFileName = `${sessionId}.jsonl`;
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => {
      return (
        entry.isFile() &&
        (entry.name === baseFileName ||
          entry.name.startsWith(`${baseFileName}.reset.`) ||
          entry.name.startsWith(`${baseFileName}.deleted.`))
      );
    });

    const primary = entries.find((entry) => entry.name === baseFileName);
    if (primary) {
      return { sessionFile: path.join(sessionsDir, primary.name) };
    }

    const archiveTimestamp = (name: string) =>
      parseSessionArchiveTimestamp(name, "deleted") ??
      parseSessionArchiveTimestamp(name, "reset") ??
      0;
    const latestArchive = entries
      .filter((entry) => isSessionArchiveArtifactName(entry.name))
      .map((entry) => entry.name)
      .toSorted((a, b) => archiveTimestamp(b) - archiveTimestamp(a) || b.localeCompare(a))[0];

    const sessionFile = latestArchive ? path.join(sessionsDir, latestArchive) : candidate;
    return sessionFile ? { sessionFile } : undefined;
  } catch {
    return candidate ? { sessionFile: candidate } : undefined;
  }
}
