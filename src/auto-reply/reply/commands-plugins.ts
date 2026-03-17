import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginRecord } from "../../plugins/registry.js";
import { buildPluginStatusReport, type PluginStatusReport } from "../../plugins/status.js";
import { setPluginEnabledInConfig } from "../../plugins/toggle-config.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScopeForInternalChannel,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { parsePluginsCommand } from "./plugins-commands.js";

function renderJsonBlock(label: string, value: unknown): string {
  return `${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function formatPluginLabel(plugin: PluginRecord): string {
  if (!plugin.name || plugin.name === plugin.id) {
    return plugin.id;
  }
  return `${plugin.name} (${plugin.id})`;
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
      return `- ${formatPluginLabel(plugin)} [${plugin.status}] ${format}`;
    }),
  ];
  return lines.join("\n");
}

function findPlugin(report: PluginStatusReport, rawName: string): PluginRecord | undefined {
  const target = rawName.trim().toLowerCase();
  if (!target) {
    return undefined;
  }
  return report.plugins.find(
    (plugin) => plugin.id.toLowerCase() === target || plugin.name.toLowerCase() === target,
  );
}

async function loadPluginCommandState(workspaceDir: string): Promise<
  | {
      ok: true;
      path: string;
      config: OpenClawConfig;
      report: PluginStatusReport;
    }
  | { ok: false; path: string; error: string }
> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    return {
      ok: false,
      path: snapshot.path,
      error: "Config file is invalid; fix it before using /plugins.",
    };
  }
  const config = structuredClone(snapshot.resolved);
  return {
    ok: true,
    path: snapshot.path,
    config,
    report: buildPluginStatusReport({ config, workspaceDir }),
  };
}

export const handlePluginsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const pluginsCommand = parsePluginsCommand(params.command.commandBodyNormalized);
  if (!pluginsCommand) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/plugins");
  if (unauthorized) {
    return unauthorized;
  }
  const allowInternalReadOnly =
    (pluginsCommand.action === "list" || pluginsCommand.action === "show") &&
    isInternalMessageChannel(params.command.channel);
  const nonOwner = allowInternalReadOnly ? null : rejectNonOwnerCommand(params, "/plugins");
  if (nonOwner) {
    return nonOwner;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/plugins",
    configKey: "plugins",
  });
  if (disabled) {
    return disabled;
  }
  if (pluginsCommand.action === "error") {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${pluginsCommand.message}` },
    };
  }

  const loaded = await loadPluginCommandState(params.workspaceDir);
  if (!loaded.ok) {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${loaded.error}` },
    };
  }

  if (pluginsCommand.action === "list") {
    return {
      shouldContinue: false,
      reply: { text: formatPluginsList(loaded.report) },
    };
  }

  if (pluginsCommand.action === "show") {
    if (!pluginsCommand.name) {
      return {
        shouldContinue: false,
        reply: { text: formatPluginsList(loaded.report) },
      };
    }
    const plugin = findPlugin(loaded.report, pluginsCommand.name);
    if (!plugin) {
      return {
        shouldContinue: false,
        reply: { text: `🔌 No plugin named "${pluginsCommand.name}" found.` },
      };
    }
    const install = loaded.config.plugins?.installs?.[plugin.id] ?? null;
    return {
      shouldContinue: false,
      reply: {
        text: renderJsonBlock(`🔌 Plugin "${plugin.id}"`, {
          plugin,
          install,
        }),
      },
    };
  }

  const missingAdminScope = requireGatewayClientScopeForInternalChannel(params, {
    label: "/plugins write",
    allowedScopes: ["operator.admin"],
    missingText: "❌ /plugins enable|disable requires operator.admin for gateway clients.",
  });
  if (missingAdminScope) {
    return missingAdminScope;
  }

  const plugin = findPlugin(loaded.report, pluginsCommand.name);
  if (!plugin) {
    return {
      shouldContinue: false,
      reply: { text: `🔌 No plugin named "${pluginsCommand.name}" found.` },
    };
  }

  const next = setPluginEnabledInConfig(
    structuredClone(loaded.config),
    plugin.id,
    pluginsCommand.action === "enable",
  );
  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    const issue = validated.issues[0];
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Config invalid after /plugins ${pluginsCommand.action} (${issue.path}: ${issue.message}).`,
      },
    };
  }
  await writeConfigFile(validated.config);

  return {
    shouldContinue: false,
    reply: {
      text: `🔌 Plugin "${plugin.id}" ${pluginsCommand.action}d in ${loaded.path}. Restart the gateway to apply.`,
    },
  };
};
