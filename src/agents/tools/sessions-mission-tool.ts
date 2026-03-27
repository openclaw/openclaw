import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { createMission, DEFAULT_MAX_LOOPS } from "../subagent-mission.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { PSQL_PATH } from "./psql-path.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

const SessionsMissionToolSchema = Type.Object({
  label: Type.String(),
  subtasks: Type.Array(
    Type.Object({
      id: Type.String(),
      agentId: Type.String(),
      task: Type.String(),
      after: Type.Optional(Type.Array(Type.String())),
      maxLoops: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: `Loop iterations: 0 = unlimited (runs until status=done JSON or LOOP_DONE), >0 = cap at N. Omit for default of ${DEFAULT_MAX_LOOPS} iterations.`,
        }),
      ),
      subcommandHint: Type.Optional(Type.String()),
      compensationAction: Type.Optional(
        Type.String({
          description: "Saga rollback: how to undo this subtask if a later step fails.",
        }),
      ),
    }),
    { minItems: 1 },
  ),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  maxTotalSpawns: Type.Optional(Type.Number({ minimum: 1 })),
});

/** Simplified schema for proxy tools — no `after` field, no optional params. */
const ProxyMissionSchema = Type.Object({
  label: Type.String(),
  subtasks: Type.Array(
    Type.Object({
      id: Type.String(),
      agentId: Type.String(),
      task: Type.String(),
      subcommandHint: Type.Optional(Type.String()),
      compensationAction: Type.Optional(
        Type.String({
          description: "Saga rollback: how to undo this subtask if a later step fails.",
        }),
      ),
    }),
    { minItems: 1 },
  ),
  maxLoops: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: `Loop iterations for ALL subtasks: 0 = unlimited (runs until status=done JSON or LOOP_DONE), >0 = cap at N. Omit for default of ${DEFAULT_MAX_LOOPS} iterations.`,
    }),
  ),
  qualityGateRequired: Type.Optional(
    Type.Boolean({
      description:
        "When true, the mission announce injects delegation quality gate (D1-D6) instructions, findings classification, and autonomous follow-up protocol instead of generic synthesis instructions. Used by /delegate.",
    }),
  ),
  chainDepth: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 10,
      description:
        "Follow-up chain depth: 0 = original mission, 1+ = follow-up from a previous mission's Gate 6. Used to enforce maxChainDepth limit.",
    }),
  ),
  parentMissionId: Type.Optional(
    Type.String({
      description: "Links this follow-up mission back to the originating mission.",
    }),
  ),
});

interface MissionToolOpts {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  requesterAgentIdOverride?: string;
}

/**
 * Shared validation logic for all mission tools.
 * Resolves session keys, validates agent allowlist, and parses subtask entries.
 * Returns validated subtask array + requester context, or a JSON error result.
 */
function validateMissionSubtasks(
  rawSubtasks: unknown[],
  opts?: MissionToolOpts,
):
  | {
      ok: true;
      subtaskInputs: Array<{
        id: string;
        agentId: string;
        task: string;
        after?: string[];
        maxLoops?: number;
      }>;
      requesterInternalKey: string;
      requesterDisplayKey: string;
      requesterOrigin: ReturnType<typeof normalizeDeliveryContext>;
    }
  | { ok: false; error: ReturnType<typeof jsonResult> } {
  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterSessionKey = opts?.agentSessionKey;
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({ key: requesterSessionKey, alias, mainKey })
    : alias;
  const requesterDisplayKey = resolveDisplaySessionKey({
    key: requesterInternalKey,
    alias,
    mainKey,
  });
  const requesterAgentId = normalizeAgentId(
    opts?.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );

  const requesterConfig = resolveAgentConfig(cfg, requesterAgentId);
  const allowAgents = requesterConfig?.subagents?.allowAgents ?? [];
  const allowAny = allowAgents.some((v) => v.trim() === "*");
  const allowSet = new Set(
    allowAgents
      .filter((v) => v.trim() && v.trim() !== "*")
      .map((v) => normalizeAgentId(v).toLowerCase()),
  );

  const subtaskInputs: Array<{
    id: string;
    agentId: string;
    task: string;
    after?: string[];
    maxLoops?: number;
    subcommandHint?: string;
    compensationAction?: string;
  }> = [];

  for (const raw of rawSubtasks) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: jsonResult({ status: "error", error: "Invalid subtask entry" }) };
    }
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const agentId = typeof entry.agentId === "string" ? entry.agentId.trim() : "";
    const task = typeof entry.task === "string" ? entry.task.trim() : "";
    const after = Array.isArray(entry.after)
      ? entry.after
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean)
      : undefined;
    const maxLoops =
      typeof entry.maxLoops === "number" && Number.isFinite(entry.maxLoops) && entry.maxLoops >= 0
        ? Math.floor(entry.maxLoops)
        : DEFAULT_MAX_LOOPS; // Default: cap at DEFAULT_MAX_LOOPS iterations
    const subcommandHint =
      typeof entry.subcommandHint === "string"
        ? entry.subcommandHint.trim() || undefined
        : undefined;
    const compensationAction =
      typeof entry.compensationAction === "string"
        ? entry.compensationAction.trim() || undefined
        : undefined;

    if (!id || !agentId || !task) {
      return {
        ok: false,
        error: jsonResult({
          status: "error",
          error: "Subtask missing required fields (id, agentId, task)",
        }),
      };
    }

    const normalizedTarget = normalizeAgentId(agentId);
    if (
      normalizedTarget !== requesterAgentId &&
      !allowAny &&
      !allowSet.has(normalizedTarget.toLowerCase())
    ) {
      const allowedText = allowAny
        ? "*"
        : allowSet.size > 0
          ? Array.from(allowSet).join(", ")
          : "none";
      return {
        ok: false,
        error: jsonResult({
          status: "forbidden",
          error: `agentId "${agentId}" is not allowed (allowed: ${allowedText})`,
        }),
      };
    }

    subtaskInputs.push({
      id,
      agentId: normalizedTarget,
      task,
      after: after && after.length > 0 ? after : undefined,
      maxLoops,
      subcommandHint,
      compensationAction,
    });
  }

  const requesterOrigin = normalizeDeliveryContext({
    channel: opts?.agentChannel,
    accountId: opts?.agentAccountId,
    to: opts?.agentTo,
    threadId: opts?.agentThreadId,
  });

  return { ok: true, subtaskInputs, requesterInternalKey, requesterDisplayKey, requesterOrigin };
}

