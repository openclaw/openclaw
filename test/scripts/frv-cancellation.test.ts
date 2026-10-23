import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import { cancelReleaseTree } from "../../scripts/frv-cancellation.mjs";
import { createClient } from "../../scripts/frv.mjs";
import {
  releaseChildSpec,
  releaseExecutionPlanSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import {
  child,
  executionPlanArtifact,
  REPOSITORY,
  rootRun,
  runFor,
  SHA,
  SOURCE_REF,
  TARGET_SHA,
} from "./frv.test-support.js";

const completedJob = (id: number, name: string) => ({
  id,
  name,
  run_attempt: 1,
  status: "completed",
});
const runUrl = (id: number) => `https://github.com/${REPOSITORY}/actions/runs/${id}`;
const telegramRun = (id: number, attempt = 1, nonce = "c") => ({
  ...runFor(child("releaseChecks", "303"), 1, null),
  id,
  display_title: `OpenClaw Release Telegram QA release-checks-303-${attempt}-${nonce.repeat(32)}`,
  path: ".github/workflows/openclaw-release-telegram-qa.yml",
});

function cancellationFixture(
  options: { nested?: boolean; delayed?: boolean; borrowed?: boolean } = {},
) {
  const entry = child("releaseChecks", "303");
  const plan = executionPlanArtifact({ children: [entry] });
  if (options.borrowed) {
    plan.evidenceReuse = { ...plan.evidenceReuse, requested: true };
    for (const planned of plan.children) {
      planned.source = "reused";
    }
    plan.evidenceReuse.requested = false;
    plan.sha256 = releaseExecutionPlanSha256(plan);
  }
  const runs = new Map<string, Record<string, unknown>>([
    ["77", rootRun(1, null)],
    ["303", runFor(entry, 1, null)],
  ]);
  if (options.nested) {
    runs.set("909", telegramRun(909));
  }
  const sent: Array<[string, boolean]> = [];
  const upload = {
    name: "Upload immutable release execution plan",
    number: 2,
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-09T00:00:00Z",
    completed_at: "2026-10-09T00:00:02Z",
  };
  const sealer = {
    ...completedJob(1, "Seal release execution plan"),
    steps: [upload],
  };
  const jobs = [sealer, completedJob(2, releaseChildSpec(entry.key).parentJobName)];
  const logs = new Map([
    [2, `TARGET_SHA: ${TARGET_SHA}\nDispatched ${entry.workflow}: ${runUrl(303)} (attempt 1)`],
    [3, `Dispatched trusted Telegram QA: ${runUrl(909)}`],
  ]);
  const retained = {
    plan,
    artifact: {
      workflow_run: { id: 77, head_sha: SHA, head_branch: SOURCE_REF },
      created_at: "2026-10-09T00:00:01Z",
    },
  };
  const evidenceClient = {
    ...createClient(REPOSITORY).getReleaseEvidenceClient(),
    getWorkflowSource: (_sha: string) => "name: Full Release Validation",
    getJobLog: async (id: number) => logs.get(id)!,
    loadExecutionPlanEvidence: (_runId: string) => retained,
  };
  const client = {
    ...createClient(REPOSITORY),
    getReleaseEvidenceClient: () => evidenceClient,
    getRun: async (id: string) => structuredClone(runs.get(id)!),
    getParentJobs: async () => jobs,
    getAttemptJobs: async (_runId: string, _runAttempt: number) => [
      {
        ...completedJob(3, "Run QA Lab live Telegram lane"),
        ...(!options.nested && { conclusion: "skipped" }),
      },
    ],
    getJobLog: async (id: number) => logs.get(id)!,
    cancelRun: async (id: string, force: boolean) => {
      sent.push([id, force]);
      if (!options.delayed || force) {
        Object.assign(runs.get(id)!, { status: "completed", conclusion: "cancelled" });
      }
    },
  };
  function producer(name: string, workflow: string, title: string) {
    jobs.push(completedJob(4, name));
    logs.set(4, `Dispatched ${workflow}: ${runUrl(808)} (attempt 1)`);
    runs.set("808", {
      ...runs.get("303")!,
      id: 808,
      path: `.github/workflows/${workflow}`,
      display_title: title,
    });
  }
  return { client, evidenceClient, retained, runs, sent, jobs, sealer, upload, logs, producer };
}

// Protect the operator boundary: complete owned tree, fresh attempts, no borrowed-run mutation.
describe("FRV cancellation tree", () => {
  let fixture: ReturnType<typeof cancellationFixture>;
  beforeEach(() => {
    fixture = cancellationFixture();
  });
  async function cancel(complete: boolean, options: { force?: boolean } = {}) {
    const result = await cancelReleaseTree("77", fixture.client, options);
    expect(result.complete).toBe(complete);
    return result;
  }
  const sentIds = () => fixture.sent.map(([id]) => id);

  it("authenticates a plan sealed by a pre-seal recovery attempt", async () => {
    fixture.retained.plan.sealParentRunAttempt = 2;
    fixture.retained.plan.sha256 = releaseExecutionPlanSha256(fixture.retained.plan);
    fixture.sealer.run_attempt = 2;
    await cancel(true);
    expect(sentIds()).toEqual(["303", "77"]);
  });

  it("includes earlier Telegram descendants beside runnerless rerun copies", async () => {
    fixture = cancellationFixture({ nested: true });
    fixture.runs.get("303")!.run_attempt = 2;
    fixture.runs.set("919", telegramRun(919, 2, "d"));
    fixture.logs.set(4, `Dispatched trusted Telegram QA: ${runUrl(919)}`);
    fixture.client.getAttemptJobs = async (_runId, attempt) => {
      const completed = {
        id: attempt === 1 ? 3 : 4,
        name: "Run QA Lab live Telegram lane",
        run_attempt: attempt,
        status: "completed",
        runner_id: 42,
        runner_name: "GitHub Actions 1",
        steps: [{ name: "Dispatch", status: "completed", conclusion: "success" }],
      };
      const queued = { ...completed, id: 40, status: "queued", runner_id: 0, runner_name: "" };
      return attempt === 2 ? [queued, completed, queued] : [completed];
    };
    await cancel(true);
    expect(sentIds()).toEqual(["909", "919", "303", "77"]);
    await cancel(true);
    expect(fixture.sent).toHaveLength(4);
  });
  it("rejects an independently runner-assigned duplicate rather than borrowing its dispatch", async () => {
    fixture = cancellationFixture({ nested: true });
    const read = fixture.client.getAttemptJobs;
    fixture.client.getAttemptJobs = async (id, attempt) => {
      const jobs = await read(id, attempt);
      return jobs.flatMap((job) => [{ ...job, id: 40, status: "queued", runner_id: 42 }, job]);
    };
    const result = await cancel(false);
    expect(fixture.sent.some(([id]) => id === "909")).toBe(false);
    expect(result.failures).not.toEqual([]);
  });
  it("reports delayed cancellations as active until explicit force settles them", async () => {
    fixture = cancellationFixture({ delayed: true });
    const first = await cancel(false);
    expect(first.activeRunIds).toEqual(["303", "77"]);
    await cancel(true, { force: true });
    expect(fixture.sent).toEqual([
      ["303", false],
      ["77", false],
      ["303", true],
      ["77", true],
    ]);
  });
  it("continues after a lost cancellation response and resumes remaining exact children", async () => {
    fixture = cancellationFixture({ nested: true });
    const sendCancel = fixture.client.cancelRun;
    let interrupted = true;
    fixture.client.cancelRun = async (id, force) => {
      if (id === "303" && interrupted) {
        interrupted = false;
        throw new Error("transport interrupted");
      }
      await sendCancel(id, force);
    };
    await cancel(false);
    await cancel(true);
    expect(fixture.sent).toEqual([
      ["909", false],
      ["77", false],
      ["303", false],
    ]);
  });
  it("resolves a lost response or conflict once the exact attempt is observed terminal", async () => {
    const sendCancel = fixture.client.cancelRun;
    fixture.client.cancelRun = async (id, force) => {
      await sendCancel(id, force);
      throw new Error("HTTP 409 / response lost");
    };
    const result = await cancel(true);
    expect(result.failures).toEqual([]);
    expect(sentIds()).toEqual(["303", "77"]);
  });
  it("includes the exact independently dispatched plugin npm producer", async () => {
    fixture.producer(
      "Prepare exact plugin npm artifacts",
      "plugin-npm-release.yml",
      `Plugin NPM Artifact Preflight [default] ${TARGET_SHA} (full-release-validation-77-1-plugin-npm-preflight)`,
    );
    await cancel(true);
    expect(sentIds()).toEqual(["303", "808", "77"]);
    expect(fixture.runs.get("808")?.status).toBe("completed");
  });
  it("reconciles the exact npm producer and rejects another parent's nonce", async () => {
    fixture.producer(
      "Prepare release npm artifacts",
      "full-release-artifacts.yml",
      "Full Release Artifacts full-release-validation-77-1-artifacts-npm",
    );
    fixture.runs.get("808")!.head_repository = { full_name: REPOSITORY };
    await cancel(true);
    expect(sentIds()).toEqual(["303", "808", "77"]);
    fixture.runs.get("808")!.display_title =
      "Full Release Artifacts full-release-validation-88-1-artifacts-npm";
    fixture.runs.get("808")!.status = "in_progress";
    const sent = fixture.sent.length;
    await cancel(false);
    expect(fixture.sent).toHaveLength(sent);
  });
  it("reports an unsettled plugin producer without guessing its run authority", async () => {
    fixture.jobs.push({
      ...completedJob(4, "Prepare exact plugin npm artifacts"),
      status: "in_progress",
    });
    const result = await cancel(false);
    expect(result.failures.join(" ")).toContain("dispatch observation unavailable");
    expect(sentIds()).toEqual(["303", "77"]);
    expect(result.nextCommand).toContain("frv cancel --run 77");
  });
  it("authenticates republished rerun plans through the original retained digest witness", async () => {
    fixture.runs.get("77")!.run_attempt = 2;
    fixture.retained.artifact.created_at = "2026-10-09T01:00:00Z";
    fixture.evidenceClient.getWorkflowSource = () =>
      "  FULL_RELEASE_EXECUTION_PLAN_RESTORE_CONTRACT: 1";
    fixture.sealer.steps.push({
      name: "Record immutable release execution plan digest",
      number: 3,
      status: "completed",
      conclusion: "success",
      started_at: "2026-10-09T00:00:02Z",
      completed_at: "2026-10-09T00:00:03Z",
    });
    fixture.logs.set(
      1,
      `2026-10-09T00:00:02.100Z FRV_EXECUTION_PLAN_SHA256=${fixture.retained.plan.sha256}`,
    );
    await cancel(true);
    fixture.logs.set(1, `2026-10-09T00:00:02.100Z FRV_EXECUTION_PLAN_SHA256=${"a".repeat(64)}`);
    await expect(cancel(true)).rejects.toThrow("original");
  });
  it("fences parent or intermediate-owner replacement during the final descendant read", async () => {
    for (const changedId of ["77", "303"]) {
      fixture = cancellationFixture({ nested: true });
      const read = fixture.client.getRun;
      let reads = 0;
      fixture.client.getRun = async (id) => {
        const run = await read(id);
        if (id === "909" && ++reads === 2) {
          fixture.runs.get(changedId)!.run_attempt = 2;
        }
        return run;
      };
      await cancel(false);
      expect(fixture.sent.some(([id]) => id === "909")).toBe(false);
    }
  });
  it("never cancels borrowed children or unrelated runs", async () => {
    fixture = cancellationFixture({ borrowed: true });
    const result = await cancelReleaseTree("77", fixture.client);
    expect(result.excludedRunIds).toEqual(["303"]);
    expect(fixture.sent).toEqual([["77", false]]);
    expect(fixture.runs.get("303")?.status).toBe("in_progress");
  });
  it("previews without mutations and rejects a plan not uploaded by its exact producer", async () => {
    const preview = await cancelReleaseTree("77", fixture.client, { dryRun: true });
    expect(preview.cancellation.map((run) => run.state)).toEqual(["would-cancel", "would-cancel"]);
    expect(fixture.sent).toEqual([]);
    fixture.upload.conclusion = "failure";
    await expect(cancelReleaseTree("77", fixture.client)).rejects.toThrow(
      "exact original successful upload",
    );
  });
  it("executes forced cancellation through the real CLI with a secretless controlled GitHub transport", async () => {
    const retained = fixture.client.getReleaseEvidenceClient().loadExecutionPlanEvidence("77");
    const directory = mkdtempSync(join(tmpdir(), "frv-cancel-cli-"));
    const script = join(directory, "gh");
    const zip = new JSZip();
    zip.file("full-release-execution-plan.json", JSON.stringify(retained.plan));
    const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const artifact = {
      ...retained.artifact,
      id: 700,
      name: "full-release-execution-plan-77",
      expired: false,
      size_in_bytes: archive.length,
      digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    };
    const source = Buffer.from("name: Full Release Validation");
    const attemptJobs = await fixture.client.getAttemptJobs("303", 1);
    const responses: Record<string, unknown> = {
      "actions/runs/77/artifacts?per_page=100&page=1": { total_count: 1, artifacts: [artifact] },
      "actions/artifacts/700": artifact,
      "actions/runs/77/jobs?filter=all&per_page=100": fixture.jobs,
      "actions/runs/303/attempts/1/jobs?per_page=100": attemptJobs,
      "actions/jobs/2/logs": fixture.logs.get(2),
      [`contents/.github/workflows/full-release-validation.yml?ref=${SHA}`]: {
        type: "file",
        encoding: "base64",
        path: ".github/workflows/full-release-validation.yml",
        size: source.length,
        content: source.toString("base64"),
        sha: createHash("sha1").update(`blob ${source.length}\0`).update(source).digest("hex"),
      },
    };
    writeFileSync(join(directory, "responses.json"), JSON.stringify(responses));
    writeFileSync(join(directory, "runs.json"), JSON.stringify(Object.fromEntries(fixture.runs)));
    writeFileSync(join(directory, "plan.zip"), archive);
    writeFileSync(
      script,
      `#!${process.execPath}
const fs = require("node:fs"), root = __dirname;
const args = process.argv.slice(2);
const endpoint = args.find(value => value.startsWith("repos/"));
if (!endpoint) throw Error("fixture refuses non-API call");
const suffix = endpoint.slice(${JSON.stringify(`repos/${REPOSITORY}/`)}.length);
const runs = JSON.parse(fs.readFileSync(root + "/runs.json"));
fs.appendFileSync(root + "/calls.jsonl", JSON.stringify(args) + "\\n");
if (args.includes("POST")) {
  if (!["actions/runs/77/cancel", "actions/runs/303/cancel", "actions/runs/77/force-cancel", "actions/runs/303/force-cancel"].includes(suffix)) throw Error("unowned mutation");
  const id = suffix.split("/")[2];
  Object.assign(runs[id], {status:"completed", conclusion:"cancelled"});
  fs.writeFileSync(root + "/runs.json", JSON.stringify(runs));
  process.exit(0);
}
if (suffix === "actions/artifacts/700/zip") { process.stdout.write(fs.readFileSync(root + "/plan.zip")); process.exit(0); }
const response = JSON.parse(fs.readFileSync(root + "/responses.json"))[suffix] ?? runs[suffix.split("/")[2]];
if (response === undefined) throw Error("unexpected fixture request " + suffix);
if (args.includes("--include")) process.stdout.write("HTTP/2.0 200 OK\\nContent-Type: application/json\\n\\n");
if (args.includes("--jq")) response.forEach(row => console.log(JSON.stringify(row)));
else if (typeof response === "string") console.log(response);
else console.log(JSON.stringify(response));
`,
    );
    chmodSync(script, 0o755);
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/frv.mjs", "cancel", "--run", "77", "--json", "--force"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            PATH: `${directory}${delimiter}${process.env.PATH}`,
            HOME: directory,
            GH_TOKEN: "synthetic-fixture",
            OPENCLAW_GH_BIN: script,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).complete).toBe(true);
      const calls = readFileSync(join(directory, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(
        calls
          .filter((call) => call.includes("POST"))
          .map((call) => call.find((arg) => arg.endsWith("/force-cancel"))),
      ).toEqual([
        `repos/${REPOSITORY}/actions/runs/303/force-cancel`,
        `repos/${REPOSITORY}/actions/runs/77/force-cancel`,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
