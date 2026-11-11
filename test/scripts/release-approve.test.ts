import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SHA = "a".repeat(40);
const REF = `release-publish/${"b".repeat(12)}-123`;
const ENDPOINT = "repos/openclaw/openclaw/actions/runs/123/pending_deployments";

function runApproval(
  options: {
    canApprove?: boolean;
    displayTitle?: string;
    dryRun?: boolean;
    failConfirmationRead?: boolean;
    failPost?: boolean;
    headSha?: string;
    headBranch?: string;
    retainPending?: boolean;
    workflowPath?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "release-approve-"));
  const callsFile = join(root, "calls.jsonl");
  const gh = join(root, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const callsFile = ${JSON.stringify(callsFile)};
const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
fs.appendFileSync(callsFile, JSON.stringify(args) + "\\n");
const endpoint = args.find((arg) => arg.startsWith("repos/") || arg === "user");
if (endpoint === "repos/openclaw/openclaw/actions/runs/123") {
  console.log(JSON.stringify({ id: 123, head_sha: ${JSON.stringify(options.headSha ?? SHA)}, head_branch: ${JSON.stringify(options.headBranch ?? REF)}, path: ${JSON.stringify(options.workflowPath ?? ".github/workflows/openclaw-npm-release.yml")}, display_title: ${JSON.stringify(options.displayTitle ?? "openclaw-npm-release.yml [v2026.10.10] publish parent=manual/1")}, status: "in_progress" }));
} else if (endpoint === "user") {
  console.log(JSON.stringify({ login: "release-operator" }));
} else if (endpoint === ${JSON.stringify(ENDPOINT)} && args.includes("POST")) {
  if (${JSON.stringify(options.failPost ?? false)}) {
    console.error("approval response unavailable");
    process.exit(19);
  }
  console.log("{}");
} else if (endpoint === ${JSON.stringify(ENDPOINT)}) {
  const priorReads = calls.filter((call) => call.includes(${JSON.stringify(ENDPOINT)}) && !call.includes("POST")).length;
  if (priorReads > 0 && ${JSON.stringify(options.failConfirmationRead ?? false)}) {
    console.error("confirmation unavailable");
    process.exit(18);
  }
  console.log(JSON.stringify(priorReads === 0 || ${JSON.stringify(options.retainPending ?? false)} ? [{ environment: { id: 77, name: "npm-release" }, current_user_can_approve: ${JSON.stringify(options.canApprove ?? true)} }] : []));
} else {
  console.error("unexpected gh call: " + JSON.stringify(args));
  process.exit(17);
}
`,
  );
  chmodSync(gh, 0o755);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      resolve("scripts/tsx.mjs"),
      resolve("scripts/release-approve.mts"),
      "--run",
      "123",
      "--env",
      "npm-release",
      "--sha",
      SHA,
      "--release",
      "2026.10.10",
      "--workflow",
      "openclaw-npm-release.yml",
      "--ref",
      REF,
      ...(options.dryRun ? ["--dry-run"] : []),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` },
    },
  );
  const calls = readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  return { calls, result };
}

describe("release approval helper", () => {
  it("binds the run SHA and confirms the approved environment disappeared", () => {
    const { calls, result } = runApproval();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Approved npm-release for openclaw/openclaw run 123 at ${SHA}`);
    expect(
      calls.map((call) => call.find((arg) => arg.startsWith("repos/") || arg === "user")),
    ).toEqual(["repos/openclaw/openclaw/actions/runs/123", ENDPOINT, "user", ENDPOINT, ENDPOINT]);
    const post = calls.find((call) => call.includes("POST"));
    expect(post).toContain("environment_ids[]=77");
    expect(post).not.toContain("--jq");
  });

  it.each([
    { name: "SHA", options: { headSha: "b".repeat(40) } },
    { name: "workflow", options: { workflowPath: ".github/workflows/unrelated.yml" } },
    {
      name: "release ref",
      options: { headBranch: `release-publish/${"c".repeat(12)}-456` },
    },
  ])("refuses a run whose $name does not match the requested release", ({ options }) => {
    const { calls, result } = runApproval(options);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match");
    expect(calls).toHaveLength(1);
  });

  it("refuses a mismatched release title even when the tooling ref matches", () => {
    const { calls, result } = runApproval({
      displayTitle: "openclaw-npm-release.yml [v2026.10.11] publish parent=manual/1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("title does not identify release 2026.10.10");
    expect(calls).toHaveLength(1);
  });

  it.each([
    {
      name: "the approval response is unavailable",
      options: { failPost: true },
      status: "may have been submitted",
    },
    {
      name: "the gate remains pending",
      options: { retainPending: true },
      status: "was submitted",
    },
    {
      name: "the confirmation read fails",
      options: { failConfirmationRead: true },
      status: "was submitted",
    },
  ])("gives read-only reconciliation steps when $name", ({ options, status }) => {
    const { calls, result } = runApproval(options);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${status}, but its effect was not confirmed`);
    expect(result.stderr).toContain("Do not retry this approval");
    expect(result.stderr).toContain(ENDPOINT);
    expect(result.stderr).toContain("repos/openclaw/openclaw/actions/runs/123/approvals");
    expect(calls.filter((call) => call.includes("POST"))).toHaveLength(1);
  });

  it("refuses an approval the authenticated identity cannot perform", () => {
    const { calls, result } = runApproval({ canApprove: false });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Authenticated GitHub identity cannot approve npm-release");
    expect(calls.some((call) => call.includes("POST"))).toBe(false);
  });

  it("previews the exact bound approval without writing", () => {
    const { calls, result } = runApproval({ dryRun: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Would approve npm-release");
    expect(calls.some((call) => call.includes("POST"))).toBe(false);
    expect(calls).toHaveLength(3);
  });
});
