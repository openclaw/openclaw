import { Type } from "@sinclair/typebox";
import { callGateway } from "../../gateway/call.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsRecallToolSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  maxTokens: Type.Optional(Type.Number({ minimum: 256, maximum: 4000 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
  scope: Type.Optional(Type.String({ enum: ["recent", "all"] })),
});

type SessionsRecallResult = {
  summary?: string;
  citations?: Array<{
    sessionKey: string;
    sessionId: string;
    lineRange: [number, number];
    source: string;
    evidenceId?: string;
  }>;
  cached?: boolean;
};

export function createSessionsRecallTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session Recall",
    name: "sessions_recall",
    description:
      "Summarize relevant prior session context with citations for cross-session recall questions.",
    parameters: SessionsRecallToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const maxTokens =
        typeof params.maxTokens === "number" && Number.isFinite(params.maxTokens)
          ? Math.min(4000, Math.max(256, Math.floor(params.maxTokens)))
          : undefined;
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.min(20, Math.max(1, Math.floor(params.limit)))
          : undefined;
      const scope = params.scope === "recent" || params.scope === "all" ? params.scope : undefined;
      const result = await callGateway<SessionsRecallResult>({
        method: "sessions.recall",
        params: {
          query,
          maxTokens,
          limit,
          scope,
          requesterSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed === true,
        },
      });

      return jsonResult({
        summary:
          typeof result?.summary === "string" && result.summary.trim()
            ? result.summary
            : "No relevant prior sessions found.",
        citations: Array.isArray(result?.citations) ? result.citations : [],
        cached: result?.cached === true,
      });
    },
  };
}
