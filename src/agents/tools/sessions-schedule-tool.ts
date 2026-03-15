import { Type } from "@sinclair/typebox";
import {
  WORK_GRAPH_DEPENDENCY_TYPES,
  type WorkGraphDependencyType,
} from "../../operator-control/work-graph.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { scheduleSessionsGraph } from "../sessions-schedule.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { SUBAGENT_SPAWN_MODES } from "../subagent-spawn.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const SESSIONS_SCHEDULE_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SCHEDULE_SANDBOX_MODES = ["inherit", "require"] as const;
const SESSIONS_SCHEDULE_STREAM_TARGETS = ["parent"] as const;

const SessionsScheduleNodeSchema = Type.Object({
  id: Type.String(),
  task: Type.String(),
  label: Type.Optional(Type.String()),
  runtime: Type.Optional(optionalStringEnum(SESSIONS_SCHEDULE_RUNTIMES)),
  agentId: Type.Optional(Type.String()),
  teamId: Type.Optional(Type.String()),
  capability: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: Type.Optional(optionalStringEnum(SUBAGENT_SPAWN_MODES)),
  cleanup: Type.Optional(optionalStringEnum(["delete", "keep"] as const)),
  sandbox: Type.Optional(optionalStringEnum(SESSIONS_SCHEDULE_SANDBOX_MODES)),
  streamTo: Type.Optional(optionalStringEnum(SESSIONS_SCHEDULE_STREAM_TARGETS)),
});

const SessionsScheduleDependencySchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
  type: Type.Unsafe<WorkGraphDependencyType>({
    type: "string",
    enum: [...WORK_GRAPH_DEPENDENCY_TYPES],
  }),
});

const SessionsScheduleToolSchema = Type.Object({
  nodes: Type.Array(SessionsScheduleNodeSchema, { minItems: 1, maxItems: 64 }),
  dependencies: Type.Optional(Type.Array(SessionsScheduleDependencySchema, { maxItems: 256 })),
  maxParallel: Type.Optional(Type.Number({ minimum: 1 })),
});

function validateNodeSelectors(nodes: Array<Record<string, unknown>>): void {
  for (const node of nodes) {
    const id = typeof node.id === "string" ? node.id : "(unknown)";
    const agentId = typeof node.agentId === "string" && node.agentId.trim();
    const teamId = typeof node.teamId === "string" && node.teamId.trim();
    const capability = typeof node.capability === "string" && node.capability.trim();
    const role = typeof node.role === "string" && node.role.trim();

    if (agentId && (teamId || capability || role)) {
      throw new ToolInputError(
        `sessions_schedule node ${id}: agentId cannot be combined with teamId/capability/role`,
      );
    }
    if ((capability || role) && !teamId) {
      throw new ToolInputError(`sessions_schedule node ${id}: capability/role requires teamId`);
    }
    if (!agentId && !teamId) {
      throw new ToolInputError(
        `sessions_schedule node ${id}: provide either agentId or teamId + capability/role`,
      );
    }
  }
}

function normalizeScheduleNodeMode(value: unknown): "run" | "session" | undefined {
  return value === "run" || value === "session" ? value : undefined;
}

export function createSessionsScheduleTool(
  opts?: {
    agentSessionKey?: string;
    agentChannel?: string;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    requesterAgentIdOverride?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  return {
    label: "Schedule",
    name: "sessions_schedule",
    description:
      "Submit a dependency graph of subagent/ACP work. Ready nodes start immediately, and dependent nodes start automatically when prerequisites settle.",
    parameters: SessionsScheduleToolSchema,
    execute: async (_toolCallId, args) => {
      try {
        const params = args as Record<string, unknown>;
        const nodes = Array.isArray(params.nodes)
          ? (params.nodes as Array<Record<string, unknown>>)
          : [];
        const dependencies = Array.isArray(params.dependencies)
          ? (params.dependencies as Array<{
              from: string;
              to: string;
              type: WorkGraphDependencyType;
            }>)
          : undefined;
        validateNodeSelectors(nodes);

        const result = await scheduleSessionsGraph({
          nodes: nodes.map((node) => ({
            id: String(node.id),
            task: String(node.task),
            label: typeof node.label === "string" ? node.label : undefined,
            runtime: node.runtime === "acp" ? "acp" : "subagent",
            agentId: typeof node.agentId === "string" ? node.agentId : undefined,
            teamId: typeof node.teamId === "string" ? node.teamId : undefined,
            capability: typeof node.capability === "string" ? node.capability : undefined,
            role: typeof node.role === "string" ? node.role : undefined,
            model: typeof node.model === "string" ? node.model : undefined,
            thinking: typeof node.thinking === "string" ? node.thinking : undefined,
            cwd: typeof node.cwd === "string" ? node.cwd : undefined,
            runTimeoutSeconds:
              typeof node.runTimeoutSeconds === "number" ? node.runTimeoutSeconds : undefined,
            timeoutSeconds:
              typeof node.timeoutSeconds === "number" ? node.timeoutSeconds : undefined,
            thread: node.thread === true,
            mode: normalizeScheduleNodeMode(node.mode),
            cleanup:
              node.cleanup === "delete" || node.cleanup === "keep" ? node.cleanup : undefined,
            sandbox: node.sandbox === "require" ? "require" : "inherit",
            streamTo: node.streamTo === "parent" ? "parent" : undefined,
          })),
          dependencies,
          maxParallel:
            typeof params.maxParallel === "number" && Number.isFinite(params.maxParallel)
              ? Math.max(1, Math.floor(params.maxParallel))
              : undefined,
          context: {
            agentSessionKey: opts?.agentSessionKey,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            agentGroupId: opts?.agentGroupId,
            agentGroupChannel: opts?.agentGroupChannel,
            agentGroupSpace: opts?.agentGroupSpace,
            requesterAgentIdOverride: opts?.requesterAgentIdOverride,
            workspaceDir: opts?.workspaceDir,
            sandboxed: opts?.sandboxed,
          },
        });

        return jsonResult(result);
      } catch (error) {
        if (error instanceof ToolInputError) {
          return jsonResult({
            status: "error",
            error: error.message,
          });
        }
        throw error;
      }
    },
  };
}
