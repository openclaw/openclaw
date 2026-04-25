/**
 * Benchmark runner: sends prompts to Ollama, collects responses, scores them.
 *
 * Supports two modes:
 *   --mock: deterministic scoring against expected outputs (no LLM judge needed)
 *   default: full run with LLM judge scoring
 */

import http from "node:http";
import type { HardwareInfo } from "../provision/hardware.js";
import {
  buildJudgePrompt,
  parseJudgeResponse,
  scoreDeterministic,
  type TaskScore,
} from "./scorer.js";
import type { BenchmarkTask } from "./tasks.js";

export type BenchmarkConfig = {
  ollamaUrl: string;
  model: string;
  mock: boolean;
  filter?: string;
  contextLength?: number;
  gpuLayers?: number;
  batchSize?: number;
};

export type TaskResult = {
  task: BenchmarkTask;
  output: string;
  score: TaskScore;
  elapsedMs: number;
  tokensPerSecond?: number;
  error?: string;
};

export type BenchmarkResult = {
  config: BenchmarkConfig;
  hardware: HardwareInfo;
  tasks: TaskResult[];
  summary: {
    totalScore: number;
    maxScore: number;
    percentage: number;
    totalTimeMs: number;
    avgTokensPerSecond?: number;
    passedCount: number;
    failedCount: number;
  };
  timestamp: string;
};

function ollamaChat(
  url: string,
  model: string,
  prompt: string,
  system?: string,
  options?: { num_ctx?: number; num_gpu?: number; num_batch?: number },
): Promise<{ content: string; evalCount?: number; evalDurationNs?: number }> {
  return new Promise((resolve, reject) => {
    const messages: Array<{ role: string; content: string }> = [];
    if (system) {
      messages.push({ role: "system", content: system });
    }
    messages.push({ role: "user", content: prompt });

    const body = JSON.stringify({
      model,
      messages,
      stream: false,
      keep_alive: "6h",
      options: {
        ...(options?.num_ctx != null ? { num_ctx: options.num_ctx } : {}),
        ...(options?.num_gpu != null ? { num_gpu: options.num_gpu } : {}),
        ...(options?.num_batch != null ? { num_batch: options.num_batch } : {}),
      },
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
        timeout: 300_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve({
              content: data.message?.content ?? "",
              evalCount: data.eval_count,
              evalDurationNs: data.eval_duration,
            });
          } catch (e: unknown) {
            reject(new Error(`Failed to parse Ollama response: ${String(e)}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Ollama request timed out (300s)"));
    });
    req.write(body);
    req.end();
  });
}

export async function runBenchmark(
  tasks: BenchmarkTask[],
  config: BenchmarkConfig,
  hardware: HardwareInfo,
  progress?: (msg: string) => void,
): Promise<BenchmarkResult> {
  const results: TaskResult[] = [];
  const startTime = Date.now();
  const log = progress ?? console.log;

  const ollamaOptions = {
    num_ctx: config.contextLength,
    num_gpu: config.gpuLayers,
    num_batch: config.batchSize,
  };

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const taskNum = `[${i + 1}/${tasks.length}]`;

    log(`\n${taskNum} ${task.name} (${task.difficulty})`);

    const prompt = config.mock && task.mock?.prompt ? task.mock.prompt : task.prompt;
    const taskStart = Date.now();
    let output = "";
    let tokensPerSecond: number | undefined;
    let error: string | undefined;

    try {
      const response = await ollamaChat(
        config.ollamaUrl,
        config.model,
        prompt,
        task.system,
        ollamaOptions,
      );
      output = response.content;

      if (response.evalCount && response.evalDurationNs) {
        tokensPerSecond = response.evalCount / (response.evalDurationNs / 1_000_000_000);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      log(`  ERROR: ${error}`);
    }

    const elapsedMs = Date.now() - taskStart;

    // Score the output.
    let score: TaskScore;
    if (config.mock) {
      score = scoreDeterministic(output, task);
    } else if (error) {
      score = {
        taskId: task.id,
        score: 0,
        maxScore: task.grading.maxScore,
        percentage: 0,
        method: "deterministic",
        details: `Error: ${error}`,
        passed: false,
      };
    } else {
      // LLM judge mode: ask the same model to grade the output.
      try {
        const judgePrompt = buildJudgePrompt(task, output);
        const judgeResponse = await ollamaChat(
          config.ollamaUrl,
          config.model,
          judgePrompt,
          "You are a strict but fair evaluator. Score the response accurately.",
          ollamaOptions,
        );
        score = parseJudgeResponse(judgeResponse.content, task.grading.maxScore);
        score.taskId = task.id;
      } catch {
        // Fall back to deterministic if judge fails.
        score = scoreDeterministic(output, task);
      }
    }

    const tpsStr = tokensPerSecond ? ` (${tokensPerSecond.toFixed(1)} tok/s)` : "";
    const statusIcon = score.passed ? "PASS" : "FAIL";
    log(
      `  ${statusIcon} ${score.score}/${score.maxScore} (${score.percentage}%)${tpsStr} [${(elapsedMs / 1000).toFixed(1)}s]`,
    );

    results.push({ task, output, score, elapsedMs, tokensPerSecond, error });
  }

  const totalTimeMs = Date.now() - startTime;
  const totalScore = results.reduce((s, r) => s + r.score.score, 0);
  const maxScore = results.reduce((s, r) => s + r.score.maxScore, 0);
  const tpsValues = results.map((r) => r.tokensPerSecond).filter((v): v is number => v != null);
  const avgTps =
    tpsValues.length > 0 ? tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length : undefined;

  return {
    config,
    hardware,
    tasks: results,
    summary: {
      totalScore: Math.round(totalScore * 10) / 10,
      maxScore,
      percentage: maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0,
      totalTimeMs,
      avgTokensPerSecond: avgTps ? Math.round(avgTps * 10) / 10 : undefined,
      passedCount: results.filter((r) => r.score.passed).length,
      failedCount: results.filter((r) => !r.score.passed).length,
    },
    timestamp: new Date().toISOString(),
  };
}
