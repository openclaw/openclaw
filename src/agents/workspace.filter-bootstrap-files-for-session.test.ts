import { describe, expect, it } from "vitest";
import { filterBootstrapFilesForSession } from "./workspace.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

const makeFile = (name: string): WorkspaceBootstrapFile => ({
  name,
  path: `/workspace/${name}`,
  content: `# ${name}`,
  missing: false,
});

const allFiles: WorkspaceBootstrapFile[] = [
  makeFile("AGENTS.md"),
  makeFile("TOOLS.md"),
  makeFile("SOUL.md"),
  makeFile("USER.md"),
  makeFile("IDENTITY.md"),
  makeFile("MEMORY.md"),
];

describe("filterBootstrapFilesForSession", () => {
  it("returns all files for main session (no sessionKey)", () => {
    const result = filterBootstrapFilesForSession(allFiles);
    expect(result).toEqual(allFiles);
  });

  it("returns all files for main session (main sessionKey)", () => {
    const result = filterBootstrapFilesForSession(allFiles, "agent:main:main");
    expect(result).toEqual(allFiles);
  });

  it("returns only default files (AGENTS.md, TOOLS.md) for subagent without config", () => {
    const result = filterBootstrapFilesForSession(allFiles, "agent:main:subagent:abc123");
    expect(result.map((f) => f.name)).toEqual(["AGENTS.md", "TOOLS.md"]);
  });

  it("returns configured files for subagent with bootstrapFiles config", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            bootstrapFiles: ["AGENTS.md", "TOOLS.md", "SOUL.md", "USER.md"],
          },
        },
      },
    };
    const result = filterBootstrapFilesForSession(allFiles, "agent:main:subagent:abc123", config);
    expect(result.map((f) => f.name)).toEqual(["AGENTS.md", "TOOLS.md", "SOUL.md", "USER.md"]);
  });

  it("returns all workspace files if configured with all file names", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            bootstrapFiles: ["AGENTS.md", "TOOLS.md", "SOUL.md", "USER.md", "IDENTITY.md", "MEMORY.md"],
          },
        },
      },
    };
    const result = filterBootstrapFilesForSession(allFiles, "agent:main:subagent:abc123", config);
    expect(result).toEqual(allFiles);
  });

  it("falls back to defaults if bootstrapFiles is empty array", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            bootstrapFiles: [],
          },
        },
      },
    };
    const result = filterBootstrapFilesForSession(allFiles, "agent:main:subagent:abc123", config);
    expect(result.map((f) => f.name)).toEqual(["AGENTS.md", "TOOLS.md"]);
  });

  it("config does not affect main session", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            bootstrapFiles: ["SOUL.md"],
          },
        },
      },
    };
    const result = filterBootstrapFilesForSession(allFiles, "agent:main:main", config);
    expect(result).toEqual(allFiles);
  });
});
