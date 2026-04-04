import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { getActiveMemorySearchManager } from "../../plugins/memory-runtime.js";
import { formatError } from "../server-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

const SHORT_TERM_STORE_RELATIVE_PATH = path.join("memory", ".dreams", "short-term-recall.json");
const SHORT_TERM_PATH_RE = /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/;
const SHORT_TERM_BASENAME_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;
const MANAGED_DREAMING_CRON_NAME = "Memory Dreaming Promotion";
const MANAGED_DREAMING_CRON_TAG = "[managed-by=memory-core.short-term-promotion]";
const DREAMING_SYSTEM_EVENT_TEXT = "__openclaw_memory_core_short_term_promotion_dream__";

type DreamingMode = "off" | "core" | "rem" | "deep";
type DreamingPreset = Exclude<DreamingMode, "off">;

const DREAMING_PRESET_DEFAULTS: Record<
  DreamingPreset,
  {
    frequency: string;
    limit: number;
    minScore: number;
    minRecallCount: number;
    minUniqueQueries: number;
  }
> = {
  core: {
    frequency: "0 3 * * *",
    limit: 10,
    minScore: 0.75,
    minRecallCount: 3,
    minUniqueQueries: 2,
  },
  deep: {
    frequency: "0 */12 * * *",
    limit: 10,
    minScore: 0.8,
    minRecallCount: 3,
    minUniqueQueries: 3,
  },
  rem: {
    frequency: "0 */6 * * *",
    limit: 10,
    minScore: 0.85,
    minRecallCount: 4,
    minUniqueQueries: 3,
  },
};

type DoctorMemoryDreamingPayload = {
  mode: DreamingMode;
  enabled: boolean;
  frequency: string;
  timezone?: string;
  limit: number;
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  shortTermCount: number;
  promotedTotal: number;
  promotedToday: number;
  storePath?: string;
  lastPromotedAt?: string;
  nextRunAtMs?: number;
  managedCronPresent: boolean;
  storeError?: string;
};

export type DoctorMemoryStatusPayload = {
  agentId: string;
  provider?: string;
  embedding: {
    ok: boolean;
    error?: string;
  };
  dreaming?: DoctorMemoryDreamingPayload;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeDreamingMode(value: unknown): DreamingMode {
  const normalized = normalizeTrimmedString(value)?.toLowerCase();
  if (
    normalized === "off" ||
    normalized === "core" ||
    normalized === "rem" ||
    normalized === "deep"
  ) {
    return normalized;
  }
  return "off";
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored < 0 ? fallback : floored;
}

function normalizeScore(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < 0 || value > 1) {
    return fallback;
  }
  return value;
}

function resolveDreamingConfig(
  cfg: Record<string, unknown>,
): Omit<
  DoctorMemoryDreamingPayload,
  | "shortTermCount"
  | "promotedTotal"
  | "promotedToday"
  | "storePath"
  | "lastPromotedAt"
  | "nextRunAtMs"
  | "managedCronPresent"
  | "storeError"
> {
  const plugins = asRecord(cfg.plugins);
  const entries = asRecord(plugins?.entries);
  const memoryCore = asRecord(entries?.["memory-core"]);
  const pluginConfig = asRecord(memoryCore?.config);
  const dreaming = asRecord(pluginConfig?.dreaming);
  const mode = normalizeDreamingMode(dreaming?.mode);
  const preset: DreamingPreset = mode === "off" ? "core" : mode;
  const defaults = DREAMING_PRESET_DEFAULTS[preset];

  return {
    mode,
    enabled: mode !== "off",
    frequency: normalizeTrimmedString(dreaming?.frequency) ?? defaults.frequency,
    timezone: normalizeTrimmedString(dreaming?.timezone),
    limit: normalizeNonNegativeInt(dreaming?.limit, defaults.limit),
    minScore: normalizeScore(dreaming?.minScore, defaults.minScore),
    minRecallCount: normalizeNonNegativeInt(dreaming?.minRecallCount, defaults.minRecallCount),
    minUniqueQueries: normalizeNonNegativeInt(
      dreaming?.minUniqueQueries,
      defaults.minUniqueQueries,
    ),
  };
}

function normalizeMemoryPath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isShortTermMemoryPath(filePath: string): boolean {
  const normalized = normalizeMemoryPath(filePath);
  if (SHORT_TERM_PATH_RE.test(normalized)) {
    return true;
  }
  return SHORT_TERM_BASENAME_RE.test(normalized);
}

