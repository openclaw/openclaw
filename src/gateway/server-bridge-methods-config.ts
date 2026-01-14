import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  CONFIG_PATH_CLAWDBOT,
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  validateConfigObject,
  writeConfigFile,
} from "../config/config.js";
import { buildConfigSchema } from "../config/schema.js";
import { loadClawdbotPlugins } from "../plugins/loader.js";
import {
  ErrorCodes,
  formatValidationErrors,
  validateConfigGetParams,
  validateConfigSchemaParams,
  validateConfigSetParams,
} from "./protocol/index.js";
import type { BridgeMethodHandler } from "./server-bridge-types.js";

export const handleConfigBridgeMethods: BridgeMethodHandler = async (
  _ctx,
  _nodeId,
  method,
  params,
) => {
  switch (method) {
    case "config.get": {
      if (!validateConfigGetParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid config.get params: ${formatValidationErrors(validateConfigGetParams.errors)}`,
          },
        };
      }
      const snapshot = await readConfigFileSnapshot();
      return { ok: true, payloadJSON: JSON.stringify(snapshot) };
    }
    case "config.schema": {
      if (!validateConfigSchemaParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid config.schema params: ${formatValidationErrors(validateConfigSchemaParams.errors)}`,
          },
        };
      }
      const cfg = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(
        cfg,
        resolveDefaultAgentId(cfg),
      );
      const pluginRegistry = loadClawdbotPlugins({
        config: cfg,
        workspaceDir,
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      });
      const schema = buildConfigSchema({
        plugins: pluginRegistry.plugins.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          configUiHints: plugin.configUiHints,
        })),
      });
      return { ok: true, payloadJSON: JSON.stringify(schema) };
    }
    case "config.set": {
      if (!validateConfigSetParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid config.set params: ${formatValidationErrors(validateConfigSetParams.errors)}`,
          },
        };
      }
      const rawValue = (params as { raw?: unknown }).raw;
      if (typeof rawValue !== "string") {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "invalid config.set params: raw (string) required",
          },
        };
      }
      const parsedRes = parseConfigJson5(rawValue);
      if (!parsedRes.ok) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: parsedRes.error,
          },
        };
      }
      const validated = validateConfigObject(parsedRes.parsed);
      if (!validated.ok) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "invalid config",
            details: { issues: validated.issues },
          },
        };
      }
      await writeConfigFile(validated.config);
      return {
        ok: true,
        payloadJSON: JSON.stringify({
          ok: true,
          path: CONFIG_PATH_CLAWDBOT,
          config: validated.config,
        }),
      };
    }
    default:
      return null;
  }
};
