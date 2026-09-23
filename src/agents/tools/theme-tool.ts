import { Type } from "typebox";
import {
  ThemeDefinitionSchema,
  type ThemesGetResult,
  type ThemesListResult,
  type ThemesMutationResult,
} from "../../../packages/gateway-protocol/src/schema/themes.js";
import { normalizeThemeDefinition } from "../../../packages/gateway-protocol/src/theme.js";
import type { AnyAgentTool } from "./common.js";
import { asToolParamsRecord, jsonResult, readToolStringParam, ToolInputError } from "./common.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";

const ThemeToolSchema = Type.Object(
  {
    action: Type.String({ enum: ["list", "get", "set", "import"] }),
    id: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
        description: "Theme ID; import uses a personal slug. Set null to clear the override.",
      }),
    ),
    mode: Type.Optional(
      Type.Union([Type.String({ enum: ["system", "light", "dark"] }), Type.Null()], {
        description: "Set/import appearance mode. Set null to clear the override.",
      }),
    ),
    definition: Type.Optional(ThemeDefinitionSchema),
    apply: Type.Optional(Type.Boolean({ description: "Import and activate in one call" })),
  },
  { additionalProperties: false },
);

function themeParams(action: string, params: Record<string, unknown>): Record<string, unknown> {
  if (action === "list") {
    return {};
  }
  if (action === "get") {
    const id = readToolStringParam(params, "id");
    return id ? { id } : {};
  }
  if (action !== "set" && action !== "import") {
    throw new ToolInputError(`Unknown theme action: ${action}`);
  }
  const mode = params.mode === null ? null : readToolStringParam(params, "mode");
  if (mode !== undefined && mode !== null && !["system", "light", "dark"].includes(mode)) {
    throw new ToolInputError("mode must be system, light, or dark");
  }
  if (action === "set") {
    const id = params.id === null ? null : readToolStringParam(params, "id");
    if (id === undefined && mode === undefined) {
      throw new ToolInputError("set requires id or mode");
    }
    return {
      ...(id !== undefined ? { id } : {}),
      ...(mode !== undefined ? { mode } : {}),
    };
  }
  if (mode === null) {
    throw new ToolInputError("import mode must be system, light, or dark");
  }
  if (params.apply !== undefined && typeof params.apply !== "boolean") {
    throw new ToolInputError("apply must be a boolean");
  }
  const id = readToolStringParam(params, "id", { required: true });
  let definition;
  try {
    definition = normalizeThemeDefinition(params.definition);
  } catch (error) {
    throw new ToolInputError(error instanceof Error ? error.message : "Invalid theme definition");
  }
  return {
    id,
    definition,
    ...(params.apply !== undefined ? { apply: params.apply } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

export function createThemeTool(): AnyAgentTool {
  return {
    label: "Theme",
    name: "theme",
    description:
      "Read and change the requesting user's OpenClaw appearance. list includes available built-in, plugin, and personal themes with descriptions and current selection. get inspects the current theme or an id, including its editable definition when available. set selects an id and/or mode; null clears that profile override. import saves a custom definition under user/<id>; apply:true also activates it in the same call. Each supplied light/dark palette requires all listed colors; use hex colors and optional font-sans/font-mono. Plugin themes follow plugin hot reload without a Gateway restart. Set/import return the saved result, so no extra get is needed. Requires a trusted requesting profile for personal changes; no connected browser is required. Saved does not confirm browser rendering.",
    parameters: ThemeToolSchema,
    execute: async (_toolCallId, rawArgs, signal) => {
      const params = asToolParamsRecord(rawArgs);
      const action = readToolStringParam(params, "action", { required: true });
      const request = {
        method: `themes.${action}`,
        params: themeParams(action, params),
        signal,
      };
      if (action === "list") {
        const { themes, current } = await callAgentToolGatewayRequest<ThemesListResult>(request);
        return jsonResult({ themes, current });
      }
      if (action === "get") {
        return jsonResult(await callAgentToolGatewayRequest<ThemesGetResult>(request));
      }
      const { current, theme, application } =
        await callAgentToolGatewayRequest<ThemesMutationResult>(request);
      return jsonResult({ current, theme, application });
    },
  };
}
