import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import {
  validateUsersPersonalFileGetParams,
  validateUsersPersonalFileSetParams,
  type UsersPersonalFileGetResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { assertAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { bindAgentToolGatewayRequest } from "./in-process-gateway.js";

const PersonalInstructionsSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
    agentId: Type.Optional(Type.String({ minLength: 1 })),
    content: Type.Optional(Type.String({ maxLength: 4_000 })),
    expectedHash: Type.Optional(
      Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);

export function createPersonalInstructionsTool(agentId: string): AnyAgentTool {
  return {
    name: "personal_instructions",
    label: "Personal Instructions",
    description:
      "On a multi-user Gateway, read or update the authenticated requesting user’s personal USER.md from any Gateway chat session, including project worktrees. Defaults to this agent’s configured workspace; agentId selects another permitted agent. Use get first, preserve unrelated preferences, then set the complete content with expectedHash set to the returned hash (null only when missing). Limit 4,000 characters. Only update when the user asks. Never use the session owner’s identity or shared USER.md. Requires a live authenticated user turn; does not grant general filesystem access.",
    parameters: PersonalInstructionsSchema,
    execute: async (_id, input, signal) => {
      const inputParams = asOptionalObjectRecord(input);
      if (!inputParams) {
        throw new ToolInputError("Personal instructions require an object parameter.");
      }
      const { action, agentId: selectedAgent, content, expectedHash } = inputParams;
      const targetAgent = selectedAgent ?? agentId;
      const params =
        action === "get"
          ? { agentId: targetAgent }
          : { agentId: targetAgent, content, expectedHash };
      if (
        (action !== "get" && action !== "set") ||
        !(action === "get"
          ? validateUsersPersonalFileGetParams(params)
          : validateUsersPersonalFileSetParams(params))
      ) {
        throw new ToolInputError("Use get, or set with content and the hash returned by get.");
      }
      // Keep the canonical file owner on the admitted Gateway, independent of the
      // task workspace/sandbox. Never fall back to shell access or another Gateway.
      const authority = getGatewayToolCallerIdentity()?.operatorAuthority;
      const assertCurrent = captureGatewayToolCallerAssertion();
      if (!authority || !assertCurrent) {
        throw new Error("Personal instructions require a live authenticated Gateway user turn.");
      }
      assertAdmittedRunOperatorAuthority(authority);
      assertCurrent();
      const request = bindAgentToolGatewayRequest({ hostedOnly: true });
      return jsonResult(
        await request<UsersPersonalFileGetResult>({
          method: `users.personalFile.${action}`,
          params,
          signal,
        }),
      );
    },
  };
}
