import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const srcRoot = path.join(repoRoot, "src");
const extensionsRoot = path.join(repoRoot, "extensions");
const forbiddenOllamaFacadeFiles = [
  "src/plugin-sdk/ollama.ts",
  "src/plugin-sdk/ollama-runtime.ts",
] as const;
const genericCoreFixtureFiles = [
  "src/commands/auth-choice.apply.plugin-provider.test.ts",
  "src/plugins/contracts/memory-embedding-provider.contract.test.ts",
  "src/plugins/discovery.test.ts",
  "src/plugins/contracts/tts-contract-suites.ts",
] as const;
const forbiddenGenericFixtureTerms = [
  /\bOllama\b|\bollama\b/u,
  /\bMoonshot\b|\bmoonshot\b/u,
  /\bxAI\b|\bxai\b|\bx-ai\b/u,
] as const;
const importSpecifierPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const piPackagePattern = /^@mariozechner\/pi-/u;
const piPackageStringPattern = /["'](@mariozechner\/pi-[^"']+)["']/g;
const allowedPiPackageImportFiles = new Set([
  "src/agents/agent-core-contract.ts",
  "src/agents/pi-ai-contract.ts",
  "src/agents/pi-ai-oauth-contract.ts",
  "src/agents/pi-ai-openai-completions-contract.ts",
  "src/agents/pi-coding-agent-contract.ts",
  "src/agents/pi-tui-contract.ts",
  "src/types/pi-agent-core.d.ts",
  "src/types/pi-coding-agent.d.ts",
]);
const allowedPiPackageStringFiles = new Set([
  ...allowedPiPackageImportFiles,
  "src/agents/pi-model-discovery.compat.e2e.test.ts",
  "src/plugins/pi-package-graph.test.ts",
]);

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "plugin-sdk") {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(entryPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

function toRepoRelative(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function isTestSupportFile(repoPath: string): boolean {
  return (
    repoPath.includes(".test.") ||
    repoPath.endsWith(".test.ts") ||
    repoPath.includes(".live.") ||
    repoPath.includes(".e2e.") ||
    repoPath.includes(".harness.") ||
    repoPath.includes(".test-support.") ||
    repoPath.endsWith("/test-support.ts") ||
    repoPath.endsWith("/test-helpers.ts") ||
    repoPath.includes("/test-helpers/")
  );
}

describe("core extension facade boundary", () => {
  it("does not expose Ollama plugin facades from core plugin-sdk", () => {
    expect(
      forbiddenOllamaFacadeFiles.filter((file) => fs.existsSync(path.join(repoRoot, file))),
    ).toStrictEqual([]);
  });

  it("does not import Ollama plugin facades from core code", () => {
    const violations: string[] = [];
    for (const filePath of collectSourceFiles(srcRoot)) {
      const source = fs.readFileSync(filePath, "utf8");
      for (const match of source.matchAll(importSpecifierPattern)) {
        const specifier = match[1] ?? match[2];
        if (specifier?.includes("plugin-sdk/ollama")) {
          violations.push(`${toRepoRelative(filePath)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toStrictEqual([]);
  });

  it("keeps generic core fixtures free of bundled provider names", () => {
    const violations: string[] = [];
    for (const file of genericCoreFixtureFiles) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      for (const pattern of forbiddenGenericFixtureTerms) {
        if (pattern.test(source)) {
          violations.push(`${file} matches ${String(pattern)}`);
        }
      }
    }

    expect(violations).toStrictEqual([]);
  });

  it("keeps direct PI package imports behind OpenClaw-owned facades", () => {
    const violations: string[] = [];
    for (const filePath of collectSourceFiles(srcRoot)) {
      const repoPath = toRepoRelative(filePath);
      if (isTestSupportFile(repoPath)) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      for (const match of source.matchAll(importSpecifierPattern)) {
        const specifier = match[1] ?? match[2];
        if (
          specifier &&
          piPackagePattern.test(specifier) &&
          !allowedPiPackageImportFiles.has(repoPath)
        ) {
          violations.push(`${repoPath} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps direct PI package strings out of core test mocks and helpers", () => {
    const violations: string[] = [];
    for (const filePath of collectSourceFiles(srcRoot)) {
      const repoPath = toRepoRelative(filePath);
      if (allowedPiPackageStringFiles.has(repoPath)) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      for (const match of source.matchAll(piPackageStringPattern)) {
        violations.push(`${repoPath} -> ${match[1]}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps bundled extension production code off direct PI package imports", () => {
    const violations: string[] = [];
    for (const filePath of collectSourceFiles(extensionsRoot)) {
      const repoPath = toRepoRelative(filePath);
      if (isTestSupportFile(repoPath)) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      for (const match of source.matchAll(importSpecifierPattern)) {
        const specifier = match[1] ?? match[2];
        if (specifier && piPackagePattern.test(specifier)) {
          violations.push(`${repoPath} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
