import { withSuppressedNotes } from "../../../packages/terminal-core/src/note.js";
import type {
  StartupConfigPreflightOptions,
  StartupConfigPreflightResult,
} from "../../commands/startup-config-preflight.js";
import { readConfigFileSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  configFailureHeading,
  createConfigReadError,
  createInvalidConfigError,
  isConfigReadFailure,
} from "../../config/io.invalid-config.js";
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

const ALLOWED_INVALID_COMMANDS = new Set(["audit", "doctor", "logs", "health", "help", "status"]);
const ALLOWED_INVALID_GATEWAY_SUBCOMMANDS = new Set([
  "run",
  "status",
  "probe",
  "health",
  "discover",
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
]);
// Legacy-key notices end with doctor repair advice. Doctor cannot write a read-only config,
// so keep the step it would take ("move it to ...") and drop the command.
const TRAILING_DOCTOR_HINT =
  /(;\s*|(?<=[.!?])\s+)(?:re)?run\s+["`]openclaw doctor(?:\s+--fix)?["`](?:\s+to\s+((?:(?![.!?]\s).)+?))?[.!?]?$/iu;

function withoutTrailingDoctorCommand(message: string): string {
  const match = TRAILING_DOCTOR_HINT.exec(message);
  if (!match) {
    return message;
  }
  const [, separator = "", step] = match;
  const head = message.slice(0, match.index);
  if (!step) {
    return /[.!?]$/u.test(head) ? head : `${head}.`;
  }
  const action = separator.startsWith(";") ? step : step.charAt(0).toUpperCase() + step.slice(1);
  return `${head}${separator}${action}.`;
}

let didRunStartupConfigPreflight = false;
let configSnapshotPromise: Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> | null =
  null;

function resetConfigGuardStateForTests() {
  didRunStartupConfigPreflight = false;
  configSnapshotPromise = null;
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

export async function ensureConfigReady(params: {
  runtime: RuntimeEnv;
  commandPath?: string[];
  suppressDoctorStdout?: boolean;
  allowInvalid?: boolean;
  beforeStatePreparation?: StartupConfigPreflightOptions["beforeStatePreparation"];
  measure?: ConfigSnapshotReadMeasure;
  validateConfigOnly?: boolean;
}): Promise<void> {
  await using preflightResources = new AsyncDisposableStack();
  let preflightCache: StartupConfigPreflightResult["pluginCache"];
  preflightResources.defer(async () => {
    await preflightCache?.[Symbol.asyncDispose]();
  });
  const commandPath = params.commandPath ?? [];
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  const prepareGatewayState =
    commandName === "gateway" &&
    (subcommandName === undefined || subcommandName === "run" || subcommandName.trim() === "");
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
    // A newer restart client may be controlling an older live Gateway. Validate
    // config without advancing the persistent schema owned by that process.
    !isRestartController &&
    !(commandName === "update" && subcommandName === "status");
  if (!didRunStartupConfigPreflight && shouldRunStartupPreflight) {
    didRunStartupConfigPreflight = true;
    const runStartupConfigPreflight = async () =>
      (await import("../../commands/startup-config-preflight.js")).runStartupConfigPreflight({
        gateway: prepareGatewayState,
        ...(params.measure ? { measure: params.measure } : {}),
        ...(commandName === "status" ? { observe: false } : {}),
        ...(prepareGatewayState
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
                  params.runtime.error(errors.join("\n"));
                  throw new ExitError(78);
                }
              },
            }
          : {}),
        ...(params.beforeStatePreparation
          ? { beforeStatePreparation: params.beforeStatePreparation }
          : {}),
      });
    try {
      preflightResult = !params.suppressDoctorStdout
        ? await runStartupConfigPreflight()
        : await withSuppressedNotes(runStartupConfigPreflight);
      preflightCache = preflightResult.pluginCache;
    } catch (error) {
      if (prepareGatewayState) {
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
  }

  // Read-only diagnostics must not record config health. Core-only validation
  // also skips plugin metadata discovery, whose state reads create SQLite sidecars.
  const isPassiveConfigOnly = params.validateConfigOnly || commandName === "logs";
  const configSnapshotOptions = isPassiveConfigOnly
    ? ({ observe: false, pluginValidation: "core-only" } as const)
    : isManagedNodeRuntime || commandName === "status" || isRestartController
      ? ({ observe: false } as const)
      : undefined;
  const snapshot =
    preflightResult?.snapshot ?? (await getConfigSnapshot(configSnapshotOptions, params.measure));
  const isBareGatewayForegroundRun =
    commandName === "gateway" && (subcommandName === undefined || subcommandName.trim() === "");
  const allowInvalid = commandName
    ? params.allowInvalid === true ||
      ALLOWED_INVALID_COMMANDS.has(commandName) ||
      isBareGatewayForegroundRun ||
      (commandName === "gateway" &&
        subcommandName &&
        ALLOWED_INVALID_GATEWAY_SUBCOMMANDS.has(subcommandName))
    : false;
  const invalid = snapshot.exists && !snapshot.valid;
  if (!invalid) {
    setRuntimeConfigSnapshot(snapshot.runtimeConfig ?? snapshot.config, snapshot.sourceConfig);
    if (prepareGatewayState && preflightResult?.pluginMetadataSnapshot) {
      // Carry verified package facts into the final config reread without publishing Gateway policy.
      adoptProcessPluginCache(
        getPluginMetadataSnapshotCache(preflightResult.pluginMetadataSnapshot),
      );
      preflightCache = undefined;
    }
    return;
  }

  const [
    { formatConfigIssueLines },
    { renderConfigValidationIssueLines },
    { colorize, isRich, theme },
    { shortenHomePath },
    { formatCliCommand },
    { isPluginPackagingRuntimeOutputInvalidConfigSnapshot },
    { formatPluginPackagingRuntimeOutputRecoveryHint },
  ] = await Promise.all([
    import("../../config/issue-format.js"),
    import("../../config/issue-location.js"),
    import("../../../packages/terminal-core/src/theme.js"),
    import("../../utils.js"),
    import("../command-format.js"),
    import("../../config/recovery-policy.js"),
    import("../config-recovery-hints.js"),
  ]);
  const issues = renderConfigValidationIssueLines(snapshot);
  // Externally managed config: only its source can fix it, so omit local command hints.
  const isReadOnlyConfig = resolveIsConfigReadOnly();
  const legacyIssues = formatConfigIssueLines(
    isReadOnlyConfig
      ? snapshot.legacyIssues.map((issue) => ({
          ...issue,
          message: withoutTrailingDoctorCommand(issue.message),
        }))
      : snapshot.legacyIssues,
    "-",
  );
  const rich = isRich();
  const muted = (value: string) => colorize(rich, theme.muted, value);
  const error = (value: string) => colorize(rich, theme.error, value);
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const commandText = (value: string) => colorize(rich, theme.command, value);

  const readFailure = isConfigReadFailure(snapshot);
  params.runtime.error(heading(configFailureHeading(snapshot)));
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
  const isGatewayStartup =
    commandName === "gateway" &&
    (subcommandName === undefined ||
      subcommandName === "run" ||
      subcommandName === "start" ||
      subcommandName === "restart");
  const mustBlockInvalid = !allowInvalid || (isGatewayStartup && params.allowInvalid !== true);
  const shouldOfferRecovery =
    mustBlockInvalid &&
    !readFailure &&
    !params.suppressDoctorStdout &&
    !isReadOnlyConfig &&
    !isManagedNodeRuntime;
  if (readFailure) {
    params.runtime.error(muted("Resolve the read error shown above, then retry."));
  } else if (isPluginPackagingFailure || isReadOnlyConfig || !shouldOfferRecovery) {
    const fixHint = isPluginPackagingFailure
      ? formatPluginPackagingRuntimeOutputRecoveryHint()
      : isReadOnlyConfig
        ? (await import("../../config/config-write-guard.js")).createConfigMutationError({
            configPath: snapshot.path,
          }).message
        : commandText(formatCliCommand("openclaw doctor --fix"));
    params.runtime.error(`${muted("Fix:")} ${fixHint}`);
  }
  if (!isReadOnlyConfig) {
    params.runtime.error(
      `${muted("Inspect:")} ${commandText(formatCliCommand("openclaw config validate"))}`,
    );
    params.runtime.error(
      muted(
        readFailure
          ? "Audit, status, health, logs, and doctor commands still run when config cannot be read."
          : "Audit, status, health, logs, and doctor commands still run with invalid config.",
      ),
    );
  }
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
      retry: async () => {
        // Explicit Doctor owns the repair; retry only current snapshot validation.
        configSnapshotPromise = null;
        const retryPreflight = shouldRunStartupPreflight
          ? await (
              await import("../../commands/startup-config-preflight.js")
            ).runStartupConfigPreflight({
              gateway: false,
              ...(params.measure ? { measure: params.measure } : {}),
              ...(configSnapshotOptions?.observe === false ? { observe: false } : {}),
            })
          : undefined;
        preflightResources.use(retryPreflight?.pluginCache);
        const retrySnapshot =
          retryPreflight?.snapshot ??
          (await getConfigSnapshot(configSnapshotOptions, params.measure));
        if (retrySnapshot.exists && !retrySnapshot.valid) {
          const retryIssues = renderConfigValidationIssueLines(retrySnapshot);
          const details = retryIssues.join("\n") || "Unknown validation issue.";
          throw isConfigReadFailure(retrySnapshot)
            ? createConfigReadError(retrySnapshot, details)
            : createInvalidConfigError(retrySnapshot.path, details);
        }
        setRuntimeConfigSnapshot(
          retrySnapshot.runtimeConfig ?? retrySnapshot.config,
          retrySnapshot.sourceConfig,
        );
      },
    });
    if (recovery) {
      return;
    }
    params.runtime.exit(isGatewayStartup ? 78 : 1);
    return;
  }
  if (mustBlockInvalid) {
    // EX_CONFIG parks supervised Gateways; a failed read has not proven config invalid.
    params.runtime.exit(isGatewayStartup && !readFailure ? 78 : 1);
  }
}

export const testApi = {
  resetConfigGuardStateForTests,
};
