// `openclaw update status`: combines install metadata, configured channel, and remote update checks.

import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../../packages/terminal-core/src/table.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { ChannelStatusIssue } from "../../channels/plugins/types.public.js";
import { readSessionSqliteMigrationWarnings } from "../../commands/doctor-session-sqlite-warnings.js";
import { collectNodeRuntimeFindings } from "../../commands/node-runtime-diagnostics.js";
import {
  formatUpdateAvailableHint,
  formatUpdateOneLiner,
  resolveStatusRegistryUpdateChannel,
  resolveUpdateAvailability,
} from "../../commands/status.update.js";
import { readSourceConfigBestEffort } from "../../config/config.js";
import { isDefaultInstallIdentity, resolveIsNixMode } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  auditGatewayServiceConfig,
  type ServiceDefinitionDrift,
} from "../../daemon/service-audit.js";
import { resolveGatewayService } from "../../daemon/service.js";
import {
  formatDeferredPluginMigration,
  readDeferredPluginMigrations,
} from "../../infra/deferred-plugin-migrations.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  normalizeUpdateChannel,
  resolveUpdateChannelDisplay,
} from "../../infra/update-channels.js";
import { checkUpdateStatus, formatGitInstallLabel } from "../../infra/update-check.js";
import { readUpdateRunReportHealth } from "../../infra/update-run-report-health.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { readUpdateRunStatus } from "../../infra/update-run-status.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { parseTimeoutMsOrExit, resolveUpdateRoot, type UpdateStatusOptions } from "./shared.js";

async function readChannelStatusIssues(
  config: OpenClawConfig,
  timeoutMs = 5_000,
): Promise<ChannelStatusIssue[]> {
  try {
    const [{ callGateway }, { collectChannelStatusIssues }] = await Promise.all([
      import("../../gateway/call.js"),
      import("../../infra/channels-status-issues.js"),
    ]);
    const payload = await callGateway({
      method: "channels.status",
      params: { probe: false, timeoutMs },
      timeoutMs,
      config,
      sharedStateMode: "read-only",
    });
    return collectChannelStatusIssues(payload, []);
  } catch {
    return [];
  }
}

