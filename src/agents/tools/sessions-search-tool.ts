import { Type } from "@sinclair/typebox";
import { callGateway } from "../../gateway/call.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam } from "./common.js";

const SessionsSearchToolSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
  activeMinutes: Type.Optional(Type.Number({ minimum: 1 })),
  kinds: Type.Optional(Type.Array(Type.String())),
});

export function createSessionsSearchTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session Search",
    name: "sessions_search",
    description: "Search across session transcripts using memory FTS.",
    parameters: SessionsSearchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.min(50, Math.max(1, Math.floor(params.limit)))
          : undefined;
      const activeMinutes =
        typeof params.activeMinutes === "number" && Number.isFinite(params.activeMinutes)
          ? Math.max(1, Math.floor(params.activeMinutes))
          : undefined;
      const kindsRaw = readStringArrayParam(params, "kinds");
      const kinds = kindsRaw
        ?.map((value) => value.trim().toLowerCase())
        .filter((value) => ["main", "group", "cron", "hook", "node", "other"].includes(value));

      const hasKinds = Boolean(kinds && kinds.length > 0);
      const result = await callGateway<{
        count: number;
        results: Array<{
          sessionKey: string;
          sessionId: string;
          snippet: string;
          score: number;
          startLine: number;
          endLine: number;
        }>;
      }>({
        method: "sessions.search",
        params: {
          query,
          limit,
          activeMinutes,
          kinds: hasKinds ? kinds : undefined,
          ...(hasKinds ? { kindScope: "session" as const } : {}),
          requesterSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed === true,
        },
      });

      return jsonResult({
        count: typeof result?.count === "number" ? result.count : 0,
        results: Array.isArray(result?.results) ? result.results : [],
      });
    },
  };
}
