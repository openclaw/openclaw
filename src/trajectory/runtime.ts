// Trajectory runtime records bounded session events into SQLite-backed storage.
import { hash } from "node:crypto";
import { isProxy } from "node:util/types";
import type { DiagnosticProjectionPolicy } from "@openclaw/ai/diagnostics";
import { projectPreparedDiagnosticValue } from "@openclaw/ai/internal/shared";
import { getPublishedRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import {
  TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES,
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
} from "./paths.js";
import { createSqliteTrajectoryRuntimeSink } from "./runtime-store-writer.js";
import type { TrajectoryEvent, TrajectoryToolDefinition } from "./types.js";

type TrajectoryRuntimeInit = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  maxRuntimeFileBytes?: number;
  runId?: string;
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  assertCommitAllowed?: () => void;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
};

const TRAJECTORY_RUNTIME_DATA_STRING_MAX_CHARS = 32_768;
const TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS = 64;
const TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS = 64;
const TRAJECTORY_RUNTIME_DATA_MAX_DEPTH = 6;
const TRAJECTORY_RUNTIME_FINAL_PROMPT_MAX_BYTES = 4 * 1024;
const TRAJECTORY_TOOL_CACHE_MAX_CHARS = 16_384;
const TRAJECTORY_TOOL_CACHE_MAX_ENTRIES = 256;
const toolParameterProjections = new Map<string, string>();
const TRAJECTORY_PAYLOAD_PROJECTION = {
  // Every JSON object needs at least two bytes. Avoid a second, smaller budget
  // corrupting payloads that fit the event limit, including explicit bound markers.
  maxNodes: TRAJECTORY_RUNTIME_EVENT_MAX_BYTES / 2,
  maxKeys: TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS + 2,
  redactCredentials: false,
  omitField: (key) => key === "providerReplay",
  propertyScope: "enumerable",
  projectBinary: (binary) => ({
    redacted: "<redacted>",
    bytes: binary.byteLength,
    sha256: sha256Hex(binary),
  }),
  projectMedia: (key, media) => ({
    [key]: "<redacted>",
    ...(media.source === undefined ? {} : { bytes: media.bytes, sha256: sha256Hex(media.source) }),
  }),
} satisfies DiagnosticProjectionPolicy;

// Oversized events first shed repeated conversation state while keeping the
// rest of their schema-v1 payload. The compact fallback then preserves keys
// that remain useful even when every nonessential field must be dropped.
// sanitizeTrajectoryPayload bounds prompt strings before this limiter runs.
const TRAJECTORY_RUNTIME_OVERSIZE_DROP_FIRST_DATA_KEYS = [
  "messagesSnapshot",
  "messages",
  "systemPrompt",
] as const;
const OVERSIZE_PRESERVED_DATA_KEYS = [
  "threadId",
  "turnId",
  "itemId",
  "toolCallId",
  "name",
  "status",
  "success",
  "isError",
  "timedOut",
  "yieldDetected",
  "aborted",
  "promptError",
  "stopReason",
  "usage",
  "promptCache",
  "prompt",
] as const;

function truncateOversizedTrajectoryEvent(
  event: TrajectoryEvent,
  line: string,
  stringify: (event: TrajectoryEvent) => string | null | undefined,
): string | undefined {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
    return line;
  }

  const originalData = event.data ?? {};
  const originalDataKeys = Object.keys(originalData);
  const preservedDataKeys = new Set<string>();
  const baseData = {
    truncated: true,
    originalBytes: bytes,
    limitBytes: TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
    reason: "trajectory-event-size-limit",
  };
  const reducedData = { ...originalData };
  const reducedDroppedFields: string[] = [];
  for (const key of TRAJECTORY_RUNTIME_OVERSIZE_DROP_FIRST_DATA_KEYS) {
    if (!Object.hasOwn(reducedData, key)) {
      continue;
    }
    delete reducedData[key];
    reducedDroppedFields.push(key);
    const reduced = stringify({
      ...event,
      data: {
        ...reducedData,
        ...baseData,
        droppedFields: reducedDroppedFields,
      },
    });
    if (reduced && Buffer.byteLength(reduced, "utf8") <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
      return reduced;
    }
  }

  const buildTruncatedEventLine = (includeDroppedFields: boolean): string | undefined => {
    const data: Record<string, unknown> = { ...baseData };
    for (const key of OVERSIZE_PRESERVED_DATA_KEYS) {
      if (preservedDataKeys.has(key)) {
        data[key] = originalData[key];
      }
    }
    if (includeDroppedFields) {
      const droppedFields = originalDataKeys.filter((key) => !preservedDataKeys.has(key));
      if (droppedFields.length > 0) {
        data.droppedFields = droppedFields;
      }
    }
    const truncated = stringify({ ...event, data });
    if (truncated && Buffer.byteLength(truncated, "utf8") <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
      return truncated;
    }
    return undefined;
  };

  let best = buildTruncatedEventLine(true) ?? buildTruncatedEventLine(false);
  if (!best) {
    return undefined;
  }

  for (const key of OVERSIZE_PRESERVED_DATA_KEYS) {
    if (!Object.hasOwn(originalData, key)) {
      continue;
    }
    preservedDataKeys.add(key);
    const next = buildTruncatedEventLine(true) ?? buildTruncatedEventLine(false);
    if (next) {
      best = next;
      continue;
    }
    preservedDataKeys.delete(key);
  }
  return best;
}

