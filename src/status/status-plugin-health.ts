// Builds compact plugin health summaries for chat status surfaces.
import type { PluginDiagnosticCode } from "../plugins/manifest-types.js";

type StatusPluginDependencyStatus = {
  hasDependencies?: boolean;
  requiredInstalled?: boolean;
  missing?: string[];
};

export type PluginHealthRecord = {
  id: string;
  status?: "loaded" | "disabled" | "error";
  enabled?: boolean;
  error?: string;
  dependencyStatus?: StatusPluginDependencyStatus;
  failurePhase?: string;
};

export type PluginDiagnosticRecord = {
  level: "warn" | "error";
  message: string;
  pluginId?: string;
  code?: PluginDiagnosticCode;
};

type ContextEngineQuarantineRecord = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAt: Date | number;
};

export type RuntimeToolQuarantineRecord = {
  toolName: string;
  owner?: string;
  reason: string;
  failedAt: Date | number;
};

export type PluginCompatibilityHealthNotice = {
  pluginId: string;
  severity: "warn" | "info";
  message: string;
  code?: string;
};

export type ChannelPluginFailureRecord = {
  channelId: string;
  pluginId?: string;
  message: string;
  source?: string;
};

export type StatusPluginHealthSnapshot = {
  plugins: PluginHealthRecord[];
  diagnostics: PluginDiagnosticRecord[];
  contextEngineQuarantines: ContextEngineQuarantineRecord[];
  runtimeToolQuarantines?: RuntimeToolQuarantineRecord[];
  compatibilityNotices?: PluginCompatibilityHealthNotice[];
  channelPluginFailures?: ChannelPluginFailureRecord[];
};

/** Keeps the first record per key; later duplicates are dropped. */
function dedupeBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (!seen.has(key)) {
      seen.set(key, item);
    }
  }
  return [...seen.values()];
}

export function dedupePluginDiagnostics(
  diagnostics: readonly PluginDiagnosticRecord[],
): PluginDiagnosticRecord[] {
  return dedupeBy(diagnostics, (entry) =>
    JSON.stringify([entry.level, entry.pluginId ?? "", entry.code ?? "", entry.message]),
  );
}

// The key ignores `source` so the same failure surfaced via loader diagnostics
// and via channel resolution dedupes; callers list the preferred record first.
export function dedupeChannelPluginFailures(
  failures: readonly ChannelPluginFailureRecord[],
): ChannelPluginFailureRecord[] {
  return dedupeBy(failures, (entry) =>
    JSON.stringify([entry.channelId, entry.pluginId ?? "", entry.message]),
  );
}

function dedupeCompatibilityNotices(
  notices: readonly PluginCompatibilityHealthNotice[],
): PluginCompatibilityHealthNotice[] {
  return dedupeBy(notices, (entry) =>
    JSON.stringify([entry.pluginId, entry.severity, entry.code ?? "", entry.message]),
  );
}

function mergePluginRecords(
  installed: readonly PluginHealthRecord[],
  runtime: readonly PluginHealthRecord[],
): PluginHealthRecord[] {
  const merged = new Map<string, PluginHealthRecord>();
  for (const plugin of installed) {
    merged.set(plugin.id, plugin);
  }
  for (const plugin of runtime) {
    const existing = merged.get(plugin.id);
    // Field-wise merge: runtime facts win, but a runtime record missing a
    // field never erases what the installed scan knew.
    merged.set(plugin.id, {
      id: plugin.id,
      status: plugin.status ?? existing?.status,
      enabled: plugin.enabled ?? existing?.enabled,
      error: plugin.error ?? existing?.error,
      dependencyStatus: plugin.dependencyStatus ?? existing?.dependencyStatus,
      failurePhase: plugin.failurePhase ?? existing?.failurePhase,
    });
  }
  return [...merged.values()];
}

export function mergeStatusPluginHealthSnapshots(
  installed: StatusPluginHealthSnapshot,
  runtime: StatusPluginHealthSnapshot,
): StatusPluginHealthSnapshot {
  return {
    plugins: mergePluginRecords(installed.plugins, runtime.plugins),
    diagnostics: dedupePluginDiagnostics([...installed.diagnostics, ...runtime.diagnostics]),
    contextEngineQuarantines: [
      ...installed.contextEngineQuarantines,
      ...runtime.contextEngineQuarantines,
    ],
    runtimeToolQuarantines: [
      ...(installed.runtimeToolQuarantines ?? []),
      ...(runtime.runtimeToolQuarantines ?? []),
    ],
    channelPluginFailures: dedupeChannelPluginFailures([
      ...(installed.channelPluginFailures ?? []),
      ...(runtime.channelPluginFailures ?? []),
    ]),
    compatibilityNotices: dedupeCompatibilityNotices([
      ...(installed.compatibilityNotices ?? []),
      ...(runtime.compatibilityNotices ?? []),
    ]),
  };
}

