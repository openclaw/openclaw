import {
  CONFIG_PATH_CLAWDIS,
  parseConfigJson5,
  readConfigFileSnapshot,
  validateConfigObject,
  writeConfigFile,
} from "../../config/config.js";
import { buildConfigSchema } from "../../config/schema.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateConfigGetParams,
  validateConfigSchemaParams,
  validateConfigSetParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const configHandlers: GatewayRequestHandlers = {
  "config.get": async ({ params, respond }) => {
    if (!validateConfigGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid config.get params: ${formatValidationErrors(validateConfigGetParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    respond(true, snapshot, undefined);
  },
  "config.schema": ({ params, respond }) => {
    if (!validateConfigSchemaParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid config.schema params: ${formatValidationErrors(validateConfigSchemaParams.errors)}`,
        ),
      );
      return;
    }
    const schema = buildConfigSchema();
    respond(true, schema, undefined);
  },
  "config.set": async ({ params, respond }) => {
    if (!validateConfigSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid config.set params: ${formatValidationErrors(validateConfigSetParams.errors)}`,
        ),
      );
      return;
    }
    const rawValue = (params as { raw?: unknown }).raw;
    if (typeof rawValue !== "string") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid config.set params: raw (string) required",
        ),
      );
      return;
    }
    const parsedRes = parseConfigJson5(rawValue);
    if (!parsedRes.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error),
      );
      return;
    }
    const validated = validateConfigObject(parsedRes.parsed);
    if (!validated.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config", {
          details: { issues: validated.issues },
        }),
      );
      return;
    }
    await writeConfigFile(validated.config);
    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH_CLAWDIS,
        config: validated.config,
      },
      undefined,
    );
  },
};
