// Issue Fix Agent tests cover local maintainer automation behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseIssueFixAgentArgs,
  renderIssueFixAgentUsage,
} from "../../scripts/issue-fix-agent-main.ts";
import {
  classifyIssueCandidate,
  formatScanResult,
  sortQualifiedCandidates,
} from "../../scripts/issue-fix-agent-lib/candidates.ts";
import {
  classifyCheckSnapshots,
  normalizePrCheckRollup,
} from "../../scripts/issue-fix-agent-lib/checks.ts";
import type { CommandRunner } from "../../scripts/issue-fix-agent-lib/command-runner.ts";
import { fetchOpenIssueCandidates } from "../../scripts/issue-fix-agent-lib/github.ts";
import {
  renderIssueFixAgentPrBody,
  renderIssueFixAgentPrTitle,
} from "../../scripts/issue-fix-agent-lib/pr.ts";
import {
  appendIssueFixAgentEvent,
  createIssueFixAgentRun,
  getLatestOpenIssueFixAgentRun,
  openIssueFixAgentState,
  transitionIssueFixAgentRun,
} from "../../scripts/issue-fix-agent-lib/state.sqlite.ts";
import type { IssueCandidate } from "../../scripts/issue-fix-agent-lib/types.ts";
import { runIssueFixAgentCommand } from "../../scripts/issue-fix-agent-lib/workflow.ts";

function issue(overrides: Partial<IssueCandidate> = {}): IssueCandidate {
  return {
    author: "external-user",
    body: "Repro: running openclaw status throws TypeError at src/commands/status.ts:12",
    isPullRequest: false,
    labels: ["bug"],
    number: 12345,
    title: "status crashes with TypeError",
    updatedAt: "2026-06-01T00:00:00Z",
    url: "https://github.com/openclaw/openclaw/issues/12345",
    ...overrides,
  };
}

describe("issue-fix-agent args", () => {
  it("parses scan without write flags", () => {
    expect(parseIssueFixAgentArgs(["scan"])).toStrictEqual({
      command: "scan",
      execute: false,
      pushPr: false,
      yes: false,
    });
  });

  it("requires --execute before --push-pr", () => {
    expect(() => parseIssueFixAgentArgs(["run", "--push-pr"])).toThrow(
      "--push-pr requires --execute",
    );
  });

  it("parses monitor with a PR number", () => {
    expect(parseIssueFixAgentArgs(["monitor", "12345"])).toStrictEqual({
      command: "monitor",
      execute: false,
      prNumber: 12345,
      pushPr: false,
      yes: false,
    });
  });

  it("renders usage with every first-version command", () => {
    expect(renderIssueFixAgentUsage()).toContain("scripts/issue-fix-agent scan");
    expect(renderIssueFixAgentUsage()).toContain("scripts/issue-fix-agent gc --dry-run");
  });
});

describe("issue-fix-agent candidates", () => {
  it("qualifies concrete narrow bug reports", () => {
    const result = classifyIssueCandidate(issue());
    expect(result.kind).toBe("qualified");
    if (result.kind === "qualified") {
      expect(result.candidate.score).toBeGreaterThan(0);
      expect(result.candidate.evidence).toContain("concrete symptom");
    }
  });

  it("skips pull requests and high-risk labels", () => {
    expect(classifyIssueCandidate(issue({ isPullRequest: true }))).toMatchObject({
      kind: "skipped",
      reason: "item is a pull request",
    });
    expect(classifyIssueCandidate(issue({ labels: ["security"] }))).toMatchObject({
      kind: "skipped",
      reason: "high-risk label: security",
    });
  });

  it("sorts qualified candidates by score then issue number", () => {
    const first = classifyIssueCandidate(
      issue({ labels: ["bug", "clawsweeper:source-repro"], number: 2 }),
    );
    const second = classifyIssueCandidate(issue({ number: 1 }));
    if (first.kind !== "qualified" || second.kind !== "qualified") {
      throw new Error("expected qualified candidates");
    }
    expect(sortQualifiedCandidates([second.candidate, first.candidate]).map((entry) => entry.number))
      .toEqual([2, 1]);
  });

  it("formats scan output with qualified and skipped rows", () => {
    const output = formatScanResult({
      qualified: [{ ...issue(), score: 5, evidence: ["concrete symptom"] }],
      skipped: [{ ...issue({ number: 99 }), reason: "high-risk label: security" }],
    });
    expect(output).toContain("#12345 status crashes with TypeError score=5");
    expect(output).toContain("skipped #99: high-risk label: security");
  });
});

