import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerProvisionCommand(program: Command) {
  program
    .command("provision")
    .description("Install and start a local Gemma backend (Ollama, llama.cpp, or gemma.cpp)")
    .requiredOption("--backend <backend>", "Backend to provision: ollama, llama-cpp, or gemma-cpp")
    .option("--model <model>", "Model to pull (default: smallest Gemma for the backend)")
    .option("--port <port>", "Port for the backend API server")
    .option("--no-verify", "Skip the post-provision chat completion verification")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { provisionCommand } = await import("../../commands/provision.js");
        await provisionCommand(
          {
            backend: opts.backend as string,
            model: opts.model as string | undefined,
            port: opts.port as string | undefined,
            verify: opts.verify as boolean,
          },
          defaultRuntime,
        );
      });
    });
}
