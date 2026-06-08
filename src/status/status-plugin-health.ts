// Builds compact plugin health summaries for chat status surfaces.

export type StatusPluginDependencyStatus = {
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
};

export type ContextEngineQuarantineRecord = {
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

function diagnosticKey(diagnostic: PluginDiagnosticRecord): string {
  return JSON.stringify([diagnostic.level, diagnostic.pluginId ?? "", diagnostic.message]);
}

function channelFailureKey(failure: ChannelPluginFailureRecord): string {
  return JSON.stringify([
    failure.channelId,
    failure.pluginId ?? "",
    failure.source ?? "",
    failure.message,
  ]);
}

function compatibilityNoticeKey(notice: PluginCompatibilityHealthNotice): string {
  return JSON.stringify([notice.pluginId, notice.severity, notice.code ?? "", notice.message]);
}

function mergeDiagnostics(
  left: readonly PluginDiagnosticRecord[],
  right: readonly PluginDiagnosticRecord[],
): PluginDiagnosticRecord[] {
  const merged = new Map<string, PluginDiagnosticRecord>();
  for (const diagnostic of [...left, ...right]) {
    merged.set(diagnosticKey(diagnostic), diagnostic);
  }
  return [...merged.values()];
}

function mergeChannelFailures(
  left: readonly ChannelPluginFailureRecord[],
  right: readonly ChannelPluginFailureRecord[],
): ChannelPluginFailureRecord[] {
  const merged = new Map<string, ChannelPluginFailureRecord>();
  for (const failure of [...left, ...right]) {
    merged.set(channelFailureKey(failure), failure);
  }
  return [...merged.values()];
}

function mergeCompatibilityNotices(
  left: readonly PluginCompatibilityHealthNotice[],
  right: readonly PluginCompatibilityHealthNotice[],
): PluginCompatibilityHealthNotice[] {
  const merged = new Map<string, PluginCompatibilityHealthNotice>();
  for (const notice of [...left, ...right]) {
    merged.set(compatibilityNoticeKey(notice), notice);
  }
  return [...merged.values()];
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
    merged.set(plugin.id, {
      ...existing,
      ...plugin,
      ...(existing?.dependencyStatus && !plugin.dependencyStatus
        ? { dependencyStatus: existing.dependencyStatus }
        : {}),
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
    diagnostics: mergeDiagnostics(installed.diagnostics, runtime.diagnostics),
    contextEngineQuarantines: [
      ...installed.contextEngineQuarantines,
      ...runtime.contextEngineQuarantines,
    ],
    runtimeToolQuarantines: [
      ...(installed.runtimeToolQuarantines ?? []),
      ...(runtime.runtimeToolQuarantines ?? []),
    ],
    channelPluginFailures: mergeChannelFailures(
      installed.channelPluginFailures ?? [],
      runtime.channelPluginFailures ?? [],
    ),
    compatibilityNotices: mergeCompatibilityNotices(
      installed.compatibilityNotices ?? [],
      runtime.compatibilityNotices ?? [],
    ),
  };
}

function countEnabledDependencyIssues(plugins: readonly PluginHealthRecord[]): number {
  return plugins.filter(
    (plugin) =>
      plugin.enabled !== false &&
      plugin.dependencyStatus?.hasDependencies === true &&
      plugin.dependencyStatus.requiredInstalled === false,
  ).length;
}

function shouldSuppressChannelPluginDiagnostic(
  diagnostic: PluginDiagnosticRecord,
  channelPluginFailures: readonly ChannelPluginFailureRecord[],
): boolean {
  if (!isChannelPluginFailureDiagnostic(diagnostic)) {
    return false;
  }
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
  return {
    errors: diagnostics.filter((entry) => entry.level === "error").length,
    warnings: diagnostics.filter((entry) => entry.level === "warn").length,
  };
}

export function isChannelPluginFailureDiagnostic(diagnostic: PluginDiagnosticRecord): boolean {
  if (diagnostic.level !== "error") {
    return false;
  }
  return /failed to (?:apply setup(?:-runtime)? channel runtime|load setup(?:-runtime)? channel entry|load setup entry|register setup(?:-runtime)? channel)/iu.test(
    diagnostic.message,
  );
}

export function formatCompactPluginHealthLine(snapshot: StatusPluginHealthSnapshot): string {
  const loadErrors = snapshot.plugins.filter((plugin) => plugin.status === "error").length;
  const dependencyIssues = countEnabledDependencyIssues(snapshot.plugins);
  const diagnostics = getReportableDiagnostics(snapshot);
  const diagnosticCounts = countProblemDiagnostics(diagnostics);
  const quarantines = snapshot.contextEngineQuarantines.length;
  const runtimeToolQuarantines = snapshot.runtimeToolQuarantines?.length ?? 0;
  const channelPluginFailures = snapshot.channelPluginFailures?.length ?? 0;
  const problems =
    loadErrors +
    dependencyIssues +
    diagnosticCounts.errors +
    quarantines +
    runtimeToolQuarantines +
    channelPluginFailures;

  if (problems === 0) {
    return "🔌 Plugins: OK";
  }

  const parts = [
    loadErrors > 0 ? `${loadErrors} plugin error${loadErrors === 1 ? "" : "s"}` : null,
    quarantines > 0
      ? `${quarantines} context engine quarantine${quarantines === 1 ? "" : "s"}`
      : null,
    runtimeToolQuarantines > 0
      ? `${runtimeToolQuarantines} runtime tool quarantine${
          runtimeToolQuarantines === 1 ? "" : "s"
        }`
      : null,
    channelPluginFailures > 0
      ? `${channelPluginFailures} channel plugin failure${channelPluginFailures === 1 ? "" : "s"}`
      : null,
    dependencyIssues > 0
      ? `${dependencyIssues} dependency issue${dependencyIssues === 1 ? "" : "s"}`
      : null,
    diagnosticCounts.errors > 0
      ? `${diagnosticCounts.errors} diagnostic error${diagnosticCounts.errors === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => Boolean(part));

  return `⚠️ Plugins: ${parts.join(" · ")}`;
}

function formatPluginList(ids: readonly string[], limit: number): string {
  if (ids.length === 0) {
    return "none";
  }
  const visible = ids.slice(0, limit).join(", ");
  return ids.length > limit ? `${visible}, +${ids.length - limit} more` : visible;
}

export function formatDetailedPluginHealth(snapshot: StatusPluginHealthSnapshot): string {
  const loaded = snapshot.plugins
    .filter((plugin) => plugin.status === "loaded")
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  const disabled = snapshot.plugins.filter((plugin) => plugin.status === "disabled").length;
  const errors = snapshot.plugins
    .filter((plugin) => plugin.status === "error")
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const dependencyIssues = snapshot.plugins
    .filter(
      (plugin) =>
        plugin.enabled !== false &&
        plugin.dependencyStatus?.hasDependencies === true &&
        plugin.dependencyStatus.requiredInstalled === false,
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const diagnostics = getReportableDiagnostics(snapshot);
  const diagnosticCounts = countProblemDiagnostics(diagnostics);
  const runtimeToolQuarantines = snapshot.runtimeToolQuarantines ?? [];
  const compatibilityNotices = snapshot.compatibilityNotices ?? [];
  const channelPluginFailures = snapshot.channelPluginFailures ?? [];
  const header = formatCompactPluginHealthLine(snapshot);
  const lines = [
    header,
    `Loaded: ${loaded.length}${loaded.length > 0 ? ` (${formatPluginList(loaded, 8)})` : ""}`,
    `Disabled: ${disabled}`,
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

  if (snapshot.contextEngineQuarantines.length > 0) {
    lines.push(
      `Context engine quarantines: ${snapshot.contextEngineQuarantines.length}`,
      ...snapshot.contextEngineQuarantines.slice(0, 8).map((entry) => {
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
