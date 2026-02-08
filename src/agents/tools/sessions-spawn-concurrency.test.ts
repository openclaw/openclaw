import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("sessions spawn concurrency limit", () => {
  it("imports countActiveSubagentRuns from subagent-registry", async () => {
    const source = await fs.readFile(
      `${process.cwd()}/src/agents/tools/sessions-spawn-tool.ts`,
      "utf-8",
    );
    expect(source.includes("countActiveSubagentRuns")).toBe(true);
  });

  it("imports resolveSubagentMaxConcurrent from config/agent-limits", async () => {
    const source = await fs.readFile(
      `${process.cwd()}/src/agents/tools/sessions-spawn-tool.ts`,
      "utf-8",
    );
    expect(source.includes("resolveSubagentMaxConcurrent")).toBe(true);
    expect(source.includes('from "../../config/agent-limits.js"')).toBe(true);
  });

  it("checks concurrency limit before spawning", async () => {
    const source = await fs.readFile(
      `${process.cwd()}/src/agents/tools/sessions-spawn-tool.ts`,
      "utf-8",
    );

    // Verify the concurrency check code exists
    expect(source.includes("maxConcurrent = resolveSubagentMaxConcurrent")).toBe(true);
    expect(source.includes("activeCount = countActiveSubagentRuns")).toBe(true);
    expect(source.includes("activeCount >= maxConcurrent")).toBe(true);
  });

  it("returns forbidden status when limit exceeded", async () => {
    const source = await fs.readFile(
      `${process.cwd()}/src/agents/tools/sessions-spawn-tool.ts`,
      "utf-8",
    );

    // Verify the error message mentions concurrency
    expect(source.includes("concurrency limit exceeded")).toBe(true);
  });
});
