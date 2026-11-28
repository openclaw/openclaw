import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginConfigUiHint } from "../plugins/types.js";
import { getPath, setPathCreateStrict } from "../secrets/path-utils.js";
import {
  parseConcreteConfigPathTokens,
  type ConcreteConfigPathSegment,
} from "../shared/dot-path.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";

type ConfigurablePlugin = {
  id: string;
  name: string;
  uiHints: Record<string, PluginConfigUiHint>;
  /** JSON schema from the plugin manifest (used for type/enum info). */
  jsonSchema?: JsonSchemaObject;
};

const loadPluginMetadataSnapshotModule = createLazyRuntimeModule(
  () => import("../plugins/plugin-metadata-snapshot.js"),
);

type JsonSchemaProperty = {
  type?: string;
  enum?: unknown[];
};

function getExistingPluginConfig(
  config: OpenClawConfig,
  pluginId: string,
): Record<string, unknown> {
  return (config.plugins?.entries?.[pluginId]?.config as Record<string, unknown>) ?? {};
}

function resolvePluginField(
  fieldKey: string,
  existing: Record<string, unknown>,
  jsonSchema?: JsonSchemaObject,
): { pathSegments: ConcreteConfigPathSegment[]; schemaProp?: JsonSchemaProperty } {
  const segments = parseConcreteConfigPathTokens(fieldKey);
  let value: unknown = existing;
  let cursor: unknown = jsonSchema;

  const pathSegments = segments.map((segment) => {
    const schema =
      cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>) : undefined;
    // Existing containers own their shape; the schema recovers arrays not created yet.
    const arrayContainer = Array.isArray(value) || (value == null && schema?.type === "array");
    const arrayIndex =
      typeof segment === "string" && arrayContainer
        ? parseConfigPathArrayIndex(segment)
        : undefined;
    const resolved = arrayIndex ?? segment;
    value =
      value !== null && typeof value === "object"
        ? Reflect.get(value, String(resolved))
        : undefined;
    const properties = schema?.properties;
    cursor =
      schema?.type === "array"
        ? schema.items
        : properties && typeof properties === "object"
          ? (properties as Record<string, unknown>)[String(segment)]
          : undefined;
    return resolved;
  });
  return {
    pathSegments,
    schemaProp: cursor && typeof cursor === "object" ? (cursor as JsonSchemaProperty) : undefined,
  };
}

function formatCurrentValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return JSON.stringify(value);
}

function parseJsonNumberInput(value: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function discoverConfigurablePlugins(
  manifestPlugins: readonly PluginManifestRecord[],
): ConfigurablePlugin[] {
  const result: ConfigurablePlugin[] = [];
  for (const plugin of manifestPlugins) {
    if (!plugin.configUiHints) {
      continue;
    }
    const promptableHints: Record<string, PluginConfigUiHint> = {};
    for (const [key, hint] of Object.entries(plugin.configUiHints)) {
      if (!hint.advanced) {
        promptableHints[key] = hint;
      }
    }
    if (Object.keys(promptableHints).length === 0) {
      continue;
    }
    result.push({
      id: plugin.id,
      name: plugin.name ?? plugin.id,
      uiHints: promptableHints,
      jsonSchema: plugin.configSchema,
    });
  }
  return result.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function listEnabledConfigurableManifestPlugins(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
}): Promise<readonly PluginManifestRecord[]> {
  const { loadPluginMetadataSnapshot } = await loadPluginMetadataSnapshotModule();
  const snapshot = loadPluginMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: process.env,
  });
  return snapshot.plugins.filter((plugin) => {
    const entry = params.config.plugins?.entries?.[plugin.id];
    return plugin.enabledByDefault || entry?.enabled === true;
  });
}

