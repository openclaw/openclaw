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
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { isDefaultInstallIdentity, resolveIsNixMode } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateConfigObjectRaw } from "../../config/validation-core.js";
import {
  auditGatewayServiceConfig,
  type ServiceDefinitionDrift,
} from "../../daemon/service-audit.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  formatDeferredPluginMigration,
  readDeferredPluginMigrationsAsync,
} from "../../infra/deferred-plugin-migrations.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readGatewayLastInstallationReplacementAsync } from "../../infra/gateway-boot-lifecycle.js";
import { readPackageActivationReceipt } from "../../infra/package-update-activation.js";
import { withSqliteDatabaseAdmissionWait } from "../../infra/sqlite-worker-database-admission-relay.js";
import {
  normalizeUpdateChannel,
  resolveUpdateChannelDisplay,
} from "../../infra/update-channels.js";
import {
  checkUpdateStatus,
  formatGitInstallLabel,
  type UpdateCheckResult,
} from "../../infra/update-check.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { projectUpdateRunHistory } from "../../infra/update-run-history-projection.js";
import type { getUpdateRunAsync } from "../../infra/update-run-reader.js";
import { readUpdateRunReportHealth } from "../../infra/update-run-report-health.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { readUpdateRunStatus } from "../../infra/update-run-status.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { defaultRuntime } from "../../runtime.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { withArtifactPreservingStateReads } from "../../state/openclaw-state-db-readonly.js";
import { VERSION } from "../../version.js";
import { formatCliCommand } from "../command-format.js";
import { parseUpdateTimeoutMs, resolveUpdateRoot, type UpdateStatusOptions } from "./shared.js";
import { readUpdateChannelConfig } from "./update-command-config.js";
import { withUpdateDatabaseEngine } from "./update-command-database-engine.js";

async function readUpdateRecoverySetStatus(readRun?: typeof getUpdateRunAsync) {
  try {
    const { inspectUpdateRecoveryBackups } =
      await import("../../infra/update-recovery-backup-status.js");
    const sets = await inspectUpdateRecoveryBackups(readRun);
    return {
      recoverySets: sets.map((set) =>
        set.status === "incomplete"
          ? {
              directory: set.directory,
              status: set.status,
              message: set.message,
              nextAction: set.nextAction,
            }
          : {
              runId: set.runId,
              manifestPath: set.ref.manifestPath,
              status: set.status,
              message: set.message,
              nextAction: set.nextAction,
            },
      ),
    };
  } catch (error) {
    return { recoverySetsError: formatErrorMessage(error) };
  }
}

