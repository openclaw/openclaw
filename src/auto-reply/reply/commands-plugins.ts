import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import {
  formatPluginCapabilityConsentLines,
  resolvePluginCapabilityConsentCliOptions,
} from "../../cli/plugin-capability-consent.js";
import { createPluginInstallLogger } from "../../cli/plugins-command-helpers.js";
import { assertConfigWriteAllowedInCurrentMode } from "../../config/config-write-guard.js";
import { readConfigFileSnapshot, readConfigFileSnapshotForWrite } from "../../config/config.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolvePendingPluginCapabilityReview } from "../../plugins/capability-consent.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
} from "../../plugins/install-config-mutation.js";
import {
  formatNonClawHubInstallWarning,
  NON_CLAWHUB_INSTALL_FORCE_FLAG,
} from "../../plugins/install-provenance.js";
import { resolvePluginInstallSourcePlan } from "../../plugins/install-source-plan.js";
import { createInstalledPluginOwnershipResolver } from "../../plugins/installed-plugin-package-ownership.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import { installManagedPlugin } from "../../plugins/management-mutations.js";
import { withPluginLifecycleLeaseAsync } from "../../plugins/plugin-lifecycle-lease.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  buildAllPluginInspectReports,
  withPluginDiagnosticsReportForInspection,
  buildPluginInspectReport,
  buildPluginRegistrySnapshotReport,
  formatPluginCompatibilityNotice,
  type PluginStatusReport,
} from "../../plugins/status.js";
import {
  commandReply,
  defineAuthorizedTextCommand,
  rejectNonOwnerCommand,
  renderCommandJsonBlock,
  requireCommandFlagEnabled,
  requireGatewayClientScope,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { AutoReplyConfigMutationError, setPluginEnabledFromCommand } from "./config-mutations.js";

/** Parsed `/plugins` command variants accepted by auto-reply command handling. */
type PluginsCommand =
  | { action: "list" }
  | { action: "inspect"; name?: string }
  | { action: "install"; acceptCapabilities: boolean; force: boolean; spec: string }
  | { action: "enable"; acceptCapabilities: boolean; name: string }
  | { action: "disable"; name: string }
  | { action: "error"; message: string };

/** Parses a `/plugin` or `/plugins` command into a closed command action. */
function parsePluginsCommand(raw: string): PluginsCommand | null {
  const match = raw.match(/^\/plugins?(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }

  const tail = normalizeOptionalString(match?.[1]) ?? "";
  if (!tail) {
    return { action: "list" };
  }

  const [rawAction, ...rest] = tail.split(/\s+/);
  const action = normalizeOptionalLowercaseString(rawAction);
  const name = rest.join(" ").trim();

  if (action === "list") {
    return name
      ? {
          action: "error",
          message: "Usage: /plugins list|inspect|show|get|enable|disable [plugin]",
        }
      : { action: "list" };
  }

  if (action === "inspect" || action === "show" || action === "get") {
    return { action: "inspect", name: name || undefined };
  }

  if (action === "install" || action === "add") {
    let force = false;
    let acceptCapabilities = false;
    while (rest.length > 0) {
      const flag = rest.at(-1);
      if (flag === "--force" && !force) {
        force = true;
      } else if (flag === "--accept-capabilities" && !acceptCapabilities) {
        acceptCapabilities = true;
      } else {
        break;
      }
      rest.pop();
    }
    const hasMisplacedFlag = rest.some(
      (part) => part === "--force" || part === "--accept-capabilities",
    );
    const spec = rest.join(" ").trim();
    if (!spec || hasMisplacedFlag) {
      return {
        action: "error",
        message:
          "Usage: /plugins install <package|npm:package|path|archive|npm-pack:path|git:repo|clawhub:pkg> [--force] [--accept-capabilities]",
      };
    }
    return { action: "install", acceptCapabilities, force, spec };
  }

  if (action === "enable") {
    const acceptCapabilities = rest.at(-1) === "--accept-capabilities";
    const nameParts = acceptCapabilities ? rest.slice(0, -1) : rest;
    const pluginName = nameParts.join(" ").trim();
    if (!pluginName || nameParts.includes("--accept-capabilities")) {
      return {
        action: "error",
        message: "Usage: /plugins enable <plugin-id-or-name> [--accept-capabilities]",
      };
    }
    return { action, acceptCapabilities, name: pluginName };
  }

  if (action === "disable") {
    if (!name) {
      return {
        action: "error",
        message: `Usage: /plugins ${action} <plugin-id-or-name>`,
      };
    }
    return { action, name };
  }

  return {
    action: "error",
    message: "Usage: /plugins list|inspect|show|get|install|enable|disable [plugin]",
  };
}

function formatPluginCommandCapabilityConsentError(
  error: unknown,
  retryCommand: string,
): string | null {
  if (!(error instanceof ManagedPluginLifecycleError) || !error.capabilityConsent) {
    return null;
  }
  const review = resolvePendingPluginCapabilityReview(error.capabilityConsent.pluginId);
  if (review?.reviewToken !== error.capabilityConsent.reviewToken) {
    return null;
  }
  return [
    ...formatPluginCapabilityConsentLines(review),
    `Review these capabilities, then rerun ${stripAnsi(retryCommand)} --accept-capabilities to continue.`,
  ].join("\n");
}

function buildPluginInspectJson(
  inspect: ReturnType<typeof buildAllPluginInspectReports>[number],
  ownershipResolver: ReturnType<typeof createInstalledPluginOwnershipResolver>,
) {
  const ownership = ownershipResolver.resolvePackage(inspect.plugin.id);
  return {
    inspect,
    compatibilityWarnings: inspect.compatibility.map((warning) => ({
      code: warning.code,
      severity: warning.severity,
      message: formatPluginCompatibilityNotice(warning),
    })),
    install: ownership.ok ? ownership.value.installRecord : null,
  };
}

function formatPluginsList(report: PluginStatusReport): string {
  if (report.plugins.length === 0) {
    return `🔌 No plugins found for workspace ${report.workspaceDir ?? "(unknown workspace)"}.`;
  }

  const loaded = report.plugins.filter((plugin) => plugin.status === "loaded").length;
  return [
    `🔌 Plugins (${loaded}/${report.plugins.length} loaded)`,
    ...report.plugins.map((plugin) => {
      const format = plugin.bundleFormat
        ? `${plugin.format ?? "openclaw"}/${plugin.bundleFormat}`
        : (plugin.format ?? "openclaw");
      const label =
        !plugin.name || plugin.name === plugin.id ? plugin.id : `${plugin.name} (${plugin.id})`;
      return `- ${label} [${plugin.status}] ${format}`;
    }),
  ].join("\n");
}

function hasGatewayAdminScope(params: Parameters<CommandHandler>[0]): boolean {
  return params.ctx.GatewayClientScopes?.includes("operator.admin") === true;
}

export const handlePluginsCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/plugins", match: parsePluginsCommand },
  async (params, pluginsCommand) => {
    const disabled = requireCommandFlagEnabled(params.cfg, {
      label: "/plugins",
      configKey: "plugins",
    });
    if (disabled) {
      return disabled;
    }
    if (pluginsCommand.action === "error") {
      return commandReply(`⚠️ ${pluginsCommand.message}`);
    }

    if (
      pluginsCommand.action === "install" ||
      pluginsCommand.action === "enable" ||
      pluginsCommand.action === "disable"
    ) {
      const missingAdminScope = requireGatewayClientScope(params, {
        label: "/plugins write",
        allowedScopes: ["operator.admin"],
        missingText:
          "❌ /plugins install|enable|disable requires operator.admin for gateway clients.",
      });
      if (missingAdminScope) {
        return missingAdminScope;
      }
      if (!hasGatewayAdminScope(params)) {
        const nonOwner = rejectNonOwnerCommand(params, "/plugins write");
        if (nonOwner) {
          return nonOwner;
        }
      }
      try {
        assertConfigWriteAllowedInCurrentMode();
      } catch (error) {
        return commandReply(`⚠️ ${formatErrorMessage(error)}`);
      }
    }

    if (pluginsCommand.action === "install") {
      const resolveContext =
        readChannelContextGatewayContextResolver(params.rootCtx ?? params.ctx) ??
        getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
      const context = resolveContext?.();
      const assertInvokerOwned = () => {
        if (!hasGatewayAdminScope(params)) {
          params.command.assertOwnerCurrent?.();
        }
        params.commandInvocationSignal?.throwIfAborted();
        params.opts?.abortSignal?.throwIfAborted();
        if (resolveContext && (!context || resolveContext() !== context)) {
          throw new Error("The Gateway that admitted this command is no longer available.");
        }
      };
      assertInvokerOwned();
      return await withPluginLifecycleLeaseAsync({ signal: params.opts?.abortSignal }, async () => {
        const prepared = await readConfigFileSnapshotForWrite();
        const snapshot = prepared.snapshot;
        if (!snapshot.valid) {
          return commandReply("⚠️ Config file is invalid; fix it before using /plugins.");
        }
        const writeOptions = selectInstallMutationWriteOptions(prepared.writeOptions);
        const { pluginMutation } = resolveInstallConfigMutationPreflights({
          parsed: (snapshot.parsed ?? {}) as Record<string, unknown>,
          snapshotPath: snapshot.path,
          writeOptions,
        });
        if (pluginMutation.mode === "blocked") {
          return commandReply(`⚠️ ${pluginMutation.reason}`);
        }
        const installMode = pluginsCommand.force ? "update" : "install";
        const plan = resolvePluginInstallSourcePlan({
          raw: pluginsCommand.spec,
          mode: installMode,
        });
        if (!plan.ok) {
          return commandReply(
            `⚠️ ${plan.error.replace(/^Plugin path not found:/, "Path not found:")}`,
          );
        }
        const acknowledgement = plan.acknowledgement
          ? formatNonClawHubInstallWarning(plan.acknowledgement)
          : undefined;
        if (acknowledgement !== undefined && !pluginsCommand.force) {
          return commandReply(
            `⚠️ ${acknowledgement}\nReview the source, then rerun this chat command with ${NON_CLAWHUB_INSTALL_FORCE_FLAG} to continue.`,
          );
        }
        const warnings: string[] = plan.warning ? [plan.warning] : [];
        const logger = createPluginInstallLogger();
        let installed: Awaited<ReturnType<typeof installManagedPlugin>>;
        try {
          installed = await installManagedPlugin({
            request: plan.request,
            applyRuntime: context?.applyPluginLifecycleChange,
            beforePersistentApply: assertInvokerOwned,
            signal: params.opts?.abortSignal,
            snapshot: {
              config: snapshot.sourceConfig,
              baseHash: snapshot.hash,
              writeOptions,
            },
            ...resolvePluginCapabilityConsentCliOptions({
              acceptCapabilities: pluginsCommand.acceptCapabilities,
              action: "install",
              allowPrompt: false,
            }),
            logger: { ...logger, terminalLinks: false },
          });
        } catch (error) {
          const forceFlag = pluginsCommand.force ? " --force" : "";
          const consentError = formatPluginCommandCapabilityConsentError(
            error,
            `/plugins install ${pluginsCommand.spec}${forceFlag}`,
          );
          if (consentError) {
            return commandReply(`⚠️ ${consentError}`);
          }
          if (error instanceof ManagedPluginLifecycleError && error.installRejected) {
            return commandReply(`⚠️ ${[error.warning, error.message].filter(Boolean).join(" ")}`);
          }
          throw error;
        }
        warnings.push(...(installed.warnings ?? []).map(stripAnsi));
        if (acknowledgement !== undefined) {
          warnings.push(acknowledgement);
        }
        return commandReply(
          [
            `🔌 Installed plugin "${installed.plugin.id}". ${installed.application ? `Applied in Gateway generation ${installed.application.generation}.` : "Saved for the next Gateway start."}`,
            ...warnings.map((warning) => `⚠️ ${warning}`),
          ].join("\n"),
        );
      });
    }

    const handleLoadedCommand = async () => {
      const snapshot = await readConfigFileSnapshot();
      if (!snapshot.valid) {
        return commandReply("⚠️ Config file is invalid; fix it before using /plugins.");
      }
      const config = snapshot.resolved;
      const reportParams = { config, workspaceDir: params.workspaceDir };

      if (pluginsCommand.action === "inspect") {
        const metadataSnapshot = loadPluginMetadataSnapshot(reportParams);
        const text = await withPluginDiagnosticsReportForInspection(
          { ...reportParams, metadataSnapshot },
          (report) => {
            if (!pluginsCommand.name) {
              return formatPluginsList(report);
            }
            if (normalizeOptionalLowercaseString(pluginsCommand.name) === "all") {
              const ownershipResolver = createInstalledPluginOwnershipResolver(
                metadataSnapshot.index,
              );
              const reports = buildAllPluginInspectReports({ config, report }).map((inspect) =>
                buildPluginInspectJson(inspect, ownershipResolver),
              );
              return renderCommandJsonBlock("🔌 Plugins", reports);
            }
            const inspect = buildPluginInspectReport({
              id: pluginsCommand.name,
              config,
              report,
            });
            if (!inspect) {
              return `🔌 No plugin named "${pluginsCommand.name}" found.`;
            }
            const payload = buildPluginInspectJson(
              inspect,
              createInstalledPluginOwnershipResolver(metadataSnapshot.index),
            );
            return renderCommandJsonBlock(`🔌 Plugin "${inspect.plugin.id}"`, {
              ...inspect,
              compatibilityWarnings: payload.compatibilityWarnings,
              install: payload.install,
            });
          },
        );
        return commandReply(text);
      }

      const report = buildPluginRegistrySnapshotReport(reportParams);
      if (pluginsCommand.action === "list") {
        return commandReply(formatPluginsList(report));
      }
      const target = normalizeOptionalLowercaseString(pluginsCommand.name);
      const plugin = target
        ? report.plugins.find(
            (entry) =>
              normalizeOptionalLowercaseString(entry.id) === target ||
              normalizeOptionalLowercaseString(entry.name) === target,
          )
        : undefined;
      if (!plugin) {
        return commandReply(`🔌 No plugin named "${pluginsCommand.name}" found.`);
      }

      let registryWarning: string | undefined;
      try {
        await setPluginEnabledFromCommand({
          pluginId: plugin.id,
          action: pluginsCommand.action,
          assertCurrent: hasGatewayAdminScope(params)
            ? undefined
            : params.command.assertOwnerCurrent,
          ...resolvePluginCapabilityConsentCliOptions({
            acceptCapabilities:
              pluginsCommand.action === "enable" && pluginsCommand.acceptCapabilities,
            action: "enable",
            allowPrompt: false,
          }),
        });
        await refreshPluginRegistryAfterConfigMutation({
          reason: "policy-changed",
          logger: {
            warn: (message) => {
              registryWarning = message;
            },
          },
        });
      } catch (error) {
        const consentError = formatPluginCommandCapabilityConsentError(
          error,
          `/plugins enable ${plugin.id}`,
        );
        const message =
          consentError ||
          (error instanceof AutoReplyConfigMutationError ? error.message : undefined);
        if (message !== undefined) {
          return commandReply(`⚠️ ${message}`);
        }
        throw error;
      }

      return commandReply(
        `🔌 Plugin "${plugin.id}" ${pluginsCommand.action}d in ${snapshot.path}. Gateway reload will apply it to new agent turns.` +
          (registryWarning ? `\n${registryWarning}` : ""),
      );
    };

    if (pluginsCommand.action === "enable" || pluginsCommand.action === "disable") {
      return await withPluginLifecycleLeaseAsync({}, handleLoadedCommand);
    }
    return await handleLoadedCommand();
  },
);
