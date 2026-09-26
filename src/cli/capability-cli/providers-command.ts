import type { Command } from "commander";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { emitJsonOrText } from "./output.js";

export function registerLocalProvidersCommand<T>(
  parent: Command,
  description: string,
  collect: (cfg: OpenClawConfig, agentId: string) => T | Promise<T>,
  format: (value: T) => string,
): void {
  parent
    .command("providers")
    .description(description)
    .option("--agent <id>", "Agent whose provider state should be inspected")
    .option("--json", "Output JSON", false)
    .action(async (opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { getRuntimeConfig } = await import("../../config/config.js");
        const { resolveCapabilityProviderAgentId, resolveCapabilityAgentOption } =
          await import("./shared.js");
        const cfg = getRuntimeConfig();
        const agentId = resolveCapabilityProviderAgentId(
          cfg,
          resolveCapabilityAgentOption(command, opts.agent),
        );
        const result = await collect(cfg, agentId);
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, format);
      });
    });
}