function isSameLocalDay(firstEpochMs: number, secondEpochMs: number): boolean {
  const first = new Date(firstEpochMs);
  const second = new Date(secondEpochMs);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

type DreamingStoreStats = Pick<
  DoctorMemoryDreamingPayload,
  | "shortTermCount"
  | "promotedTotal"
  | "promotedToday"
  | "storePath"
  | "lastPromotedAt"
  | "storeError"
>;

async function loadDreamingStoreStats(
  workspaceDir: string,
  nowMs: number,
): Promise<DreamingStoreStats> {
  const storePath = path.join(workspaceDir, SHORT_TERM_STORE_RELATIVE_PATH);
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const store = asRecord(parsed);
    const entries = asRecord(store?.entries) ?? {};
    let shortTermCount = 0;
    let promotedTotal = 0;
    let promotedToday = 0;
    let latestPromotedAtMs = Number.NEGATIVE_INFINITY;
    let latestPromotedAt: string | undefined;

    for (const value of Object.values(entries)) {
      const entry = asRecord(value);
      if (!entry) {
        continue;
      }
      const source = normalizeTrimmedString(entry.source);
      const entryPath = normalizeTrimmedString(entry.path);
      if (source !== "memory" || !entryPath || !isShortTermMemoryPath(entryPath)) {
        continue;
      }
      const promotedAt = normalizeTrimmedString(entry.promotedAt);
      if (!promotedAt) {
        shortTermCount += 1;
        continue;
      }
      promotedTotal += 1;
      const promotedAtMs = Date.parse(promotedAt);
      if (Number.isFinite(promotedAtMs) && isSameLocalDay(promotedAtMs, nowMs)) {
        promotedToday += 1;
      }
      if (Number.isFinite(promotedAtMs) && promotedAtMs > latestPromotedAtMs) {
        latestPromotedAtMs = promotedAtMs;
        latestPromotedAt = promotedAt;
      }
    }

    return {
      shortTermCount,
      promotedTotal,
      promotedToday,
      storePath,
      ...(latestPromotedAt ? { lastPromotedAt: latestPromotedAt } : {}),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return {
        shortTermCount: 0,
        promotedTotal: 0,
        promotedToday: 0,
        storePath,
      };
    }
    return {
      shortTermCount: 0,
      promotedTotal: 0,
      promotedToday: 0,
      storePath,
      storeError: formatError(err),
    };
  }
}

type ManagedDreamingCronStatus = {
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

type ManagedCronJobLike = {
  name?: string;
  description?: string;
  enabled?: boolean;
  payload?: { kind?: string; text?: string };
  state?: { nextRunAtMs?: number };
};

function isManagedDreamingJob(job: ManagedCronJobLike): boolean {
  const description = normalizeTrimmedString(job.description);
  if (description?.includes(MANAGED_DREAMING_CRON_TAG)) {
    return true;
  }
  const name = normalizeTrimmedString(job.name);
  const payloadKind = normalizeTrimmedString(job.payload?.kind)?.toLowerCase();
  const payloadText = normalizeTrimmedString(job.payload?.text);
  return (
    name === MANAGED_DREAMING_CRON_NAME &&
    payloadKind === "systemevent" &&
    payloadText === DREAMING_SYSTEM_EVENT_TEXT
  );
}

async function resolveManagedDreamingCronStatus(context: {
  cron?: { list?: (opts?: { includeDisabled?: boolean }) => Promise<unknown[]> };
}): Promise<ManagedDreamingCronStatus> {
  if (!context.cron || typeof context.cron.list !== "function") {
    return { managedCronPresent: false };
  }
  try {
    const jobs = await context.cron.list({ includeDisabled: true });
    const managed = jobs
      .filter((job): job is ManagedCronJobLike => typeof job === "object" && job !== null)
      .filter(isManagedDreamingJob);
    let nextRunAtMs: number | undefined;
    for (const job of managed) {
      if (job.enabled !== true) {
        continue;
      }
      const candidate = job.state?.nextRunAtMs;
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        continue;
      }
      if (nextRunAtMs === undefined || candidate < nextRunAtMs) {
        nextRunAtMs = candidate;
      }
    }
    return {
      managedCronPresent: managed.length > 0,
      ...(nextRunAtMs !== undefined ? { nextRunAtMs } : {}),
    };
  } catch {
    return { managedCronPresent: false };
  }
}

export const doctorHandlers: GatewayRequestHandlers = {
  "doctor.memory.status": async ({ respond, context }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const { manager, error } = await getActiveMemorySearchManager({
      cfg,
      agentId,
      purpose: "status",
    });
    if (!manager) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: error ?? "memory search unavailable",
        },
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      const status = manager.status();
      let embedding = await manager.probeEmbeddingAvailability();
      if (!embedding.ok && !embedding.error) {
        embedding = { ok: false, error: "memory embeddings unavailable" };
      }
      const nowMs = Date.now();
      const dreamingConfig = resolveDreamingConfig(cfg as Record<string, unknown>);
      const workspaceDir = normalizeTrimmedString((status as Record<string, unknown>).workspaceDir);
      const storeStats = workspaceDir
        ? await loadDreamingStoreStats(workspaceDir, nowMs)
        : {
            shortTermCount: 0,
            promotedTotal: 0,
            promotedToday: 0,
          };
      const cronStatus = await resolveManagedDreamingCronStatus(context);
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        provider: status.provider,
        embedding,
        dreaming: {
          ...dreamingConfig,
          ...storeStats,
          ...cronStatus,
        },
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: `gateway memory probe failed: ${formatError(err)}`,
        },
      };
      respond(true, payload, undefined);
    } finally {
      await manager.close?.().catch(() => {});
    }
  },
};
