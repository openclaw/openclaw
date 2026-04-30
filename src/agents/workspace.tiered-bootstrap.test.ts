import { describe, expect, it } from "vitest";
import {
  filterBootstrapFilesForSession,
  resolveBootstrapTier,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

function makeFile(name: string, missing = false): WorkspaceBootstrapFile {
  return {
    name: name as WorkspaceBootstrapFile["name"],
    path: `/workspace/${name}`,
    content: "test",
    missing,
    source: "root",
  };
}

function makeHookFile(name: string, relPath: string): WorkspaceBootstrapFile {
  return {
    name: name as WorkspaceBootstrapFile["name"],
    path: `/workspace/${relPath}`,
    content: "extra",
    missing: false,
    source: "hook",
  };
}

// Session key formats: agent:<agentId>:<rest>
const MAIN_KEY = "agent:main:main";
const SUBAGENT_KEY = "agent:main:subagent:task123";
const CRON_KEY = "agent:main:cron:job123";

const STANDARD_FILES: WorkspaceBootstrapFile[] = [
  makeFile("AGENTS.md"),
  makeFile("SOUL.md"),
  makeFile("TOOLS.md"),
  makeFile("IDENTITY.md"),
  makeFile("USER.md"),
  makeFile("HEARTBEAT.md"),
  makeFile("BOOTSTRAP.md"),
  makeFile("MEMORY.md"),
];

// Simulate extra bootstrap files loaded via the bootstrap-extra-files hook
const EXTRA_FILES: WorkspaceBootstrapFile[] = [makeFile("PROJECT.md"), makeFile("CONVENTIONS.md")];

const ALL_FILES: WorkspaceBootstrapFile[] = [...STANDARD_FILES, ...EXTRA_FILES];

describe("resolveBootstrapTier", () => {
  it("returns 'standard' for main sessions without override", () => {
    expect(resolveBootstrapTier(undefined)).toBe("standard");
    expect(resolveBootstrapTier(MAIN_KEY)).toBe("standard");
  });

  it("returns 'minimal' for subagent sessions", () => {
    expect(resolveBootstrapTier(SUBAGENT_KEY)).toBe("minimal");
  });

  it("returns 'minimal' for cron sessions", () => {
    expect(resolveBootstrapTier(CRON_KEY)).toBe("minimal");
  });

  it("respects explicit tier override for main sessions", () => {
    expect(resolveBootstrapTier(MAIN_KEY, "minimal")).toBe("minimal");
    expect(resolveBootstrapTier(MAIN_KEY, "full")).toBe("full");
  });

  it("respects explicit tier override for subagent sessions", () => {
    expect(resolveBootstrapTier(SUBAGENT_KEY, "standard")).toBe("standard");
    expect(resolveBootstrapTier(SUBAGENT_KEY, "full")).toBe("full");
  });
});

describe("filterBootstrapFilesForSession", () => {
  it("returns only recognized files for main session (standard tier)", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES);
    expect(result).toHaveLength(STANDARD_FILES.length);
    expect(result.map((f) => f.name)).not.toContain("PROJECT.md");
    expect(result.map((f) => f.name)).not.toContain("CONVENTIONS.md");
  });

  it("returns minimal files for subagent session", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, SUBAGENT_KEY);
    const names = result.map((f) => f.name);
    expect(names).toContain("AGENTS.md");
    expect(names).toContain("TOOLS.md");
    expect(names).toContain("SOUL.md");
    expect(names).toContain("IDENTITY.md");
    expect(names).toContain("USER.md");
    expect(names).not.toContain("HEARTBEAT.md");
    expect(names).not.toContain("BOOTSTRAP.md");
    expect(names).not.toContain("MEMORY.md");
    expect(names).not.toContain("PROJECT.md");
  });

  it("returns minimal files for cron session", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, CRON_KEY);
    const names = result.map((f) => f.name);
    expect(names).toContain("AGENTS.md");
    expect(names).toContain("TOOLS.md");
    expect(names).toContain("SOUL.md");
    expect(names).not.toContain("HEARTBEAT.md");
    expect(names).not.toContain("PROJECT.md");
  });

  it("returns only recognized files when tierOverride is 'standard' even for subagent", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, SUBAGENT_KEY, "standard");
    expect(result).toHaveLength(STANDARD_FILES.length);
    expect(result.map((f) => f.name)).not.toContain("PROJECT.md");
  });

  it("returns minimal files when tierOverride is 'minimal' for main session", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY, "minimal");
    const names = result.map((f) => f.name);
    expect(names).toContain("AGENTS.md");
    expect(names).toContain("TOOLS.md");
    expect(names).toContain("SOUL.md");
    expect(names).not.toContain("HEARTBEAT.md");
    expect(names).not.toContain("PROJECT.md");
  });

  it("returns all files including extras when tierOverride is 'full'", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY, "full");
    expect(result).toHaveLength(ALL_FILES.length);
    expect(result.map((f) => f.name)).toContain("PROJECT.md");
    expect(result.map((f) => f.name)).toContain("CONVENTIONS.md");
  });

  it("standard tier excludes extra files, full tier includes them", () => {
    const standard = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY, "standard");
    const full = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY, "full");
    expect(full.length).toBeGreaterThan(standard.length);
    expect(full.length - standard.length).toBe(EXTRA_FILES.length);
  });

  it("standard tier excludes hook-sourced files even when basename matches the root allowlist", () => {
    // Regression: previously the standard-tier filter matched only on basename,
    // so an extra like `packages/core/AGENTS.md` slipped through alongside the
    // root AGENTS.md and rendered standard indistinguishable from full.
    const rootAgents = makeFile("AGENTS.md");
    const hookAgents = makeHookFile("AGENTS.md", "packages/core/AGENTS.md");
    const hookSoul = makeHookFile("SOUL.md", "packages/persona/SOUL.md");
    const files = [rootAgents, hookAgents, hookSoul];

    const standard = filterBootstrapFilesForSession(files, MAIN_KEY, "standard");
    expect(standard).toHaveLength(1);
    expect(standard[0]?.path).toBe("/workspace/AGENTS.md");
    expect(standard[0]?.source).toBe("root");

    const full = filterBootstrapFilesForSession(files, MAIN_KEY, "full");
    expect(full).toHaveLength(3);
  });
});
