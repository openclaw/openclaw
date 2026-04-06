import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  isSameMemoryDreamingDay,
  resolveMemoryCorePluginConfig,
  resolveMemoryDreamingConfig,
  resolveMemoryDeepDreamingConfig,
  resolveMemoryLightDreamingConfig,
  resolveMemoryDreamingWorkspaces,
  resolveMemoryRemDreamingConfig,
} from "../../memory-host-sdk/dreaming.js";
import { getActiveMemorySearchManager } from "../../plugins/memory-runtime.js";
import { formatError } from "../server-utils.js";
import { asRecord, normalizeTrimmedString } from "./record-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

const SHORT_TERM_STORE_RELATIVE_PATH = path.join("memory", ".dreams", "short-term-recall.json");
const SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH = path.join("memory", ".dreams", "phase-signals.json");
const MANAGED_DEEP_SLEEP_CRON_NAME = "Memory Dreaming Promotion";
const MANAGED_DEEP_SLEEP_CRON_TAG = "[managed-by=memory-core.short-term-promotion]";
const DEEP_SLEEP_SYSTEM_EVENT_TEXT = "__openclaw_memory_core_short_term_promotion_dream__";
const DREAM_DIARY_FILE_NAMES = ["DREAMS.md", "dreams.md"] as const;

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
  recallSignalCount: number;
  dailySignalCount: number;
  totalSignalCount: number;
  phaseSignalCount: number;
  lightPhaseHitCount: number;
  remPhaseHitCount: number;
  promotedTotal: number;
  promotedToday: number;
  storePath?: string;
  phaseSignalPath?: string;
  lastPromotedAt?: string;
  storeError?: string;
  phaseSignalError?: string;
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

export type DoctorMemoryDreamDiaryPayload = {
  agentId: string;
  found: boolean;
  path: string;
  content?: string;
  updatedAtMs?: number;
};

function resolveDreamingConfig(
  cfg: OpenClawConfig,
): Omit<
  DoctorMemoryDreamingPayload,
  | "shortTermCount"
  | "recallSignalCount"
  | "dailySignalCount"
  | "totalSignalCount"
  | "phaseSignalCount"
  | "lightPhaseHitCount"
  | "remPhaseHitCount"
  | "promotedTotal"
  | "promotedToday"
  | "storePath"
  | "phaseSignalPath"
  | "lastPromotedAt"
  | "storeError"
  | "phaseSignalError"
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
  | "recallSignalCount"
  | "dailySignalCount"
  | "totalSignalCount"
  | "phaseSignalCount"
  | "lightPhaseHitCount"
  | "remPhaseHitCount"
  | "promotedTotal"
  | "promotedToday"
  | "storePath"
  | "phaseSignalPath"
  | "lastPromotedAt"
  | "storeError"
  | "phaseSignalError"
>;

function toNonNegativeInt(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.max(0, Math.floor(num));
}

async function loadDreamingStoreStats(
  workspaceDir: string,
  nowMs: number,
  timezone?: string,
): Promise<DreamingStoreStats> {
  const storePath = path.join(workspaceDir, SHORT_TERM_STORE_RELATIVE_PATH);
  const phaseSignalPath = path.join(workspaceDir, SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH);
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const store = asRecord(parsed);
    const entries = asRecord(store?.entries) ?? {};
    let shortTermCount = 0;
    let recallSignalCount = 0;
    let dailySignalCount = 0;
    let totalSignalCount = 0;
    let phaseSignalCount = 0;
    let lightPhaseHitCount = 0;
    let remPhaseHitCount = 0;
    let promotedTotal = 0;
    let promotedToday = 0;
    let latestPromotedAtMs = Number.NEGATIVE_INFINITY;
    let latestPromotedAt: string | undefined;
    const activeKeys = new Set<string>();

    for (const [entryKey, value] of Object.entries(entries)) {
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
        activeKeys.add(entryKey);
        const recallCount = toNonNegativeInt(entry.recallCount);
        const dailyCount = toNonNegativeInt(entry.dailyCount);
        recallSignalCount += recallCount;
        dailySignalCount += dailyCount;
        totalSignalCount += recallCount + dailyCount;
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

    let phaseSignalError: string | undefined;
    try {
      const phaseRaw = await fs.readFile(phaseSignalPath, "utf-8");
      const parsedPhase = JSON.parse(phaseRaw) as unknown;
      const phaseStore = asRecord(parsedPhase);
      const phaseEntries = asRecord(phaseStore?.entries) ?? {};
      for (const [key, value] of Object.entries(phaseEntries)) {
        if (!activeKeys.has(key)) {
          continue;
        }
        const phaseEntry = asRecord(value);
        const lightHits = toNonNegativeInt(phaseEntry?.lightHits);
        const remHits = toNonNegativeInt(phaseEntry?.remHits);
        lightPhaseHitCount += lightHits;
        remPhaseHitCount += remHits;
        phaseSignalCount += lightHits + remHits;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        phaseSignalError = formatError(err);
      }
    }

    return {
      shortTermCount,
      recallSignalCount,
      dailySignalCount,
      totalSignalCount,
      phaseSignalCount,
      lightPhaseHitCount,
      remPhaseHitCount,
      promotedTotal,
      promotedToday,
      storePath,
      phaseSignalPath,
      ...(latestPromotedAt ? { lastPromotedAt: latestPromotedAt } : {}),
      ...(phaseSignalError ? { phaseSignalError } : {}),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return {
        shortTermCount: 0,
        recallSignalCount: 0,
        dailySignalCount: 0,
        totalSignalCount: 0,
        phaseSignalCount: 0,
        lightPhaseHitCount: 0,
        remPhaseHitCount: 0,
        promotedTotal: 0,
        promotedToday: 0,
        storePath,
        phaseSignalPath,
      };
    }
    return {
      shortTermCount: 0,
      recallSignalCount: 0,
      dailySignalCount: 0,
      totalSignalCount: 0,
      phaseSignalCount: 0,
      lightPhaseHitCount: 0,
      remPhaseHitCount: 0,
      promotedTotal: 0,
      promotedToday: 0,
      storePath,
      phaseSignalPath,
      storeError: formatError(err),
    };
  }
}

