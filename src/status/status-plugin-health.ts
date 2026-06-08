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

export type StatusPluginHealthSnapshot = {
  plugins: PluginHealthRecord[];
  diagnostics: PluginDiagnosticRecord[];
  contextEngineQuarantines: ContextEngineQuarantineRecord[];
};

function countEnabledDependencyIssues(plugins: readonly PluginHealthRecord[]): number {
  return plugins.filter(
    (plugin) =>
      plugin.enabled !== false &&
      plugin.dependencyStatus?.hasDependencies === true &&
      plugin.dependencyStatus.requiredInstalled === false,
  ).length;
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

export function formatCompactPluginHealthLine(snapshot: StatusPluginHealthSnapshot): string {
  const loadErrors = snapshot.plugins.filter((plugin) => plugin.status === "error").length;
  const dependencyIssues = countEnabledDependencyIssues(snapshot.plugins);
  const diagnosticCounts = countProblemDiagnostics(snapshot.diagnostics);
  const quarantines = snapshot.contextEngineQuarantines.length;
  const problems = loadErrors + dependencyIssues + diagnosticCounts.errors + quarantines;

  if (problems === 0) {
    return "🔌 Plugins: OK";
  }

  const parts = [
    loadErrors > 0 ? `${loadErrors} plugin error${loadErrors === 1 ? "" : "s"}` : null,
    quarantines > 0
      ? `${quarantines} context engine quarantine${quarantines === 1 ? "" : "s"}`
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
  const diagnosticCounts = countProblemDiagnostics(snapshot.diagnostics);
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
    for (const diagnostic of snapshot.diagnostics.slice(0, 8)) {
      const target = diagnostic.pluginId ? `${diagnostic.pluginId}: ` : "";
      lines.push(`- ${diagnostic.level.toUpperCase()} ${target}${diagnostic.message}`);
    }
  }

  lines.push("Full inventory: /plugins list");
  return lines.join("\n");
}
