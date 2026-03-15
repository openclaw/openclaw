import {
  compileOperatorAgentRegistry,
  getCompiledOperatorTeam,
  type CompiledOperatorTeamRecord,
} from "./agent-registry.js";
import {
  canonicalizeOperatorExecutionTransport,
  taskEnvelopeSchema,
  type OperatorTaskEnvelope,
} from "./contracts.js";
import { resolveSpecialistTarget } from "./specialist-resolver.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExplicitTransport(input: unknown): boolean {
  const record = asRecord(input);
  const execution = record ? asRecord(record.execution) : null;
  return Boolean(
    execution && typeof execution.transport === "string" && execution.transport.trim().length > 0,
  );
}

export function resolveOperatorTaskEnvelope(input: unknown): OperatorTaskEnvelope {
  const parsed = taskEnvelopeSchema.parse(input);
  const teamId = parsed.target.team_id?.trim() || null;
  const capability = parsed.target.capability.trim();
  const role = parsed.target.role?.trim() || null;
  const normalizedCapability = capability || role || null;
  if (!normalizedCapability) {
    throw new Error("target capability is required");
  }
  if (!teamId) {
    return {
      ...parsed,
      target: {
        ...parsed.target,
        capability: normalizedCapability,
      },
    };
  }

  compileOperatorAgentRegistry();
  const team = getCompiledOperatorTeam(teamId);
  if (!team) {
    throw new Error(`unknown operator team: ${teamId}`);
  }

  const next: OperatorTaskEnvelope = {
    ...parsed,
    target: {
      ...parsed.target,
      capability: normalizedCapability,
      team_id: team.id,
      role: undefined,
    },
    execution: {
      ...parsed.execution,
      transport: canonicalizeOperatorExecutionTransport(parsed.execution.transport),
    },
  };

  next.target.alias = resolveSpecialistTarget({
    teamId: team.id,
    capability: next.target.capability,
    explicitAlias: next.target.alias ?? null,
    role,
    runtimePreference:
      next.execution.runtime === "subagent"
        ? "subagent"
        : next.execution.runtime === "acpx"
          ? "acp"
          : "any",
  }).identityId;

  if (!hasExplicitTransport(input) && team.dispatchTransport) {
    next.execution.transport = canonicalizeOperatorExecutionTransport(
      team.dispatchTransport as OperatorTaskEnvelope["execution"]["transport"],
    );
  }

  return next;
}

export function getResolvedOperatorTaskTeam(
  task: Pick<OperatorTaskEnvelope, "target">,
): CompiledOperatorTeamRecord | null {
  const teamId = task.target.team_id?.trim();
  if (!teamId) {
    return null;
  }
  return getCompiledOperatorTeam(teamId);
}
