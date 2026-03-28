import { Type } from "@sinclair/typebox";
import { runSessionsArchive } from "../../commands/sessions-archive-core.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsArchiveToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  allAgents: Type.Optional(Type.Boolean()),
  status: Type.Optional(
    Type.Union([Type.Literal("done"), Type.Literal("killed"), Type.Literal("timeout")]),
  ),
  olderThan: Type.Optional(Type.String({ minLength: 1 })),
  dryRun: Type.Optional(Type.Boolean()),
});

export function createSessionsArchiveTool(): AnyAgentTool {
  return {
    label: "Session Archive",
    name: "sessions_archive",
    description:
      "Archive one session or batch-archive completed sessions by agent/status/age. Never archives active, main, or cron sessions.",
    parameters: SessionsArchiveToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = readStringParam(params, "sessionKey");
      const agent = readStringParam(params, "agent");
      const agentId = readStringParam(params, "agentId");
      if (agent && agentId && agent !== agentId) {
        return jsonResult({
          ok: false,
          error: "Provide either agent or agentId (not conflicting values for both).",
        });
      }

      const statusRaw = readStringParam(params, "status")?.toLowerCase();
      const status =
        statusRaw && ["done", "killed", "timeout"].includes(statusRaw)
          ? (statusRaw as "done" | "killed" | "timeout")
          : undefined;
      if (statusRaw && !status) {
        return jsonResult({
          ok: false,
          error: "status must be one of: done, killed, timeout",
        });
      }

      try {
        const result = await runSessionsArchive({
          sessionKey,
          agent: agent ?? agentId,
          allAgents: params.allAgents === true,
          status,
          olderThan: readStringParam(params, "olderThan"),
          dryRun: params.dryRun === true,
        });
        if (result.stores.length === 1) {
          return jsonResult(result.stores[0]?.summary ?? {});
        }
        return jsonResult({
          allAgents: result.allAgents,
          dryRun: params.dryRun === true,
          requestedKey: result.requestedKey,
          status: result.status,
          olderThan: result.olderThan,
          stores: result.stores.map((store) => store.summary),
        });
      } catch (error) {
        return jsonResult({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
