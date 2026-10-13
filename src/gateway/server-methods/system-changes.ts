import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  ErrorCodes,
  errorShape,
  validateSystemChangesListParams,
  type SystemChangeEntry,
  type SystemChangesListParams,
  type SystemChangesListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { CONFIG_AUDIT_SCOPE, type ConfigAuditRecord } from "../../config/io.audit.js";
import { consumeRootOptionToken, FLAG_TERMINATOR } from "../../infra/cli-root-options.js";
import { createSqliteAuditRecordReader } from "../../infra/sqlite-audit-record-store.async.js";
import type { SequencedSqliteAuditRecordEntry } from "../../infra/sqlite-audit-record.kernel.js";
import { SYSTEM_AGENT_AUDIT_SCOPE, type SystemAgentAuditEntry } from "../../system-agent/audit.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const DEFAULT_CHANGE_LIMIT = 50;
const MAX_CHANGE_LIMIT = 200;
const CHANGE_SCAN_BATCH_SIZE = MAX_CHANGE_LIMIT + 1;
export const SYSTEM_CHANGE_MAX_RAW_SCAN_PER_SCOPE = 1_000;
const COLLAPSE_MAX_DELAY_MS = 60_000;
const MAX_PENDING_COLLAPSES = MAX_CHANGE_LIMIT;
const CONFIG_WRITE_PREFIXES = new Map<SystemChangeEntry["source"], string>([
  ["doctor", "Doctor updated configuration"],
  ["config-rpc", "Settings updated configuration"],
  ["plugin-install", "Plugin installation updated configuration"],
  ["system-agent", "OpenClaw updated configuration"],
  ["cli", "CLI updated configuration"],
]);

type PendingCollapse = {
  transition: string;
  maxConfigSequence: number;
  operationAt: number;
};

type ChangeCursor = {
  version: 1;
  systemAgentBefore: number;
  configBefore: number;
  pendingCollapse?: PendingCollapse[];
};

type ChangeScope = typeof SYSTEM_AGENT_AUDIT_SCOPE | typeof CONFIG_AUDIT_SCOPE;

type ChangeCandidate = {
  entry: SystemChangeEntry;
  recordedAt: number;
  transition?: string;
  pendingCollapse?: PendingCollapse;
  position: { scope: ChangeScope; sequence: number };
};

type CandidateScan = {
  entries: ChangeCandidate[];
  exhausted: boolean;
  nextBeforeSequence: number;
};

type AuditStore<T> = {
  latest: (params: {
    limit: number;
    beforeSequence?: number;
  }) => Promise<SequencedSqliteAuditRecordEntry<T>[]>;
};

function encodeCursor(cursor: ChangeCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): ChangeCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid change-history cursor");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Number.isSafeInteger((parsed as { systemAgentBefore?: unknown }).systemAgentBefore) ||
    !Number.isSafeInteger((parsed as { configBefore?: unknown }).configBefore) ||
    !isValidPendingCollapses((parsed as { pendingCollapse?: unknown }).pendingCollapse)
  ) {
    throw new Error("invalid change-history cursor");
  }
  return parsed as ChangeCursor;
}

function isValidPendingCollapses(value: unknown): value is PendingCollapse[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_PENDING_COLLAPSES &&
      value.every(
        (marker) =>
          marker !== null &&
          typeof marker === "object" &&
          typeof (marker as PendingCollapse).transition === "string" &&
          (marker as PendingCollapse).transition.length <= 512 &&
          Number.isSafeInteger((marker as PendingCollapse).maxConfigSequence) &&
          Number.isSafeInteger((marker as PendingCollapse).operationAt),
      ))
  );
}

function transitionKey(before: string | null | undefined, after: string | null | undefined) {
  if (before === after || (before == null && after == null)) {
    return undefined;
  }
  return JSON.stringify([before ?? null, after ?? null]);
}

