import { Type } from "typebox";
import { SECRET_NAME_RE, type SecretCategory } from "../../secrets/platform-runtime.js";
import { stringEnum } from "../schema/string-enum.js";
import {
  asToolParamsRecord,
  jsonResult,
  readStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";
import { isOpenClawOwnerOnlyCoreToolName } from "./owner-only-tools.js";

const SAVE_SECRET_CATEGORIES = ["ssh_key", "api_key", "token", "env_var"] as const;
const FORBIDDEN_VALUE_KEYS = new Set(["value", "secret", "secretPayload", "secret_payload"]);

const SaveSecretToolSchema = Type.Object(
  {
    name: Type.String({
      description: "Uppercase secret name, such as OPENAI_API_KEY or DEPLOY_KEY.",
      pattern: "^[A-Z][A-Z0-9_]*$",
    }),
    category: stringEnum(SAVE_SECRET_CATEGORIES),
    description: Type.Optional(
      Type.String({
        description: "Optional non-secret description for the saved secret.",
        maxLength: 500,
      }),
    ),
  },
  { additionalProperties: false },
);

function readSecretCategory(value: string): SecretCategory {
  if (!SAVE_SECRET_CATEGORIES.includes(value as SecretCategory)) {
    throw new ToolInputError("category must be one of ssh_key, api_key, token, env_var.");
  }
  return value as SecretCategory;
}

function assertNoInlineSecretValue(params: Record<string, unknown>): void {
  for (const key of FORBIDDEN_VALUE_KEYS) {
    if (Object.hasOwn(params, key)) {
      throw new ToolInputError(
        "save_secret never accepts a secret value in tool input. Submit the value only via the secret_payload control frame.",
      );
    }
  }
}

export function createSaveSecretTool(): AnyAgentTool {
  return {
    label: "Save Secret",
    name: "save_secret",
    ownerOnly: isOpenClawOwnerOnlyCoreToolName("save_secret"),
    displaySummary: "Request a user-provided secret save without receiving the value.",
    description:
      "Request that the user save or rotate a secret. Provide only name, category, and optional description. Never include the secret value; the UI will collect it through a secret_payload control frame bound to this tool call.",
    parameters: SaveSecretToolSchema,
    execute: async (toolCallId, args) => {
      const params = asToolParamsRecord(args);
      assertNoInlineSecretValue(params);
      const name = readStringParam(params, "name", { required: true });
      if (!SECRET_NAME_RE.test(name)) {
        throw new ToolInputError("name must match ^[A-Z][A-Z0-9_]*$.");
      }
      const category = readSecretCategory(
        readStringParam(params, "category", { required: true }) as string,
      );
      const description = readStringParam(params, "description");
      return jsonResult({
        status: "awaiting_secret_payload",
        tool_use_id: toolCallId,
        secret: {
          name,
          category,
          ...(description ? { description } : {}),
        },
      });
    },
  };
}
