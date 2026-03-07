import { Type } from "@sinclair/typebox";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";

const RequestUserInputToolSchema = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          header: Type.String({ minLength: 1 }),
          id: Type.String({ minLength: 1 }),
          question: Type.String({ minLength: 1 }),
          options: Type.Array(
            Type.Object(
              {
                label: Type.String({ minLength: 1 }),
                description: Type.String(),
              },
              { additionalProperties: false },
            ),
            { minItems: 2, maxItems: 4 },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 3 },
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export function createRequestUserInputTool(opts: {
  runId?: string;
  agentSessionKey?: string;
}): AnyAgentTool {
  return {
    label: "Request User Input",
    name: "request_user_input",
    description:
      "Ask the operator one to three structured multiple-choice questions and wait for their answers. Use only for material planning decisions.",
    parameters: RequestUserInputToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const questions = Array.isArray(params.questions) ? params.questions : [];
      if (questions.length === 0) {
        throw new Error("questions required");
      }
      if (!opts.runId?.trim()) {
        throw new Error("request_user_input unavailable without runId");
      }
      const sessionKey = opts.agentSessionKey?.trim();
      if (!sessionKey) {
        throw new Error("request_user_input unavailable without sessionKey");
      }

      for (const question of questions) {
        const record =
          question && typeof question === "object" ? (question as Record<string, unknown>) : {};
        readStringParam(record, "header", { required: true });
        readStringParam(record, "id", { required: true });
        readStringParam(record, "question", { required: true });
        const options = Array.isArray(record.options) ? record.options : [];
        if (options.length < 2 || options.length > 4) {
          throw new Error("each question must include 2-4 options");
        }
      }

      const result = await callGatewayTool(
        "plan.input.request",
        readGatewayCallOptions(params),
        {
          runId: opts.runId,
          sessionKey,
          questions,
          timeoutMs: readNumberParam(params, "timeoutMs", { integer: true }),
        },
        { expectFinal: true },
      );
      return jsonResult(result);
    },
  };
}