function classifyConfigWriteSource(record: Extract<ConfigAuditRecord, { event: "config.write" }>) {
  if (record.origin) {
    return record.origin;
  }
  const launcherIndex = record.argv.findIndex((arg) =>
    /(?:^|[/\\])openclaw(?:\.m?js)?$/i.test(arg),
  );
  let command: string | undefined;
  if (launcherIndex >= 0) {
    for (let index = launcherIndex + 1; index < record.argv.length; index += 1) {
      const consumed = consumeRootOptionToken(record.argv, index);
      if (consumed > 0) {
        index += consumed - 1;
        continue;
      }
      if (record.argv[index] === FLAG_TERMINATOR) {
        command = record.argv[index + 1];
        break;
      }
      if (!record.argv[index]?.startsWith("-")) {
        command = record.argv[index];
        break;
      }
    }
  }
  if (command === "doctor") {
    return "doctor" as const;
  }
  if (command === "config") {
    return "cli" as const;
  }
  return "unknown" as const;
}

function summarizePaths(prefix: string, changedPaths: readonly string[] | undefined): string {
  if (!changedPaths || changedPaths.length === 0) {
    return prefix;
  }
  return `${prefix}: ${changedPaths.join(", ")}`;
}

function toSystemAgentCandidate(
  record: SequencedSqliteAuditRecordEntry<SystemAgentAuditEntry>,
): ChangeCandidate {
  return {
    entry: {
      id: `${SYSTEM_AGENT_AUDIT_SCOPE}:${record.sequence}`,
      at: parseDateStringTimestampMs(record.value.timestamp) ?? record.createdAt,
      kind: "operation",
      source: "system-agent",
      summary: record.value.summary,
    },
    transition: transitionKey(record.value.configHashBefore, record.value.configHashAfter),
    recordedAt: record.createdAt,
    position: { scope: SYSTEM_AGENT_AUDIT_SCOPE, sequence: record.sequence },
  };
}

function toConfigCandidate(
  record: SequencedSqliteAuditRecordEntry<ConfigAuditRecord>,
): ChangeCandidate | null {
  const value = record.value;
  if (
    value.event === "config.observe" ||
    (value.event !== "config.external" &&
      value.result !== "rename" &&
      value.result !== "copy-fallback")
  ) {
    return null;
  }
  const changedPaths = value.changedPaths?.length ? value.changedPaths : undefined;
  const source = value.event === "config.external" ? "external" : classifyConfigWriteSource(value);
  return {
    entry: {
      id: `${CONFIG_AUDIT_SCOPE}:${record.sequence}`,
      at: parseDateStringTimestampMs(value.ts) ?? record.createdAt,
      kind: value.event === "config.external" ? "external-edit" : "config-write",
      source,
      summary: summarizePaths(
        value.event === "config.external"
          ? "Configuration edited outside OpenClaw"
          : (CONFIG_WRITE_PREFIXES.get(source) ?? "Configuration updated"),
        changedPaths,
      ),
      ...(changedPaths ? { changedPaths } : {}),
      ...(value.event === "config.external" && !value.valid ? { invalid: true } : {}),
      ...(value.event === "config.external" && value.opaqueChange ? { opaqueChange: true } : {}),
    },
    transition: transitionKey(value.previousHash, value.nextHash),
    recordedAt: record.createdAt,
    position: { scope: CONFIG_AUDIT_SCOPE, sequence: record.sequence },
  };
}

