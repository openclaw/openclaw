/** Run-scoped Ultra guidance shared by host harnesses; tools remain policy-owned. */
export function buildProactiveSubagentOrchestrationSection(params: {
  enabled: boolean;
  hasSessionsSpawn: boolean;
  /** Operator-kept native delegation tools on this run, such as Claude Code's `Agent`. */
  nativeDelegationTools?: readonly string[];
}): string[] {
  if (!params.enabled) {
    return [];
  }
  const delegationTools = [
    ...(params.hasSessionsSpawn ? ["`sessions_spawn`"] : []),
    ...(params.nativeDelegationTools ?? []).map((name) => `native \`${name}\``),
  ];
  return [
    delegationTools.length > 0 ? "## Proactive Sub-Agent Orchestration" : "## Ultra Execution",
    "Ultra active for this turn. Plan the work, carry it through, and verify the result before replying.",
    ...(delegationTools.length > 0
      ? [
          `Use ${delegationTools.join(" or ")} when independent work improves speed/quality.`,
          "- Parallelize independent investigation, implementation, verification.",
          "- Simple/tightly coupled stays local.",
          "- Give bounded objectives; synthesize results before replying.",
        ]
      : []),
    "",
  ];
}
