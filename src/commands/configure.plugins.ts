import type { OpenClawConfig } from "../config/types.js";
import type { PluginRecord } from "../plugins/registry.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { writeConfigFile } from "../config/config.js";
import { applyExclusiveSlotSelection } from "../plugins/slots.js";
import { buildPluginStatusReport } from "../plugins/status.js";
import { guardCancel } from "./onboard-helpers.js";

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === undefined || current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || current[key] === null || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function getSchemaDefault(schema: Record<string, unknown>, path: string): unknown {
  if (!schema || !schema.properties) {
    return undefined;
  }
  const keys = path.split(".");
  let current: unknown = schema;
  for (const key of keys) {
    if (
      !current ||
      typeof current !== "object" ||
      !("properties" in current) ||
      typeof current.properties !== "object" ||
      !current.properties ||
      !(key in current.properties)
    ) {
      return undefined;
    }
    current = (current.properties as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" && "default" in current
    ? current.default
    : undefined;
}

async function promptPluginEntryConfig(
  plugin: PluginRecord,
  currentConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const pluginId = plugin.id;
  const entry =
    (
      currentConfig.plugins as unknown as {
        entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
      }
    )?.entries?.[pluginId] ?? {};
  const isEnabled = entry.enabled ?? false;

  const report = buildPluginStatusReport({ config: currentConfig as unknown as OpenClawConfig });

  let toggleEnabled = await prompter.confirm({
    message: `Enable plugin "${plugin.name || pluginId}"?`,
    initialValue: isEnabled,
  });

  let nextConfig = { ...currentConfig };
  let nextEntry = { ...entry, enabled: toggleEnabled };

  if (toggleEnabled && plugin.kind) {
    const slotResult = applyExclusiveSlotSelection({
      config: currentConfig as unknown as OpenClawConfig,
      selectedId: pluginId,
      selectedKind: plugin.kind,
      registry: report,
    });
    if (slotResult.changed) {
      nextConfig = slotResult.config as unknown as OpenClawConfig;
      nextEntry =
        (
          nextConfig.plugins as unknown as {
            entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
          }
        )?.entries?.[pluginId] ?? nextEntry;
      if (slotResult.warnings.length > 0) {
        for (const w of slotResult.warnings) {
          await prompter.note(w, "Slot Selection");
        }
      }
    }
  }

  if (toggleEnabled && plugin.configUiHints) {
    const pluginConfig = entry.config ?? {};
    const nextPluginConfig = { ...pluginConfig };

    for (const [key, hint] of Object.entries(plugin.configUiHints)) {
      const message = hint.label || key;
      const currentVal = getNestedValue(pluginConfig, key);
      const defaultVal = getSchemaDefault(plugin.configJsonSchema, key);
      const fallback = currentVal ?? defaultVal ?? hint.placeholder ?? "";
      const initialValue =
        typeof fallback === "string" ||
        typeof fallback === "number" ||
        typeof fallback === "boolean"
          ? String(fallback)
          : "";

      if (hint.sensitive) {
        const input = guardCancel(
          await prompter.text({
            message: `${message}${hint.help ? ` (${hint.help})` : ""}`,
            placeholder: hint.placeholder,
            // Don't show current value for sensitive fields if it looks like a secret
            initialValue: initialValue && !initialValue.includes("***") ? "" : initialValue,
          }),
          runtime,
        );
        if (input !== undefined) {
          nextPluginConfig[key] = String(input).trim();
        }
      } else {
        const input = guardCancel(
          await prompter.text({
            message: `${message}${hint.help ? ` (${hint.help})` : ""}`,
            initialValue: initialValue,
            placeholder: hint.placeholder,
          }),
          runtime,
        );
        if (input !== undefined) {
          const val = String(input).trim();
          let finalVal: unknown = val;
          // Simple type conversion for booleans/numbers if they look like it
          if (val.toLowerCase() === "true") {
            finalVal = true;
          } else if (val.toLowerCase() === "false") {
            finalVal = false;
          } else if (/^\d+$/.test(val)) {
            finalVal = Number.parseInt(val, 10);
          }

          setNestedValue(nextPluginConfig, key, finalVal);
        }
      }
    }
    nextEntry.config = nextPluginConfig;
  }

  return {
    ...nextConfig,
    plugins: {
      ...(nextConfig.plugins as Record<string, unknown>),
      entries: {
        ...(nextConfig.plugins as unknown as { entries?: Record<string, unknown> })?.entries,
        [pluginId]: nextEntry,
      },
    },
  };
}

export async function promptPluginsConfig(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const report = buildPluginStatusReport({ config: cfg as unknown as OpenClawConfig });
  const plugins = report.plugins;

  if (plugins.length === 0) {
    await prompter.note("No plugins found.", "Plugins");
    return cfg;
  }

  let nextConfig = { ...cfg };

  while (true) {
    const options = plugins.map((p) => {
      const isEnabled =
        (nextConfig.plugins as unknown as { entries?: Record<string, { enabled?: boolean }> })
          ?.entries?.[p.id]?.enabled ?? p.enabled;
      const status = isEnabled ? "✅ enabled" : "❌ disabled";
      return {
        value: p.id,
        label: p.name || p.id,
        hint: `${status} — ${p.description || ""}`,
      };
    });

    const choice = guardCancel(
      await prompter.select({
        message: "Select a plugin to configure",
        options: [
          ...options,
          { value: "__done__", label: "Done", hint: "Finish plugin configuration" },
        ],
      }),
      runtime,
    );

    if (choice === "__done__" || choice === undefined) {
      break;
    }

    const target = plugins.find((p) => p.id === choice);
    if (target) {
      nextConfig = await promptPluginEntryConfig(target, nextConfig, runtime, prompter);
      await writeConfigFile(nextConfig);
    }
  }

  return nextConfig;
}