async function promptPluginFields(params: {
  plugin: ConfigurablePlugin;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  /** When true, show all fields including already-configured ones (for configure flow). */
  showConfigured?: boolean;
}): Promise<OpenClawConfig> {
  const { plugin, config, prompter } = params;
  const existing = getExistingPluginConfig(config, plugin.id);
  const updatedConfig = structuredClone(existing);
  let changed = false;

  for (const [key, hint] of Object.entries(plugin.uiHints)) {
    const { pathSegments, schemaProp } = resolvePluginField(key, existing, plugin.jsonSchema);
    const currentValue = getPath(existing, pathSegments.map(String));
    const hasValue = currentValue !== undefined && currentValue !== null && currentValue !== "";

    if (hasValue && !params.showConfigured) {
      continue;
    }

    const label = terminalText`${hint.label ?? key}`;
    const helpSuffix = hint.help ? terminalText` — ${hint.help}` : "";

    // Plugin secrets stay with config set and the Web UI's secret-storage flow.
    if (hint.sensitive) {
      await prompter.note(
        t("wizard.plugins.sensitiveField", {
          label,
          plugin: plugin.id,
          field: key,
        }),
        t("wizard.plugins.sensitiveTitle"),
      );
      continue;
    }

    let nextValue: unknown;
    if (schemaProp?.enum && Array.isArray(schemaProp.enum)) {
      const options = schemaProp.enum.map((configValue, index) => ({
        value: String(index),
        label: terminalText`${JSON.stringify(configValue) ?? String(configValue)}`,
      }));
      if (hasValue) {
        options.unshift({
          value: "__keep__",
          label: t("wizard.plugins.currentValue", {
            value: terminalText`${formatCurrentValue(currentValue)}`,
          }),
        });
      }
      const selected = await prompter.select({
        message: `${label}${helpSuffix}`,
        options,
        initialValue: hasValue ? "__keep__" : undefined,
      });
      if (selected === "__keep__") {
        continue;
      }
      nextValue = structuredClone(schemaProp.enum[Number(selected)]);
    } else if (schemaProp?.type === "boolean") {
      nextValue = await prompter.confirm({
        message: `${label}${helpSuffix}`,
        initialValue: typeof currentValue === "boolean" ? currentValue : false,
      });
      if (nextValue === currentValue) {
        continue;
      }
    } else {
      const isArray = schemaProp?.type === "array";
      const numberType =
        schemaProp?.type === "number" || schemaProp?.type === "integer"
          ? schemaProp.type
          : undefined;
      const currentStr = isArray
        ? Array.isArray(currentValue)
          ? currentValue.join(", ")
          : ""
        : formatCurrentValue(currentValue);
      const input = await prompter.text({
        message: `${label}${isArray ? t("wizard.plugins.arrayPromptSuffix") : ""}${helpSuffix}`,
        initialValue: currentStr,
        placeholder: hint.placeholder
          ? terminalText`${hint.placeholder}`
          : isArray
            ? t("wizard.plugins.arrayPlaceholder")
            : undefined,
        validate: numberType
          ? (value) => {
              const trimmed = value.trim();
              if (!trimmed) {
                return undefined;
              }
              const parsed = parseJsonNumberInput(trimmed);
              return parsed !== undefined && (numberType === "number" || Number.isInteger(parsed))
                ? undefined
                : t(
                    numberType === "integer"
                      ? "wizard.plugins.invalidInteger"
                      : "wizard.plugins.invalidNumber",
                  );
            }
          : undefined,
      });
      const trimmed = input.trim();
      if (trimmed === currentStr) {
        continue;
      }
      nextValue = trimmed
        ? isArray
          ? normalizeStringEntries(trimmed.split(","))
          : trimmed
        : undefined;
      if (trimmed && numberType) {
        nextValue = JSON.parse(trimmed);
      }
    }
    setPathCreateStrict(updatedConfig, pathSegments, nextValue);
    changed = true;
  }

  if (!changed) {
    return config;
  }

  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [plugin.id]: {
          ...config.plugins?.entries?.[plugin.id],
          config: updatedConfig,
        },
      },
    },
  };
}

export async function setupPluginConfig(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  workspaceDir?: string;
}): Promise<OpenClawConfig> {
  const manifestPlugins = await listEnabledConfigurableManifestPlugins(params);

  const unconfigured = discoverConfigurablePlugins(manifestPlugins).filter((plugin) => {
    const existing = getExistingPluginConfig(params.config, plugin.id);
    return Object.keys(plugin.uiHints).some((key) => {
      const { pathSegments } = resolvePluginField(key, existing, plugin.jsonSchema);
      const val = getPath(existing, pathSegments.map(String));
      return val === undefined || val === null || val === "";
    });
  });

  if (unconfigured.length === 0) {
    return params.config;
  }

  const selected = await params.prompter.multiselect({
    message: t("wizard.plugins.configureSelectOnboard"),
    options: [
      {
        value: "__skip__",
        label: t("common.skipForNow"),
        hint: t("wizard.plugins.skipConfigHint"),
      },
      ...unconfigured.map((p) => ({
        value: p.id,
        label: terminalText`${p.name}`,
        hint: t("wizard.plugins.fieldsCount", {
          count: Object.keys(p.uiHints).length,
          plural: Object.keys(p.uiHints).length === 1 ? "" : "s",
        }),
      })),
    ],
  });

  let config = params.config;
  for (const pluginId of selected.filter((value) => value !== "__skip__")) {
    const plugin = unconfigured.find((p) => p.id === pluginId);
    if (!plugin) {
      continue;
    }
    await params.prompter.note(
      t("wizard.plugins.configurePlugin", { plugin: terminalText`${plugin.name}` }),
      t("wizard.plugins.configureFieldsTitle"),
    );
    config = await promptPluginFields({
      plugin,
      config,
      prompter: params.prompter,
    });
  }

  return config;
}

export async function configurePluginConfig(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  workspaceDir?: string;
}): Promise<OpenClawConfig> {
  const manifestPlugins = await listEnabledConfigurableManifestPlugins(params);

  const configurable = discoverConfigurablePlugins(manifestPlugins);

  if (configurable.length === 0) {
    await params.prompter.note(
      t("wizard.plugins.configureEmpty"),
      t("wizard.plugins.configureEmptyTitle"),
    );
    return params.config;
  }

  const selected = await params.prompter.select({
    message: t("wizard.plugins.configureSelect"),
    options: [
      ...configurable.map((p) => {
        const existing = getExistingPluginConfig(params.config, p.id);
        const configuredCount = Object.keys(p.uiHints).filter((k) => {
          const { pathSegments } = resolvePluginField(k, existing, p.jsonSchema);
          const val = getPath(existing, pathSegments.map(String));
          return val !== undefined && val !== null && val !== "";
        }).length;
        const totalCount = Object.keys(p.uiHints).length;
        return {
          value: p.id,
          label: terminalText`${p.name}`,
          hint: t("wizard.plugins.configuredCount", {
            configured: configuredCount,
            total: totalCount,
          }),
        };
      }),
      { value: "__skip__", label: t("common.back"), hint: t("wizard.plugins.configureBackHint") },
    ],
    searchable: true,
  });

  if (selected === "__skip__") {
    return params.config;
  }

  const plugin = configurable.find((p) => p.id === selected);
  if (!plugin) {
    return params.config;
  }

  return promptPluginFields({
    plugin,
    config: params.config,
    prompter: params.prompter,
    showConfigured: true,
  });
}