/**
 * Fire-and-forget OMS backlog INSERT for each subtask in a mission.
 * Runs psql asynchronously — never blocks the mission tool response.
 * Failures are silently ignored (OMS logging is best-effort).
 */
function logMissionToOms(
  label: string,
  subtasks: Array<{ id: string; agentId: string; task: string }>,
  mode: "sequential" | "parallel",
  missionId: string,
): void {
  for (const subtask of subtasks) {
    const title = escapeSql(`[${label}] ${subtask.task}`.slice(0, 200));
    const description = escapeSql(
      `Auto-logged from ${mode} mission ${missionId}. Subtask: ${subtask.id}. Task: ${subtask.task}`,
    );
    const agent = escapeSql(subtask.agentId);
    const sql =
      `INSERT INTO oms.backlog (backlog_code, title, agent_assigned, priority, status, description) ` +
      `VALUES ('M-' || nextval('oms.mission_backlog_seq'), ` +
      `'${title}', '${agent}', 'medium', 'in_progress', '${description}');\n`;
    const proc = spawn(PSQL_PATH, ["-d", "brain"], { stdio: ["pipe", "ignore", "ignore"] });
    proc.stdin?.write(sql);
    proc.stdin?.end();
  }
}

function escapeSql(s: string): string {
  return s.replace(/'/g, "''");
}

export function createSessionsMissionTool(opts?: MissionToolOpts): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_mission",
    description:
      "Orchestrate a multi-agent mission with dependency ordering. Subtasks run in parallel when possible, with results from completed subtasks injected into dependent ones. Returns a single synthesized announcement when the entire mission completes.",
    parameters: SessionsMissionToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const label = readStringParam(params, "label", { required: true });
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const maxTotalSpawns =
        typeof params.maxTotalSpawns === "number" &&
        Number.isFinite(params.maxTotalSpawns) &&
        params.maxTotalSpawns >= 1
          ? Math.floor(params.maxTotalSpawns)
          : undefined;

      const rawSubtasks = params.subtasks;
      if (!Array.isArray(rawSubtasks) || rawSubtasks.length === 0) {
        return jsonResult({ status: "error", error: "subtasks required" });
      }

      const validated = validateMissionSubtasks(rawSubtasks, opts);
      if (!validated.ok) {
        return validated.error;
      }

      const { subtaskInputs, requesterInternalKey, requesterDisplayKey, requesterOrigin } =
        validated;

      // Fail-safe: if multiple subtasks and ZERO after fields, auto-chain sequentially
      if (subtaskInputs.length > 1 && !subtaskInputs.some((t) => t.after && t.after.length > 0)) {
        for (let i = 1; i < subtaskInputs.length; i++) {
          subtaskInputs[i].after = [subtaskInputs[i - 1].id];
        }
      }

      const result = createMission({
        label,
        subtasks: subtaskInputs,
        requesterSessionKey: requesterInternalKey,
        requesterOrigin,
        requesterDisplayKey,
        cleanup,
        maxTotalSpawns,
      });

      if ("error" in result) {
        return jsonResult({ status: "error", error: result.error });
      }

      return jsonResult({
        status: "accepted",
        missionId: result.missionId,
        subtaskCount: subtaskInputs.length,
        label,
      });
    },
  };
}

/**
 * Proxy tool: sequential mission.
 * Auto-chains subtasks so each waits for the previous one.
 * Uses simplified schema (no `after` field) to reduce LLM cognitive load.
 */
