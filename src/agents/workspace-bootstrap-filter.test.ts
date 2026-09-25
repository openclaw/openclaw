import { describe, expect, it } from "vitest";
import { filterBootstrapFilesForSession, type WorkspaceBootstrapFile } from "./workspace.js";

function expectSubagentAllowedBootstrapNames(files: WorkspaceBootstrapFile[]) {
  const names = files.map((file) => file.name);
  expect(names).toStrictEqual(["AGENTS.md"]);
}

function expectCronAllowedBootstrapNames(files: WorkspaceBootstrapFile[]) {
  const names = files.map((file) => file.name);
  expect(names).toStrictEqual(["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]);
}

describe("filterBootstrapFilesForSession", () => {
  const mockFiles: WorkspaceBootstrapFile[] = [
    { name: "AGENTS.md", path: "/w/AGENTS.md", content: "", missing: false },
    { name: "SOUL.md", path: "/w/SOUL.md", content: "", missing: false },
    { name: "IDENTITY.md", path: "/w/IDENTITY.md", content: "", missing: false },
    { name: "USER.md", path: "/w/USER.md", content: "", missing: false },
    { name: "BOOTSTRAP.md", path: "/w/BOOTSTRAP.md", content: "", missing: false },
    { name: "MEMORY.md", path: "/w/MEMORY.md", content: "", missing: false },
  ];

  it("returns all files for main session (no sessionKey)", () => {
    const result = filterBootstrapFilesForSession(mockFiles);
    expect(result).toStrictEqual(mockFiles);
  });

  it("returns all files for normal (non-subagent, non-cron) session key", () => {
    const result = filterBootstrapFilesForSession(mockFiles, "agent:default:chat:main");
    expect(result).toStrictEqual(mockFiles);
  });

  it("filters to allowlist for subagent sessions", () => {
    const result = filterBootstrapFilesForSession(mockFiles, "agent:default:subagent:task-1");
    expectSubagentAllowedBootstrapNames(result);
  });

  it("filters to allowlist for cron sessions", () => {
    const result = filterBootstrapFilesForSession(mockFiles, "agent:default:cron:daily-check");
    expectCronAllowedBootstrapNames(result);
  });
});
