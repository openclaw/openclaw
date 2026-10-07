import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { resolvePluginCapabilityConsentCliOptions } from "../../cli/plugin-capability-consent.js";
import { assertConfigWriteAllowedInCurrentMode } from "../../config/config-write-guard.js";
import { readConfigFileSnapshot, readConfigFileSnapshotForWrite } from "../../config/config.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
} from "../../plugins/install-config-mutation.js";
import { createInstalledPluginOwnershipResolver } from "../../plugins/installed-plugin-package-ownership.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
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
  requireCommandFlagEnabled,
  requireGatewayClientScope,
} from "./command-gates.js";
import {
  formatPluginCommandCapabilityConsentError,
  installPluginFromPluginsCommand,
} from "./commands-plugins-install.js";
import type { CommandHandler } from "./commands-types.js";
import { AutoReplyConfigMutationError, setPluginEnabledFromCommand } from "./config-mutations.js";
import { parsePluginsCommand } from "./plugins-commands.js";

function renderJsonBlock(label: string, value: unknown): string {
  return `${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
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
  const lines = [
    `🔌 Plugins (${loaded}/${report.plugins.length} loaded)`,
    ...report.plugins.map((plugin) => {
      const format = plugin.bundleFormat
        ? `${plugin.format ?? "openclaw"}/${plugin.bundleFormat}`
        : (plugin.format ?? "openclaw");
      const label =
        !plugin.name || plugin.name === plugin.id ? plugin.id : `${plugin.name} (${plugin.id})`;
      return `- ${label} [${plugin.status}] ${format}`;
    }),
  ];
  return lines.join("\n");
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
      return await withPluginLifecycleLease({ signal: params.opts?.abortSignal }, async () => {
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
        const installed = await installPluginFromPluginsCommand({
          raw: pluginsCommand.spec,
          acceptCapabilities: pluginsCommand.acceptCapabilities,
          force: pluginsCommand.force,
          snapshot: {
            config: structuredClone(snapshot.sourceConfig),
            baseHash: snapshot.hash,
            writeOptions,
          },
          applyRuntime: context?.applyPluginLifecycleChange,
          beforePersistentApply: assertInvokerOwned,
          signal: params.opts?.abortSignal,
        });
        if (!installed.ok) {
          return commandReply(`⚠️ ${installed.error}`);
        }
        return commandReply(
          [
            `🔌 Installed plugin "${installed.pluginId}". ${installed.application ? `Applied in Gateway generation ${installed.application.generation}.` : "Saved for the next Gateway start."}`,
            ...(installed.warnings ?? []).map((warning) => `⚠️ ${warning}`),
          ].join("\n"),
        );
      });
    }

    const handleLoadedCommand = async () => {
      const snapshot = await readConfigFileSnapshot();
      if (!snapshot.valid) {
        return commandReply("⚠️ Config file is invalid; fix it before using /plugins.");
      }
      const config = structuredClone(snapshot.resolved);
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
              return renderJsonBlock("🔌 Plugins", reports);
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
            return renderJsonBlock(`🔌 Plugin "${inspect.plugin.id}"`, {
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
          enabled: pluginsCommand.action === "enable",
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
        if (consentError) {
          return commandReply(`⚠️ ${consentError}`);
        }
        if (error instanceof AutoReplyConfigMutationError) {
          return commandReply(`⚠️ ${error.message}`);
        }
        throw error;
      }

      return commandReply(
        `🔌 Plugin "${plugin.id}" ${pluginsCommand.action}d in ${snapshot.path}. Gateway reload will apply it to new agent turns.` +
          (registryWarning ? `\n${registryWarning}` : ""),
      );
    };

    if (pluginsCommand.action === "enable" || pluginsCommand.action === "disable") {
      return await withPluginLifecycleLease({}, handleLoadedCommand);
    }
    return await handleLoadedCommand();
  },
);