export function createSpawnSequentialMissionTool(opts?: MissionToolOpts): AnyAgentTool {
  return {
    label: "Sessions",
    name: "spawn_sequential_mission",
    description:
      "Run agents in order where each step needs data from the previous step. Results from earlier steps are automatically passed to later steps.",
    parameters: ProxyMissionSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const label = readStringParam(params, "label", { required: true });
      const topLevelMaxLoops =
        typeof params.maxLoops === "number" &&
        Number.isFinite(params.maxLoops) &&
        params.maxLoops >= 0
          ? Math.floor(params.maxLoops)
          : DEFAULT_MAX_LOOPS; // Default: cap at DEFAULT_MAX_LOOPS iterations

      const rawSubtasks = params.subtasks;
      if (!Array.isArray(rawSubtasks) || rawSubtasks.length === 0) {
        return jsonResult({ status: "error", error: "subtasks required" });
      }

      // Apply top-level maxLoops to each subtask that doesn't already have one
      for (const raw of rawSubtasks) {
        if (raw && typeof raw === "object" && !("maxLoops" in raw)) {
          (raw as Record<string, unknown>).maxLoops = topLevelMaxLoops;
        }
      }

      const validated = validateMissionSubtasks(rawSubtasks, opts);
      if (!validated.ok) {
        return validated.error;
      }

      const { subtaskInputs, requesterInternalKey, requesterDisplayKey, requesterOrigin } =
        validated;

      // Auto-chain: each subtask depends on the previous one
      for (let i = 1; i < subtaskInputs.length; i++) {
        subtaskInputs[i].after = [subtaskInputs[i - 1].id];
      }

      const qualityGateRequired = params.qualityGateRequired === true;
      const chainDepth =
        typeof params.chainDepth === "number" &&
        Number.isFinite(params.chainDepth) &&
        params.chainDepth >= 0
          ? Math.floor(params.chainDepth)
          : undefined;
      const parentMissionId =
        typeof params.parentMissionId === "string"
          ? params.parentMissionId.trim() || undefined
          : undefined;

      const result = createMission({
        label,
        subtasks: subtaskInputs,
        requesterSessionKey: requesterInternalKey,
        requesterOrigin,
        requesterDisplayKey,
        cleanup: "keep",
        qualityGateRequired,
        chainDepth,
        parentMissionId,
      });

      if ("error" in result) {
        return jsonResult({ status: "error", error: result.error });
      }

      logMissionToOms(label, subtaskInputs, "sequential", result.missionId);

      return jsonResult({
        status: "accepted",
        missionId: result.missionId,
        subtaskCount: subtaskInputs.length,
        label,
        mode: "sequential",
      });
    },
  };
}

/**
 * Proxy tool: parallel mission.
 * All subtasks run simultaneously with no dependencies.
 * Uses simplified schema (no `after` field) to reduce LLM cognitive load.
 */
export function createSpawnParallelMissionTool(opts?: MissionToolOpts): AnyAgentTool {
  return {
    label: "Sessions",
    name: "spawn_parallel_mission",
    description:
      "Run agents at the same time when tasks are completely independent. All agents start immediately in parallel.",
    parameters: ProxyMissionSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const label = readStringParam(params, "label", { required: true });
      const topLevelMaxLoops =
        typeof params.maxLoops === "number" &&
        Number.isFinite(params.maxLoops) &&
        params.maxLoops >= 0
          ? Math.floor(params.maxLoops)
          : DEFAULT_MAX_LOOPS; // Default: cap at DEFAULT_MAX_LOOPS iterations

      const rawSubtasks = params.subtasks;
      if (!Array.isArray(rawSubtasks) || rawSubtasks.length === 0) {
        return jsonResult({ status: "error", error: "subtasks required" });
      }

      // Apply top-level maxLoops to each subtask that doesn't already have one
      for (const raw of rawSubtasks) {
        if (raw && typeof raw === "object" && !("maxLoops" in raw)) {
          (raw as Record<string, unknown>).maxLoops = topLevelMaxLoops;
        }
      }

      const validated = validateMissionSubtasks(rawSubtasks, opts);
      if (!validated.ok) {
        return validated.error;
      }

      const { subtaskInputs, requesterInternalKey, requesterDisplayKey, requesterOrigin } =
        validated;

      // No chaining — all subtasks run in parallel (no after fields)
      const qualityGateRequired = params.qualityGateRequired === true;
      const chainDepth =
        typeof params.chainDepth === "number" &&
        Number.isFinite(params.chainDepth) &&
        params.chainDepth >= 0
          ? Math.floor(params.chainDepth)
          : undefined;
      const parentMissionId =
        typeof params.parentMissionId === "string"
          ? params.parentMissionId.trim() || undefined
          : undefined;

      const result = createMission({
        label,
        subtasks: subtaskInputs,
        requesterSessionKey: requesterInternalKey,
        requesterOrigin,
        requesterDisplayKey,
        cleanup: "keep",
        qualityGateRequired,
        chainDepth,
        parentMissionId,
      });

      if ("error" in result) {
        return jsonResult({ status: "error", error: result.error });
      }

      logMissionToOms(label, subtaskInputs, "parallel", result.missionId);

      return jsonResult({
        status: "accepted",
        missionId: result.missionId,
        subtaskCount: subtaskInputs.length,
        label,
        mode: "parallel",
      });
    },
  };
}