function hasDependencyIssue(plugin: PluginHealthRecord): boolean {
  return (
    plugin.enabled !== false &&
    plugin.dependencyStatus?.hasDependencies === true &&
    plugin.dependencyStatus.requiredInstalled === false
  );
}

type PluginRecordSummary = {
  loadedIds: string[];
  disabled: number;
  errors: PluginHealthRecord[];
  dependencyIssues: PluginHealthRecord[];
};

function summarizePluginRecords(plugins: readonly PluginHealthRecord[]): PluginRecordSummary {
  const loadedIds: string[] = [];
  const errors: PluginHealthRecord[] = [];
  const dependencyIssues: PluginHealthRecord[] = [];
  let disabled = 0;

  for (const plugin of plugins) {
    if (plugin.status === "loaded") {
      loadedIds.push(plugin.id);
    } else if (plugin.status === "disabled") {
      disabled += 1;
    } else if (plugin.status === "error") {
      errors.push(plugin);
    }
    if (hasDependencyIssue(plugin)) {
      dependencyIssues.push(plugin);
    }
  }

  return { loadedIds, disabled, errors, dependencyIssues };
}

function shouldSuppressChannelPluginDiagnostic(
  diagnostic: PluginDiagnosticRecord,
  channelPluginFailures: readonly ChannelPluginFailureRecord[],
): boolean {
  if (!isChannelPluginFailureDiagnostic(diagnostic)) {
    return false;
  }
  // Only suppress when the failure is actually reported in the channel
  // section; otherwise the diagnostic must still count as a problem.
  return channelPluginFailures.some(
    (failure) =>
      failure.message === diagnostic.message &&
      (failure.pluginId == null ||
        diagnostic.pluginId == null ||
        failure.pluginId === diagnostic.pluginId),
  );
}

function getReportableDiagnostics(snapshot: StatusPluginHealthSnapshot): PluginDiagnosticRecord[] {
  const channelPluginFailures = snapshot.channelPluginFailures ?? [];
  return snapshot.diagnostics.filter(
    (entry) => !shouldSuppressChannelPluginDiagnostic(entry, channelPluginFailures),
  );
}

function countProblemDiagnostics(diagnostics: readonly PluginDiagnosticRecord[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const entry of diagnostics) {
    if (entry.level === "error") {
      errors += 1;
    } else if (entry.level === "warn") {
      warnings += 1;
    }
  }
  return { errors, warnings };
}