async function scanCandidates<T>(params: {
  beforeSequence: number;
  target: number;
  latest: AuditStore<T>["latest"];
  project: (entry: SequencedSqliteAuditRecordEntry<T>) => ChangeCandidate | null;
}): Promise<CandidateScan> {
  const entries: ChangeCandidate[] = [];
  let beforeSequence = params.beforeSequence;
  let exhausted = false;
  let loadedRawEntries = 0;
  // Bound each scope even when most rows are observations or failed writes.
  while (
    entries.length < params.target &&
    loadedRawEntries < SYSTEM_CHANGE_MAX_RAW_SCAN_PER_SCOPE
  ) {
    const pageLimit = Math.min(
      CHANGE_SCAN_BATCH_SIZE,
      SYSTEM_CHANGE_MAX_RAW_SCAN_PER_SCOPE - loadedRawEntries,
    );
    const page = await params.latest({
      limit: pageLimit,
      beforeSequence,
    });
    if (page.length === 0) {
      exhausted = true;
      break;
    }
    loadedRawEntries += page.length;
    for (let index = 0; index < page.length; index += 1) {
      const entry = page[index]!;
      // The cursor tracks every scanned raw row, including filtered records.
      beforeSequence = entry.sequence;
      const candidate = params.project(entry);
      if (candidate) {
        entries.push(candidate);
        if (entries.length >= params.target) {
          exhausted = index === page.length - 1 && page.length < pageLimit;
          break;
        }
      }
    }
    if (entries.length >= params.target) {
      break;
    }
    if (page.length < pageLimit) {
      exhausted = true;
      break;
    }
  }
  return {
    entries,
    exhausted,
    nextBeforeSequence: entries.at(-1)?.position.sequence ?? beforeSequence,
  };
}

function planConfigMatches(
  systemCandidates: ChangeCandidate[],
  configCandidates: ChangeCandidate[],
): ReadonlyMap<ChangeCandidate, ChangeCandidate> {
  const configByTransition = new Map<string, ChangeCandidate[]>();
  for (const candidate of configCandidates) {
    if (
      !candidate.transition ||
      candidate.entry.kind !== "config-write" ||
      candidate.entry.source !== "system-agent"
    ) {
      continue;
    }
    const matches = configByTransition.get(candidate.transition) ?? [];
    matches.push(candidate);
    configByTransition.set(candidate.transition, matches);
  }

  const planned = new Map<ChangeCandidate, ChangeCandidate>();
  let lastMatchedConfigSequence = Number.POSITIVE_INFINITY;
  for (const operation of systemCandidates) {
    if (!operation.transition) {
      continue;
    }
    const write = configByTransition
      .get(operation.transition)
      ?.filter((candidate) => {
        const configSequence = candidate.position.sequence;
        return (
          configSequence < lastMatchedConfigSequence &&
          isWithinCollapseWindow(operation.entry.at, candidate.entry.at)
        );
      })
      .toSorted((left, right) => right.recordedAt - left.recordedAt)[0];
    if (!write) {
      continue;
    }
    planned.set(operation, write);
    lastMatchedConfigSequence = write.position.sequence;
  }
  return planned;
}

function compareCandidates(left: ChangeCandidate, right: ChangeCandidate): number {
  // History is insertion-ordered; display time may differ if a producer's clock skewed.
  if (left.recordedAt !== right.recordedAt) {
    return right.recordedAt - left.recordedAt;
  }
  const scopeOrder = right.position.scope.localeCompare(left.position.scope);
  if (scopeOrder !== 0) {
    return scopeOrder;
  }
  return right.position.sequence - left.position.sequence;
}

function isWithinCollapseWindow(operationAt: number, configAt: number): boolean {
  const delay = operationAt - configAt;
  return delay >= 0 && delay <= COLLAPSE_MAX_DELAY_MS;
}

function appendPendingCollapse(
  pending: readonly PendingCollapse[],
  marker: PendingCollapse,
): PendingCollapse[] {
  const next = [...pending, marker];
  // Keep the cursor bounded. A dropped marker can reveal a rare duplicate
  // config-write row, but never hides a newer visible history entry.
  return next.length <= MAX_PENDING_COLLAPSES ? next : next.slice(-MAX_PENDING_COLLAPSES);
}