describe("issue-fix-agent sqlite state", () => {
  it("creates a run and resumes the latest non-terminal run", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-fix-agent-state-"));
    const store = openIssueFixAgentState(path.join(root, "issue-fix-agent.sqlite"));
    const run = createIssueFixAgentRun(store, {
      issueNumber: 12345,
      issueTitle: "status crashes",
      issueUrl: "https://github.com/openclaw/openclaw/issues/12345",
      source: "test",
    });
    transitionIssueFixAgentRun(store, run.runId, "qualified", {
      reason: "candidate passed gates",
    });
    appendIssueFixAgentEvent(store, run.runId, "note", { message: "verified source repro" });

    expect(getLatestOpenIssueFixAgentRun(store)).toMatchObject({
      issueNumber: 12345,
      state: "qualified",
    });
    store.close();
  });

  it("rejects invalid backward transitions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-fix-agent-transition-"));
    const store = openIssueFixAgentState(path.join(root, "issue-fix-agent.sqlite"));
    const run = createIssueFixAgentRun(store, {
      issueNumber: 12345,
      issueTitle: "status crashes",
      issueUrl: "https://github.com/openclaw/openclaw/issues/12345",
      source: "test",
    });
    transitionIssueFixAgentRun(store, run.runId, "qualified", {
      reason: "candidate passed gates",
    });

    expect(() =>
      transitionIssueFixAgentRun(store, run.runId, "discovered", { reason: "backward" }),
    ).toThrow("invalid issue-fix-agent transition");
    store.close();
  });
});

describe("issue-fix-agent github reads", () => {
  it("reads open issues through gitcrawl and normalizes candidates", async () => {
    const calls: string[][] = [];
    const runCommand: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            author: { login: "external-user" },
            body: "Repro: TypeError in src/commands/status.ts",
            labels: ["bug"],
            number: 12345,
            title: "status crashes",
            updatedAt: "2026-06-01T00:00:00Z",
            url: "https://github.com/openclaw/openclaw/issues/12345",
          },
        ]),
      };
    };

    await expect(fetchOpenIssueCandidates({ limit: 5, runCommand })).resolves.toMatchObject([
      {
        author: "external-user",
        isPullRequest: false,
        number: 12345,
      },
    ]);
    expect(calls[0]).toEqual([
      "gitcrawl",
      "search",
      "issues",
      "repo:openclaw/openclaw state:open is:issue",
      "-R",
      "openclaw/openclaw",
      "--state",
      "open",
      "--json",
      "number,title,url,body,labels,author,updatedAt",
      "--limit",
      "5",
    ]);
  });
});

describe("issue-fix-agent workflow", () => {
  function gitcrawlIssueStdout() {
    return JSON.stringify([
      {
        author: { login: "external-user" },
        body: "Repro: TypeError in src/commands/status.ts",
        labels: ["bug"],
        number: 12345,
        title: "status crashes",
        updatedAt: "2026-06-01T00:00:00Z",
        url: "https://github.com/openclaw/openclaw/issues/12345",
      },
    ]);
  }

  it("scan prints qualified candidates and performs no writes", async () => {
    const calls: string[][] = [];
    const output: string[] = [];
    await runIssueFixAgentCommand({
      args: { command: "scan", execute: false, pushPr: false, yes: false },
      out: (line) => output.push(line),
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        return { code: 0, stderr: "", stdout: gitcrawlIssueStdout() };
      },
    });
    expect(output.join("\n")).toContain("#12345 status crashes");
    expect(calls.every((call) => call[0] === "gitcrawl")).toBe(true);
  });

  it("run dry-runs through qualified and records a resumable state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-fix-run-"));
    const output: string[] = [];
    await runIssueFixAgentCommand({
      args: { command: "run", execute: false, pushPr: false, yes: false },
      out: (line) => output.push(line),
      runCommand: async () => ({ code: 0, stderr: "", stdout: gitcrawlIssueStdout() }),
      statePath: path.join(root, "state.sqlite"),
    });

    expect(output.join("\n")).toContain("Dry run stopped at qualified");
    const store = openIssueFixAgentState(path.join(root, "state.sqlite"));
    expect(getLatestOpenIssueFixAgentRun(store)).toMatchObject({
      issueNumber: 12345,
      state: "qualified",
    });
    store.close();
  });

  it("status reports when there is no active run", async () => {
    const output: string[] = [];
    const statePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "issue-fix-status-")),
      "state.sqlite",
    );
    await runIssueFixAgentCommand({
      args: { command: "status", execute: false, pushPr: false, yes: false },
      out: (line) => output.push(line),
      runCommand: async () => ({ code: 0, stderr: "", stdout: "" }),
      statePath,
    });
    expect(output.join("\n")).toContain("No active issue-fix-agent run.");
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("execute mode stops before push and PR creation", async () => {
    const output: string[] = [];
    await runIssueFixAgentCommand({
      args: { command: "run", execute: true, pushPr: false, yes: false },
      out: (line) => output.push(line),
      runCommand: async () => ({ code: 0, stderr: "", stdout: gitcrawlIssueStdout() }),
      statePath: path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "issue-fix-execute-")),
        "state.sqlite",
      ),
    });

    expect(output.join("\n")).toContain("Execution stopped before push/PR");
  });

  it("monitor prints failed relevant checks", async () => {
    const calls: string[][] = [];
    const output: string[] = [];
    await runIssueFixAgentCommand({
      args: { command: "monitor", execute: false, prNumber: 123, pushPr: false, yes: false },
      out: (line) => output.push(line),
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify([
            {
              conclusion: "FAILURE",
              detailsUrl: "https://example.test/check",
              name: "Test",
              status: "COMPLETED",
            },
          ]),
        };
      },
    });

    expect(calls[0]).toEqual([
      "gh",
      "pr",
      "view",
      "123",
      "--repo",
      "openclaw/openclaw",
      "--json",
      "statusCheckRollup",
      "--jq",
      ".statusCheckRollup",
    ]);
    expect(output.join("\n")).toContain("PR #123 checks: failed");
    expect(output.join("\n")).toContain("failed: Test https://example.test/check");
  });
});

