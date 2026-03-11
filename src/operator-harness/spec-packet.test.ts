import { describe, expect, it } from "vitest";
import {
  buildTaskPacket,
  buildSpecPacket,
  determineReviewRoles,
  extractAcceptanceCriteria,
  parseSpecPacket,
  parseTaskPacket,
  renderSpecPacket,
  renderTaskPacket,
} from "./spec-packet.js";

describe("spec-packet", () => {
  it("extracts acceptance criteria under the matching heading", () => {
    expect(
      extractAcceptanceCriteria(`
# Summary

## Acceptance Criteria
- shows a summary card
- filters active tickets

## Notes
ignore me
      `),
    ).toEqual(["shows a summary card", "filters active tickets"]);
  });

  it("adds UX review when the issue is UI-heavy", () => {
    const roles = determineReviewRoles({
      issue: {
        id: "1",
        identifier: "END-1",
        title: "Improve frontend screenshot flow",
        description: "Add a browser-tested design refinement",
        url: "https://linear.example/END-1",
        priority: 3,
        state: { id: "todo", name: "Todo", type: "unstarted" },
        labels: [],
        projectName: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
      },
      overrideRoles: undefined,
      config: {
        paperclip: { apiBase: "http://127.0.0.1:3100", companyName: "x", projectName: "x" },
        linear: { teamKey: "END", readyStateTypes: ["unstarted"], readyStateNames: ["Todo"] },
        notion: {},
        workspace: {
          repoKey: "openclaw",
          repoName: "OpenClaw",
          repoCwd: "/tmp/openclaw",
          baseBranch: "main",
        },
        artifacts: { rootDir: "/tmp/artifacts" },
        agents: {
          builder: {
            name: "builder",
            title: "Builder",
            role: "builder",
            instructionsFile: "/tmp/builder.md",
          },
          qa: { name: "qa", title: "QA", role: "qa", instructionsFile: "/tmp/qa.md" },
        },
        reviewRules: {
          default: ["qa"],
          ui: ["qa", "ux"],
          ai: ["qa", "ai"],
        },
      },
    });
    expect(roles).toEqual(["qa", "ux"]);
  });

  it("does not add AI review for non-AI words containing ai substrings", () => {
    const roles = determineReviewRoles({
      issue: {
        id: "1",
        identifier: "END-2",
        title: "Tighten waiting state copy",
        description: "Explain why tickets are waiting for review in the browser UI.",
        url: "https://linear.example/END-2",
        priority: 2,
        state: { id: "todo", name: "Todo", type: "unstarted" },
        labels: [],
        projectName: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
      },
      overrideRoles: undefined,
      config: {
        paperclip: { apiBase: "http://127.0.0.1:3100", companyName: "x", projectName: "x" },
        linear: { teamKey: "END", readyStateTypes: ["unstarted"], readyStateNames: ["Todo"] },
        notion: {},
        workspace: {
          repoKey: "openclaw",
          repoName: "OpenClaw",
          repoCwd: "/tmp/openclaw",
          baseBranch: "main",
        },
        artifacts: { rootDir: "/tmp/artifacts" },
        agents: {
          builder: {
            name: "builder",
            title: "Builder",
            role: "builder",
            instructionsFile: "/tmp/builder.md",
          },
          qa: { name: "qa", title: "QA", role: "qa", instructionsFile: "/tmp/qa.md" },
        },
        reviewRules: {
          default: ["qa"],
          ui: ["qa", "ux"],
          ai: ["qa", "ai"],
        },
      },
    });
    expect(roles).toEqual(["qa", "ux"]);
  });

  it("renders and parses a spec packet", () => {
    const spec = buildSpecPacket({
      config: {
        paperclip: { apiBase: "http://127.0.0.1:3100", companyName: "x", projectName: "x" },
        linear: { teamKey: "END", readyStateTypes: ["unstarted"], readyStateNames: ["Todo"] },
        notion: {},
        workspace: {
          repoKey: "openclaw",
          repoName: "OpenClaw",
          repoCwd: "/tmp/openclaw",
          baseBranch: "main",
          defaultStartupCommand: "python3 -m http.server 43123",
          defaultHealthcheckUrl: "http://127.0.0.1:43123/index.html",
          defaultBrowserWalkthrough: [
            { action: "open", value: "http://127.0.0.1:43123/index.html" },
          ],
        },
        artifacts: { rootDir: "/tmp/artifacts" },
        agents: {
          builder: {
            name: "builder",
            title: "Builder",
            role: "builder",
            instructionsFile: "/tmp/builder.md",
          },
          qa: { name: "qa", title: "QA", role: "qa", instructionsFile: "/tmp/qa.md" },
        },
        reviewRules: { default: ["qa"], ui: ["qa", "ux"], ai: ["qa", "ai"] },
      },
      issue: {
        id: "issue-1",
        identifier: "END-9",
        title: "Add summary card",
        description:
          "Add the new summary card.\n\n## Acceptance Criteria\n- shows counts\n- updates when filtered",
        url: "https://linear.example/END-9",
        priority: 2,
        state: { id: "todo", name: "Todo", type: "unstarted" },
        labels: ["ui"],
        projectName: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
      },
      notionEntries: [],
    });
    const rendered = renderSpecPacket(spec);
    expect(parseSpecPacket(rendered)).toEqual(spec);
    expect(spec.contractId).toBe("generic");
    expect(spec.storyboardHubUrls).toEqual([]);
  });

  it("switches Moore Bass pilot work to the real pilot contract", () => {
    const spec = buildSpecPacket({
      config: {
        paperclip: { apiBase: "http://127.0.0.1:3100", companyName: "x", projectName: "x" },
        linear: { teamKey: "END", readyStateTypes: ["unstarted"], readyStateNames: ["Todo"] },
        notion: {
          baselineUrls: [
            "https://www.notion.so/Construction-Knowledge-Platform-Storyboard-Hub-3182cb8d0fb481c08f55c19d7c9bd4f5",
          ],
        },
        workspace: {
          repoKey: "openclaw",
          repoName: "OpenClaw",
          repoCwd: "/tmp/openclaw",
          baseBranch: "main",
        },
        artifacts: { rootDir: "/tmp/artifacts" },
        agents: {
          builder: {
            name: "builder",
            title: "Builder",
            role: "builder",
            instructionsFile: "/tmp/builder.md",
          },
          qa: { name: "qa", title: "QA", role: "qa", instructionsFile: "/tmp/qa.md" },
        },
        reviewRules: { default: ["qa"], ui: ["qa", "ux"], ai: ["qa", "ai"] },
      },
      issue: {
        id: "issue-7",
        identifier: "END-7",
        title: "Pilot shell and parcel intake on clean main",
        description:
          "## Acceptance Criteria\n- A dedicated `/pilot` shell exists on clean `main`.\n- `/pilot/project` captures parcel ID, address, and project scope.",
        url: "https://linear.example/END-7",
        priority: 1,
        state: { id: "todo", name: "Todo", type: "unstarted" },
        labels: ["ui"],
        projectName: "Moore Bass Pilot: Discovery-First DD",
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
      },
      notionEntries: [
        {
          id: "hub",
          url: "https://www.notion.so/Construction-Knowledge-Platform-Storyboard-Hub-3182cb8d0fb481c08f55c19d7c9bd4f5",
          title: "Construction Knowledge Platform Storyboard Hub",
          summary: "Active discovery-first corpus.",
          markdown: "Moore Bass Pilot",
          relevantScreens: [],
          imageUrls: [],
          updatedAt: "2026-03-10T00:00:00.000Z",
        },
      ],
    });
    expect(spec.contractId).toBe("moore-bass-pilot");
    expect(spec.healthcheckUrl).toBe("http://127.0.0.1:4173/pilot/");
    expect(
      spec.browserWalkthrough.some(
        (step) => step.target === "[data-testid='pilot-home-new-project']",
      ),
    ).toBe(true);
  });

  it("adds helper commands to task packets when a task path is available", () => {
    const spec = buildSpecPacket({
      config: {
        paperclip: { apiBase: "http://127.0.0.1:3100", companyName: "x", projectName: "x" },
        linear: { teamKey: "END", readyStateTypes: ["unstarted"], readyStateNames: ["Todo"] },
        notion: {},
        workspace: {
          repoKey: "openclaw",
          repoName: "OpenClaw",
          repoCwd: "/tmp/openclaw",
          baseBranch: "main",
          defaultStartupCommand: "pnpm ui:dev --host 127.0.0.1 --port 4173",
          defaultHealthcheckUrl: "http://127.0.0.1:4173/pilot/",
          defaultBrowserWalkthrough: [{ action: "open", value: "http://127.0.0.1:4173/pilot/" }],
        },
        artifacts: { rootDir: "/tmp/artifacts" },
        agents: {
          builder: {
            name: "builder",
            title: "Builder",
            role: "builder",
            instructionsFile: "/tmp/builder.md",
          },
          qa: { name: "qa", title: "QA", role: "qa", instructionsFile: "/tmp/qa.md" },
        },
        reviewRules: { default: ["qa"], ui: ["qa", "ux"], ai: ["qa", "ai"] },
      },
      issue: {
        id: "issue-10",
        identifier: "END-10",
        title: "Create pilot validation runner",
        description: "## Acceptance Criteria\n- runs browser validation",
        url: "https://linear.example/END-10",
        priority: 1,
        state: { id: "todo", name: "Todo", type: "unstarted" },
        labels: ["ui"],
        projectName: "Moore Bass Pilot: Discovery-First DD",
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
      },
      notionEntries: [],
    });
    const task = buildTaskPacket({
      role: "builder",
      specPacket: spec,
      summary: "Implement END-10",
      artifactDir: "/tmp/artifacts/END-10/builder",
      repoRelativeArtifactDir: "operator-harness/evidence/END-10/builder",
      repoCwd: "/tmp/openclaw",
      branchName: "codex/end-10-create-pilot-validation-runner",
      baseBranch: "main",
      gitRemoteName: "origin",
      prRequired: true,
      prTitle: "[END-10] Create pilot validation runner",
      prBodyPath: "/tmp/openclaw/.openclaw-operator/pr-body.md",
      specPacketPath: "/tmp/openclaw/.openclaw-operator/spec-packet.json",
      taskPacketPath: "/tmp/openclaw/.openclaw-operator/task-builder.json",
    });
    expect(task.validationCommand).toContain("run-artifact-walkthrough.ts");
    expect(task.validationCommand).toContain("/tmp/openclaw/.openclaw-operator/task-builder.json");
    expect(task.prSyncCommand).toContain("sync-pr.ts");
    const rendered = renderTaskPacket(task);
    expect(rendered).toContain("Validation command:");
    expect(parseTaskPacket(rendered)).toEqual(task);
  });
});
