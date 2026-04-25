#!/usr/bin/env node
/**
 * Standalone benchmark CLI runner.
 * Allows running benchmarks directly via `pnpm benchmark` without building the full project.
 *
 * Usage:
 *   pnpm benchmark                          # Full LLM judge mode
 *   pnpm benchmark:mock                     # Deterministic mock mode
 *   pnpm benchmark --model gemma3:4b        # Specify model
 *   pnpm benchmark --filter coding          # Run only coding tasks
 *   pnpm benchmark --context-length 8192    # Set context window
 */

import process from "node:process";
import { benchmarkGemmaCommand } from "../../commands/benchmark-gemma.js";
import { defaultRuntime } from "../../runtime.js";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const opts: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mock") {
      opts.mock = true;
    } else if (arg === "--model" && args[i + 1]) {
      opts.model = args[++i]!;
    } else if (arg === "--ollama-url" && args[i + 1]) {
      opts.ollamaUrl = args[++i]!;
    } else if (arg === "--filter" && args[i + 1]) {
      opts.filter = args[++i]!;
    } else if (arg === "--output-dir" && args[i + 1]) {
      opts.outputDir = args[++i]!;
    } else if (arg === "--context-length" && args[i + 1]) {
      opts.contextLength = args[++i]!;
    } else if (arg === "--gpu-layers" && args[i + 1]) {
      opts.gpuLayers = args[++i]!;
    } else if (arg === "--batch-size" && args[i + 1]) {
      opts.batchSize = args[++i]!;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: pnpm benchmark [options]

Options:
  --mock                 Run deterministic scoring only (fast, no LLM judge)
  --model <name>         Ollama model name (default: from config or gemma3:4b)
  --ollama-url <url>     Ollama API URL (default: http://127.0.0.1:11434)
  --filter <text>        Run only tasks matching text (id, category, difficulty)
  --output-dir <dir>     Output directory for results
  --context-length <n>   Context window size
  --gpu-layers <n>       Number of GPU layers
  --batch-size <n>       Batch size
  -h, --help             Show this help
`);
      process.exit(0);
    }
  }

  return opts;
}

const opts = parseArgs(process.argv);

benchmarkGemmaCommand(
  {
    mock: Boolean(opts.mock),
    model: opts.model as string | undefined,
    ollamaUrl: opts.ollamaUrl as string | undefined,
    filter: opts.filter as string | undefined,
    outputDir: opts.outputDir as string | undefined,
    contextLength: opts.contextLength ? Number.parseInt(String(opts.contextLength), 10) : undefined,
    gpuLayers: opts.gpuLayers ? Number.parseInt(String(opts.gpuLayers), 10) : undefined,
    batchSize: opts.batchSize ? Number.parseInt(String(opts.batchSize), 10) : undefined,
  },
  defaultRuntime,
).catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
