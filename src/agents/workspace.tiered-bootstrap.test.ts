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
  };
}

// Session key formats: agent:<agentId>:<rest>
const MAIN_KEY = "agent:main:main";
const SUBAGENT_KEY = "agent:main:subagent:task123";
const CRON_KEY = "agent:main:cron:job123";

const ALL_FILES: WorkspaceBootstrapFile[] = [
  makeFile("AGENTS.md"),
  makeFile("SOUL.md"),
  makeFile("TOOLS.md"),
  makeFile("IDENTITY.md"),
  makeFile("USER.md"),
  makeFile("HEARTBEAT.md"),
  makeFile("BOOTSTRAP.md"),
  makeFile("MEMORY.md"),
];

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
  it("returns all files for main session (standard tier)", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES);
    expect(result).toHaveLength(ALL_FILES.length);
  });

  it("returns minimal files for subagent session", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, SUBAGENT_KEY);
    expect(result.map((f) => f.name)).toEqual(["AGENTS.md", "TOOLS.md"]);
  });

  it("returns minimal files for cron session", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, CRON_KEY);
    expect(result.map((f) => f.name)).toEqual(["AGENTS.md", "TOOLS.md"]);
  });

  it("returns all files when tierOverride is 'standard' even for subagent", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, SUBAGENT_KEY, "standard");
    expect(result).toHaveLength(ALL_FILES.length);
  });

  it("returns minimal files when tierOverride is 'minimal' for main session", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY, "minimal");
    expect(result.map((f) => f.name)).toEqual(["AGENTS.md", "TOOLS.md"]);
  });

  it("returns all files when tierOverride is 'full'", () => {
    const result = filterBootstrapFilesForSession(ALL_FILES, MAIN_KEY, "full");
    expect(result).toHaveLength(ALL_FILES.length);
  });
});
