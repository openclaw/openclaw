import { describe, expect, it } from "vitest";
import { buildTaskExecutionContract } from "./task-contract.js";
import type { HarnessConfig, SpecPacket } from "./types.js";

const config: HarnessConfig = {
  paperclip: { apiBase: "http://127.0.0.1:3100", companyName: "x", projectName: "x" },
  linear: { teamKey: "END", readyStateTypes: ["unstarted"], readyStateNames: ["Todo"] },
  notion: {},
  workspace: {
    repoKey: "openclaw",
    repoName: "OpenClaw",
    repoCwd: "/tmp/openclaw",
    baseBranch: "main",
    installCommand: "pnpm install --frozen-lockfile",
  },
  artifacts: { rootDir: "/tmp/artifacts" },
  agents: {
    builder: { name: "builder", title: "Builder", role: "builder", instructionsFile: "/tmp/b.md" },
    qa: { name: "qa", title: "QA", role: "qa", instructionsFile: "/tmp/q.md" },
  },
  reviewRules: { default: ["qa"], ui: ["qa", "ux"], ai: ["qa", "ai"] },
};

const mooreBassSpec: SpecPacket = {
  kind: "parent",
  contractId: "moore-bass-pilot",
  externalTicketId: "END-7",
  upstreamIssueId: "linear-7",
  title: "Pilot shell and parcel intake on clean main",
  summary: "Build the pilot shell.",
  upstreamUrl: "https://linear.example/END-7",
  notionUrls: [],
  storyboardHubUrls: [],
  acceptanceCriteria: [],
  startupCommand: "placeholder",
  healthcheckUrl: "http://127.0.0.1:4173/pilot/",
  browserWalkthrough: [{ action: "open", value: "http://127.0.0.1:4173/pilot/" }],
  requiredArtifacts: ["before.png"],
  requiredReviewRoles: ["qa", "ux"],
  relevantScreens: [],
  notionPages: [],
  repoKey: "openclaw",
  repoName: "OpenClaw",
  repoCwd: "/tmp/openclaw",
  repoUrl: "https://github.com/openclaw/openclaw",
  baseBranch: "main",
  environmentPrerequisites: [],
};

describe("buildTaskExecutionContract", () => {
  it("assigns stable per-role ports for Moore Bass pilot work", () => {
    const builder = buildTaskExecutionContract({
      config,
      specPacket: mooreBassSpec,
      role: "builder",
    });
    const qa = buildTaskExecutionContract({
      config,
      specPacket: mooreBassSpec,
      role: "qa",
    });
    expect(builder.healthcheckUrl).toContain("/pilot/");
    expect(builder.healthcheckUrl).not.toBe(qa.healthcheckUrl);
    expect(builder.startupCommand).toContain("pnpm ui:dev");
  });
});
