/**
 * Plugin management gateway RPC handlers.
 *
 * Provides plugin listing, info, enable/disable, and configuration management
 * to the UI and CLI. Uses `buildPluginStatusReport` for discovery and
 * `writeConfigFile` for persisting enable/disable changes.
 */
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { enablePluginInConfig } from "../../plugins/enable.js";
import { setPluginEnabledInConfig } from "../../plugins/toggle-config.js";
import { buildPluginStatusReport } from "../../plugins/status.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

// ── Handlers ─────────────────────────────────────────────────────────────────

export const pluginsHandlers: GatewayRequestHandlers = {
  // ── READ ──────────────────────────────────────────────────────────────────

  /** List all discovered plugins with status, capabilities, and enabled state. */
  "plugins.list": async ({ respond }) => {
    const report = buildPluginStatusReport();
    const plugins = report.plugins.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      kind: p.kind,
      enabled: p.enabled,
      status: p.status,
      capabilities: p.bundleCapabilities ?? [],
      version: p.version,
      source: p.source,
      origin: p.origin,
      format: p.format,
      providerIds: p.providerIds,
      toolNames: p.toolNames,
      error: p.error,
    }));
    respond(true, { plugins, workspaceDir: report.workspaceDir });
  },

  /** Get detailed info for a single plugin by id or name. */
  "plugins.info": async ({ params, respond }) => {
    const id = params.id as string | undefined;
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing required param: id"));
      return;
    }

    const report = buildPluginStatusReport();
    const plugin = report.plugins.find((p) => p.id === id || p.name === id);
    if (!plugin) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `plugin not found: ${id}`),
      );
      return;
    }

    const cfg = loadConfig();
    const install = cfg.plugins?.installs?.[plugin.id];

    respond(true, { plugin, install: install ?? null });
  },

  // ── WRITE ─────────────────────────────────────────────────────────────────

  /** Enable a plugin by id. Persists the change to config. */
  "plugins.enable": async ({ params, respond }) => {
    const id = params.id as string | undefined;
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing required param: id"));
      return;
    }

    try {
      const cfg = loadConfig();
      const result = enablePluginInConfig(cfg, id);
      if (!result.enabled) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `plugin "${id}" could not be enabled: ${result.reason ?? "unknown reason"}`,
          ),
        );
        return;
      }
      await writeConfigFile(result.config);
      respond(true, { id, enabled: true, message: "Restart the gateway to apply." });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to enable plugin: ${(err as Error).message}`),
      );
    }
  },

  /** Disable a plugin by id. Persists the change to config. */
  "plugins.disable": async ({ params, respond }) => {
    const id = params.id as string | undefined;
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing required param: id"));
      return;
    }

    try {
      const cfg = loadConfig();
      const next = setPluginEnabledInConfig(cfg, id, false);
      await writeConfigFile(next);
      respond(true, { id, enabled: false, message: "Restart the gateway to apply." });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `failed to disable plugin: ${(err as Error).message}`,
        ),
      );
    }
  },

  /** Update plugin-specific config fields. Validates against configSchema when present. */
  "plugins.configure": async ({ params, respond }) => {
    const id = params.id as string | undefined;
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing required param: id"));
      return;
    }

    const pluginConfig = params.config as Record<string, unknown> | undefined;
    if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing or invalid param: config (must be an object)"),
      );
      return;
    }

    try {
      const cfg = loadConfig();

      // Validate keys against configSchema if the plugin manifests one.
      const { loadPluginManifestRegistry } = await import("../../plugins/manifest-registry.js");
      const registry = loadPluginManifestRegistry();
      const manifest = registry.plugins.find((p) => p.id === id);
      if (manifest?.configSchema) {
        const schema = manifest.configSchema as Record<string, unknown>;
        const properties = schema.properties as Record<string, unknown> | undefined;
        if (properties) {
          const unknownKeys = Object.keys(pluginConfig).filter((k) => !(k in properties));
          if (unknownKeys.length > 0) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `unknown config keys for plugin "${id}": ${unknownKeys.join(", ")}`,
              ),
            );
            return;
          }
        }
      }

      const next = {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            [id]: {
              ...(cfg.plugins?.entries?.[id] as object | undefined),
              config: {
                ...((cfg.plugins?.entries?.[id] as Record<string, unknown> | undefined)?.config as
                  | object
                  | undefined),
                ...pluginConfig,
              },
            },
          },
        },
      };
      await writeConfigFile(next);
      respond(true, { id, config: pluginConfig, message: "Restart the gateway to apply." });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `failed to configure plugin: ${(err as Error).message}`,
        ),
      );
    }
  },
};