function truncatedTrajectoryValue(reason: string, details: Record<string, unknown> = {}): unknown {
  return Object.assign({ truncated: true, reason }, details);
}

function limitTrajectoryPayloadValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
  serialization?: { needsSafeJson: boolean },
): unknown {
  if (typeof value === "string") {
    if (value.length > TRAJECTORY_RUNTIME_DATA_STRING_MAX_CHARS) {
      return truncatedTrajectoryValue("trajectory-field-size-limit", {
        originalChars: value.length,
        limitChars: TRAJECTORY_RUNTIME_DATA_STRING_MAX_CHARS,
      });
    }
    return value;
  }
  if (typeof value !== "object" || value === null) {
    if (serialization && (typeof value === "bigint" || typeof value === "function")) {
      serialization.needsSafeJson = true;
    }
    return value;
  }
  if (seen.has(value)) {
    return truncatedTrajectoryValue("trajectory-circular-reference");
  }
  if (depth >= TRAJECTORY_RUNTIME_DATA_MAX_DEPTH) {
    return truncatedTrajectoryValue("trajectory-depth-limit", {
      limitDepth: TRAJECTORY_RUNTIME_DATA_MAX_DEPTH,
    });
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const limited: unknown[] = [];
    const count = Math.min(value.length, TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS);
    for (let index = 0; index < count; index += 1) {
      limited.push(limitTrajectoryPayloadValue(value[index], depth + 1, seen, serialization));
    }
    if (value.length > TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS) {
      limited.push(
        truncatedTrajectoryValue("trajectory-array-size-limit", {
          originalLength: value.length,
          limitItems: TRAJECTORY_RUNTIME_DATA_ARRAY_MAX_ITEMS,
        }),
      );
    }
    seen.delete(value);
    return limited;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const limited: Record<string, unknown> = {};
  for (const key of keys.slice(0, TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS)) {
    limited[key] = limitTrajectoryPayloadValue(record[key], depth + 1, seen, serialization);
  }
  if (keys.length > TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS) {
    limited["_truncated"] = truncatedTrajectoryValue("trajectory-object-size-limit", {
      originalKeys: keys.length,
      limitKeys: TRAJECTORY_RUNTIME_DATA_OBJECT_MAX_KEYS,
    });
  }
  seen.delete(value);
  return limited;
}

function sanitizeTrajectoryPayload(
  data: Record<string, unknown>,
  serialization: { needsSafeJson: boolean },
): Record<string, unknown> {
  const finalPromptText = data.finalPromptText;
  let boundedData = data;
  if (typeof finalPromptText === "string") {
    boundedData = { ...data };
    if (Buffer.byteLength(finalPromptText, "utf8") > TRAJECTORY_RUNTIME_FINAL_PROMPT_MAX_BYTES) {
      boundedData.finalPromptText = truncateUtf8Prefix(
        finalPromptText,
        TRAJECTORY_RUNTIME_FINAL_PROMPT_MAX_BYTES,
      );
      boundedData.finalPromptTextOriginalLength = finalPromptText.length;
    }
  }
  return projectPreparedDiagnosticValue(
    limitTrajectoryPayloadValue(boundedData, 0, new WeakSet(), serialization),
    TRAJECTORY_PAYLOAD_PROJECTION,
  ) as Record<string, unknown>;
}

function isTrajectoryJsonData(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0);
  }
  if (
    typeof value !== "object" ||
    depth > TRAJECTORY_RUNTIME_DATA_MAX_DEPTH + 1 ||
    isProxy(value)
  ) {
    return false;
  }
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) {
    return false;
  }
  const keys = Reflect.ownKeys(value).filter((key) => !array || key !== "length");
  if (array && keys.length !== value.length) {
    return false;
  }
  return keys.every((key, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return (
      typeof key === "string" &&
      (!array || key === String(index)) &&
      "value" in descriptor &&
      descriptor.enumerable &&
      isTrajectoryJsonData(descriptor.value, depth + 1)
    );
  });
}

