import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CronJob } from "../../cron/types.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { buildAgentsRuntimeStatus } from "./agents.js";
import type { GatewayRequestHandlers } from "./types.js";

export type OpsSummaryState = "healthy" | "watching" | "needs_review" | "degraded" | "critical";
export type OpsSummarySeverity = "critical" | "high" | "medium" | "low";

export type OpsSummaryIssue = {
  id: string;
  severity: OpsSummarySeverity;
  title: string;
  affected: string;
  detectedAt: number | null;
  likelyCause: string;
  nextInspection: string;
  source: "cron" | "runtime" | "gateway" | "channel" | "memory" | "customization";
  plainSummary?: string;
  whyItMatters?: string;
  recommendedAction?: string;
};

export type DashboardCustomizationProtectionStatus =
  | "protected"
  | "needs_review"
  | "missing"
  | "unknown";

export type DashboardCustomizationProtection = {
  status: DashboardCustomizationProtectionStatus;
  checkedAt: number;
  generatedAtUtc: string | null;
  manifestPath: string;
  patchPath: string | null;
  fileCount: number;
  missingFileCount: number;
  contentDriftCount: number;
  patchApplies: boolean | null;
  updateGuardActive: boolean;
  preserveDirty: boolean;
  sourceRootConfigured: boolean;
  detail: string;
};

export type OpsSummaryResult = {
  ts: number;
  state: OpsSummaryState;
  issues: OpsSummaryIssue[];
  checks: {
    cronEnabled: boolean;
    cronJobs: number;
    failedCronJobs: number;
    nextCronRunAtMs: number | null;
    channelAccounts: number;
    loadedModelCount: number;
    loadedModelBytes: number;
    ollamaProcessRssBytes: number;
    openclawProcessRssBytes: number;
    macosAvailabilityEstimateBytes: number | null;
    customizationProtection: DashboardCustomizationProtection;
  };
  next: {
    automation: string;
    nextCronRunAtMs: number | null;
  };
  sources: {
    runtimeTelemetry: "live" | "unavailable";
    cron: "live" | "unavailable";
    channels: "live";
  };
};

type DashboardCustomizationManifest = {
  generatedAtUtc?: unknown;
  patch?: unknown;
  fileCount?: unknown;
  files?: Array<{ path?: unknown; sha256?: unknown }>;
};

const DASHBOARD_CUSTOMIZATION_MANIFEST_PATH = "customizations/dashboard/manifest.json";
const DASHBOARD_CUSTOMIZATION_PATCH_PATH =
  "customizations/dashboard/openclaw-dashboard-customizations.patch";