function mergeDreamingStoreStats(stats: DreamingStoreStats[]): DreamingStoreStats {
  let shortTermCount = 0;
  let recallSignalCount = 0;
  let dailySignalCount = 0;
  let totalSignalCount = 0;
  let phaseSignalCount = 0;
  let lightPhaseHitCount = 0;
  let remPhaseHitCount = 0;
  let promotedTotal = 0;
  let promotedToday = 0;
  let latestPromotedAtMs = Number.NEGATIVE_INFINITY;
  let lastPromotedAt: string | undefined;
  const storePaths = new Set<string>();
  const phaseSignalPaths = new Set<string>();
  const storeErrors: string[] = [];
  const phaseSignalErrors: string[] = [];

  for (const stat of stats) {
    shortTermCount += stat.shortTermCount;
    recallSignalCount += stat.recallSignalCount;
    dailySignalCount += stat.dailySignalCount;
    totalSignalCount += stat.totalSignalCount;
    phaseSignalCount += stat.phaseSignalCount;
    lightPhaseHitCount += stat.lightPhaseHitCount;
    remPhaseHitCount += stat.remPhaseHitCount;
    promotedTotal += stat.promotedTotal;
    promotedToday += stat.promotedToday;
    if (stat.storePath) {
      storePaths.add(stat.storePath);
    }
    if (stat.phaseSignalPath) {
      phaseSignalPaths.add(stat.phaseSignalPath);
    }
    if (stat.storeError) {
      storeErrors.push(stat.storeError);
    }
    if (stat.phaseSignalError) {
      phaseSignalErrors.push(stat.phaseSignalError);
    }
    const promotedAtMs = stat.lastPromotedAt ? Date.parse(stat.lastPromotedAt) : Number.NaN;
    if (Number.isFinite(promotedAtMs) && promotedAtMs > latestPromotedAtMs) {
      latestPromotedAtMs = promotedAtMs;
      lastPromotedAt = stat.lastPromotedAt;
    }
  }

  return {
    shortTermCount,
    recallSignalCount,
    dailySignalCount,
    totalSignalCount,
    phaseSignalCount,
    lightPhaseHitCount,
    remPhaseHitCount,
    promotedTotal,
    promotedToday,
    ...(storePaths.size === 1 ? { storePath: [...storePaths][0] } : {}),
    ...(phaseSignalPaths.size === 1 ? { phaseSignalPath: [...phaseSignalPaths][0] } : {}),
    ...(lastPromotedAt ? { lastPromotedAt } : {}),
    ...(storeErrors.length === 1
      ? { storeError: storeErrors[0] }
      : storeErrors.length > 1
        ? { storeError: `${storeErrors.length} dreaming stores had read errors.` }
        : {}),
    ...(phaseSignalErrors.length === 1
      ? { phaseSignalError: phaseSignalErrors[0] }
      : phaseSignalErrors.length > 1
        ? { phaseSignalError: `${phaseSignalErrors.length} phase signal stores had read errors.` }
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
  const sweepStatus = await resolveManagedDreamingCronStatus({
    context,
    match: {
      name: MANAGED_DEEP_SLEEP_CRON_NAME,
      tag: MANAGED_DEEP_SLEEP_CRON_TAG,
      payloadText: DEEP_SLEEP_SYSTEM_EVENT_TEXT,
    },
  });
  return {
    light: sweepStatus,
    deep: sweepStatus,
    rem: sweepStatus,
  };
}

async function readDreamDiary(
  workspaceDir: string,
): Promise<Omit<DoctorMemoryDreamDiaryPayload, "agentId">> {
  for (const name of DREAM_DIARY_FILE_NAMES) {
    const filePath = path.join(workspaceDir, name);
    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        continue;
      }
      return {
        found: false,
        path: name,
      };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      continue;
    }
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return {
        found: true,
        path: name,
        content,
        updatedAtMs: Math.floor(stat.mtimeMs),
      };
    } catch {
      return {
        found: false,
        path: name,
      };
    }
  }
  return {
    found: false,
    path: DREAM_DIARY_FILE_NAMES[0],
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
              recallSignalCount: 0,
              dailySignalCount: 0,
              totalSignalCount: 0,
              phaseSignalCount: 0,
              lightPhaseHitCount: 0,
              remPhaseHitCount: 0,
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
  "doctor.memory.dreamDiary": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const dreamDiary = await readDreamDiary(workspaceDir);
    const payload: DoctorMemoryDreamDiaryPayload = {
      agentId,
      ...dreamDiary,
    };
    respond(true, payload, undefined);
  },
};