/** Print update status in JSON or table form for scripts and humans. */
export async function updateStatusCommand(opts: UpdateStatusOptions): Promise<void> {
  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  if (timeoutMs === null) {
    return;
  }

  const [root, config, runtimeFindings] = await Promise.all([
    resolveUpdateRoot(),
    readSourceConfigBestEffort(),
    collectNodeRuntimeFindings(),
  ]);
  const configChannel = normalizeUpdateChannel(config.update?.channel);

  const [update, channelIssues] = await Promise.all([
    checkUpdateStatus({
      root,
      timeoutMs,
      fetchGit: true,
      useDetachedDevUpstream: configChannel === "dev",
      includeRegistry: true,
      resolveRegistryChannel: ({ installKind, git }) =>
        resolveStatusRegistryUpdateChannel({
          configChannel,
          installKind,
          git,
        }),
    }),
    readChannelStatusIssues(config, timeoutMs),
  ]);

  const channelInfo = resolveUpdateChannelDisplay({
    configChannel,
    currentVersion: VERSION,
    installKind: update.installKind,
    gitTag: update.git?.tag ?? null,
    gitBranch: update.git?.branch ?? null,
  });
  const channelLabel = channelInfo.label;

  const updateAvailability = resolveUpdateAvailability(update);

  const runStatus = readUpdateRunStatus();
  const safeMessage = (message: string) =>
    sanitizeTerminalText(redactSensitiveText(message, { mode: "tools" }));
  let serviceDefinition: { drift: ServiceDefinitionDrift[]; warnings: string[] } | undefined;
  if (
    config.gateway?.mode !== "remote" &&
    isDefaultInstallIdentity(process.env) &&
    !resolveIsNixMode(process.env)
  ) {
    try {
      const command = await resolveGatewayService().readCommand(process.env, {
        requireEffective: true,
        timeoutMs,
      });
      if (command) {
        const audit = await auditGatewayServiceConfig({ env: process.env, command, timeoutMs });
        serviceDefinition = {
          drift: audit.definitionDrift ?? [],
          warnings: [
            ...(audit.definitionDrift ?? []).map((fact) => fact.message),
            ...(audit.definitionDriftError ? [audit.definitionDriftError] : []),
          ].map(safeMessage),
        };
      }
    } catch (error) {
      serviceDefinition = {
        drift: [],
        warnings: [
          safeMessage(`Service definition inspection failed: ${formatErrorMessage(error)}`),
        ],
      };
    }
  }
  const safeChannelIssues = channelIssues.map((issue) =>
    Object.assign({}, issue, {
      channel: safeMessage(issue.channel),
      accountId: safeMessage(issue.accountId),
      message: safeMessage(issue.message),
      ...(issue.fix ? { fix: safeMessage(issue.fix) } : {}),
    }),
  );
  const migrationWarnings: string[] = [];
  const migrationWarningErrors: string[] = [];
  for (const readWarnings of [
    () => readDeferredPluginMigrations().map(formatDeferredPluginMigration),
    () => readSessionSqliteMigrationWarnings(),
  ]) {
    try {
      migrationWarnings.push(...readWarnings().map(safeMessage));
    } catch (error) {
      migrationWarningErrors.push(safeMessage(formatErrorMessage(error)));
    }
  }
  const migrationWarningsError = migrationWarningErrors.join("\n");

  if (opts.json) {
    defaultRuntime.writeJson({
      update,
      channel: {
        value: channelInfo.channel,
        source: channelInfo.source,
        label: channelLabel,
        config: configChannel,
      },
      availability: updateAvailability,
      ...(runtimeFindings.length > 0 ? { runtimeFindings } : {}),
      ...(serviceDefinition ? { serviceDefinition } : {}),
      ...(safeChannelIssues.length > 0 ? { channelIssues: safeChannelIssues } : {}),
      ...(migrationWarnings.length > 0 ? { migrationWarnings } : {}),
      ...(migrationWarningsError ? { migrationWarningsError } : {}),
      ...runStatus,
    });
    return;
  }

  const gitLabel = formatGitInstallLabel(update);
  const updateLine = formatUpdateOneLiner(update).replace(/^Update:\s*/i, "");
  const tableWidth = getTerminalTableWidth();
  const installLabel =
    update.installKind === "git"
      ? `git (${update.root ?? "unknown"})`
      : update.installKind === "package"
        ? update.packageManager
        : "unknown";

  const rows = [
    { Item: "Install", Value: installLabel },
    { Item: "Channel", Value: channelLabel },
    ...(gitLabel ? [{ Item: "Git", Value: gitLabel }] : []),
    {
      Item: "Update",
      Value: updateAvailability.available ? theme.warn(`available · ${updateLine}`) : updateLine,
    },
  ];

  defaultRuntime.log(theme.heading("OpenClaw update status"));
  defaultRuntime.log("");
  for (const finding of runtimeFindings) {
    const color =
      finding.severity === "error"
        ? theme.error
        : finding.severity === "warning"
          ? theme.warn
          : theme.muted;
    defaultRuntime.log(color(finding.message));
    if (finding.fixHint) {
      defaultRuntime.log(finding.fixHint);
    }
    defaultRuntime.log("");
  }
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Item", header: "Item", minWidth: 10 },
        { key: "Value", header: "Value", flex: true, minWidth: 24 },
      ],
      rows,
    }).trimEnd(),
  );
  defaultRuntime.log("");

  for (const warning of serviceDefinition?.warnings ?? []) {
    defaultRuntime.log(theme.warn(`Warning: ${warning}`));
  }
  for (const issue of safeChannelIssues) {
    defaultRuntime.log(theme.warn(`Channel ${issue.channel} ${issue.accountId}: ${issue.message}`));
    if (issue.fix) {
      defaultRuntime.log(issue.fix);
    }
  }
  if (safeChannelIssues.length > 0) {
    defaultRuntime.log("");
  }

  for (const warning of migrationWarnings) {
    defaultRuntime.log(theme.warn(`Warning: ${warning}`));
  }
  if (migrationWarningsError) {
    defaultRuntime.log(
      theme.warn(`Pending migration status unavailable: ${migrationWarningsError}`),
    );
  }
  if (migrationWarnings.length > 0 || migrationWarningsError) {
    defaultRuntime.log("");
  }

  if ("runReconciliationError" in runStatus) {
    defaultRuntime.log(
      theme.warn(`Update run reconciliation failed: ${runStatus.runReconciliationError}`),
    );
    defaultRuntime.log("");
  }
  if ("runStatusError" in runStatus) {
    defaultRuntime.log(theme.warn(`Update run status unavailable: ${runStatus.runStatusError}`));
    defaultRuntime.log("");
  } else {
    const { activeRun, lastRun, staleRun, abandonedRun, advisories } = runStatus;
    const run = activeRun ?? lastRun;
    for (const advisory of advisories ?? []) {
      if (advisory.runId !== run?.runId) {
        defaultRuntime.log(advisory.message);
      }
    }
    if (run) {
      if (staleRun) {
        defaultRuntime.log(`Update ${run.runId}: ${staleRun.guidance}`);
      }
      if (abandonedRun) {
        defaultRuntime.log(
          "Abandoned update detected; the Gateway will reconcile its recorded outcome. Run openclaw update repair to reconcile it now.",
        );
      }
      const report = renderUpdateRunReport(
        run,
        run.status === "failed"
          ? { currentHealth: await readUpdateRunReportHealth(run.verification, { timeoutMs }) }
          : {},
      );
      if (!abandonedRun && !staleRun) {
        defaultRuntime.log(report.headline);
      }
      for (const line of report.lines) {
        defaultRuntime.log(line);
      }
      defaultRuntime.log("");
    }
  }

  const updateHint = formatUpdateAvailableHint(update);
  if (updateHint) {
    defaultRuntime.log(theme.warn(updateHint));
  }
}