function relativePathInsideRoot(root: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) {
    return null;
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function readDashboardCustomizationManifest(manifestPath: string): DashboardCustomizationManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as DashboardCustomizationManifest;
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function checkPatchApplies(sourceRoot: string, patchPath: string): { ok: boolean; detail: string } {
  const result = spawnSync("git", ["apply", "--check", "--cached", "--", patchPath], {
    cwd: sourceRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
    timeout: 5_000,
  });
  if (result.status === 0) {
    return { ok: true, detail: "Patch applies cleanly." };
  }
  const detail = (result.stderr || result.stdout || result.error?.message || "Patch check failed.")
    .trim()
    .split("\n")
    .slice(0, 3)
    .join(" ");
  return { ok: false, detail };
}

function resolveCustomizationSourceRoot(params: {
  configuredSourceRoot?: string | null;
  manifestRelativePath: string;
}): { sourceRoot: string; sourceRootConfigured: boolean } | null {
  if (!params.configuredSourceRoot) {
    return null;
  }
  const candidates = [{ root: path.resolve(params.configuredSourceRoot), configured: true }];
  for (const candidate of candidates) {
    const manifestPath = relativePathInsideRoot(candidate.root, params.manifestRelativePath);
    if (manifestPath && existsSync(manifestPath)) {
      return { sourceRoot: candidate.root, sourceRootConfigured: candidate.configured };
    }
  }
  return { sourceRoot: path.resolve(params.configuredSourceRoot), sourceRootConfigured: true };
}

function getDashboardCustomizationProtection(params: {
  ts: number;
  preserveDirty: boolean;
  sourceRoot?: string | null;
  requiredPaths: string[];
}): DashboardCustomizationProtection {
  const sourceRoot = resolveCustomizationSourceRoot({
    configuredSourceRoot: params.sourceRoot,
    manifestRelativePath: DASHBOARD_CUSTOMIZATION_MANIFEST_PATH,
  });
  const requiredPaths = new Set(params.requiredPaths);
  const preserveDirty = params.preserveDirty;
  const defaultSummary: DashboardCustomizationProtection = {
    status: "unknown",
    checkedAt: params.ts,
    generatedAtUtc: null,
    manifestPath: DASHBOARD_CUSTOMIZATION_MANIFEST_PATH,
    patchPath: null,
    fileCount: 0,
    missingFileCount: 0,
    contentDriftCount: 0,
    patchApplies: null,
    updateGuardActive: false,
    preserveDirty,
    sourceRootConfigured: false,
    detail: "No local dashboard customization source root is configured.",
  };
  if (!sourceRoot) {
    return defaultSummary;
  }
  const manifestPath = relativePathInsideRoot(
    sourceRoot.sourceRoot,
    DASHBOARD_CUSTOMIZATION_MANIFEST_PATH,
  );
  const updateGuardActive =
    preserveDirty &&
    requiredPaths.has(DASHBOARD_CUSTOMIZATION_MANIFEST_PATH) &&
    requiredPaths.has(DASHBOARD_CUSTOMIZATION_PATCH_PATH);
  if (!manifestPath || !existsSync(manifestPath)) {
    return {
      ...defaultSummary,
      status: sourceRoot.sourceRootConfigured ? "missing" : "unknown",
      sourceRootConfigured: sourceRoot.sourceRootConfigured,
      updateGuardActive,
      detail: sourceRoot.sourceRootConfigured
        ? "Dashboard customization manifest is missing from the configured source root."
        : defaultSummary.detail,
    };
  }

  try {
    const manifest = readDashboardCustomizationManifest(manifestPath);
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const patchRelativePath =
      typeof manifest.patch === "string" && manifest.patch.trim()
        ? manifest.patch.trim()
        : DASHBOARD_CUSTOMIZATION_PATCH_PATH;
    const patchPath = relativePathInsideRoot(sourceRoot.sourceRoot, patchRelativePath);
    const patchExists = Boolean(patchPath && existsSync(patchPath));
    let missingFileCount = 0;
    let contentDriftCount = 0;
    for (const entry of files) {
      if (typeof entry.path !== "string" || !entry.path.trim()) {
        continue;
      }
      const protectedPath = relativePathInsideRoot(sourceRoot.sourceRoot, entry.path.trim());
      if (!protectedPath || !existsSync(protectedPath)) {
        missingFileCount += 1;
        continue;
      }
      if (
        typeof entry.sha256 === "string" &&
        entry.sha256 &&
        sha256(protectedPath) !== entry.sha256
      ) {
        contentDriftCount += 1;
      }
    }
    const patchCheck =
      patchExists && patchPath ? checkPatchApplies(sourceRoot.sourceRoot, patchRelativePath) : null;
    const blockers = [
      !patchExists ? "patch missing" : null,
      missingFileCount > 0 ? `${missingFileCount} protected file(s) missing` : null,
      contentDriftCount > 0
        ? `${contentDriftCount} protected file(s) changed since bundle generation`
        : null,
      patchCheck && !patchCheck.ok ? "patch no longer applies cleanly" : null,
      !preserveDirty ? "dirty-change preservation is disabled" : null,
      !updateGuardActive ? "update required-path guard is incomplete" : null,
    ].filter((entry): entry is string => Boolean(entry));
    return {
      status: blockers.length === 0 ? "protected" : "needs_review",
      checkedAt: params.ts,
      generatedAtUtc: typeof manifest.generatedAtUtc === "string" ? manifest.generatedAtUtc : null,
      manifestPath: DASHBOARD_CUSTOMIZATION_MANIFEST_PATH,
      patchPath: patchRelativePath,
      fileCount:
        typeof manifest.fileCount === "number" && Number.isFinite(manifest.fileCount)
          ? manifest.fileCount
          : files.length,
      missingFileCount,
      contentDriftCount,
      patchApplies: patchCheck?.ok ?? null,
      updateGuardActive,
      preserveDirty,
      sourceRootConfigured: sourceRoot.sourceRootConfigured,
      detail:
        blockers.length === 0
          ? "Patch bundle, manifest, and update guard are current."
          : blockers.join("; "),
    };
  } catch (err) {
    return {
      ...defaultSummary,
      status: "needs_review",
      sourceRootConfigured: sourceRoot.sourceRootConfigured,
      updateGuardActive,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function createCustomizationIssues(
  protection: DashboardCustomizationProtection,
): OpsSummaryIssue[] {
  if (protection.status === "protected" || protection.status === "unknown") {
    return [];
  }
  return [
    {
      id: "customization-protection",
      severity: protection.status === "missing" ? "high" : "medium",
      title: "Dashboard customization protection needs review",
      affected: "OpenClaw Dashboard custom features",
      detectedAt: protection.checkedAt,
      likelyCause: protection.detail,
      nextInspection: protection.manifestPath,
      source: "customization",
      plainSummary:
        protection.status === "missing"
          ? "The dashboard customization bundle is missing."
          : "The dashboard customization bundle is not fully current.",
      whyItMatters:
        "A one-click update could fail to preserve custom dashboard features unless the local patch bundle and update guard are healthy.",
      recommendedAction:
        "Regenerate the dashboard customization bundle, verify the patch applies, then rerun the update dry-run.",
    },
  ];
}

function cronRunFailed(job: CronJob): boolean {
  return (
    job.state?.lastRunStatus === "error" ||
    job.state?.lastStatus === "error" ||
    (job.state?.consecutiveErrors ?? 0) > 0
  );
}

function nextCronRunAt(jobs: CronJob[]): number | null {
  const upcoming = jobs
    .filter((job) => job.enabled && typeof job.state?.nextRunAtMs === "number")
    .map((job) => job.state.nextRunAtMs as number)
    .toSorted((a, b) => a - b);
  return upcoming[0] ?? null;
}

function createCronIssues(jobs: CronJob[]): OpsSummaryIssue[] {
  return jobs
    .filter((job) => job.enabled && cronRunFailed(job))
    .map((job) => ({
      id: `cron-${job.id}`,
      severity: (job.state?.consecutiveErrors ?? 0) > 1 ? "high" : "medium",
      title: "Scheduled job failed",
      affected: job.name,
      detectedAt: job.state?.lastRunAtMs ?? job.updatedAtMs ?? null,
      likelyCause: job.state?.lastError ?? "The latest cron run failed.",
      nextInspection: `cron.runs for ${job.id}`,
      source: "cron",
    }));
}

function countChannelAccounts(snapshot: ChannelRuntimeSnapshot): number {
  return Object.values(snapshot.channelAccounts ?? {}).reduce(
    (sum, accounts) => sum + Object.keys(accounts ?? {}).length,
    0,
  );
}

function formatChannelDisconnectCause(account: {
  lastDisconnect?: unknown;
  lastError?: string | null;
  running?: boolean;
  connected?: boolean;
}): string {
  if (account.lastError) {
    return account.lastError;
  }
  const disconnect = account.lastDisconnect;
  if (disconnect && typeof disconnect === "object") {
    const status = (disconnect as { status?: unknown }).status;
    const error = (disconnect as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return error;
    }
    if (typeof status === "number" && Number.isFinite(status)) {
      return `gateway close code ${status}`;
    }
  }
  if (typeof disconnect === "string" && disconnect.trim()) {
    return disconnect;
  }
  if (account.running === false) {
    return "The channel monitor is stopped.";
  }
  if (account.connected === false) {
    return "The channel monitor is running but has not reached connected state.";
  }
  return "The channel account is not connected.";
}

function createChannelIssueSummary(params: {
  channel: string;
  accountLabel: string;
  cause: string;
}): Pick<OpsSummaryIssue, "title" | "plainSummary" | "whyItMatters" | "recommendedAction"> {
  if (params.channel === "discord") {
    const discordLooksUnavailable =
      /gateway close code 4000|timeout|5\d\d|internal server error|gateway time-out/i.test(
        params.cause,
      );
    return {
      title: discordLooksUnavailable
        ? "Discord is having trouble connecting"
        : "Discord account is not connected",
      plainSummary: discordLooksUnavailable
        ? "Discord is reachable in config, but the live Discord connection is degraded."
        : "Discord is configured but not connected.",
      whyItMatters:
        "Messages from Discord may not reach OpenClaw, and OpenClaw may not be able to reply there until this reconnects.",
      recommendedAction:
        "Open Channels, check the Discord account, then retry after Discord API/Gateway connectivity settles.",
    };
  }
  return {
    title: "Channel account is not connected",
    plainSummary: `${params.channel} is configured but not connected.`,
    whyItMatters:
      "OpenClaw may miss incoming messages or fail to send replies on this channel until it reconnects.",
    recommendedAction: "Open Channels and inspect the channel account status.",
  };
}

function createChannelIssues(snapshot: ChannelRuntimeSnapshot): OpsSummaryIssue[] {
  const issues: OpsSummaryIssue[] = [];
  for (const [channel, accountsById] of Object.entries(snapshot.channelAccounts ?? {})) {
    for (const [accountId, account] of Object.entries(accountsById ?? {})) {
      if (account.configured === false || account.enabled === false) {
        continue;
      }
      if (account.running === false || account.connected === false) {
        const accountLabel = account.name ?? account.accountId ?? accountId;
        const cause = formatChannelDisconnectCause(account);
        const summary = createChannelIssueSummary({ channel, accountLabel, cause });
        issues.push({
          id: `channel-${channel}-${account.accountId ?? accountId}`,
          severity: "medium",
          title: summary.title,
          affected: `${channel}: ${accountLabel}`,
          detectedAt:
            (typeof account.lastDisconnect === "object" && account.lastDisconnect
              ? account.lastDisconnect.at
              : null) ??
            account.lastStopAt ??
            account.lastProbeAt ??
            account.lastEventAt ??
            account.lastTransportActivityAt ??
            null,
          likelyCause: cause,
          nextInspection: "channels.status",
          source: "channel",
          plainSummary: summary.plainSummary,
          whyItMatters: summary.whyItMatters,
          recommendedAction: summary.recommendedAction,
        });
      }
    }
  }
  return issues;
}

function issuePriority(issue: OpsSummaryIssue): number {
  switch (issue.severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
  }
  return 3;
}

function sortIssues(issues: OpsSummaryIssue[]): OpsSummaryIssue[] {
  return issues.toSorted((a, b) => {
    const priority = issuePriority(a) - issuePriority(b);
    if (priority !== 0) {
      return priority;
    }
    return (b.detectedAt ?? 0) - (a.detectedAt ?? 0) || a.id.localeCompare(b.id);
  });
}

function stateFromIssues(issues: OpsSummaryIssue[], loadedModelCount: number): OpsSummaryState {
  if (issues.some((issue) => issue.severity === "critical")) {
    return "critical";
  }
  if (issues.some((issue) => issue.severity === "high")) {
    return "degraded";
  }
  if (issues.some((issue) => issue.severity === "medium")) {
    return "needs_review";
  }
  if (loadedModelCount > 0) {
    return "watching";
  }
  return "healthy";
}

function describeNextAutomation(atMs: number | null): string {
  if (!atMs) {
    return "No scheduled automation found";
  }
  return `Next scheduled automation at ${new Date(atMs).toISOString()}`;
}

export const opsSummaryHandlers: GatewayRequestHandlers = {
  "ops.summary": async ({ context, respond }) => {
    const ts = Date.now();
    let cronJobs: CronJob[] = [];
    let cronEnabled = false;
    let cronUnavailableIssue: OpsSummaryIssue | null = null;
    try {
      const [status, jobs] = await Promise.all([
        context.cron.status(),
        context.cron.list({ includeDisabled: true }),
      ]);
      cronEnabled = status.enabled;
      cronJobs = jobs;
    } catch (err) {
      cronUnavailableIssue = {
        id: "cron-unavailable",
        severity: "high",
        title: "Cron telemetry unavailable",
        affected: "Gateway cron scheduler",
        detectedAt: ts,
        likelyCause: err instanceof Error ? err.message : String(err),
        nextInspection: "cron.status",
        source: "cron",
      };
    }

    const runtime = await buildAgentsRuntimeStatus();
    const channelSnapshot = context.getRuntimeSnapshot();
    const runtimeConfig = context.getRuntimeConfig?.() ?? {};
    const customizationProtection = getDashboardCustomizationProtection({
      ts,
      preserveDirty: runtimeConfig.update?.preserveDirty === true,
      sourceRoot: runtimeConfig.update?.sourceRoot,
      requiredPaths: runtimeConfig.update?.requiredPaths ?? [],
    });
    const cronIssues = createCronIssues(cronJobs);
    const channelIssues = createChannelIssues(channelSnapshot);
    const customizationIssues = createCustomizationIssues(customizationProtection);
    const runtimeIssues: OpsSummaryIssue[] = runtime.warnings.map((warning, index) => ({
      id: `runtime-warning-${index}`,
      severity: runtime.localModels.available ? "low" : "medium",
      title: "Runtime telemetry warning",
      affected: "Local model runtime",
      detectedAt: runtime.ts,
      likelyCause: warning,
      nextInspection: "agents.runtime.status",
      source: "runtime",
    }));
    const issues = sortIssues([
      ...(cronUnavailableIssue ? [cronUnavailableIssue] : []),
      ...cronIssues,
      ...channelIssues,
      ...customizationIssues,
      ...runtimeIssues,
    ]);
    const nextRunAtMs = nextCronRunAt(cronJobs);
    respond(true, {
      ts,
      state: stateFromIssues(issues, runtime.localModels.count),
      issues,
      checks: {
        cronEnabled,
        cronJobs: cronJobs.length,
        failedCronJobs: cronIssues.length,
        nextCronRunAtMs: nextRunAtMs,
        channelAccounts: countChannelAccounts(channelSnapshot),
        loadedModelCount: runtime.localModels.count,
        loadedModelBytes: runtime.localModels.totalLoadedBytes,
        ollamaProcessRssBytes: runtime.localModels.process.rssBytes,
        openclawProcessRssBytes: runtime.system.processes?.openclawRssBytes ?? 0,
        macosAvailabilityEstimateBytes: runtime.system.macosMemory?.available
          ? runtime.system.macosMemory.availabilityEstimateBytes
          : null,
        customizationProtection,
      },
      next: {
        automation: describeNextAutomation(nextRunAtMs),
        nextCronRunAtMs: nextRunAtMs,
      },
      sources: {
        runtimeTelemetry: runtime.localModels.available ? "live" : "unavailable",
        cron: cronUnavailableIssue ? "unavailable" : "live",
        channels: "live",
      },
    } satisfies OpsSummaryResult);
  },
};