export function isChannelPluginFailureDiagnostic(diagnostic: PluginDiagnosticRecord): boolean {
  return diagnostic.level === "error" && diagnostic.code === "channel-setup-failure";
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatCompactPluginHealthLineFromSummary(
  snapshot: StatusPluginHealthSnapshot,
  pluginSummary: PluginRecordSummary,
): string {
  const loadErrors = pluginSummary.errors.length;
  const dependencyIssues = pluginSummary.dependencyIssues.length;
  const diagnosticErrors = countProblemDiagnostics(getReportableDiagnostics(snapshot)).errors;
  const quarantines = snapshot.contextEngineQuarantines.length;
  const runtimeToolQuarantines = snapshot.runtimeToolQuarantines?.length ?? 0;
  const channelPluginFailures = snapshot.channelPluginFailures?.length ?? 0;

  const parts = [
    loadErrors > 0 ? formatCount(loadErrors, "plugin error") : null,
    quarantines > 0 ? formatCount(quarantines, "context engine quarantine") : null,
    runtimeToolQuarantines > 0
      ? formatCount(runtimeToolQuarantines, "runtime tool quarantine")
      : null,
    channelPluginFailures > 0 ? formatCount(channelPluginFailures, "channel plugin failure") : null,
    dependencyIssues > 0 ? formatCount(dependencyIssues, "dependency issue") : null,
    diagnosticErrors > 0 ? formatCount(diagnosticErrors, "diagnostic error") : null,
  ].filter((part): part is string => Boolean(part));

  return parts.length === 0 ? "🔌 Plugins: OK" : `⚠️ Plugins: ${parts.join(" · ")}`;
}

export function formatCompactPluginHealthLine(snapshot: StatusPluginHealthSnapshot): string {
  return formatCompactPluginHealthLineFromSummary(snapshot, summarizePluginRecords(snapshot.plugins));
}

function formatPluginList(ids: readonly string[], limit: number): string {
  if (ids.length === 0) {
    return "none";
  }
  const visible = ids.slice(0, limit).join(", ");
  return ids.length > limit ? `${visible}, +${ids.length - limit} more` : visible;
}

function byLocale(left: string, right: string): number {
  return left.localeCompare(right);
}

export function formatDetailedPluginHealth(snapshot: StatusPluginHealthSnapshot): string {
  const pluginSummary = summarizePluginRecords(snapshot.plugins);
  const loaded = pluginSummary.loadedIds.toSorted(byLocale);
  const errors = pluginSummary.errors.toSorted((left, right) => byLocale(left.id, right.id));
  const dependencyIssues = pluginSummary.dependencyIssues.toSorted((left, right) =>
    byLocale(left.id, right.id),
  );
  const diagnostics = getReportableDiagnostics(snapshot);
  const diagnosticCounts = countProblemDiagnostics(diagnostics);
  const contextEngineQuarantines = snapshot.contextEngineQuarantines.toSorted((left, right) =>
    byLocale(left.engineId, right.engineId),
  );
  const runtimeToolQuarantines = (snapshot.runtimeToolQuarantines ?? []).toSorted((left, right) =>
    byLocale(left.toolName, right.toolName),
  );
  const compatibilityNotices = (snapshot.compatibilityNotices ?? []).toSorted((left, right) =>
    byLocale(left.pluginId, right.pluginId),
  );
  const channelPluginFailures = (snapshot.channelPluginFailures ?? []).toSorted((left, right) =>
    byLocale(left.channelId, right.channelId),
  );
  const lines = [
    formatCompactPluginHealthLineFromSummary(snapshot, pluginSummary),
    `Loaded: ${loaded.length}${loaded.length > 0 ? ` (${formatPluginList(loaded, 8)})` : ""}`,
    `Disabled: ${pluginSummary.disabled}`,
  ];

  if (errors.length > 0) {
    lines.push(
      `Errors: ${errors.length}`,
      ...errors.slice(0, 8).map((plugin) => {
        const phase = plugin.failurePhase ? ` [${plugin.failurePhase}]` : "";
        return `- ${plugin.id}${phase}: ${plugin.error ?? "failed to load"}`;
      }),
    );
  }

  if (contextEngineQuarantines.length > 0) {
    lines.push(
      `Context engine quarantines: ${contextEngineQuarantines.length}`,
      ...contextEngineQuarantines.slice(0, 8).map((entry) => {
        const owner = entry.owner ? ` owner=${entry.owner}` : "";
        return `- ${entry.engineId}${owner} during ${entry.operation}: ${entry.reason}`;
      }),
    );
  }

  if (runtimeToolQuarantines.length > 0) {
    lines.push(
      `Runtime tool quarantines: ${runtimeToolQuarantines.length}`,
      ...runtimeToolQuarantines.slice(0, 8).map((entry) => {
        const owner = entry.owner ? ` owner=${entry.owner}` : "";
        return `- ${entry.toolName}${owner}: ${entry.reason}`;
      }),
    );
  }

  if (channelPluginFailures.length > 0) {
    lines.push(
      `Channel plugin failures: ${channelPluginFailures.length}`,
      ...channelPluginFailures.slice(0, 8).map((entry) => {
        const plugin = entry.pluginId ? ` plugin=${entry.pluginId}` : "";
        const source = entry.source ? ` [${entry.source}]` : "";
        return `- ${entry.channelId}${plugin}${source}: ${entry.message}`;
      }),
    );
  }

  if (dependencyIssues.length > 0) {
    lines.push(
      `Dependency issues: ${dependencyIssues.length}`,
      ...dependencyIssues.slice(0, 8).map((plugin) => {
        const missing = plugin.dependencyStatus?.missing ?? [];
        return `- ${plugin.id}: missing ${missing.join(", ") || "required dependencies"}`;
      }),
    );
  }

  if (diagnosticCounts.errors > 0 || diagnosticCounts.warnings > 0) {
    lines.push(
      `Diagnostics: ${diagnosticCounts.errors} errors · ${diagnosticCounts.warnings} warnings`,
    );
    for (const diagnostic of diagnostics.slice(0, 8)) {
      const target = diagnostic.pluginId ? `${diagnostic.pluginId}: ` : "";
      lines.push(`- ${diagnostic.level.toUpperCase()} ${target}${diagnostic.message}`);
    }
  }

  if (compatibilityNotices.length > 0) {
    lines.push(
      `Compatibility notices: ${compatibilityNotices.length}`,
      ...compatibilityNotices.slice(0, 8).map((notice) => {
        const code = notice.code ? ` [${notice.code}]` : "";
        return `- ${notice.severity.toUpperCase()} ${notice.pluginId}${code}: ${notice.message}`;
      }),
    );
  }

  lines.push("Full inventory: /plugins list");
  return lines.join("\n");
}
