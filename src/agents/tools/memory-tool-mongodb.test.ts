import { describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createKBSearchTool, createMemoryWriteTool } from "./memory-tool.js";

describe("createKBSearchTool", () => {
  it("returns null when backend is not mongodb", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "builtin" },
    } as OpenClawConfig;

    const tool = createKBSearchTool({ config: cfg });
    expect(tool).toBeNull();
  });

  it("returns tool when mongodb backend is active", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createKBSearchTool({ config: cfg });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("kb_search");
  });

  it("returns null when config is undefined", () => {
    const tool = createKBSearchTool({});
    expect(tool).toBeNull();
  });
});

describe("createMemoryWriteTool", () => {
  it("returns null when backend is not mongodb", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "qmd" },
    } as OpenClawConfig;

    const tool = createMemoryWriteTool({ config: cfg });
    expect(tool).toBeNull();
  });

  it("returns tool when mongodb backend is active", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createMemoryWriteTool({ config: cfg });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("memory_write");
    expect(tool!.description).toContain("structured observation");
  });

  it("returns null when config is undefined", () => {
    const tool = createMemoryWriteTool({});
    expect(tool).toBeNull();
  });
});
