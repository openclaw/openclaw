import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerBenchmarkCommand(program: Command) {
  program
    .command("benchmark")
    .description("Run the gemmaclaw benchmark suite against your local Gemma model")
    .option("--mock", "Run deterministic scoring only (no LLM judge, fast CI mode)", false)
    .option("--model <model>", "Ollama model name (default: from config or gemma3:4b)")
    .option("--ollama-url <url>", "Ollama API URL (default: http://127.0.0.1:11434)")
    .option("--filter <text>", "Run only tasks matching this text (id, category, difficulty, name)")
    .option(
      "--output-dir <dir>",
      "Output directory for results (default: ./results/<model>__<timestamp>)",
    )
    .option("--context-length <n>", "Context window size (num_ctx)", parseInt)
    .option("--gpu-layers <n>", "Number of GPU layers (num_gpu)", parseInt)
    .option("--batch-size <n>", "Batch size (num_batch)", parseInt)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { benchmarkGemmaCommand } = await import("../../commands/benchmark-gemma.js");
        await benchmarkGemmaCommand({
          mock: Boolean(opts.mock),
          model: opts.model as string | undefined,
          ollamaUrl: opts.ollamaUrl as string | undefined,
          filter: opts.filter as string | undefined,
          outputDir: opts.outputDir as string | undefined,
          contextLength: opts.contextLength as number | undefined,
          gpuLayers: opts.gpuLayers as number | undefined,
          batchSize: opts.batchSize as number | undefined,
        });
      });
    });
}
