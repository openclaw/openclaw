export type UpdateCanaryCommand = {
  phase: "doctor" | "lint" | "config" | "plugins" | "runtime";
  name: string;
  args: string[];
  entry?: string;
};

export function buildUpdateCanaryCommands(params: {
  continuationEntry: string;
  migrationPolicy?: "rehearse" | "startup-only";
}): UpdateCanaryCommand[] {
  const runtime: UpdateCanaryCommand = {
    phase: "runtime",
    name: "candidate-recovery",
    // After a schema bump only a fresh candidate may finalize the run;
    // prove its full recovery import graph before live state changes.
    entry: params.continuationEntry,
    args: ["--check"],
  };
  if (params.migrationPolicy === "startup-only") {
    return [runtime];
  }
  return [
    {
      phase: "doctor",
      name: "candidate-doctor",
      args: ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
    },
    {
      phase: "lint",
      name: "candidate-doctor-lint",
      args: ["doctor", "--lint", "--json", "--severity-min", "error"],
    },
    {
      phase: "config",
      name: "candidate-config",
      args: ["config", "validate", "--json"],
    },
    {
      phase: "plugins",
      name: "candidate-plugins",
      args: ["plugins", "list", "--json"],
    },
    runtime,
  ];
}
