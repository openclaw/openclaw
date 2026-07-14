// Prompt-facing durable orchestration policy helpers.
export type DurableOrchestrationPolicy = "auto" | "solo_first" | "parallel_first" | "manual_fanout";

const DURABLE_ORCHESTRATION_POLICIES = new Set<DurableOrchestrationPolicy>([
  "auto",
  "solo_first",
  "parallel_first",
  "manual_fanout",
]);

export function normalizeDurableOrchestrationPolicy(value: unknown): DurableOrchestrationPolicy {
  return typeof value === "string" &&
    DURABLE_ORCHESTRATION_POLICIES.has(value.trim() as DurableOrchestrationPolicy)
    ? (value.trim() as DurableOrchestrationPolicy)
    : "auto";
}

export function resolveDurableOrchestrationPolicy(
  env: NodeJS.ProcessEnv = process.env,
): DurableOrchestrationPolicy {
  return normalizeDurableOrchestrationPolicy(env.OPENCLAW_DURABLE_ORCHESTRATION_POLICY);
}

export function buildDurableSubagentOrchestrationGuidance(params: {
  policy?: DurableOrchestrationPolicy;
  hasSessionsSpawn: boolean;
  hasSubagents: boolean;
  hasSessionsYield: boolean;
}): string {
  const policy = params.policy ?? "auto";
  if (!params.hasSessionsSpawn) {
    return params.hasSubagents
      ? "- Sub-agent status -> use `subagents(action=list)` only for on-demand status/debugging visibility."
      : "";
  }

  const yieldGuidance = params.hasSessionsYield
    ? " Use `sessions_yield` when waiting for spawned sub-agent completion events."
    : "";
  const statusGuidance = params.hasSubagents
    ? " Use `subagents(action=list)` only for on-demand status/debugging visibility, not wait loops."
    : "";

  switch (policy) {
    case "solo_first":
      return `- Sub-agent orchestration -> prefer doing the work directly when current context and tools are sufficient; spawn only for parallel I/O, specialist isolation, fault isolation, or long background work.${yieldGuidance}${statusGuidance}`;
    case "parallel_first":
      return `- Sub-agent orchestration -> use \`sessions_spawn(...)\` for meaningful parallel branches, specialist lanes, or background work; keep the parent responsible for fan-in, route isolation, and final synthesis.${yieldGuidance}${statusGuidance}`;
    case "manual_fanout":
      return `- Sub-agent orchestration -> do not fan out automatically. Ask or continue directly unless the user, profile, or task contract clearly requires sub-agent work.${yieldGuidance}${statusGuidance}`;
    case "auto":
      return `- Sub-agent orchestration -> start directly when the current context is enough; use \`sessions_spawn(...)\` when parallelism, specialist isolation, fault isolation, or long background work makes the run more reliable.${yieldGuidance}${statusGuidance}`;
  }
  return "";
}
