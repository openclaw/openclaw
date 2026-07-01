import type { Command } from "commander";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { undoLastSoulRule } from "../agents/soul-auto-update.js";
import { getRuntimeConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { removeCommandByName } from "./program/command-tree.js";

type SoulUndoOptions = {
  readonly agent?: string;
  readonly json?: boolean;
};

export function registerSoulCli(program: Command): void {
  removeCommandByName(program, "soul");

  const soul = program
    .command("soul")
    .description("Inspect and revise the agent's SOUL.md persistent personality file");

  soul
    .command("undo")
    .description("Remove the most recent auto-added rule from SOUL.md")
    .option("--agent <id>", "Agent id whose SOUL.md to edit (defaults to the default agent)")
    .option("--json", "Output JSON", false)
    .action(async (opts: SoulUndoOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = getRuntimeConfig();
        const agentId = opts.agent?.trim() || resolveDefaultAgentId(cfg);
        const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
        const removed = await undoLastSoulRule(workspaceDir);
        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ agentId, workspaceDir, removed }, null, 2));
          return;
        }
        if (removed === null) {
          defaultRuntime.log(`No auto-added rule to undo in ${workspaceDir}/SOUL.md`);
          return;
        }
        defaultRuntime.log(`Removed from SOUL.md: '${removed}'`);
      });
    });
}
