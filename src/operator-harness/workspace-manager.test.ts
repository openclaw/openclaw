import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "./types.js";
import {
  buildRepoRelativeArtifactDir,
  buildTicketBranchName,
  buildWorkspacePath,
} from "./workspace-manager.js";

const config: HarnessConfig = {
  paperclip: { apiBase: "http://127.0.0.1:3100", companyName: "x", projectName: "x" },
  linear: { teamKey: "END", readyStateTypes: ["unstarted"], readyStateNames: ["Todo"] },
  notion: {},
  workspace: {
    repoKey: "openclaw",
    repoName: "OpenClaw",
    repoCwd: "/tmp/openclaw",
    repoUrl: "https://github.com/openclaw/openclaw",
    baseBranch: "main",
    branchPrefix: "codex",
    ticketWorkspaceRootDir: "/tmp/openclaw-workspaces",
  },
  artifacts: { rootDir: "/tmp/artifacts" },
  agents: {
    builder: { name: "builder", title: "Builder", role: "builder", instructionsFile: "/tmp/b.md" },
    qa: { name: "qa", title: "QA", role: "qa", instructionsFile: "/tmp/q.md" },
  },
  reviewRules: { default: ["qa"], ui: ["qa", "ux"], ai: ["qa", "ai"] },
};

describe("workspace-manager", () => {
  it("builds deterministic branch names and workspace paths", () => {
    expect(
      buildTicketBranchName(config, "END-7", "Pilot shell and parcel intake on clean main"),
    ).toBe("codex/end-7-pilot-shell-and-parcel-intake-on-clean-main");
    expect(buildWorkspacePath(config, "END-7", "builder")).toBe(
      "/tmp/openclaw-workspaces/END-7/builder",
    );
    expect(buildRepoRelativeArtifactDir("END-7", "builder")).toBe(
      "operator-harness/evidence/END-7/builder",
    );
  });
});
