import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemorySearchResult } from "../../memory/types.js";
import {
  createMemorySearchTool,
  createKBSearchTool,
  createMemoryWriteTool,
  computeFeedbackHint,
} from "./memory-tool.js";

// --------------------------------------------------------------------------
// Tool description enhancement tests
// --------------------------------------------------------------------------

describe("memory tool descriptions with MongoDB backend", () => {
  it("memory_search description includes usage example when mongodb backend", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createMemorySearchTool({ config: cfg });
    expect(tool).not.toBeNull();
    expect(tool!.description).toContain("Example:");
  });

  it("memory_search description does NOT include example when builtin backend", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "builtin" },
    } as OpenClawConfig;

    const tool = createMemorySearchTool({ config: cfg });
    expect(tool).not.toBeNull();
    expect(tool!.description).not.toContain("Example:");
  });

  it("kb_search description includes usage example", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createKBSearchTool({ config: cfg });
    expect(tool).not.toBeNull();
    expect(tool!.description).toContain("Example:");
  });

  it("memory_write description includes usage example", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createMemoryWriteTool({ config: cfg });
    expect(tool).not.toBeNull();
    expect(tool!.description).toContain("Example:");
  });
});

// --------------------------------------------------------------------------
// Feedback loop — computeFeedbackHint() pure function tests
// --------------------------------------------------------------------------

describe("computeFeedbackHint", () => {
  const makeResult = (score: number): MemorySearchResult => ({
    snippet: "text",
    path: "memory/test.md",
    score,
    startLine: 1,
    endLine: 5,
  });

  it("returns hint when < 2 results and all scores < 0.3", () => {
    const results = [makeResult(0.2)];
    const hint = computeFeedbackHint(results, "mongodb");
    expect(hint).toContain("Low confidence results");
    expect(hint).toContain("kb_search");
  });

  it("returns hint when 0 results (empty)", () => {
    const hint = computeFeedbackHint([], "mongodb");
    expect(hint).toContain("Low confidence results");
  });

  it("returns undefined when results have high scores", () => {
    const results = [makeResult(0.8), makeResult(0.7)];
    const hint = computeFeedbackHint(results, "mongodb");
    expect(hint).toBeUndefined();
  });

  it("returns undefined when >= 2 results even with low scores", () => {
    const results = [makeResult(0.1), makeResult(0.15)];
    const hint = computeFeedbackHint(results, "mongodb");
    expect(hint).toBeUndefined();
  });

  it("returns undefined when 1 result with score >= 0.3", () => {
    const results = [makeResult(0.3)];
    const hint = computeFeedbackHint(results, "mongodb");
    expect(hint).toBeUndefined();
  });

  it("returns undefined for non-mongodb backend", () => {
    const results = [makeResult(0.1)];
    const hint = computeFeedbackHint(results, "builtin");
    expect(hint).toBeUndefined();
  });

  it("returns undefined for undefined backend", () => {
    const results = [makeResult(0.1)];
    const hint = computeFeedbackHint(results, undefined);
    expect(hint).toBeUndefined();
  });

  it("returns hint with rephrasing suggestion", () => {
    const results = [makeResult(0.05)];
    const hint = computeFeedbackHint(results, "mongodb");
    expect(hint).toContain("rephrasing");
  });
});
