import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

// NOTE: ROOT_DIR resolves to the source tree because Vitest processes TypeScript
// in-place (source mode). If the test runner ever compiles to a dist/ tree first,
// this path assumption will need updating.
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type GuardedSource = {
  path: string;
  requiredPatterns: RegExp[];
};

const COMPLETENESS_SCAN_SOURCES: GuardedSource[] = [
  {
    path: "agents/system-prompt.ts",
    requiredPatterns: [/\bbuildCompletenessScanSection\b/, /completeness_scan/],
  },
  {
    path: "agents/system-prompt-contribution.ts",
    requiredPatterns: [/"completeness_scan"/],
  },
];

describe("system prompt completeness scan guardrails", () => {
  it("system prompt source includes mandatory completeness scan section builder", () => {
    for (const source of COMPLETENESS_SCAN_SOURCES) {
      const absolutePath = resolve(ROOT_DIR, source.path);
      const text = readFileSync(absolutePath, "utf8");
      for (const pattern of source.requiredPatterns) {
        expect(text).toMatch(pattern);
      }
    }
  });

  it("full prompt mode includes completeness scan section", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "full",
    });

    expect(prompt).toContain("## Completeness Scan (mandatory)");
    expect(prompt).toContain("Read and search operations require completeness verification");
    expect(prompt).toContain("Do not stop early");
    expect(prompt).toContain("Empty or partial results");
    expect(prompt).toContain("Truncation handling");
    expect(prompt).toContain("Verification before finalizing");
  });

  it("minimal prompt mode omits completeness scan section", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
    });

    expect(prompt).not.toContain("## Completeness Scan (mandatory)");
  });

  it("none prompt mode omits completeness scan section", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "none",
    });

    expect(prompt).not.toContain("## Completeness Scan (mandatory)");
  });

  it("completeness scan section can be overridden via provider contribution", () => {
    const customCompleteness = "## Custom Completeness\nOverride text here.";
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "full",
      promptContribution: {
        sectionOverrides: {
          completeness_scan: customCompleteness,
        },
      },
    });

    expect(prompt).toContain("## Custom Completeness");
    expect(prompt).toContain("Override text here.");
    expect(prompt).not.toContain("## Completeness Scan (mandatory)");
  });
});
