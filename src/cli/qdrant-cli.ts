import type { Command } from "commander";
import { runQdrantWorkspaceReconcileCommand } from "../commands/qdrant-workspace-reconcile.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";

export function registerQdrantCli(program: Command) {
  const qdrant = program.command("qdrant").description("Qdrant maintenance and reconciliation");
  const workspace = qdrant.command("workspace").description("Workspace-managed Qdrant data");

  workspace
    .command("reconcile")
    .description("Reconcile managed workspace markdown into Qdrant")
    .option("--dry-run", "Build inventory and diff without writing to Qdrant", false)
    .option("--apply", "Embed changed workspace chunks and write updates to Qdrant", false)
    .option("--json", "Output JSON", false)
    .action(async (opts: { apply?: boolean; dryRun?: boolean; json?: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await runQdrantWorkspaceReconcileCommand(
          {
            apply: Boolean(opts.apply),
            dryRun: Boolean(opts.dryRun),
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });
}
