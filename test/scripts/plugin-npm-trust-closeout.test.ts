import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, assert, expect, it } from "vitest";
import { parse } from "yaml";
import { planPluginNpmTrustCloseout } from "../../scripts/plugin-npm-trust-closeout.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Job = {
  needs?: string[];
  if?: string;
  uses?: string;
  "continue-on-error"?: boolean;
  steps?: { name: string; run?: string }[];
};
type Workflow = { jobs: Record<string, Job> };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sourceSha = "a".repeat(40);
const toolingSha = "b".repeat(40);
const toolingRef = "release-publish/" + toolingSha.slice(0, 12) + "-123";
const repository = "openclaw/openclaw";
const workflow = (file: string) =>
  parse(readFileSync(".github/workflows/" + file, "utf8")) as Workflow;

function fixture() {
  const run = {
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    event: "workflow_dispatch",
    head_sha: toolingSha,
    head_branch: toolingRef,
  };
  const job = (id: number, name: string, bootstrap: boolean) => ({
    id,
    run_id: 20,
    head_sha: toolingSha,
    name: "Publish plugin npm package (" + name + ")",
    status: "completed",
    conclusion: "success",
    steps: [
      { name: "Publish approved bootstrap tarball", conclusion: bootstrap ? "success" : "skipped" },
    ],
  });
  return {
    repository,
    sourceSha,
    toolingSha,
    toolingRef,
    parentRunId: 10,
    parentRunAttempt: 1,
    releaseTag: "v2026.11.23-beta.1",
    parentRun: {
      ...run,
      id: 10,
      run_attempt: 1,
      path: ".github/workflows/openclaw-release-publish.yml",
    },
    dispatch: {
      schemaVersion: 1,
      repository,
      parentRunId: "10",
      parentRunAttempt: "1",
      parentWorkflow: ".github/workflows/openclaw-release-publish.yml",
      candidateSha: sourceSha,
      toolingSha,
      toolingRef,
      toolingFullRef: "refs/tags/" + toolingRef,
      npmRunId: 20 as number | null,
    },
    pluginRun: {
      ...run,
      id: 20,
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/plugin-npm-release.yml",
      display_title: "Plugin NPM Release [selected] " + sourceSha,
    },
    jobs: {
      total_count: 3,
      jobs: [
        job(1, "@openclaw/new", true),
        job(2, "@openclaw/existing", false),
        job(3, "@openclaw/new", true),
      ],
    },
  };
}

it("keeps required beta.1 trust closeout downstream of public activation on both release routes", () => {
  for (const [file, activation] of [
    ["openclaw-release-publish.yml", "finalize_github_release"],
    ["openclaw-release-promote.yml", "finalize"],
  ] as const) {
    const jobs = workflow(file).jobs;
    const closeout = jobs.plugin_npm_trust_closeout;
    assert(closeout, file);
    expect(closeout.needs).toContain(activation);
    expect(closeout.if).toContain("-beta.1");
    expect(closeout.if).toContain(`needs.${activation}.result == 'success'`);
    expect(closeout.uses).toBe("./.github/workflows/plugin-npm-trust-closeout.yml");
    expect(closeout["continue-on-error"]).not.toBe(true);
    for (const [name, job] of Object.entries(jobs)) {
      if (name !== "plugin_npm_trust_closeout") {
        expect(job.needs ?? []).not.toContain("plugin_npm_trust_closeout");
      }
    }
  }
});

it("retains successful bootstraps across attempts, excluding ordinary OIDC publishes", () => {
  expect(planPluginNpmTrustCloseout(fixture())).toEqual(["@openclaw/new"]);
  const input = fixture();
  input.dispatch.npmRunId = null;
  expect(planPluginNpmTrustCloseout(input)).toEqual([]);
  input.dispatch.npmRunId = 20;
  for (const job of input.jobs.jobs) {
    for (const step of job.steps) {
      step.conclusion = "skipped";
    }
  }
  expect(planPluginNpmTrustCloseout(input)).toEqual([]);
});

it("rejects unrelated or incomplete publication evidence instead of silently skipping trust", () => {
  const wrongSource = fixture();
  wrongSource.dispatch.candidateSha = "c".repeat(40);
  expect(() => planPluginNpmTrustCloseout(wrongSource)).toThrow("dispatch record");
  const wrongRun = fixture();
  wrongRun.pluginRun.head_sha = "c".repeat(40);
  expect(() => planPluginNpmTrustCloseout(wrongRun)).toThrow("publication");
  const incomplete = fixture();
  incomplete.jobs.total_count++;
  expect(() => planPluginNpmTrustCloseout(incomplete)).toThrow("truncated");
  const beta2 = fixture();
  beta2.releaseTag = "v2026.11.23-beta.2";
  expect(() => planPluginNpmTrustCloseout(beta2)).toThrow("beta.1");
});

