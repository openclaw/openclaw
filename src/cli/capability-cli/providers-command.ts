import type { Command } from "commander";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime, writeRuntimeJson } from "../../runtime.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function runCapabilityCommand<T>(
  json: boolean | undefined,
  format: ((value: T) => string) | undefined,
  run: () => T | Promise<T>,
): Promise<void> {
  return runCommandWithRuntime(defaultRuntime, async () => {
    const signal = getAsyncWorkSignal();
    try {
      const result = await run();
      // The root command signal owner records the exit status after cleanup.
      signal?.throwIfAborted();
      if (json) {
        writeRuntimeJson(defaultRuntime, result);
        return;
      }
      defaultRuntime.log((format ?? ((value) => JSON.stringify(value, null, 2)))(result));
    } catch (error) {
      // An accepted interrupt owns the exit status: publish no failure for work the
      // signal stopped.
      if (signal?.aborted) {
        return;
      }
      throw error;
    }
  });
}

export function registerLocalProvidersCommand<T>(
  parent: Command,
  description: string,
  collect: (cfg: OpenClawConfig, agentId: string) => T | Promise<T>,
  format?: (value: T) => string,
): void {
  parent
    .command("providers")
    .description(description)
    .option("--agent <id>", "Agent whose provider state should be inspected")
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runCapabilityCommand(opts.json, format, async () => {
        const { captureRuntimeConfigAsyncReader } = await import("../../config/config.js");
        const { resolveCapabilityProviderAgentId, resolveCapabilityAgentOption } =
          await import("./shared.js");
        const cfg = await captureRuntimeConfigAsyncReader()();
        const agentId = resolveCapabilityProviderAgentId(
          cfg,
          resolveCapabilityAgentOption(command, opts.agent),
        );
        return collect(cfg, agentId);
      }),
    );
}
