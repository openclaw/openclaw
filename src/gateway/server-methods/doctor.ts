import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  isSameMemoryDreamingDay,
  resolveMemoryCorePluginConfig,
  resolveMemoryDeepDreamingConfig,
  resolveMemoryLightDreamingConfig,
  resolveMemoryRemDreamingConfig,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingWorkspaces,
} from "../../memory-host-sdk/dreaming.js";
import { getActiveMemorySearchManager } from "../../plugins/memory-runtime.js";
import { formatError } from "../server-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

const SHORT_TERM_STORE_RELATIVE_PATH = path.join("memory", ".dreams", "short-term-recall.json");
const MANAGED_LIGHT_SLEEP_CRON_NAME = "Memory Light Dreaming";
const MANAGED_LIGHT_SLEEP_CRON_TAG = "[managed-by=memory-core.dreaming.light]";
const LIGHT_SLEEP_SYSTEM_EVENT_TEXT = "__openclaw_memory_core_light_sleep__";
const MANAGED_DEEP_SLEEP_CRON_NAME = "Memory Dreaming Promotion";
const MANAGED_DEEP_SLEEP_CRON_TAG = "[managed-by=memory-core.short-term-promotion]";
const DEEP_SLEEP_SYSTEM_EVENT_TEXT = "__openclaw_memory_core_short_term_promotion_dream__";
const MANAGED_REM_SLEEP_CRON_NAME = "Memory REM Dreaming";
const MANAGED_REM_SLEEP_CRON_TAG = "[managed-by=memory-core.dreaming.rem]";
const REM_SLEEP_SYSTEM_EVENT_TEXT = "__openclaw_memory_core_rem_sleep__";

type DoctorMemoryDreamingPhasePayload = {
  enabled: boolean;
  cron: string;
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

type DoctorMemoryLightDreamingPayload = DoctorMemoryDreamingPhasePayload & {
  lookbackDays: number;
  limit: number;
};

type DoctorMemoryDeepDreamingPayload = DoctorMemoryDreamingPhasePayload & {
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays: number;
  maxAgeDays?: number;
  limit: number;
};

type DoctorMemoryRemDreamingPayload = DoctorMemoryDreamingPhasePayload & {
  lookbackDays: number;
  limit: number;
  minPatternStrength: number;
};

type DoctorMemoryDreamingPayload = {
  enabled: boolean;
  timezone?: string;
  verboseLogging: boolean;
  storageMode: "inline" | "separate" | "both";
  separateReports: boolean;
  shortTermCount: number;
  promotedTotal: number;
  promotedToday: number;
  storePath?: string;
  lastPromotedAt?: string;
  storeError?: string;
  phases: {
    light: DoctorMemoryLightDreamingPayload;
    deep: DoctorMemoryDeepDreamingPayload;
    rem: DoctorMemoryRemDreamingPayload;
  };
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

function resolveDreamingConfig(
  cfg: OpenClawConfig,
): Omit<
  DoctorMemoryDreamingPayload,
  | "shortTermCount"
  | "promotedTotal"
  | "promotedToday"
  | "storePath"
  | "lastPromotedAt"
  | "storeError"
> {
  const resolved = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryCorePluginConfig(cfg),
    cfg,
  });
  const light = resolveMemoryLightDreamingConfig({
    pluginConfig: resolveMemoryCorePluginConfig(cfg),
    cfg,
  });
  const deep = resolveMemoryDeepDreamingConfig({
    pluginConfig: resolveMemoryCorePluginConfig(cfg),
    cfg,
  });
  const rem = resolveMemoryRemDreamingConfig({
    pluginConfig: resolveMemoryCorePluginConfig(cfg),
    cfg,
  });
  return {
    enabled: resolved.enabled,
    ...(resolved.timezone ? { timezone: resolved.timezone } : {}),
    verboseLogging: resolved.verboseLogging,
    storageMode: resolved.storage.mode,
    separateReports: resolved.storage.separateReports,
    phases: {
      light: {
        enabled: light.enabled,
        cron: light.cron,
        lookbackDays: light.lookbackDays,
        limit: light.limit,
        managedCronPresent: false,
      },
      deep: {
        enabled: deep.enabled,
        cron: deep.cron,
        limit: deep.limit,
        minScore: deep.minScore,
        minRecallCount: deep.minRecallCount,
        minUniqueQueries: deep.minUniqueQueries,
        recencyHalfLifeDays: deep.recencyHalfLifeDays,
        managedCronPresent: false,
        ...(typeof deep.maxAgeDays === "number" ? { maxAgeDays: deep.maxAgeDays } : {}),
      },
      rem: {
        enabled: rem.enabled,
        cron: rem.cron,
        lookbackDays: rem.lookbackDays,
        limit: rem.limit,
        minPatternStrength: rem.minPatternStrength,
        managedCronPresent: false,
      },
    },
  };
}

