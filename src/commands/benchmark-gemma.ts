import fs from "node:fs";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type BenchmarkGemmaCommandOpts = {
  mock?: boolean;
  model?: string;
  ollamaUrl?: string;
  filter?: string;
  outputDir?: string;
  contextLength?: number;
  gpuLayers?: number;
  batchSize?: number;
};

export async function benchmarkGemmaCommand(
  opts: BenchmarkGemmaCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const { detectHardware, formatHardwareInfo } = await import("../gemmaclaw/provision/hardware.js");
  const { BENCHMARK_TASKS, runBenchmark, writeResults, getMaxPossibleScore } =
    await import("../gemmaclaw/benchmark/index.js");

  // Resolve model. Priority: --model flag > gemmaclaw config > default.
  const model = opts.model ?? resolveConfiguredModel() ?? "gemma3:4b";
  const ollamaUrl = opts.ollamaUrl ?? "http://127.0.0.1:11434";
  const isMock = Boolean(opts.mock);

  runtime.log("");
  runtime.log("========================================");
  runtime.log(`  Gemmaclaw Benchmark${isMock ? " (deterministic)" : ""}`);
  runtime.log("========================================");
  runtime.log("");

  // Detect hardware.
  runtime.log("Detecting hardware...");
  const hw = detectHardware();
  for (const line of formatHardwareInfo(hw)) {
    runtime.log(line);
  }
  runtime.log("");

  // Filter tasks if requested.
  let tasks = [...BENCHMARK_TASKS];
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    tasks = tasks.filter(
      (t) =>
        t.id.toLowerCase().includes(f) ||
        t.category.toLowerCase().includes(f) ||
        t.difficulty.toLowerCase().includes(f) ||
        t.name.toLowerCase().includes(f),
    );
  }

  if (tasks.length === 0) {
    runtime.error(`No tasks match filter "${opts.filter}"`);
    runtime.exit(1);
    return;
  }

  runtime.log(`Model: ${model}`);
  runtime.log(`Ollama: ${ollamaUrl}`);
  runtime.log(`Tasks: ${tasks.length} (max ${getMaxPossibleScore()} points)`);
  runtime.log(`Mode: ${isMock ? "deterministic (mock)" : "full (LLM judge)"}`);
  if (opts.contextLength) {
    runtime.log(`Context length: ${opts.contextLength}`);
  }
  if (opts.gpuLayers != null) {
    runtime.log(`GPU layers: ${opts.gpuLayers}`);
  }
  if (opts.batchSize) {
    runtime.log(`Batch size: ${opts.batchSize}`);
  }
  runtime.log("");

  // Verify Ollama is reachable (unless mock-only with no real inference needed).
  if (!isMock) {
    try {
      const { content } = await ollamaPing(ollamaUrl, model);
      if (!content) {
        throw new Error("Empty response");
      }
      runtime.log("Ollama connection verified.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      runtime.error(`Cannot reach Ollama at ${ollamaUrl}: ${msg}`);
      runtime.error("Make sure Ollama is running with the model loaded.");
      runtime.error("  ollama serve");
      runtime.error(`  ollama pull ${model}`);
      runtime.exit(1);
      return;
    }
  }

  // Run benchmark.
  const result = await runBenchmark(
    tasks,
    {
      ollamaUrl,
      model,
      mock: isMock,
      filter: opts.filter,
      contextLength: opts.contextLength,
      gpuLayers: opts.gpuLayers,
      batchSize: opts.batchSize,
    },
    hw,
    (msg) => runtime.log(msg),
  );

  // Write results.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultDir = path.join(
    process.cwd(),
    "results",
    `${model.replace(/[/:]/g, "-")}__${timestamp}`,
  );
  const outputDir = opts.outputDir ?? defaultDir;
  const files = writeResults(result, outputDir);

  // Print summary.
  const s = result.summary;
  runtime.log("");
  runtime.log("========================================");
  runtime.log("  RESULTS");
  runtime.log("========================================");
  runtime.log(`  Score: ${s.totalScore} / ${s.maxScore} (${s.percentage}%)`);
  runtime.log(`  Passed: ${s.passedCount} / ${s.passedCount + s.failedCount}`);
  runtime.log(`  Time: ${(s.totalTimeMs / 1000).toFixed(1)}s`);
  if (s.avgTokensPerSecond != null) {
    runtime.log(`  Avg tok/s: ${s.avgTokensPerSecond}`);
  }
  runtime.log("");
  runtime.log(`  JSON: ${files.json}`);
  runtime.log(`  Markdown: ${files.markdown}`);
  runtime.log(`  Dashboard: ${files.html}`);
  runtime.log("========================================");
}

function resolveConfiguredModel(): string | undefined {
  // Check openclaw.json for a configured model.
  const configPaths = [
    path.join(process.env.HOME ?? "", ".openclaw", "openclaw.json"),
    path.join(process.cwd(), "openclaw.json"),
  ];

  for (const cp of configPaths) {
    try {
      const raw = fs.readFileSync(cp, "utf8");
      const config = JSON.parse(raw);
      // Look for model in various config locations.
      const model = config.model ?? config.llm?.model ?? config.agents?.defaults?.model;
      if (typeof model === "string" && model.length > 0) {
        return model;
      }
    } catch {
      // Config not found or invalid, continue.
    }
  }
  return undefined;
}

async function ollamaPing(url: string, model: string): Promise<{ content: string }> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      keep_alive: "6h",
      options: { num_predict: 1 },
    });

    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 11434,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve({ content: data.message?.content ?? "" });
          } catch (e: unknown) {
            reject(new Error(`Invalid Ollama response: ${String(e)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Ollama ping timed out"));
    });
    req.write(body);
    req.end();
  });
}