it.each(["success", "failure"])(
  "propagates an actual child %s through the workflow shell without publishing",
  (conclusion) => {
    const root = tempDirs.make("trust-closeout-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const input = fixture();
    writeFileSync(join(root, "dispatch.json"), JSON.stringify(input.dispatch));
    const calls = join(root, "calls.jsonl");
    writeFileSync(join(root, "fixture.json"), JSON.stringify(input));
    writeFileSync(
      join(bin, "gh"),
      [
        "#!" + process.execPath,
        'const fs = require("node:fs");',
        'const fixture = JSON.parse(fs.readFileSync(process.env.CLOSEOUT_DIR + "/fixture.json", "utf8"));',
        "const args = process.argv.slice(2);",
        'let body; if (args.includes("POST")) body = fs.readFileSync(0, "utf8");',
        'fs.appendFileSync(process.env.CALLS, JSON.stringify({args, body}) + "\\n");',
        "let result;",
        'if (args.some(a => a.includes("/commits/"))) result = process.env.TOOLING_SHA;',
        "else if (body) result = {workflow_run_id: 30};",
        'else if (args.some(a => a.includes("/attempts/"))) result = fixture.parentRun;',
        'else if (args.some(a => a.includes("/jobs?"))) result = fixture.jobs;',
        'else if (args.some(a => a.endsWith("/runs/20"))) result = fixture.pluginRun;',
        'else if (args.includes("headSha,url")) result = {headSha: process.env.TOOLING_SHA, url: "https://example.test/run/30"};',
        'else if (args.includes("status,url,updatedAt")) result = {status: "completed"};',
        'else if (args.includes("conclusion,url,createdAt,updatedAt")) result = {conclusion: process.env.CONCLUSION, createdAt: "2026-11-23T00:00:00Z", updatedAt: "2026-11-23T00:01:00Z"};',
        'else if (args.includes("jobs")) result = [];',
        'else { console.error("Unexpected gh call", args); process.exit(1); }',
        'console.log(typeof result === "string" ? result : JSON.stringify(result));',
      ].join("\n"),
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      FORCE_COLOR: "1",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      CALLS: calls,
      CONCLUSION: conclusion,
      CLOSEOUT_DIR: root,
      RUNNER_TEMP: root,
      GITHUB_REPOSITORY: repository,
      GITHUB_REF: "refs/tags/" + toolingRef,
      GITHUB_RUN_ID: "10",
      GITHUB_RUN_ATTEMPT: "2",
      RELEASE_TAG: input.releaseTag,
      SOURCE_SHA: sourceSha,
      TOOLING_SHA: toolingSha,
      TOOLING_REF: toolingRef,
      PARENT_WORKFLOW_SHA: toolingSha,
      RELEASE_RUN_ID: "10",
      RELEASE_RUN_ATTEMPT: "1",
      GITHUB_OUTPUT: join(root, "output"),
      GITHUB_ENV: join(root, "env"),
      GITHUB_STEP_SUMMARY: join(root, "summary"),
    };
    const steps = workflow("plugin-npm-trust-closeout.yml").jobs.verify?.steps;
    assert(steps);
    const planScript = steps.find((s) => s.name === "Read original successful bootstrap jobs")?.run;
    const verifyScript = steps.find(
      (s) => s.name === "Verify trust through the real publishing workflow",
    )?.run;
    assert(planScript && verifyScript);
    const plan = spawnSync("bash", ["-c", planScript], { env, encoding: "utf8" });
    expect(plan.status, plan.stderr).toBe(0);
    const plugins = readFileSync(env.GITHUB_OUTPUT, "utf8").trim().slice("plugins=".length);
    expect(plugins).toBe("@openclaw/new");
    const verify = spawnSync("bash", ["-c", verifyScript], {
      env: { ...env, PLUGINS: plugins },
      encoding: "utf8",
    });
    expect(verify.status, verify.stderr).toBe(conclusion === "success" ? 0 : 1);
    expect(verify.stdout).toContain(`plugin-npm-release.yml finished with ${conclusion} in 1m00s:`);
    const requests = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; body?: string });
    const writes = requests.filter((call) => call.body);
    expect(writes).toHaveLength(1);
    const request = writes[0];
    assert(request?.body);
    expect(request.args).toContain(
      "repos/openclaw/openclaw/actions/workflows/plugin-npm-release.yml/dispatches",
    );
    expect(JSON.parse(request.body)).toEqual({
      ref: toolingRef,
      inputs: {
        publish_scope: "selected",
        ref: sourceSha,
        plugins: "@openclaw/new",
        preflight_only: "true",
        trusted_publisher_preflight: "true",
      },
    });
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8")).toContain("accepted run");
  },
);
