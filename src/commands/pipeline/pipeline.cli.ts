import type { Command } from "commander";

export function registerPipelineCli(program: Command) {
  const pipeline = program
    .command("pipeline")
    .description("Run deterministic multi-step pipelines (gated, parallel, loopable)");

  pipeline
    .command("run")
    .description("Run a pipeline spec (pipeline.json)")
    .argument("<spec>", "Path to pipeline.json")
    .option("--phase <phase>", "Only run a specific phase (e.g. 1, 1-ADV, 6)")
    .option("--until <phase>", "Run up to and including a phase")
    .option("--yes", "Auto-approve checkpoints", false)
    .option("--dry-run", "Print plan only", false)
    .option("--json", "Emit machine-readable JSON summary", false)
    .action(async (spec, opts) => {
      const mod = await import("./pipeline.run.js");
      await mod.runPipelineCommand({ specPath: spec, opts });
    });
}