function consumePendingCollapse(
  pending: readonly PendingCollapse[],
  candidate: ChangeCandidate,
): { pending: PendingCollapse[]; suppressed: boolean } {
  if (
    candidate.entry.kind !== "config-write" ||
    candidate.entry.source !== "system-agent" ||
    !candidate.transition
  ) {
    return { pending: [...pending], suppressed: false };
  }
  const sequence = candidate.position.sequence;
  let markerIndex = -1;
  let markerSequence = Number.POSITIVE_INFINITY;
  for (let index = 0; index < pending.length; index += 1) {
    const marker = pending[index]!;
    if (
      marker.transition === candidate.transition &&
      sequence <= marker.maxConfigSequence &&
      isWithinCollapseWindow(marker.operationAt, candidate.entry.at) &&
      marker.maxConfigSequence < markerSequence
    ) {
      markerIndex = index;
      markerSequence = marker.maxConfigSequence;
    }
  }
  if (markerIndex < 0) {
    return { pending: [...pending], suppressed: false };
  }
  return {
    pending: pending.filter((_, index) => index !== markerIndex),
    suppressed: true,
  };
}

function mergeCandidates(params: {
  systemCandidates: ChangeCandidate[];
  configCandidates: ChangeCandidate[];
  pendingCollapse: readonly PendingCollapse[];
  limit: number;
}): {
  entries: ChangeCandidate[];
  systemBefore?: number;
  configBefore?: number;
  pendingCollapse: PendingCollapse[];
  hasBufferedSystemEntries: boolean;
  hasBufferedConfigEntries: boolean;
} {
  let systemIndex = 0;
  let configIndex = 0;
  let systemBefore: number | undefined;
  let configBefore: number | undefined;
  let pendingCollapse = [...params.pendingCollapse];
  const entries: ChangeCandidate[] = [];

  while (true) {
    const system = params.systemCandidates[systemIndex];
    const config = params.configCandidates[configIndex];
    const next =
      system && config
        ? compareCandidates(system, config) <= 0
          ? system
          : config
        : (system ?? config);
    if (!next) {
      break;
    }

    if (next === config) {
      const collapse = consumePendingCollapse(pendingCollapse, config);
      pendingCollapse = collapse.pending;
      if (collapse.suppressed) {
        configBefore = config.position.sequence;
        configIndex += 1;
        continue;
      }
    }
    if (entries.length >= params.limit) {
      break;
    }

    entries.push(next);
    if (next === system) {
      systemBefore = system.position.sequence;
      systemIndex += 1;
      if (system.pendingCollapse) {
        pendingCollapse = appendPendingCollapse(pendingCollapse, system.pendingCollapse);
      }
    } else {
      configBefore = config!.position.sequence;
      configIndex += 1;
    }
  }

  return {
    entries,
    systemBefore,
    configBefore,
    pendingCollapse,
    hasBufferedSystemEntries: systemIndex < params.systemCandidates.length,
    hasBufferedConfigEntries: configIndex < params.configCandidates.length,
  };
}

async function initialBefore<T>(latest: AuditStore<T>["latest"]): Promise<number> {
  const sequence = (await latest({ limit: 1 }))[0]?.sequence;
  return sequence === undefined ? 0 : sequence + 1;
}