async function readChannelStatusIssues(
  config: OpenClawConfig,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<ChannelStatusIssue[]> {
  try {
    const [{ callGateway }, { collectChannelStatusIssues }, { loadDeviceIdentityIfPresentAsync }] =
      await Promise.all([
        import("../../gateway/call.js"),
        import("../../infra/channels-status-issues.js"),
        import("../../infra/device-identity-async.js"),
      ]);
    const payload = await callGateway({
      method: "channels.status",
      params: { probe: false, timeoutMs },
      timeoutMs,
      signal,
      config,
      sharedStateMode: "read-only",
      // The RPC's default async identity lookup uses a writable actor, even for existing-only reads.
      deviceIdentity: await loadDeviceIdentityIfPresentAsync(),
    });
    return collectChannelStatusIssues(payload, []);
  } catch (error) {
    throw new Error(`Channel inspection unavailable: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
}

export async function updateStatusCommand(opts: UpdateStatusOptions): Promise<void> {
  const checkTimeoutMs = parseUpdateTimeoutMs(opts.timeout);
  // --timeout bounds update checks; a short network budget must not discard local history.
  const timeoutMs = Math.max(30_000, checkTimeoutMs ?? 0);
  const scope = new AsyncWorkScope();
  const timer = setTimeout(
    () => scope.beginClose(new Error(`Update status timed out after ${timeoutMs / 1000} seconds`)),
    timeoutMs,
  );
  try {
    await withSqliteDatabaseAdmissionWait(
      { deadlineAtMs: Date.now() + timeoutMs, assertActive: () => scope.signal.throwIfAborted() },
      () =>
        scope.run(() =>
          withArtifactPreservingStateReads(() =>
            inspectUpdateStatus(opts, scope.signal, timeoutMs, checkTimeoutMs),
          ),
        ),
    );
  } finally {
    clearTimeout(timer);
    scope.beginClose();
  }
}

async function inspectUpdateStatus(
  opts: UpdateStatusOptions,
  signal: AbortSignal,
  timeoutMs: number,
  checkTimeoutMs: number | undefined,
): Promise<void> {
  const inspectionErrors: { section: string; message: string }[] = [];
  const deadline = performance.now() + timeoutMs;
  const remainingMs = () => Math.max(1, deadline - performance.now());
  const inspect = async <T>(
    section: string,
    operation: () => T | Promise<T>,
    fallback: T,
    onError?: (message: string) => void,
  ): Promise<T> => {
    try {
      signal.throwIfAborted();
      return await racePromiseWithAbortSignal(
        Promise.resolve().then(operation),
        signal,
        (aborted) => aborted.reason,
      );
    } catch (error) {
      const message = sanitizeTerminalText(
        redactSensitiveText(formatErrorMessage(error), { mode: "tools" }),
      );
      inspectionErrors.push({ section, message });
      onError?.(message);
      return fallback;
    }
  };

  const [root, config, runtimeFindings] = await Promise.all([
    inspect<string | null>("installation root", resolveUpdateRoot, null),
    inspect<OpenClawConfig>("configuration", readSourceConfigBestEffort, {}),
    inspect("Node runtime", collectNodeRuntimeFindings, []),
  ]);
  const databaseStatusPromise = inspect(
    "state database",
    () =>
      withUpdateDatabaseEngine(process.env, () =>
        Promise.all([
          inspect<Awaited<ReturnType<typeof readUpdateRunStatus>>>(
            "update history",
            readUpdateRunStatus,
            { runStatusError: "Update history inspection unavailable" },
          ),
          inspect<Awaited<ReturnType<typeof readUpdateRecoverySetStatus>>>(
            "recovery sets",
            () => readUpdateRecoverySetStatus(),
            { recoverySetsError: "Recovery set inspection unavailable" },
          ),
          config.gateway?.mode === "remote"
            ? undefined
            : inspect(
                "previous Gateway shutdown",
                readGatewayLastInstallationReplacementAsync,
                undefined,
              ),
        ]),
      ).catch(async (error: unknown) => {
        const message = sanitizeTerminalText(
          redactSensitiveText(formatErrorMessage(error), { mode: "tools" }),
        );
        inspectionErrors.push({ section: "state database", message });
        return [
          { runStatusError: message },
          await inspect(
            "recovery sets",
            () =>
              readUpdateRecoverySetStatus(async () => {
                throw new Error(message);
              }),
            { recoverySetsError: "Recovery set inspection unavailable" },
          ),
          undefined,
        ] as const;
      }),
    [
      { runStatusError: "Update history inspection unavailable" },
      { recoverySetsError: "Recovery set inspection unavailable" },
      undefined,
    ] as const,
  );
  const configChannel = normalizeUpdateChannel(config.update?.channel);
  const gitTargetChannel =
    opts.json && (configChannel === "stable" || configChannel === "beta")
      ? await inspect(
          "channel configuration",
          () => readUpdateChannelConfig(false).then(({ storedChannel }) => storedChannel),
          null,
        )
      : null;

  const [update, channelIssues] = await Promise.all([
    inspect<UpdateCheckResult>(
      "installation",
      () =>
        checkUpdateStatus({
          root,
          timeoutMs: Math.min(checkTimeoutMs ?? Infinity, remainingMs()),
          signal,
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
      { root, installKind: "unknown", packageManager: "unknown" },
    ),
    inspect(
      "channels",
      () =>
        readChannelStatusIssues(config, Math.min(checkTimeoutMs ?? 5_000, remainingMs()), signal),
      [],
    ),
  ]);
  const git = update.git;
  const currentSha = git?.sha;
  const preferredTarget =
    update.installKind === "git" &&
    git &&
    currentSha &&
    git.dirty === false &&
    (gitTargetChannel === "stable" || gitTargetChannel === "beta")
      ? await inspect(
          "Git target",
          () =>
            import("../../infra/update-runner-git-target.js").then(
              ({ readPreferredGitChannelTarget }) =>
                readPreferredGitChannelTarget({
                  root: git.root,
                  sha: currentSha,
                  channel: gitTargetChannel,
                  timeoutMs: Math.min(checkTimeoutMs ?? Infinity, remainingMs()),
                }),
            ),
          undefined,
        )
      : undefined;

  const channelInfo = resolveUpdateChannelDisplay({
    configChannel,
    currentVersion: VERSION,
    installKind: update.installKind,
    gitTag: update.git?.tag ?? null,
    gitBranch: update.git?.branch ?? null,
  });
  const channelLabel = channelInfo.label;

  const updateAvailability = resolveUpdateAvailability(update);
  let immutableCoverage;
  let immutableCoverageLines: string[] = [];
  if (update.immutable) {
    try {
      const coverage = await inspect(
        "immutable coverage",
        async () => {
          const { inspectImmutableUpdateCoverage, formatImmutableUpdateCoverage } =
            await import("../../infra/update-immutable-inspection.js");
          const value = await inspectImmutableUpdateCoverage({ root: update.immutable!.root });
          return { value, lines: formatImmutableUpdateCoverage(value) };
        },
        undefined,
      );
      if (!coverage) {
        throw new Error("Immutable coverage inspection unavailable");
      }
      immutableCoverage = coverage.value;
      immutableCoverageLines = coverage.lines;
    } catch (error) {
      immutableCoverageLines = [`Immutable coverage unavailable: ${formatErrorMessage(error)}`];
    }
  }

  const [runStatus, recoveryStatus, replacement] = await databaseStatusPromise;
  const activeRun = "activeRun" in runStatus ? runStatus.activeRun : undefined;
  const updateInProgress =
    !("runStatusError" in runStatus) && activeRun && !runStatus.staleRun && !runStatus.abandonedRun;

  const safeMessage = (message: string) =>
    sanitizeTerminalText(redactSensitiveText(message, { mode: "tools" }));
  const printWarning = (message: string) => defaultRuntime.log(theme.warn(message));
  const configValidation = validateConfigObjectRaw(config);
  const configWarnings = configValidation.ok
    ? []
    : [
        ...formatConfigIssueLines(configValidation.issues, "", { normalizeRoot: true }),
        "Run openclaw doctor --fix to repair the configuration.",
      ].map(safeMessage);
  const lastGatewayInstallationReplacement = replacement
    ? { ...replacement, reason: safeMessage(replacement.reason) }
    : undefined;
  let serviceDefinition: { drift: ServiceDefinitionDrift[]; warnings: string[] } | undefined;
  if (
    config.gateway?.mode !== "remote" &&
    isDefaultInstallIdentity(process.env) &&
    !resolveIsNixMode(process.env)
  ) {
    try {
      const command = await inspect(
        "service command",
        () =>
          resolveGatewayService().readCommand(process.env, {
            requireEffective: true,
            timeoutMs: remainingMs(),
          }),
        null,
        (message) => {
          serviceDefinition = {
            drift: [],
            warnings: [safeMessage(`Service definition inspection failed: ${message}`)],
          };
        },
      );
      if (command) {
        const audit = await inspect(
          "service definition",
          () => auditGatewayServiceConfig({ env: process.env, command, timeoutMs: remainingMs() }),
          undefined,
        );
        if (!audit) {
          throw new Error("Service definition inspection unavailable");
        }
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
    async () =>
      (await readDeferredPluginMigrationsAsync()).map((pending) =>
        formatDeferredPluginMigration(
          pending,
          updateInProgress ? { ...process.env, OPENCLAW_UPDATE_IN_PROGRESS: "1" } : process.env,
        ),
      ),
    () => readSessionSqliteMigrationWarnings(),
  ]) {
    migrationWarnings.push(
      ...(
        await inspect("migration warnings", readWarnings, [], (message) =>
          migrationWarningErrors.push(message),
        )
      ).map(safeMessage),
    );
  }
  const migrationWarningsError = migrationWarningErrors.join("\n");
  let packageActivation;
  let packageActivationError: string | undefined;
  try {
    if (root) {
      packageActivation = readPackageActivationReceipt(resolveUpdateInstallRoot(root));
    }
  } catch (error) {
    packageActivationError = safeMessage(formatErrorMessage(error));
  }

  if (opts.json) {
    defaultRuntime.writeJson({
      update: preferredTarget ? { ...update, git: { ...update.git, preferredTarget } } : update,
      channel: {
        value: channelInfo.channel,
        source: channelInfo.source,
        label: channelLabel,
        config: configChannel,
      },
      availability: updateAvailability,
      ...(immutableCoverage ? { immutableCoverage } : {}),
      ...(update.immutable && !immutableCoverage
        ? { immutableCoverageError: immutableCoverageLines[0] }
        : {}),
      ...(runtimeFindings.length > 0 ? { runtimeFindings } : {}),
      ...(serviceDefinition ? { serviceDefinition } : {}),
      ...(lastGatewayInstallationReplacement ? { lastGatewayInstallationReplacement } : {}),
      ...(safeChannelIssues.length > 0 ? { channelIssues: safeChannelIssues } : {}),
      ...(migrationWarnings.length > 0 ? { migrationWarnings } : {}),
      ...(migrationWarningsError ? { migrationWarningsError } : {}),
      ...runStatus,
      ...(packageActivation ? { packageActivation } : {}),
      ...(packageActivationError ? { packageActivationError } : {}),
      ...recoveryStatus,
      ...(configWarnings.length > 0 ? { configWarnings } : {}),
      ...(inspectionErrors.length > 0 ? { inspectionErrors } : {}),
    });
    return;
  }

  const displayedRun = activeRun ?? ("lastRun" in runStatus ? runStatus.lastRun : undefined);
  const currentRunHealth =
    displayedRun?.status === "failed"
      ? await inspect(
          "Gateway health",
          () => readUpdateRunReportHealth(displayedRun.verification, { timeoutMs: remainingMs() }),
          undefined,
        )
      : undefined;
  const gitLabel = formatGitInstallLabel(update);
  const updateLine = formatUpdateOneLiner(update).replace(/^Update:\s*/i, "");
  const tableWidth = getTerminalTableWidth();
  const installLabel =
    update.installKind === "host"
      ? (update.installOwner?.displayName ?? "host-managed")
      : update.installKind === "immutable"
        ? `immutable (${update.immutable?.root ?? update.root ?? "unknown"})`
        : update.installKind === "git"
          ? `git (${update.root ?? "unknown"})`
          : update.installKind === "package"
            ? update.packageManager
            : "unknown";

  const immutable = update.immutable;
  const activation = immutable?.activation;
  const lastActivation = immutable?.lastActivation;
  const verifiedGateway = lastActivation?.gateway;
  const rows = [
    { Item: "Install", Value: installLabel },
    { Item: "Channel", Value: channelLabel },
    ...(immutable
      ? [
          {
            Item: "Immutable activation",
            Value: activation
              ? `pending recovery · ${activation.phase} (${activation.operationId})`
              : immutable.activationEnabled
                ? "enabled"
                : "preparation only",
          },
        ]
      : []),
    ...(activation?.failure ? [{ Item: "Immutable failure", Value: activation.failure }] : []),
    ...(activation?.recoveryCommand
      ? [{ Item: "Recovery command (external Node)", Value: activation.recoveryCommand }]
      : []),
    ...(lastActivation
      ? [
          {
            Item: "Last immutable activation",
            Value: `${lastActivation.outcome === "succeeded" ? "accepted" : "restored"} · ${lastActivation.selectedSha} · verified ${new Date(lastActivation.verifiedAtMs).toISOString()} (${lastActivation.operationId})`,
          },
        ]
      : []),
    ...(verifiedGateway
      ? [
          {
            Item: "Last verified Gateway",
            Value: `version ${verifiedGateway.version} · build ${verifiedGateway.buildId} · PID ${verifiedGateway.pid} · boot ${verifiedGateway.bootId}`,
          },
        ]
      : []),
    ...(packageActivation
      ? [
          {
            Item: "Package recovery",
            Value: `${packageActivation.phase} (${packageActivation.operationId})`,
          },
        ]
      : []),
    ...(packageActivation?.recoveryCommand
      ? [{ Item: "Recovery command (external Node)", Value: packageActivation.recoveryCommand }]
      : []),
    ...(packageActivationError
      ? [{ Item: "Package recovery", Value: packageActivationError }]
      : []),
    ...(gitLabel ? [{ Item: "Git", Value: gitLabel }] : []),
    {
      Item: "Update",
      Value: activeRun
        ? updateInProgress
          ? `in progress · ${activeRun.phase}`
          : "needs attention · see run details below"
        : updateAvailability.available
          ? theme.warn(`available · ${updateLine}`)
          : updateLine,
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

  for (const line of immutableCoverageLines) {
    defaultRuntime.log(safeMessage(line));
  }

  if (lastGatewayInstallationReplacement) {
    const { reason, completedAtMs } = lastGatewayInstallationReplacement;
    defaultRuntime.log(
      `Previous Gateway installation replacement (${new Date(completedAtMs).toISOString()}): ${reason}`,
    );
    defaultRuntime.log("");
  }
  for (const warning of serviceDefinition?.warnings ?? []) {
    printWarning(`Warning: ${warning}`);
  }
  for (const issue of safeChannelIssues) {
    printWarning(`Channel ${issue.channel} ${issue.accountId}: ${issue.message}`);
    if (issue.fix) {
      defaultRuntime.log(issue.fix);
    }
  }
  if (safeChannelIssues.length > 0) {
    defaultRuntime.log("");
  }

  for (const warning of migrationWarnings) {
    printWarning(`Warning: ${warning}`);
  }
  if (migrationWarningsError) {
    printWarning(`Pending migration status unavailable: ${migrationWarningsError}`);
  }
  if (migrationWarnings.length > 0 || migrationWarningsError) {
    defaultRuntime.log("");
  }
  for (const error of inspectionErrors) {
    printWarning(`${error.section} unavailable: ${error.message}`);
  }

  if ("runReconciliationError" in runStatus) {
    printWarning(`Update run reconciliation failed: ${runStatus.runReconciliationError}`);
    defaultRuntime.log("");
  }
  if ("runStatusError" in runStatus) {
    printWarning(`Update run status unavailable: ${runStatus.runStatusError}`);
    defaultRuntime.log("");
  } else {
    const { lastRun, staleRun, abandonedRun, advisories } = runStatus;
    const run = activeRun ?? lastRun;
    for (const advisory of advisories ?? []) {
      if (advisory.runId !== run?.runId) {
        defaultRuntime.log(advisory.message);
      }
    }
    if (run) {
      if (!activeRun) {
        defaultRuntime.log(`Last recorded update (${new Date(run.createdAtMs).toISOString()}):`);
      }
      if (staleRun) {
        defaultRuntime.log(`Update ${run.runId}: ${staleRun.guidance}`);
      }
      if (abandonedRun) {
        defaultRuntime.log(
          `Abandoned update detected; the Gateway will reconcile its recorded outcome. Stop the Gateway first (${formatCliCommand("openclaw gateway stop")}), then run ${formatCliCommand("openclaw update repair")} to reconcile it now.`,
        );
      }
      const report = renderUpdateRunReport(
        run,
        run.status === "failed" ? { currentHealth: currentRunHealth } : {},
      );
      const historical =
        currentRunHealth?.kind === "responding"
          ? projectUpdateRunHistory(run, currentRunHealth)
          : null;
      if (!abandonedRun && !staleRun) {
        defaultRuntime.log(historical ?? report.headline);
      }
      for (const line of historical ? [] : report.lines) {
        defaultRuntime.log(line);
      }
      defaultRuntime.log("");
    }
  }

  if ("recoverySetsError" in recoveryStatus) {
    printWarning(
      safeMessage(`Update recovery sets unavailable: ${recoveryStatus.recoverySetsError}`),
    );
    defaultRuntime.log("");
  } else {
    for (const set of recoveryStatus.recoverySets) {
      if (set.status === "incomplete") {
        defaultRuntime.log("Update capture: incomplete");
        defaultRuntime.log(safeMessage(set.directory));
      } else {
        const label = set.status === "manual" ? "Doctor capture" : "Update recovery set";
        defaultRuntime.log(safeMessage(`${label} ${set.runId}: ${set.status}`));
        defaultRuntime.log(safeMessage(set.manifestPath));
      }
      defaultRuntime.log(safeMessage(set.message));
      defaultRuntime.log(safeMessage(`Next action: ${set.nextAction}`));
      defaultRuntime.log("");
    }
  }

  const updateHint = activeRun ? null : formatUpdateAvailableHint(update);
  if (updateHint) {
    printWarning(updateHint);
  }
  for (const warning of configWarnings) {
    printWarning(`Warning: ${warning}`);
  }
}
