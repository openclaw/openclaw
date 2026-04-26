import type { Command } from "commander";
import crypto from "node:crypto";
import path from "node:path";
import {
  resolveAgentIdByWorkspacePath,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runTui } from "../tui/tui.js";
import { parseTimeoutMs } from "./parse-timeout.js";

export function registerSubclawCli(program: Command) {
  program
    .command("subclaw [directory]")
    .description("Launch an independent agent TUI scoped to a directory")
    .option("--session <key>", "Explicit session key (defaults to a directory-derived key)")
    .option("--thinking <level>", "Thinking level override")
    .option("--timeout-ms <ms>", "Agent timeout in ms (defaults to agents.defaults.timeoutSeconds)")
    .option("--message <text>", "Send an initial message after connecting")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/subclaw", "docs.openclaw.ai/cli/subclaw")}\n`,
    )
    .action(async (directory, opts) => {
      const targetDir = path.resolve(directory ?? process.cwd());
      const originalCwd = process.cwd();
      if (directory) {
        process.chdir(targetDir);
      }
      try {
        const config = loadConfig();
        const agentId = resolveAgentIdByWorkspacePath(config, targetDir) ?? resolveDefaultAgentId(config);
        const sessionKey =
          (opts.session as string | undefined)?.trim() || buildSubclawSessionKey(targetDir, agentId);
        const timeoutMs = parseTimeoutMs(opts.timeoutMs);

        await runTui({
          local: true,
          cwd: targetDir,
          session: sessionKey,
          thinking: opts.thinking as string | undefined,
          timeoutMs,
          message: opts.message as string | undefined,
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      } finally {
        if (directory) {
          process.chdir(originalCwd);
        }
      }
    });
}

function buildSubclawSessionKey(directory: string, agentId: string): string {
  const dirHash = crypto.createHash("sha256").update(directory).digest("hex").slice(0, 16);
  return `agent:${agentId}:subclaw-${dirHash}`;
}