function normalizeMemoryPath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isShortTermMemoryPath(filePath: string): boolean {
  const normalized = normalizeMemoryPath(filePath);
  if (/(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/.test(normalized)) {
    return true;
  }
  return /^(\d{4})-(\d{2})-(\d{2})\.md$/.test(normalized);
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
  timezone?: string,
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
      if (Number.isFinite(promotedAtMs) && isSameMemoryDreamingDay(promotedAtMs, nowMs, timezone)) {
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

function mergeDreamingStoreStats(stats: DreamingStoreStats[]): DreamingStoreStats {
  let shortTermCount = 0;
  let promotedTotal = 0;
  let promotedToday = 0;
  let latestPromotedAtMs = Number.NEGATIVE_INFINITY;
  let lastPromotedAt: string | undefined;
  const storePaths = new Set<string>();
  const storeErrors: string[] = [];

  for (const stat of stats) {
    shortTermCount += stat.shortTermCount;
    promotedTotal += stat.promotedTotal;
    promotedToday += stat.promotedToday;
    if (stat.storePath) {
      storePaths.add(stat.storePath);
    }
    if (stat.storeError) {
      storeErrors.push(stat.storeError);
    }
    const promotedAtMs = stat.lastPromotedAt ? Date.parse(stat.lastPromotedAt) : Number.NaN;
    if (Number.isFinite(promotedAtMs) && promotedAtMs > latestPromotedAtMs) {
      latestPromotedAtMs = promotedAtMs;
      lastPromotedAt = stat.lastPromotedAt;
    }
  }

  return {
    shortTermCount,
    promotedTotal,
    promotedToday,
    ...(storePaths.size === 1 ? { storePath: [...storePaths][0] } : {}),
    ...(lastPromotedAt ? { lastPromotedAt } : {}),
    ...(storeErrors.length === 1
      ? { storeError: storeErrors[0] }
      : storeErrors.length > 1
        ? { storeError: `${storeErrors.length} dreaming stores had read errors.` }
        : {}),
  };
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

function isManagedDreamingJob(
  job: ManagedCronJobLike,
  params: { name: string; tag: string; payloadText: string },
): boolean {
  const description = normalizeTrimmedString(job.description);
  if (description?.includes(params.tag)) {
    return true;
  }
  const name = normalizeTrimmedString(job.name);
  const payloadKind = normalizeTrimmedString(job.payload?.kind)?.toLowerCase();
  const payloadText = normalizeTrimmedString(job.payload?.text);
  return (
    name === params.name && payloadKind === "systemevent" && payloadText === params.payloadText
  );
}

async function resolveManagedDreamingCronStatus(params: {
  context: {
    cron?: { list?: (opts?: { includeDisabled?: boolean }) => Promise<unknown[]> };
  };
  match: {
    name: string;
    tag: string;
    payloadText: string;
  };
}): Promise<ManagedDreamingCronStatus> {
  if (!params.context.cron || typeof params.context.cron.list !== "function") {
    return { managedCronPresent: false };
  }
  try {
    const jobs = await params.context.cron.list({ includeDisabled: true });
    const managed = jobs
      .filter((job): job is ManagedCronJobLike => typeof job === "object" && job !== null)
      .filter((job) => isManagedDreamingJob(job, params.match));
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

async function resolveAllManagedDreamingCronStatuses(context: {
  cron?: { list?: (opts?: { includeDisabled?: boolean }) => Promise<unknown[]> };
}): Promise<Record<"light" | "deep" | "rem", ManagedDreamingCronStatus>> {
  return {
    light: await resolveManagedDreamingCronStatus({
      context,
      match: {
        name: MANAGED_LIGHT_SLEEP_CRON_NAME,
        tag: MANAGED_LIGHT_SLEEP_CRON_TAG,
        payloadText: LIGHT_SLEEP_SYSTEM_EVENT_TEXT,
      },
    }),
    deep: await resolveManagedDreamingCronStatus({
      context,
      match: {
        name: MANAGED_DEEP_SLEEP_CRON_NAME,
        tag: MANAGED_DEEP_SLEEP_CRON_TAG,
        payloadText: DEEP_SLEEP_SYSTEM_EVENT_TEXT,
      },
    }),
    rem: await resolveManagedDreamingCronStatus({
      context,
      match: {
        name: MANAGED_REM_SLEEP_CRON_NAME,
        tag: MANAGED_REM_SLEEP_CRON_TAG,
        payloadText: REM_SLEEP_SYSTEM_EVENT_TEXT,
      },
    }),
  };
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
      const dreamingConfig = resolveDreamingConfig(cfg);
      const workspaceDir = normalizeTrimmedString((status as Record<string, unknown>).workspaceDir);
      const configuredWorkspaces = resolveMemoryDreamingWorkspaces(cfg).map(
        (entry) => entry.workspaceDir,
      );
      const allWorkspaces =
        configuredWorkspaces.length > 0 ? configuredWorkspaces : workspaceDir ? [workspaceDir] : [];
      const storeStats =
        allWorkspaces.length > 0
          ? mergeDreamingStoreStats(
              await Promise.all(
                allWorkspaces.map((entry) =>
                  loadDreamingStoreStats(entry, nowMs, dreamingConfig.timezone),
                ),
              ),
            )
          : {
              shortTermCount: 0,
              promotedTotal: 0,
              promotedToday: 0,
            };
      const cronStatuses = await resolveAllManagedDreamingCronStatuses(context);
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        provider: status.provider,
        embedding,
        dreaming: {
          ...dreamingConfig,
          ...storeStats,
          phases: {
            light: {
              ...dreamingConfig.phases.light,
              ...cronStatuses.light,
            },
            deep: {
              ...dreamingConfig.phases.deep,
              ...cronStatuses.deep,
            },
            rem: {
              ...dreamingConfig.phases.rem,
              ...cronStatuses.rem,
            },
          },
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