function projectTrajectoryToolParameters(parameters: unknown): unknown {
  const published = getPublishedRuntimeToolInputSchema(parameters);
  // Publication owns immutable JSON; mutable or opaque inputs still need current bounds.
  const bounded = published ? undefined : limitTrajectoryPayloadValue(parameters);
  if (!published && !isTrajectoryJsonData(bounded)) {
    return projectPreparedDiagnosticValue(bounded, TRAJECTORY_PAYLOAD_PROJECTION);
  }
  const content = published?.json ?? JSON.stringify(bounded);
  const project = () =>
    projectPreparedDiagnosticValue(
      published ? limitTrajectoryPayloadValue(parameters) : bounded,
      TRAJECTORY_PAYLOAD_PROJECTION,
    );
  if (!published && content.length > TRAJECTORY_TOOL_CACHE_MAX_CHARS) {
    return project();
  }
  // Raw and already-bounded JSON can differ at truncation boundaries.
  const key = published ? `published:${published.fingerprint}` : hash("sha256", content);
  const cached = toolParameterProjections.get(key);
  if (cached !== undefined) {
    return JSON.parse(cached);
  }
  const projected = project();
  const serialized = JSON.stringify(projected);
  if (serialized.length <= TRAJECTORY_TOOL_CACHE_MAX_CHARS) {
    if (toolParameterProjections.size >= TRAJECTORY_TOOL_CACHE_MAX_ENTRIES) {
      toolParameterProjections.delete(toolParameterProjections.keys().next().value!);
    }
    toolParameterProjections.set(key, serialized);
  }
  return projected;
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
          parameters: projectTrajectoryToolParameters(tool.parameters),
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export async function createTrajectoryRuntimeRecorder(input: TrajectoryRuntimeInit) {
  const params = {
    ...input,
    env: { ...(input.env ?? process.env) },
    sessionTarget: input.sessionTarget && { ...input.sessionTarget },
  };
  const env = params.env;
  // Trajectory capture is now default-on. The env var remains as an explicit
  // override so operators can still disable recording with OPENCLAW_TRAJECTORY=0.
  const enabled = parseBooleanValue(env.OPENCLAW_TRAJECTORY) ?? true;
  if (!enabled) {
    return null;
  }

  const maxRuntimeFileBytes = Math.max(
    1,
    Math.floor(params.maxRuntimeFileBytes ?? TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES),
  );
  const sink = await createSqliteTrajectoryRuntimeSink({
    env,
    maxRuntimeFileBytes,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
    assertCommitAllowed: params.assertCommitAllowed,
  });
  params.assertCommitAllowed?.();
  if (!sink) {
    return null;
  }
  let seq = 0;

  return {
    enabled: true as const,
    recordEvent: (type: string, data?: Record<string, unknown>) => {
      const nextSeq = seq + 1;
      const serialization = { needsSafeJson: false };
      const event: TrajectoryEvent = {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: params.sessionId,
        source: "runtime",
        type,
        ts: new Date().toISOString(),
        seq: nextSeq,
        sourceSeq: nextSeq,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        workspaceDir: params.workspaceDir,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.modelApi,
        data: data ? sanitizeTrajectoryPayload(data, serialization) : undefined,
      };
      // Limiting already creates plain records. Only bigint/function leaves need
      // the replacer; functions include toJSON hooks that can return arbitrary values.
      const stringify = serialization.needsSafeJson ? safeJsonStringify : JSON.stringify;
      const line = stringify(event);
      if (!line) {
        return;
      }
      const boundedLine = truncateOversizedTrajectoryEvent(event, line, stringify);
      if (!boundedLine) {
        return;
      }
      seq = nextSeq;
      sink.write(event, boundedLine);
    },
    flush: sink.flush,
    describeFlushState: sink.describeFlushState,
  };
}
