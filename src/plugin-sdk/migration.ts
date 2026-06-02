import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import type {
  MigrationDetection,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
  MigrationSummary,
} from "../plugins/types.js";

export type {
  MigrationDetection,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
  MigrationSummary,
};

export const MIGRATION_REASON_MISSING_SOURCE_OR_TARGET = "missing source or target";
export const MIGRATION_REASON_TARGET_EXISTS = "target exists";

/** Creates a migration item and defaults missing status to planned. */
export function createMigrationItem(
  params: Omit<MigrationItem, "status"> & { status?: MigrationItem["status"] },
): MigrationItem {
  return {
    ...params,
    status: params.status ?? "planned",
  };
}

/** Marks a migration item as conflicting without mutating the original item. */
export function markMigrationItemConflict(item: MigrationItem, reason: string): MigrationItem {
  return { ...item, status: "conflict", reason };
}

/** Marks a migration item as errored without mutating the original item. */
export function markMigrationItemError(item: MigrationItem, reason: string): MigrationItem {
  return { ...item, status: "error", reason };
}

/** Marks a migration item as skipped without mutating the original item. */
export function markMigrationItemSkipped(item: MigrationItem, reason: string): MigrationItem {
  return { ...item, status: "skipped", reason };
}

/** Counts migration items by status and sensitive flag for plan summaries. */
export function summarizeMigrationItems(items: readonly MigrationItem[]): MigrationSummary {
  return {
    total: items.length,
    planned: items.filter((item) => item.status === "planned").length,
    migrated: items.filter((item) => item.status === "migrated").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    conflicts: items.filter((item) => item.status === "conflict").length,
    errors: items.filter((item) => item.status === "error").length,
    sensitive: items.filter((item) => item.sensitive).length,
  };
}

const REDACTED_MIGRATION_VALUE = "[redacted]";
const SECRET_KEY_MARKERS = [
  "accesstoken",
  "apikey",
  "authorization",
  "bearertoken",
  "clientsecret",
  "cookie",
  "credential",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
] as const;

const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gu,
  /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}\b/gu,
  /\bAIza[0-9A-Za-z_-]{12,}\b/gu,
] as const;

function normalizeSecretKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function isSecretKey(key: string): boolean {
  const normalized = normalizeSecretKey(key);
  if (normalized === "token" || normalized.endsWith("token")) {
    return true;
  }
  if (normalized === "auth" || normalized === "authorization") {
    return true;
  }
  return SECRET_KEY_MARKERS.some((marker) => normalized.includes(marker));
}

/** Config patch payload stored in migration item details. */
export type MigrationConfigPatchDetails = {
  /** Config path where the patch should be merged. */
  path: string[];
  /** Value to merge at the target path. */
  value: unknown;
};

class MigrationConfigPatchConflictError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "MigrationConfigPatchConflictError";
  }
}

