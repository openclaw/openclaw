/**
 * Results output for benchmark runs.
 *
 * Generates:
 *   1. JSON results file (machine-readable)
 *   2. Markdown summary (human-readable)
 *   3. HTML dashboard page (GitHub Pages compatible)
 */

import fs from "node:fs";
import path from "node:path";
import type { BenchmarkResult } from "./runner.js";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${minutes}m ${secs}s`;
}

export function writeJsonResults(result: BenchmarkResult, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, "results.json");

  const output = {
    model: result.config.model,
    timestamp: result.timestamp,
    config: {
      ollamaUrl: result.config.ollamaUrl,
      mock: result.config.mock,
      contextLength: result.config.contextLength,
      gpuLayers: result.config.gpuLayers,
      batchSize: result.config.batchSize,
    },
    hardware: {
      cpu: `${result.hardware.cpu.model} (${result.hardware.cpu.cores} cores)`,
      ram: formatBytes(result.hardware.ram.totalBytes),
      gpu: result.hardware.gpu.detected
        ? `${result.hardware.gpu.name ?? "Unknown GPU"}${
            result.hardware.gpu.vramBytes ? ` (${formatBytes(result.hardware.gpu.vramBytes)})` : ""
          }`
        : "None detected",
    },
    summary: result.summary,
    tasks: result.tasks.map((t) => ({
      id: t.task.id,
      name: t.task.name,
      category: t.task.category,
      difficulty: t.task.difficulty,
      score: t.score.score,
      maxScore: t.score.maxScore,
      percentage: t.score.percentage,
      passed: t.score.passed,
      method: t.score.method,
      details: t.score.details,
      elapsedMs: t.elapsedMs,
      tokensPerSecond: t.tokensPerSecond,
      error: t.error,
    })),
  };

  fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
  return filePath;
}

export function writeMarkdownSummary(result: BenchmarkResult, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, "RESULTS.md");
  const s = result.summary;
  const hw = result.hardware;

  const lines: string[] = [
    `# Benchmark Results: ${result.config.model}`,
    "",
    `**Date:** ${result.timestamp}`,
    `**Mode:** ${result.config.mock ? "Deterministic (mock)" : "Full (LLM judge)"}`,
    "",
    "## Hardware",
    "",
    `| Component | Value |`,
    `| --- | --- |`,
    `| CPU | ${hw.cpu.model} (${hw.cpu.cores} cores) |`,
    `| RAM | ${formatBytes(hw.ram.totalBytes)} |`,
    `| GPU | ${hw.gpu.detected ? (hw.gpu.name ?? "Detected") : "None"} |`,
    ...(hw.gpu.vramBytes ? [`| VRAM | ${formatBytes(hw.gpu.vramBytes)} |`] : []),
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Total Score | ${s.totalScore} / ${s.maxScore} (${s.percentage}%) |`,
    `| Passed | ${s.passedCount} / ${s.passedCount + s.failedCount} |`,
    `| Total Time | ${formatDuration(s.totalTimeMs)} |`,
    ...(s.avgTokensPerSecond != null ? [`| Avg Tokens/s | ${s.avgTokensPerSecond} |`] : []),
    "",
    "## Task Results",
    "",
    "| Task | Category | Difficulty | Score | Status | Time | tok/s |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const t of result.tasks) {
    const status = t.score.passed ? "PASS" : "FAIL";
    const tps = t.tokensPerSecond ? t.tokensPerSecond.toFixed(1) : "-";
    lines.push(
      `| ${t.task.name} | ${t.task.category} | ${t.task.difficulty} | ${t.score.score}/${t.score.maxScore} | ${status} | ${formatDuration(t.elapsedMs)} | ${tps} |`,
    );
  }

  lines.push("");

  // Category breakdown.
  const categories = [...new Set(result.tasks.map((t) => t.task.category))];
  lines.push("## By Category", "");
  for (const cat of categories) {
    const catTasks = result.tasks.filter((t) => t.task.category === cat);
    const catScore = catTasks.reduce((s, t) => s + t.score.score, 0);
    const catMax = catTasks.reduce((s, t) => s + t.score.maxScore, 0);
    const catPct = catMax > 0 ? Math.round((catScore / catMax) * 100) : 0;
    lines.push(`- **${cat}**: ${catScore}/${catMax} (${catPct}%)`);
  }

  lines.push("");
  fs.writeFileSync(filePath, lines.join("\n"));
  return filePath;
}

export function writeHtmlDashboard(result: BenchmarkResult, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, "index.html");
  const s = result.summary;
  const hw = result.hardware;

  const taskRows = result.tasks
    .map((t) => {
      const status = t.score.passed
        ? '<span class="badge pass">PASS</span>'
        : '<span class="badge fail">FAIL</span>';
      const tps = t.tokensPerSecond ? t.tokensPerSecond.toFixed(1) : "-";
      return `<tr>
        <td>${t.task.name}</td>
        <td>${t.task.category}</td>
        <td>${t.task.difficulty}</td>
        <td>${t.score.score}/${t.score.maxScore}</td>
        <td>${status}</td>
        <td>${formatDuration(t.elapsedMs)}</td>
        <td>${tps}</td>
      </tr>`;
    })
    .join("\n");

  const categories = [...new Set(result.tasks.map((t) => t.task.category))];
  const categoryData = categories.map((cat) => {
    const catTasks = result.tasks.filter((t) => t.task.category === cat);
    const score = catTasks.reduce((sum, t) => sum + t.score.score, 0);
    const max = catTasks.reduce((sum, t) => sum + t.score.maxScore, 0);
    return { category: cat, score, max, pct: max > 0 ? Math.round((score / max) * 100) : 0 };
  });

  const categoryBars = categoryData
    .map(
      (c) =>
        `<div class="bar-row">
        <span class="bar-label">${c.category}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${c.pct}%"></div></div>
        <span class="bar-value">${c.pct}%</span>
      </div>`,
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gemmaclaw Benchmark: ${result.config.model}</title>
<style>
:root {
  --gemma-blue: #4285f4;
  --pass-green: #34a853;
  --fail-red: #ea4335;
  --bg: #fafafa;
  --card: #ffffff;
  --text: #202124;
  --muted: #5f6368;
  --border: #e0e0e0;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Google Sans', 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
.container { max-width: 960px; margin: 0 auto; padding: 24px; }
h1 { font-size: 1.8rem; font-weight: 500; margin-bottom: 8px; }
h2 { font-size: 1.2rem; font-weight: 500; margin: 24px 0 12px; color: var(--muted); }
.subtitle { color: var(--muted); margin-bottom: 24px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
.card .label { font-size: 0.85rem; color: var(--muted); margin-bottom: 4px; }
.card .value { font-size: 1.6rem; font-weight: 500; }
.card .value.score { color: var(--gemma-blue); }
table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
th { background: #f8f9fa; padding: 12px 16px; text-align: left; font-weight: 500; font-size: 0.85rem; color: var(--muted); border-bottom: 1px solid var(--border); }
td { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
tr:last-child td { border-bottom: none; }
.badge { padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
.badge.pass { background: #e6f4ea; color: var(--pass-green); }
.badge.fail { background: #fce8e6; color: var(--fail-red); }
.bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.bar-label { width: 140px; font-size: 0.9rem; }
.bar-track { flex: 1; height: 20px; background: #e0e0e0; border-radius: 10px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--gemma-blue); border-radius: 10px; transition: width 0.5s ease; }
.bar-value { width: 50px; text-align: right; font-size: 0.85rem; color: var(--muted); }
.hw-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.hw-item { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.hw-item .hw-label { font-size: 0.8rem; color: var(--muted); }
.hw-item .hw-value { font-size: 0.95rem; }
footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <h1>Gemmaclaw Benchmark</h1>
  <p class="subtitle">${result.config.model} | ${result.config.mock ? "Deterministic" : "LLM Judge"} | ${result.timestamp}</p>

  <div class="cards">
    <div class="card">
      <div class="label">Overall Score</div>
      <div class="value score">${s.percentage}%</div>
    </div>
    <div class="card">
      <div class="label">Score</div>
      <div class="value">${s.totalScore} / ${s.maxScore}</div>
    </div>
    <div class="card">
      <div class="label">Passed</div>
      <div class="value">${s.passedCount} / ${s.passedCount + s.failedCount}</div>
    </div>
    <div class="card">
      <div class="label">Time</div>
      <div class="value">${formatDuration(s.totalTimeMs)}</div>
    </div>
    ${
      s.avgTokensPerSecond != null
        ? `<div class="card"><div class="label">Avg tok/s</div><div class="value">${s.avgTokensPerSecond}</div></div>`
        : ""
    }
  </div>

  <h2>By Category</h2>
  ${categoryBars}

  <h2>Hardware</h2>
  <div class="hw-grid">
    <div class="hw-item"><div class="hw-label">CPU</div><div class="hw-value">${hw.cpu.model} (${hw.cpu.cores} cores)</div></div>
    <div class="hw-item"><div class="hw-label">RAM</div><div class="hw-value">${formatBytes(hw.ram.totalBytes)}</div></div>
    <div class="hw-item"><div class="hw-label">GPU</div><div class="hw-value">${hw.gpu.detected ? (hw.gpu.name ?? "Detected") : "None"}</div></div>
    ${hw.gpu.vramBytes ? `<div class="hw-item"><div class="hw-label">VRAM</div><div class="hw-value">${formatBytes(hw.gpu.vramBytes)}</div></div>` : ""}
  </div>

  <h2>Task Results</h2>
  <table>
    <thead>
      <tr><th>Task</th><th>Category</th><th>Difficulty</th><th>Score</th><th>Status</th><th>Time</th><th>tok/s</th></tr>
    </thead>
    <tbody>
      ${taskRows}
    </tbody>
  </table>

  <footer>Generated by gemmaclaw benchmark | ${result.timestamp}</footer>
</div>
</body>
</html>`;

  fs.writeFileSync(filePath, html);
  return filePath;
}

export function writeResults(
  result: BenchmarkResult,
  outputDir: string,
): {
  json: string;
  markdown: string;
  html: string;
} {
  return {
    json: writeJsonResults(result, outputDir),
    markdown: writeMarkdownSummary(result, outputDir),
    html: writeHtmlDashboard(result, outputDir),
  };
}
