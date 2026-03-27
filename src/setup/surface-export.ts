import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listChannelPluginCatalogEntries } from "../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { resolveChannelSetupWizardAdapterForPlugin } from "../commands/channel-setup/registry.js";
import { isChannelConfigured } from "../config/channel-configured.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { createPluginLoaderLogger } from "../plugins/logger.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../plugins/types.js";
import type {
  SetupSurfaceChannelEntry,
  SetupSurfaceDocument,
  SetupSurfaceFieldDescriptor,
  SetupSurfaceProviderEntry,
  SetupSurfaceProviderMethodDescriptor,
  SetupSurfaceSection,
} from "./surface-types.js";

const log = createSubsystemLogger("setup-surface");

function resolveWorkspaceDir(cfg: OpenClawConfig, workspaceDir?: string): string | undefined {
  return workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

function serializeProviderMethod(method: ProviderAuthMethod): SetupSurfaceProviderMethodDescriptor {
  return {
    id: method.id,
    label: method.label,
    kind: method.kind,
    ...(method.hint ? { hint: method.hint } : {}),
    ...(method.wizard?.choiceId ? { choiceId: method.wizard.choiceId } : {}),
    ...(method.wizard?.choiceLabel ? { choiceLabel: method.wizard.choiceLabel } : {}),
    ...(method.wizard?.choiceHint ? { choiceHint: method.wizard.choiceHint } : {}),
    ...(method.wizard?.groupId ? { groupId: method.wizard.groupId } : {}),
    ...(method.wizard?.groupLabel ? { groupLabel: method.wizard.groupLabel } : {}),
    ...(method.wizard?.groupHint ? { groupHint: method.wizard.groupHint } : {}),
    ...(method.wizard?.onboardingScopes
      ? { onboardingScopes: [...method.wizard.onboardingScopes] }
      : {}),
    ...(method.surface
      ? {
          surface: {
            kind: "api_key",
            optionKey: method.surface.optionKey,
            flagName: method.surface.flagName,
            envVar: method.surface.envVar,
            ...(method.surface.allowProfile === false ? { allowProfile: false } : {}),
            ...(method.surface.defaultModel ? { defaultModel: method.surface.defaultModel } : {}),
          },
        }
      : {}),
  };
}

function serializeProvider(provider: ProviderPlugin): SetupSurfaceProviderEntry {
  return {
    kind: "provider",
    id: provider.id,
    ...(provider.pluginId ? { pluginId: provider.pluginId } : {}),
    label: provider.label,
    ...(provider.docsPath ? { docsPath: provider.docsPath } : {}),
    envVars: [...(provider.envVars ?? [])],
    aliases: [...(provider.aliases ?? [])],
    methods: provider.auth.map(serializeProviderMethod),
    ...(provider.wizard?.modelPicker
      ? {
          modelPicker: {
            ...(provider.wizard.modelPicker.label
              ? { label: provider.wizard.modelPicker.label }
              : {}),
            ...(provider.wizard.modelPicker.hint ? { hint: provider.wizard.modelPicker.hint } : {}),
            ...(provider.wizard.modelPicker.methodId
              ? { methodId: provider.wizard.modelPicker.methodId }
              : {}),
          },
        }
      : {}),
  };
}

function serializeChannelFields(plugin: ChannelPlugin): SetupSurfaceFieldDescriptor[] {
  const wizard = plugin.setupWizard;
  if (!wizard) {
    return [];
  }

  const credentialFields: SetupSurfaceFieldDescriptor[] = wizard.credentials.map((credential) => ({
    kind: "secret",
    key: String(credential.inputKey),
    label: credential.credentialLabel,
    ...(credential.preferredEnvVar ? { preferredEnvVar: credential.preferredEnvVar } : {}),
    ...(credential.providerHint ? { providerHint: credential.providerHint } : {}),
    message: credential.inputPrompt,
    ...(credential.helpTitle ? { helpTitle: credential.helpTitle } : {}),
    ...(credential.helpLines ? { helpLines: credential.helpLines } : {}),
  }));

  const textFields: SetupSurfaceFieldDescriptor[] = (wizard.textInputs ?? []).map((input) => ({
    kind: "text",
    key: String(input.inputKey),
    label: input.message,
    ...(input.placeholder ? { placeholder: input.placeholder } : {}),
    ...(input.required ? { required: true } : {}),
    ...(input.helpTitle ? { helpTitle: input.helpTitle } : {}),
    ...(input.helpLines ? { helpLines: input.helpLines } : {}),
  }));

  return [...credentialFields, ...textFields];
}

async function serializeInstalledChannel(params: {
  plugin: ChannelPlugin;
  enabled: boolean;
  cfg: OpenClawConfig;
}): Promise<SetupSurfaceChannelEntry> {
  const { plugin, enabled, cfg } = params;
  const adapter = resolveChannelSetupWizardAdapterForPlugin(plugin);
  const configuredWithoutAdapter = isChannelConfigured(cfg, plugin.id);
  const status = adapter
    ? await adapter.getStatus({
        cfg,
        accountOverrides: {},
      })
    : {
        channel: plugin.id,
        configured: configuredWithoutAdapter,
        statusLines: [
          `${plugin.meta.label}: ${
            configuredWithoutAdapter
              ? enabled
                ? "configured"
                : "configured (plugin disabled)"
              : enabled
                ? "installed"
                : "installed (plugin disabled)"
          }`,
        ],
        selectionHint: enabled ? "installed" : "installed · plugin disabled",
        quickstartScore: 0,
      };

  return {
    kind: "channel",
    id: plugin.id,
    installed: true,
    installable: false,
    label: plugin.meta.label,
    selectionLabel: plugin.meta.selectionLabel ?? plugin.meta.label,
    ...(plugin.meta.detailLabel ? { detailLabel: plugin.meta.detailLabel } : {}),
    ...(plugin.meta.docsPath ? { docsPath: plugin.meta.docsPath } : {}),
    ...(plugin.meta.blurb ? { blurb: plugin.meta.blurb } : {}),
    ...(plugin.meta.systemImage ? { systemImage: plugin.meta.systemImage } : {}),
    aliases: [...(plugin.meta.aliases ?? [])],
    status: {
      configured: status.configured,
      lines: [...status.statusLines],
      ...(status.selectionHint ? { selectionHint: status.selectionHint } : {}),
      ...(status.quickstartScore !== undefined ? { quickstartScore: status.quickstartScore } : {}),
    },
    features: {
      envShortcut: Boolean(plugin.setupWizard?.envShortcut),
      allowFrom: Boolean(plugin.setupWizard?.allowFrom),
      groupAccess: Boolean(plugin.setupWizard?.groupAccess),
      dmPolicy: Boolean(plugin.setupWizard?.dmPolicy),
      multipleAccounts: plugin.config.listAccountIds(cfg).length > 1,
      disableSupported: Boolean(plugin.setupWizard?.disable),
    },
    ...(plugin.setupWizard?.stepOrder ? { stepOrder: plugin.setupWizard.stepOrder } : {}),
    fields: serializeChannelFields(plugin),
  };
}

function serializeCatalogOnlyChannel(params: {
  id: string;
  pluginId?: string;
  meta: {
    label: string;
    selectionLabel?: string;
    detailLabel?: string;
    docsPath?: string;
    blurb?: string;
    systemImage?: string;
    aliases?: string[];
  };
  installed: boolean;
  selectionHint: string;
}): SetupSurfaceChannelEntry {
  return {
    kind: "channel",
    id: params.id,
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    installed: params.installed,
    installable: !params.installed,
    label: params.meta.label,
    selectionLabel: params.meta.selectionLabel ?? params.meta.label,
    ...(params.meta.detailLabel ? { detailLabel: params.meta.detailLabel } : {}),
    ...(params.meta.docsPath ? { docsPath: params.meta.docsPath } : {}),
    ...(params.meta.blurb ? { blurb: params.meta.blurb } : {}),
    ...(params.meta.systemImage ? { systemImage: params.meta.systemImage } : {}),
    aliases: [...(params.meta.aliases ?? [])],
    status: {
      configured: false,
      lines: [
        `${params.meta.label}: ${params.installed ? "installed" : "install plugin to enable"}`,
      ],
      selectionHint: params.selectionHint,
      quickstartScore: 0,
    },
    features: {
      envShortcut: false,
      allowFrom: false,
      groupAccess: false,
      dmPolicy: false,
      multipleAccounts: false,
      disableSupported: false,
    },
    fields: [],
  };
}

function collectProviderEntries(registry: PluginRegistry): SetupSurfaceProviderEntry[] {
  return registry.providers
    .map((entry) =>
      serializeProvider({
        ...entry.provider,
        pluginId: entry.pluginId,
      }),
    )
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

async function collectChannelEntries(params: {
  registry: PluginRegistry;
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  installedOnly?: boolean;
}): Promise<SetupSurfaceChannelEntry[]> {
  const installedEntries = await Promise.all(
    params.registry.channelSetups.map((entry) =>
      serializeInstalledChannel({
        plugin: entry.plugin,
        enabled: entry.enabled,
        cfg: params.cfg,
      }).then((surface) => ({
        ...surface,
        pluginId: entry.pluginId,
      })),
    ),
  );

  const installedIds = new Set(installedEntries.map((entry) => entry.id));
  const catalogOnlyEntries = params.installedOnly
    ? []
    : listChannelPluginCatalogEntries({
        workspaceDir: params.workspaceDir,
        env: params.env,
      })
        .filter((entry) => !installedIds.has(entry.id))
        .map((entry) =>
          serializeCatalogOnlyChannel({
            id: entry.id,
            pluginId: entry.pluginId,
            meta: entry.meta,
            installed: false,
            selectionHint: "plugin · install",
          }),
        );

  return [...installedEntries, ...catalogOnlyEntries].toSorted((a, b) => {
    const orderA = a.status.quickstartScore ?? -1;
    const orderB = b.status.quickstartScore ?? -1;
    if (orderA !== orderB) {
      return orderB - orderA;
    }
    return a.label.localeCompare(b.label);
  });
}

export async function exportSetupSurface(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  sections?: SetupSurfaceSection[];
  installedOnly?: boolean;
}): Promise<SetupSurfaceDocument> {
  const env = params.env ?? process.env;
  const workspaceDir = resolveWorkspaceDir(params.config, params.workspaceDir);
  const registry = loadOpenClawPlugins({
    config: params.config,
    workspaceDir,
    env,
    cache: false,
    includeSetupOnlyChannelPlugins: true,
    activate: true,
    logger: createPluginLoaderLogger(log),
  });

  const requestedSections =
    params.sections && params.sections.length > 0
      ? [...new Set(params.sections)]
      : (["providers", "channels"] satisfies SetupSurfaceSection[]);

  const providers = requestedSections.includes("providers") ? collectProviderEntries(registry) : [];
  const channels = requestedSections.includes("channels")
    ? await collectChannelEntries({
        registry,
        cfg: params.config,
        workspaceDir,
        env,
        installedOnly: params.installedOnly,
      })
    : [];

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sections: requestedSections,
    providers,
    channels,
  };
}
