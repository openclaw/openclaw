import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEvolutionLearningArchitectureReport,
  runEvolutionLearningArchitectureCheck,
} from "../../scripts/check-openclaw-evolution-learning-architecture.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const zhAdrPath = "docs/architecture/adr-\u9032\u5316\u5b78\u7fd2\u64f4\u5f35\u67b6\u69cb.md";

async function writeFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function createPassingFixture(rootDir: string): Promise<void> {
  await writeFile(
    rootDir,
    "package.json",
    JSON.stringify(
      {
        scripts: {
          "check:openclaw-evolution-learning-architecture":
            "node scripts/check-openclaw-evolution-learning-architecture.mjs",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "extensions/evolution-learning/openclaw.plugin.json",
    JSON.stringify(
      {
        id: "evolution-learning",
        activation: { onStartup: true },
        contracts: { tools: ["evolution_insights"] },
        configSchema: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            maxContextTokens: { type: "integer" },
            confidenceThreshold: { type: "number" },
            remCycleHours: { type: "integer" },
            maturityThreshold: { type: "number" },
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "extensions/evolution-learning/package.json",
    JSON.stringify(
      {
        name: "@openclaw/evolution-learning",
        exports: { ".": "./index.ts" },
        openclaw: { extensions: ["./index.ts"] },
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "extensions/evolution-learning/index.ts",
    [
      'import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";',
      'const PLUGIN_ID = "evolution-learning";',
      "const capturedActivations = new Map();",
      'function classifyTask() { return "general"; }',
      "function recordPatternUsage() {}",
      "function runRemCycle() {}",
      "function syncHermesToEvolution() {}",
      "function autoHatchAgent() {}",
      "definePluginEntry({ id: PLUGIN_ID });",
      'api.on("before_prompt_build", () => {});',
      'api.on("before_model_resolve", () => {});',
      'api.registerService({ id: "evolution-learning-rem-cycle" });',
      'api.registerTool({ name: "evolution_insights" });',
      "api.registerCli(() => {});",
      'api.registerCommand({ name: "evolution" });',
      'const files = "soft-links.json growth-metrics.json cell-registry.json hermes-learning-state.json causal-chain.jsonl";',
      "const cells = stemCells;",
    ].join("\n"),
  );
  await writeFile(
    rootDir,
    "docs/architecture/adr-evolution-learning-expansion.md",
    "Operational Learning\nNEURAL ROUTER\nGROWTH PULSE\nORGANIC CELLS\n",
  );
  await writeFile(
    rootDir,
    zhAdrPath,
    "\u904b\u884c\u5373\u5b78\u7fd2\n\u795e\u7d93\u8def\u7531\n\u589e\u9577\u5fc3\u8df3\n\u6709\u6a5f\u7d30\u80de\n",
  );
}

describe("openclaw evolution-learning architecture check", () => {
  it("passes when manifest, package, hooks, tools, and four-layer docs are present", async () => {
    const rootDir = createTempDir("openclaw-evolution-learning-pass-");
    await createPassingFixture(rootDir);

    const report = await buildEvolutionLearningArchitectureReport(rootDir);

    expect(report.summary.ok).toBe(true);
    expect(report.status).toBe("passed");
  });

  it("fails when the public tool contract is missing", async () => {
    const rootDir = createTempDir("openclaw-evolution-learning-missing-tool-");
    await createPassingFixture(rootDir);
    await writeFile(
      rootDir,
      "extensions/evolution-learning/openclaw.plugin.json",
      JSON.stringify(
        {
          id: "evolution-learning",
          activation: { onStartup: true },
          contracts: { tools: [] },
          configSchema: {
            properties: {
              enabled: {},
              maxContextTokens: {},
              confidenceThreshold: {},
              remCycleHours: {},
              maturityThreshold: {},
            },
          },
        },
        null,
        2,
      ),
    );

    const report = await buildEvolutionLearningArchitectureReport(rootDir);
    const toolCheck = report.checks.find((entry) => entry.id === "manifest-tool-contract");

    expect(report.summary.ok).toBe(false);
    expect(toolCheck?.status).toBe("fail");
  });

  it("returns non-zero when a required architecture document is missing", async () => {
    const rootDir = createTempDir("openclaw-evolution-learning-check-fail-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "docs/architecture/adr-evolution-learning-expansion.md"));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runEvolutionLearningArchitectureCheck({
      argv: [],
      repoRoot: rootDir,
      io: {
        stdout: { write: (text: string) => stdout.push(text) },
        stderr: { write: (text: string) => stderr.push(text) },
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toContain("OpenClaw evolution learning architecture");
    expect(stderr.join("")).toContain("architecture check failed");
  });
});