describe("issue-fix-agent pr rendering", () => {
  it("renders a draft PR title and body with verification evidence", () => {
    expect(renderIssueFixAgentPrTitle({ issueNumber: 12345, scope: "status" })).toBe(
      "fix(status): address issue #12345",
    );
    const body = renderIssueFixAgentPrBody({
      issueNumber: 12345,
      issueUrl: "https://github.com/openclaw/openclaw/issues/12345",
      runId: "ifr_1",
      touchedFiles: ["src/commands/status.ts", "src/commands/status.test.ts"],
      verification: ["node scripts/run-vitest.mjs src/commands/status.test.ts"],
    });
    expect(body).toContain("Closes: https://github.com/openclaw/openclaw/issues/12345");
    expect(body).toContain("Automation run: `ifr_1`");
    expect(body).toContain("node scripts/run-vitest.mjs src/commands/status.test.ts");
  });
});

describe("issue-fix-agent checks", () => {
  it("classifies all successful relevant checks as land ready", () => {
    const snapshots = normalizePrCheckRollup([
      {
        conclusion: "SUCCESS",
        detailsUrl: "https://example.test/check",
        name: "Test",
        status: "COMPLETED",
      },
    ]);

    expect(classifyCheckSnapshots(snapshots)).toStrictEqual({
      failed: [],
      kind: "land_ready",
      pending: [],
    });
  });

  it("reports failed relevant checks", () => {
    const snapshots = normalizePrCheckRollup([
      {
        conclusion: "FAILURE",
        detailsUrl: "https://example.test/check",
        name: "Test",
        status: "COMPLETED",
      },
    ]);

    expect(classifyCheckSnapshots(snapshots)).toMatchObject({
      failed: [{ name: "Test" }],
      kind: "failed",
    });
  });

  it("reports failed commit status contexts", () => {
    const snapshots = normalizePrCheckRollup([
      {
        context: "ci/external",
        state: "FAILURE",
        targetUrl: "https://example.test/status",
      },
    ]);

    expect(classifyCheckSnapshots(snapshots)).toMatchObject({
      failed: [{ detailsUrl: "https://example.test/status", name: "ci/external" }],
      kind: "failed",
    });
  });

  it("ignores routine checks", () => {
    const snapshots = normalizePrCheckRollup([
      {
        conclusion: "FAILURE",
        detailsUrl: "https://example.test/labeler",
        name: "Labeler",
        status: "COMPLETED",
      },
      {
        conclusion: "SUCCESS",
        detailsUrl: "https://example.test/test",
        name: "Test",
        status: "COMPLETED",
      },
    ]);

    expect(classifyCheckSnapshots(snapshots).kind).toBe("land_ready");
  });

  it("does not mark empty relevant checks as land ready", () => {
    expect(classifyCheckSnapshots([])).toStrictEqual({
      failed: [],
      kind: "pending",
      pending: [],
    });
    const routineOnly = normalizePrCheckRollup([
      {
        conclusion: "SUCCESS",
        detailsUrl: "https://example.test/labeler",
        name: "Labeler",
        status: "COMPLETED",
      },
    ]);

    expect(classifyCheckSnapshots(routineOnly)).toStrictEqual({
      failed: [],
      kind: "pending",
      pending: [],
    });
  });
});