export async function listSystemChanges(
  params: SystemChangesListParams,
  options: {
    env?: NodeJS.ProcessEnv;
    systemStore?: AuditStore<SystemAgentAuditEntry>;
    configStore?: AuditStore<ConfigAuditRecord>;
  } = {},
): Promise<SystemChangesListResult> {
  const env = options.env ?? process.env;
  const systemStore =
    options.systemStore ??
    createSqliteAuditRecordReader<SystemAgentAuditEntry>({
      scope: SYSTEM_AGENT_AUDIT_SCOPE,
      env,
    });
  const configStore =
    options.configStore ??
    createSqliteAuditRecordReader<ConfigAuditRecord>({
      scope: CONFIG_AUDIT_SCOPE,
      env,
    });
  const cursor = params.beforeCursor
    ? decodeCursor(params.beforeCursor)
    : {
        version: 1 as const,
        // Freeze both journal heads before scanning so page two cannot admit a
        // record inserted into the untouched scope after page one was read.
        systemAgentBefore: await initialBefore(systemStore.latest),
        configBefore: await initialBefore(configStore.latest),
      };
  const limit = Math.min(MAX_CHANGE_LIMIT, Math.max(1, params.limit ?? DEFAULT_CHANGE_LIMIT));
  const target = limit + 1;
  const systemScan = await scanCandidates({
    beforeSequence: cursor.systemAgentBefore,
    target,
    latest: systemStore.latest,
    project: toSystemAgentCandidate,
  });
  const configScan = await scanCandidates({
    beforeSequence: cursor.configBefore,
    target,
    latest: configStore.latest,
    project: toConfigCandidate,
  });
  const systemCandidates = systemScan.entries;
  const configCandidates = configScan.entries;
  // A visible write can enrich the operation immediately. Its cursor position
  // stays in the config stream and is suppressed only when that stream reaches it.
  const plannedMatches = planConfigMatches(systemCandidates, configCandidates);
  const unseenConfigMaxSequence = configScan.exhausted
    ? undefined
    : configScan.nextBeforeSequence - 1;
  for (const operation of systemCandidates) {
    if (!operation.transition) {
      continue;
    }
    const write = plannedMatches.get(operation);
    const maxConfigSequence = write?.position.sequence ?? unseenConfigMaxSequence;
    if (maxConfigSequence !== undefined) {
      operation.pendingCollapse = {
        transition: operation.transition,
        maxConfigSequence,
        operationAt: operation.entry.at,
      };
    }
    if (write?.entry.changedPaths?.length) {
      operation.entry.changedPaths = [...write.entry.changedPaths];
    }
  }
  const merged = mergeCandidates({
    systemCandidates,
    configCandidates,
    pendingCollapse: cursor.pendingCollapse ?? [],
    limit,
  });
  // Payload timestamps can move backwards, so only discard markers after every
  // remaining config record has passed the cursor and none was a partner.
  const pendingCollapse =
    configScan.exhausted && !merged.hasBufferedConfigEntries ? [] : merged.pendingCollapse;
  const next = {
    ...cursor,
    systemAgentBefore: merged.hasBufferedSystemEntries
      ? (merged.systemBefore ?? cursor.systemAgentBefore)
      : systemScan.nextBeforeSequence,
    configBefore: merged.hasBufferedConfigEntries
      ? (merged.configBefore ?? cursor.configBefore)
      : configScan.nextBeforeSequence,
  };
  if (pendingCollapse.length > 0) {
    next.pendingCollapse = pendingCollapse;
  } else {
    delete next.pendingCollapse;
  }
  const hasMore =
    merged.hasBufferedSystemEntries ||
    merged.hasBufferedConfigEntries ||
    pendingCollapse.length > 0 ||
    !systemScan.exhausted ||
    !configScan.exhausted;
  const scanAdvanced =
    next.systemAgentBefore !== cursor.systemAgentBefore ||
    next.configBefore !== cursor.configBefore;
  return {
    entries: merged.entries.map((candidate) => candidate.entry),
    ...(hasMore && (merged.entries.length > 0 || scanAdvanced)
      ? { nextCursor: encodeCursor(next) }
      : {}),
  };
}

export const systemChangesHandlers: GatewayRequestHandlers = {
  "openclaw.changes.list": defineValidatedGatewayHandler(
    "openclaw.changes.list",
    validateSystemChangesListParams,
    async (options) => {
      const { params, respond } = options;
      const authority = readGatewayRequestMutationAuthority(options);
      authority.assertCurrent();
      const result = await listSystemChanges(params);
      authority.assertCurrent();
      respond(true, result);
    },
    (error) =>
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        error instanceof Error ? error.message : "invalid change-history cursor",
      ),
  ),
};