/** Reads a nested config value from a string path without throwing on scalar parents. */
export function readMigrationConfigPath(
  root: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = root;
  for (const segment of path) {
    // Stop at the first non-record so scalar values do not behave like containers.
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** Deep-merges plain record config values while replacing scalar/array leaves. */
export function mergeMigrationConfigValue(left: unknown, right: unknown): unknown {
  if (!isRecord(left) || !isRecord(right)) {
    return structuredClone(right);
  }
  const next: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    next[key] = mergeMigrationConfigValue(next[key], value);
  }
  return next;
}

/** Creates intermediate objects and deep-merges a value into a config path. */
export function writeMigrationConfigPath(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    if (!isRecord(existing)) {
      // Migration patches own the target subtree once an intermediate segment is missing/scalar.
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  const leaf = path.at(-1);
  if (!leaf) {
    return;
  }
  current[leaf] = mergeMigrationConfigValue(current[leaf], value);
}

/** Checks whether applying a config patch would overwrite existing config without overwrite mode. */
export function hasMigrationConfigPatchConflict(
  config: MigrationProviderContext["config"],
  path: readonly string[],
  value: unknown,
): boolean {
  if (!isRecord(value)) {
    // Scalar/array patches replace the whole leaf, so any existing value needs overwrite intent.
    return readMigrationConfigPath(config as Record<string, unknown>, path) !== undefined;
  }
  const existing = readMigrationConfigPath(config as Record<string, unknown>, path);
  if (!isRecord(existing)) {
    return false;
  }
  // Record patches merge one level down; only keys that would overwrite existing leaves conflict.
  return Object.keys(value).some((key) => existing[key] !== undefined);
}

/** Creates a config-merge migration item with patch details embedded for apply. */
export function createMigrationConfigPatchItem(params: {
  /** Stable item id within the migration plan. */
  id: string;
  /** Human-readable target config area. */
  target: string;
  /** Config path where value should be merged. */
  path: string[];
  /** Config value to merge at path. */
  value: unknown;
  /** User-facing migration message. */
  message: string;
  /** Whether the item should start as a conflict. */
  conflict?: boolean;
  /** Conflict reason override. */
  reason?: string;
  /** Optional source identifier for the migration item. */
  source?: string;
  /** Extra serializable details preserved with the item. */
  details?: Record<string, unknown>;
}): MigrationItem {
  return createMigrationItem({
    id: params.id,
    kind: "config",
    action: "merge",
    source: params.source,
    target: params.target,
    status: params.conflict ? "conflict" : "planned",
    reason: params.conflict ? (params.reason ?? MIGRATION_REASON_TARGET_EXISTS) : undefined,
    message: params.message,
    details: { ...params.details, path: params.path, value: params.value },
  });
}

/** Creates a skipped manual-follow-up migration item. */
export function createMigrationManualItem(params: {
  /** Stable item id within the migration plan. */
  id: string;
  /** Source identifier requiring manual action. */
  source: string;
  /** User-facing migration message. */
  message: string;
  /** Manual recommendation stored as the skipped reason. */
  recommendation: string;
}): MigrationItem {
  return createMigrationItem({
    id: params.id,
    kind: "manual",
    action: "manual",
    source: params.source,
    status: "skipped",
    message: params.message,
    reason: params.recommendation,
  });
}

/** Reads config patch details from a migration item when they have the expected shape. */
export function readMigrationConfigPatchDetails(
  item: MigrationItem,
): MigrationConfigPatchDetails | undefined {
  const path = item.details?.path;
  if (
    !Array.isArray(path) ||
    !path.every((segment): segment is string => typeof segment === "string")
  ) {
    return undefined;
  }
  return { path, value: item.details?.value };
}

/** Applies a planned config patch item through the runtime config mutation API. */
export async function applyMigrationConfigPatchItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
): Promise<MigrationItem> {
  if (item.status !== "planned") {
    return item;
  }
  const details = readMigrationConfigPatchDetails(item);
  if (!details) {
    return markMigrationItemError(item, "missing config patch");
  }
  const configApi = ctx.runtime?.config;
  if (!configApi?.current || !configApi.mutateConfigFile) {
    return markMigrationItemError(item, "config runtime unavailable");
  }
  try {
    const currentConfig = configApi.current() as MigrationProviderContext["config"];
    if (
      !ctx.overwrite &&
      hasMigrationConfigPatchConflict(currentConfig, details.path, details.value)
    ) {
      return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
    }
    await configApi.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        // Recheck inside mutate so queued config writes cannot slip in between preview and disk write.
        if (!ctx.overwrite && hasMigrationConfigPatchConflict(draft, details.path, details.value)) {
          throw new MigrationConfigPatchConflictError(MIGRATION_REASON_TARGET_EXISTS);
        }
        writeMigrationConfigPath(draft as Record<string, unknown>, details.path, details.value);
      },
    });
    return { ...item, status: "migrated" };
  } catch (err) {
    if (err instanceof MigrationConfigPatchConflictError) {
      return markMigrationItemConflict(item, err.reason);
    }
    return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
  }
}

/** Applies a manual migration item by preserving it as skipped with a follow-up reason. */
export function applyMigrationManualItem(item: MigrationItem): MigrationItem {
  return markMigrationItemSkipped(item, item.reason ?? "manual follow-up required");
}

function isSecretReferenceLike(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  // Secret refs contain handles, not secret material; redacting them would hide the migration target.
  return (
    value.source === "env" &&
    typeof value.id === "string" &&
    (value.provider === undefined || typeof value.provider === "string")
  );
}

function redactString(value: string): string {
  let next = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    next = next.replace(pattern, REDACTED_MIGRATION_VALUE);
  }
  return next;
}

function redactMigrationValueInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactMigrationValueInternal(entry, seen));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    // Cycles cannot be represented in JSON migration output, so redact instead of recursing forever.
    return REDACTED_MIGRATION_VALUE;
  }
  seen.add(value);
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key) && !isSecretReferenceLike(entry)) {
      next[key] = REDACTED_MIGRATION_VALUE;
      continue;
    }
    next[key] = redactMigrationValueInternal(entry, seen);
  }
  return next;
}

/** Recursively redacts secret-shaped keys and token-like strings from migration output. */
export function redactMigrationValue(value: unknown): unknown {
  return redactMigrationValueInternal(value, new WeakSet<object>());
}

/** Redacts secret-shaped values inside a migration item before display/logging. */
export function redactMigrationItem(item: MigrationItem): MigrationItem {
  return redactMigrationValue(item) as MigrationItem;
}

/** Redacts secret-shaped values inside an entire migration plan before display/logging. */
export function redactMigrationPlan<T extends MigrationPlan>(plan: T): T {
  return redactMigrationValue(plan) as T;
}
