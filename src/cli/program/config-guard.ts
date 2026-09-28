// CLI config readiness guard and invalid-config recovery.
import { withSuppressedNotes } from "../../../packages/terminal-core/src/note.js";
import type { StartupConfigPreflightResult } from "../../commands/startup-config-preflight.js";
import { readConfigFileSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { createInvalidConfigError } from "../../config/io.invalid-config.js";
import type { ConfigSnapshotReadMeasure } from "../../config/io.js";
import { resolveIsConfigReadOnly } from "../../config/paths.js";
import type { ConfigFileSnapshot } from "../../config/types.js";
import {
  adoptProcessPluginCache,
  getPluginMetadataSnapshotCache,
} from "../../plugins/plugin-cache.js";
import { ExitError, type RuntimeEnv } from "../../runtime.js";
import {
  getExistingOpenClawStateSchemaPath,
  isExistingOpenClawStateSchema,
} from "../../state/openclaw-state-db-schema-policy.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { InvalidConfigRecoveryDeps } from "../invalid-config-recovery.js";

const ALLOWED_INVALID_COMMANDS = new Set(["audit", "doctor", "logs", "health", "help", "status"]);
const ALLOWED_INVALID_GATEWAY_SUBCOMMANDS = new Set([
  "run",
  "status",
  "probe",
  "health",
  "discover",
  "call",
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
]);
const ALLOWED_INVALID_TASK_SUBCOMMANDS = new Set(["list", "audit"]);
let didRunStartupConfigPreflight = false;
let configSnapshotPromise: Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> | null =
  null;

function resetConfigGuardStateForTests() {
  didRunStartupConfigPreflight = false;
  configSnapshotPromise = null;
}

function shouldPrepareGatewayState(commandPath: string[]): boolean {
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  return (
    commandName === "gateway" &&
    (subcommandName === undefined || subcommandName === "run" || subcommandName.trim() === "")
  );
}

function isGatewayStartupCommand(commandPath: string[]): boolean {
  const [commandName, subcommandName] = commandPath;
  return (
    commandName === "gateway" &&
    (subcommandName === undefined ||
      subcommandName === "run" ||
      subcommandName === "start" ||
      subcommandName === "restart")
  );
}

async function getConfigSnapshot(
  options?: { observe: false; pluginValidation?: "skip" | "core-only" },
  measure?: ConfigSnapshotReadMeasure,
) {
  if (options?.observe === false) {
    return readConfigFileSnapshot({
      ...options,
      ...(measure ? { measure } : {}),
    });
  }
  if (!configSnapshotPromise) {
    const pendingSnapshot = readConfigFileSnapshot(measure ? { measure } : undefined);
    configSnapshotPromise = pendingSnapshot;
    pendingSnapshot.catch(() => {
      if (configSnapshotPromise === pendingSnapshot) {
        configSnapshotPromise = null;
      }
    });
  }
  return configSnapshotPromise;
}

export async function ensureConfigReady(
  params: {
    runtime: RuntimeEnv;
    commandPath?: string[];
    suppressDoctorStdout?: boolean;
    allowInvalid?: boolean;
    beforeStatePreparation?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
    measure?: ConfigSnapshotReadMeasure;
    validateConfigOnly?: boolean;
  },
  recoveryDeps?: InvalidConfigRecoveryDeps,
): Promise<void> {
  const commandPath = params.commandPath ?? [];
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  const existingStatePath = getExistingOpenClawStateSchemaPath();
  const isManagedNodeRuntime =
    existingStatePath !== undefined &&
    ((commandName === "node" && subcommandName === "run") || commandName === "connect");
  if (existingStatePath !== undefined) {
    if (!isManagedNodeRuntime) {
      throw new Error("The managed node runtime cannot run shared-state maintenance commands.");
    }
    if (!isExistingOpenClawStateSchema(resolveOpenClawStateSqlitePath())) {
      throw new Error("The managed node runtime state directory changed after launcher admission.");
    }
  }
  const isRestartController =
    (commandName === "gateway" || commandName === "daemon") && subcommandName === "restart";
  let preflightResult: StartupConfigPreflightResult | null = null;
  const shouldRunStartupPreflight =
    !params.validateConfigOnly &&
    commandName !== "doctor" &&
    !isManagedNodeRuntime &&
    commandName !== "config" &&
    commandName !== "health" &&
    commandName !== "logs" &&
    commandName !== "sessions" &&
    // Remote RPC clients validate without preparing state owned by the running Gateway.
    !(commandName === "gateway" && subcommandName === "call") &&
    // A newer restart client may be controlling an older live Gateway. Validate
    // config without advancing the persistent schema owned by that process.
    !isRestartController &&
    !(commandName === "update" && subcommandName === "status");
  const runStartupPreflight = async () => {
    didRunStartupConfigPreflight = true;
    const runStartupConfigPreflight = async () =>
      (await import("../../commands/startup-config-preflight.js")).runStartupConfigPreflight({
        gateway: shouldPrepareGatewayState(commandPath),
        ...(params.measure ? { measure: params.measure } : {}),
        ...(commandName === "status" ? { observe: false } : {}),
        ...(shouldPrepareGatewayState(commandPath)
          ? {
              validateStartupConfig: async (snapshot: ConfigFileSnapshot) => {
                const { getGatewayStartGuardErrors } =
                  await import("../gateway-cli/pre-bootstrap.js");
                const errors = getGatewayStartGuardErrors({
                  allowUnconfigured: params.allowInvalid,
                  configExists: snapshot.exists,
                  mode: snapshot.config.gateway?.mode,
                });
                if (errors.length > 0) {
                  throw new Error(errors.join("\n"));
                }
              },
            }
          : {}),
        ...(params.beforeStatePreparation
          ? { beforeStatePreparation: params.beforeStatePreparation }
          : {}),
      });
    try {
      return !params.suppressDoctorStdout
        ? await runStartupConfigPreflight()
        : await withSuppressedNotes(runStartupConfigPreflight);
    } catch (error) {
      if (shouldPrepareGatewayState(commandPath)) {
        await (
          await import("../gateway-cli/startup-maintenance.js")
        ).handleGatewayStartupMaintenance(error);
      }
      if (error instanceof ExitError) {
        // Readiness has released any preparation lease before handing off the exit.
        params.runtime.exit(error.code);
      }
      throw error;
    }
  };
  if (!didRunStartupConfigPreflight && shouldRunStartupPreflight) {
    preflightResult = await runStartupPreflight();
  }

  // Read-only diagnostics must not record config health. Core-only validation
  // also skips plugin metadata discovery, whose state reads create SQLite sidecars.
  const configSnapshotOptions =
    params.validateConfigOnly || commandName === "logs"
      ? ({ observe: false, pluginValidation: "core-only" } as const)
      : isManagedNodeRuntime ||
          commandName === "status" ||
          (commandName === "gateway" && subcommandName === "call") ||
          isRestartController
        ? ({ observe: false } as const)
        : undefined;
  const snapshot =
    preflightResult?.snapshot ?? (await getConfigSnapshot(configSnapshotOptions, params.measure));
  const isBareGatewayForegroundRun =
    commandName === "gateway" && (subcommandName === undefined || subcommandName.trim() === "");
  const isReadOnlyTaskStateCommand =
    commandName === "tasks" &&
    (subcommandName === undefined || ALLOWED_INVALID_TASK_SUBCOMMANDS.has(subcommandName));
  const allowInvalid = commandName
    ? params.allowInvalid === true ||
      ALLOWED_INVALID_COMMANDS.has(commandName) ||
      isReadOnlyTaskStateCommand ||
      isBareGatewayForegroundRun ||
      (commandName === "gateway" &&
        subcommandName &&
        ALLOWED_INVALID_GATEWAY_SUBCOMMANDS.has(subcommandName))
    : false;
  const [{ formatConfigIssueLines }, { renderConfigValidationIssueLines }] = await Promise.all([
    import("../../config/issue-format.js"),
    import("../../config/issue-location.js"),
  ]);
  const issues =
    snapshot.exists && !snapshot.valid ? renderConfigValidationIssueLines(snapshot) : [];
  const legacyIssues =
    snapshot.legacyIssues.length > 0 ? formatConfigIssueLines(snapshot.legacyIssues, "-") : [];

  const invalid = snapshot.exists && !snapshot.valid;
  if (!invalid) {
    setRuntimeConfigSnapshot(snapshot.runtimeConfig ?? snapshot.config, snapshot.sourceConfig);
    if (shouldPrepareGatewayState(commandPath) && preflightResult?.pluginMetadataSnapshot) {
      // Carry verified package facts into the final config reread without publishing Gateway policy.
      adoptProcessPluginCache(
        getPluginMetadataSnapshotCache(preflightResult.pluginMetadataSnapshot),
      );
    }
    return;
  }

  const [
    { colorize, isRich, theme },
    { shortenHomePath },
    { formatCliCommand },
    { isPluginPackagingRuntimeOutputInvalidConfigSnapshot },
    { formatPluginPackagingRuntimeOutputRecoveryHint },
  ] = await Promise.all([
    import("../../../packages/terminal-core/src/theme.js"),
    import("../../utils.js"),
    import("../command-format.js"),
    import("../../config/recovery-policy.js"),
    import("../config-recovery-hints.js"),
  ]);
  const rich = isRich();
  const muted = (value: string) => colorize(rich, theme.muted, value);
  const error = (value: string) => colorize(rich, theme.error, value);
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const commandText = (value: string) => colorize(rich, theme.command, value);

  params.runtime.error(heading("OpenClaw config is invalid"));
  params.runtime.error(`${muted("File:")} ${muted(shortenHomePath(snapshot.path))}`);
  if (issues.length > 0) {
    params.runtime.error(muted("Problem:"));
    params.runtime.error(issues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  if (legacyIssues.length > 0) {
    params.runtime.error(muted("Legacy config keys detected:"));
    params.runtime.error(legacyIssues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  params.runtime.error("");
  const isPluginPackagingFailure = isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot);
  const isReadOnlyConfig = resolveIsConfigReadOnly();
  const isGatewayStartup = isGatewayStartupCommand(commandPath);
  const mustBlockInvalid = !allowInvalid || (isGatewayStartup && params.allowInvalid !== true);
  const shouldOfferRecovery =
    mustBlockInvalid && !params.suppressDoctorStdout && !isReadOnlyConfig && !isManagedNodeRuntime;
  if (isPluginPackagingFailure || isReadOnlyConfig || !shouldOfferRecovery) {
    const fixHint = isPluginPackagingFailure
      ? formatPluginPackagingRuntimeOutputRecoveryHint()
      : isReadOnlyConfig
        ? (await import("../../config/config-write-guard.js")).createConfigMutationError({
            configPath: snapshot.path,
          }).message
        : commandText(formatCliCommand("openclaw doctor --fix"));
    params.runtime.error(`${muted("Fix:")} ${fixHint}`);
  }
  params.runtime.error(
    `${muted("Inspect:")} ${commandText(formatCliCommand("openclaw config validate"))}`,
  );
  params.runtime.error(
    muted(
      "Audit, status, health, logs, tasks list/audit, and doctor commands still run with invalid config.",
    ),
  );
  if (
    mustBlockInvalid &&
    (await import("../json-output-mode.js")).isJsonOutputModeActive(process.argv)
  ) {
    const { writeInvalidConfigCliJson } = await import("../config-validation-output.js");
    writeInvalidConfigCliJson(params.runtime, snapshot);
  }
  if (isPluginPackagingFailure && isGatewayStartup) {
    params.runtime.exit(78);
    return;
  }
  if (shouldOfferRecovery && !isPluginPackagingFailure) {
    const { offerInvalidConfigRecovery } = await import("../invalid-config-recovery.js");
    const recovery = await offerInvalidConfigRecovery({
      runtime: params.runtime,
      deps: recoveryDeps,
      retry: async () => {
        // Explicit Doctor owns the repair; retry only current snapshot validation.
        configSnapshotPromise = null;
        const retrySnapshot = shouldRunStartupPreflight
          ? (
              await (
                await import("../../commands/startup-config-preflight.js")
              ).runStartupConfigPreflight({
                gateway: false,
                ...(params.measure ? { measure: params.measure } : {}),
                ...(configSnapshotOptions?.observe === false ? { observe: false } : {}),
              })
            ).snapshot
          : await getConfigSnapshot(configSnapshotOptions, params.measure);
        if (retrySnapshot.exists && !retrySnapshot.valid) {
          const retryIssues = renderConfigValidationIssueLines(retrySnapshot);
          throw createInvalidConfigError(
            retrySnapshot.path,
            retryIssues.join("\n") || "Unknown validation issue.",
          );
        }
        setRuntimeConfigSnapshot(
          retrySnapshot.runtimeConfig ?? retrySnapshot.config,
          retrySnapshot.sourceConfig,
        );
      },
    });
    if (recovery.status === "recovered") {
      return;
    }
    params.runtime.exit(isGatewayStartup ? 78 : 1);
    return;
  }
  if (mustBlockInvalid) {
    params.runtime.exit(isGatewayStartup ? 78 : 1);
  }
}

export const testApi = {
  resetConfigGuardStateForTests,
};
