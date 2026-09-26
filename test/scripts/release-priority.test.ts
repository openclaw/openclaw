import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createClient, prioritizeRelease, restoreReleasePriority } from "../../scripts/frv.mjs";
import {
  RELEASE_PRIORITY_VARIABLE,
  isDeferredCiJobSet,
  isReleaseBranch,
  selectDeferredRunCandidates,
  selectLatestRunsPerLane,
  selectQueuedRunsToCancel,
} from "../../scripts/lib/release-priority.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const PARENT = {
  id: 77,
  path: ".github/workflows/full-release-validation.yml",
  status: "in_progress",
};

function run(
  id: number,
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    conclusion: null,
    created_at: "2026-09-22T12:00:00Z",
    event: "pull_request",
    head_branch: "feat/thing",
    head_repository: { id: 100 },
    head_sha: "a".repeat(40),
    run_attempt: 1,
    workflow_id: name === "CI" ? 1 : 2,
    html_url: `https://example.invalid/runs/${id}`,
    id,
    name,
    status: "queued",
    ...overrides,
  };
}

function client(
  options: {
    queued?: Record<string, unknown>[];
    runs?: Record<string, unknown>[];
    variable?: string;
    jobs?: Record<string, Record<string, unknown>[]>;
  } = {},
) {
  const calls: string[] = [];
  let variable = options.variable ?? "";
  return {
    calls,
    cancelRun: async (id: string) => void calls.push(`cancel:${id}`),
    deleteVariable: async (name: string) => {
      calls.push(`delete:${name}`);
      variable = "";
    },
    getAttemptJobs: async (id: string) => options.jobs?.[id] ?? [],
    getRun: async (id: string) =>
      id === "77"
        ? PARENT
        : ([...(options.runs ?? []), ...(options.queued ?? [])].find(
            (entry) => String(entry.id) === id,
          ) ?? {
            id,
            status: "completed",
          }),
    getVariable: async () => variable,
    listRuns: async (query: string) => {
      calls.push(`list:${query}`);
      return query.startsWith("status=queued")
        ? (options.queued ?? [])
        : query.startsWith("created=")
          ? (options.runs ?? []).filter((entry) => {
              const branch = new URLSearchParams(query).get("branch");
              return !branch || branch === entry.head_branch;
            })
          : [];
    },
    repository: "openclaw/openclaw",
    rerunRun: async (id: string) => void calls.push(`rerun:${id}`),
    setVariable: async (name: string, value: string) => {
      calls.push(`set:${name}=${value}`);
      variable = value;
    },
  };
}

describe("release priority selection", () => {
  it("cancels only queued hosted-runner runs outside release branches and dispatches", () => {
    const runs = [
      run(1, "CI"),
      run(2, "CI", { head_branch: "release/2026.9.6" }),
      run(3, "CI", { head_branch: "release-ci/abcdef012345-77" }),
      run(4, "CI", { head_branch: "release-publish/abcdef012345-77" }),
      run(5, "CI", { event: "workflow_dispatch" }),
      run(6, "CI", { status: "in_progress" }),
      run(7, "OpenClaw Release Checks"),
      run(8, "Labeler", { event: "pull_request_target" }),
      run(77, "CI"),
    ];
    expect(selectQueuedRunsToCancel(runs, "77").map((entry) => entry.id)).toEqual(["1", "8"]);
    expect(["release/x", "release-ci/x", "release-publish/x"].every(isReleaseBranch)).toBe(true);
    expect(isReleaseBranch("feat/release/x")).toBe(false);
  });

  it("restores skipped gated runs and CI runs that only failed their deferral gate", () => {
    const record = { parentRunId: "77", recordedAt: "2026-09-22T12:00:00Z" };
    const candidates = selectDeferredRunCandidates(
      [
        run(1, "Labeler", { status: "completed", conclusion: "skipped" }),
        run(2, "CI", { status: "completed", conclusion: "failure" }),
        run(3, "CI", { status: "completed", conclusion: "success" }),
        run(4, "Labeler", {
          status: "completed",
          conclusion: "skipped",
          created_at: "2026-09-22T11:59:59Z",
        }),
        run(5, "CI", { status: "completed", conclusion: "skipped", event: "workflow_dispatch" }),
        // Draft CI skips its gate too; unlike release deferral, there is no failed gate to restore.
        run(6, "CI", { status: "completed", conclusion: "skipped" }),
      ],
      record,
    );
    expect(candidates.map((entry) => entry.id)).toEqual([1, 2]);
    const gate = { name: "openclaw/ci-gate", conclusion: "failure" };
    const preflight = { name: "preflight", conclusion: "skipped" };
    expect(isDeferredCiJobSet([preflight, gate])).toBe(true);
    expect(
      isDeferredCiJobSet([preflight, gate, { name: "security-fast", conclusion: "success" }]),
    ).toBe(true);
    expect(
      isDeferredCiJobSet([preflight, gate, { name: "macos-node", conclusion: "failure" }]),
    ).toBe(false);
    expect(isDeferredCiJobSet([{ name: "preflight", conclusion: "success" }, gate])).toBe(false);
    expect(isDeferredCiJobSet([])).toBe(false);
    expect(
      selectLatestRunsPerLane([
        { id: "1", name: "CI", lane: "pr:1", headBranch: "a", event: "pull_request", url: "" },
        { id: "9", name: "CI", lane: "pr:1", headBranch: "a", event: "pull_request", url: "" },
        { id: "2", name: "CI", lane: "pr:2", headBranch: "b", event: "pull_request", url: "" },
      ]).map((entry) => entry.id),
    ).toEqual(["9", "2"]);
  });
});

describe("pnpm frv prioritize", () => {
  it("records intent, sets the variable, cancels still-queued runs, and restores newest-per-lane", async () => {
    const fake = client({
      queued: [
        run(1, "CI"),
        run(2, "CI", { event: "workflow_dispatch" }),
        run(6, "Labeler", { event: "pull_request_target", head_branch: "other" }),
        run(15, "CI", { head_branch: "already-restored" }),
      ],
    });
    fake.getRun = async (id: string) =>
      id === "77"
        ? PARENT
        : id === "6"
          ? run(6, "Labeler", { status: "in_progress" })
          : run(Number(id), "CI");
    const outPath = join(mkdtempSync(join(tmpdir(), "frv-priority-")), "record.json");
    await expect(prioritizeRelease("77", fake, { dryRun: true })).resolves.toMatchObject({
      action: "would-prioritize",
    });
    expect(fake.calls.filter((call) => !call.startsWith("list:"))).toEqual([]);
    const result = await prioritizeRelease("77", fake, { outPath });
    expect(result).toMatchObject({
      action: "prioritized",
      failures: [],
      recordPath: outPath,
      skipped: [{ id: "6" }],
    });
    expect(fake.calls.filter((call) => !call.startsWith("list:"))).toEqual([
      `set:${RELEASE_PRIORITY_VARIABLE}=77`,
      "cancel:1",
      "cancel:15",
    ]);
    const record = JSON.parse(readFileSync(outPath, "utf8"));
    expect(record).toMatchObject({
      parentRunId: "77",
      cancelled: [
        { id: "1", name: "CI" },
        { id: "15", name: "CI" },
      ],
    });
    // A repeated call keeps the original window and cancellations.
    const again = client({ queued: [run(8, "CI", { head_branch: "later" })] });
    again.getRun = async (id: string) => (id === "77" ? PARENT : run(Number(id), "CI"));
    await prioritizeRelease("77", again, { outPath });
    const merged = JSON.parse(readFileSync(outPath, "utf8"));
    expect(merged.recordedAt).toBe(record.recordedAt);
    expect(merged.cancelled.map((entry: { id: string }) => entry.id)).toEqual(["1", "15", "8"]);
    // Older pause records have no run-lane identity; restore resolves it from current run facts.
    for (const cancelled of merged.cancelled) {
      delete cancelled.lane;
      cancelled.id = Number(cancelled.id);
    }
    writeFileSync(outPath, JSON.stringify(merged));

    const after = { created_at: "2999-01-01T00:00:00Z", status: "completed" };
    const restoreClient = client({
      variable: "77",
      runs: [
        run(1, "CI", { ...after, conclusion: "cancelled" }),
        run(3, "CI", { ...after, conclusion: "failure" }),
        run(4, "CI", { ...after, conclusion: "failure" }),
        run(5, "Labeler", { ...after, conclusion: "skipped", event: "pull_request_target" }),
        run(8, "CI", { ...after, conclusion: "cancelled", head_branch: "later" }),
        run(9, "CI", { ...after, conclusion: "failure", head_branch: "later" }),
        run(10, "CI", { ...after, status: "in_progress", head_branch: "later" }),
        run(11, "Labeler", { ...after, conclusion: "success" }),
        run(12, "Labeler", { ...after, conclusion: "skipped", head_branch: "other" }),
        run(13, "CI", { ...after, conclusion: "failure", head_branch: "manual-shared" }),
        run(14, "CI", {
          ...after,
          status: "in_progress",
          head_branch: "manual-shared",
          event: "workflow_dispatch",
        }),
        run(15, "CI", { ...after, conclusion: "success", head_branch: "already-restored" }),
        run(17, "CI", {
          ...after,
          conclusion: "failure",
          head_branch: "main",
          head_repository: { id: 201 },
          pull_requests: [{ number: 501 }],
        }),
        run(18, "CI", {
          ...after,
          conclusion: "success",
          head_branch: "main",
          head_repository: { id: 202 },
          pull_requests: [{ number: 502 }],
        }),
      ],
      jobs: {
        "3": [
          { name: "preflight", conclusion: "skipped" },
          { name: "security-fast", conclusion: "success" },
          { name: "openclaw/ci-gate", conclusion: "failure" },
        ],
        "4": [
          { name: "preflight", conclusion: "success" },
          { name: "openclaw/ci-gate", conclusion: "failure" },
        ],
        "9": [
          { name: "preflight", conclusion: "skipped" },
          { name: "openclaw/ci-gate", conclusion: "failure" },
        ],
        "13": [
          { name: "preflight", conclusion: "skipped" },
          { name: "openclaw/ci-gate", conclusion: "failure" },
        ],
        "17": [
          { name: "preflight", conclusion: "skipped" },
          { name: "openclaw/ci-gate", conclusion: "failure" },
        ],
      },
    });
    // Executed run 4 and active run 10 supersede the deferred CI attempts.
    // Successful run 11 likewise owns its lane. Manual run 14 is independent of PR run 13.
    await expect(restoreReleasePriority(outPath, restoreClient)).resolves.toMatchObject({
      action: "restored",
      cleared: true,
      failures: [],
      rerun: [{ id: "12" }, { id: "13" }, { id: "17" }],
    });
    expect(restoreClient.calls.filter((call) => !call.startsWith("list:"))).toEqual([
      `delete:${RELEASE_PRIORITY_VARIABLE}`,
      "rerun:12",
      "rerun:13",
      "rerun:17",
    ]);
  });

  it("refuses a parent that is not an active Full Release Validation and keeps a foreign variable", async () => {
    const fake = { ...client(), getRun: async () => ({ ...PARENT, status: "completed" }) };
    await expect(prioritizeRelease("77", fake)).rejects.toThrow(
      "run 77 is not an active Full Release Validation parent",
    );
    const other = client({ variable: "99" });
    const outPath = join(mkdtempSync(join(tmpdir(), "frv-priority-")), "record.json");
    await prioritizeRelease("77", other, { outPath });
    other.calls.length = 0;
    await expect(
      restoreReleasePriority(outPath, { ...other, getVariable: async () => "99" }),
    ).resolves.toMatchObject({ cleared: false });
    expect(other.calls).not.toContain(`delete:${RELEASE_PRIORITY_VARIABLE}`);
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const deferredJobs = [
  { name: "preflight", conclusion: "skipped" },
  { name: "openclaw/ci-gate", conclusion: "failure" },
];

// Exercise main(), the real client and the printer; only gh's external transport is synthetic.
function priorityCli({
  args = [],
  skipped = [100],
  allowed = true,
  prioritize = false,
}: { args?: string[]; skipped?: number[]; allowed?: boolean; prioritize?: boolean } = {}) {
  const directory = tempDirs.make("frv-priority-cli-");
  const recordPath = join(directory, "record.json");
  const record = JSON.stringify({
    kind: "openclaw.frv-release-priority",
    parentRunId: "77",
    recordedAt: "2020-01-01T00:00:00Z",
    cancelled: [],
  });
  writeFileSync(recordPath, record);
  const runs = [...skipped, ...(allowed ? [200] : [])].map((id) =>
    run(id, "CI", {
      created_at: "2020-01-01T01:00:00Z",
      head_branch: `branch-${id}`,
      status: prioritize ? "queued" : "completed",
      conclusion: prioritize ? null : "failure",
    }),
  );
  const gh = join(directory, "gh-fixture.cjs");
  writeFileSync(
    gh,
    String.raw`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\n");
const runs = ${JSON.stringify(runs)};
const skipped = ${JSON.stringify(skipped)};
const prioritize = ${prioritize};
const reject = () => { throw new Error("unplanned fixture request: " + JSON.stringify(args)); };
if (args[0] === "variable") {
  if (!prioritize || JSON.stringify(args) !== JSON.stringify(["variable", "set", ${JSON.stringify(RELEASE_PRIORITY_VARIABLE)}, "--repo", "fixture/fixture", "--body", "77"])) reject();
} else if (args[0] === "api" && args[1] === "-X") {
  if (JSON.stringify(args) !== JSON.stringify(["api", "-X", "POST", "repos/fixture/fixture/actions/runs/200/" + (prioritize ? "cancel" : "rerun")])) reject();
} else {
  if (args[0] !== "api" || !args.includes("Cache-Control: max-age=0")) reject();
  const resource = args[1].replace("repos/fixture/fixture/", "");
  const query = new URL(resource, "https://example.invalid").searchParams;
  let value;
  if (resource === "actions/variables/${RELEASE_PRIORITY_VARIABLE}") value = { value: "" };
  else if (resource === "actions/runs/77") value = ${JSON.stringify(PARENT)};
  else if (resource.startsWith("actions/runs?")) {
    const branch = query.get("branch");
    const found = runs.filter(run => !branch || run.head_branch === branch);
    if (branch) for (const run of [...found]) {
      if (skipped.includes(run.id)) found.push({ ...run, id: run.id + 1, status: "in_progress", conclusion: null });
    }
    if (query.has("status")) {
      if (!prioritize || !args.includes(".workflow_runs[] | @json")) reject();
      value = query.get("status") === "queued" ? runs : [];
    } else value = { total_count: found.length, workflow_runs: found };
  } else if (runs.some(run => resource === "actions/runs/" + run.id + "/attempts/1/jobs?per_page=100")) {
    if (!args.includes("--paginate") || !args.includes(".jobs[] | @json")) reject();
    value = ${JSON.stringify(deferredJobs)};
  } else {
    value = runs.find(run => resource === "actions/runs/" + run.id);
    if (!value) reject();
    if (prioritize && skipped.includes(value.id)) value = { ...value, status: "in_progress" };
  }
  console.log(Array.isArray(value) ? value.map(row => JSON.stringify(row)).join("\n") : JSON.stringify(value));
}
`,
  );
  const preload = join(directory, "transport.mjs");
  writeFileSync(
    preload,
    `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { promisify } from "node:util";
const reject = () => { throw new Error("unplanned fixture transport"); };
globalThis.fetch = reject;
net.Socket.prototype.connect = reject;
const execute = childProcess.execFile;
const route = (method) => (command, args, ...options) => {
  if (command !== "gh") return reject();
  return method(process.execPath, [${JSON.stringify(gh)}, ...args], ...options);
};
childProcess.execFile = route(execute);
// Retain Node's native { stdout, stderr } promise, child handle and error fields.
childProcess.execFile[promisify.custom] = route(execute[promisify.custom]);
for (const name of ["exec", "execSync", "execFileSync", "spawn", "spawnSync", "fork"]) {
  childProcess[name] = reject;
}
syncBuiltinESMExports();
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      join(process.cwd(), "scripts/frv.mjs"),
      "prioritize",
      "--repo",
      "fixture/fixture",
      ...(prioritize ? ["--run", "77", "--out", recordPath] : ["--restore", recordPath]),
      ...args,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        HOME: directory,
        USERPROFILE: directory,
        PATH: directory,
        SystemRoot: process.env.SystemRoot,
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  if (!prioritize) {
    expect(readFileSync(recordPath, "utf8")).toBe(record);
  }
  const calls: string[][] = readFileSync(join(directory, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const mutations = calls.filter((call) => call[0] === "variable" || call.includes("POST"));
  return { stdout: result.stdout, calls, mutations };
}

describe("release-priority CLI output", () => {
  it("reports a rejected rerun and recovery guidance alongside an attempted sibling", () => {
    const result = priorityCli();
    expect(result.mutations).toEqual([
      ["api", "-X", "POST", "repos/fixture/fixture/actions/runs/200/rerun"],
    ]);
    expect(result.stdout).toContain("CI 200 branch-200 https://example.invalid/runs/200");
    expect(result.stdout).toContain(
      "skipped (rerun not attempted): CI 100 branch-100 https://example.invalid/runs/100",
    );
    expect(result.stdout).toContain("Inspect the skipped runs and their latest PR checks");
    expect(result.stdout).toContain("pnpm frv prioritize --restore <record> --dry-run");
    expect(result.stdout).toContain("same --repo");
    expect(result.stdout).toContain("action: restored");
  });

  it("preserves the restore JSON shape without presentation text", () => {
    const result = priorityCli({ args: ["--json"] });
    const described = (id: number) => ({
      event: "pull_request",
      headBranch: `branch-${id}`,
      id: String(id),
      lane: `repository:100:branch:branch-${id}`,
      name: "CI",
      url: `https://example.invalid/runs/${id}`,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      action: "restored",
      cleared: false,
      failures: [],
      rerun: [described(200)],
      skipped: [described(100)],
    });
    expect(result.mutations).toEqual([
      ["api", "-X", "POST", "repos/fixture/fixture/actions/runs/200/rerun"],
    ]);
  });

  it("reports every skipped candidate even when no rerun was attempted", () => {
    const result = priorityCli({ skipped: [100, 300], allowed: false });
    expect(result.mutations).toEqual([]);
    for (const id of [100, 300]) {
      expect(result.stdout).toContain(
        `skipped (rerun not attempted): CI ${id} branch-${id} https://example.invalid/runs/${id}`,
      );
    }
    expect(result.stdout).toContain("--restore <record> --dry-run");
  });

  it("keeps ordinary output unchanged when no candidates are skipped", () => {
    const result = priorityCli({ skipped: [] });
    expect(result.stdout).toBe(
      "CI 200 branch-200 https://example.invalid/runs/200\naction: restored\n",
    );
    expect(result.mutations).toHaveLength(1);
  });

  it("previews current candidates without attempting mutations or claiming final skips", () => {
    const result = priorityCli({ args: ["--dry-run"] });
    expect(result.mutations).toEqual([]);
    expect(result.stdout).toBe(
      "CI 100 branch-100 https://example.invalid/runs/100\nCI 200 branch-200 https://example.invalid/runs/200\naction: would-restore\n",
    );
  });

  it("labels prioritize skips as cancellations, not reruns", () => {
    const result = priorityCli({ prioritize: true });
    expect(result.mutations).toEqual([
      ["variable", "set", RELEASE_PRIORITY_VARIABLE, "--repo", "fixture/fixture", "--body", "77"],
      ["api", "-X", "POST", "repos/fixture/fixture/actions/runs/200/cancel"],
    ]);
    expect(result.stdout).toContain(
      "skipped (cancellation not attempted): CI 100 branch-100 https://example.invalid/runs/100",
    );
    expect(result.stdout).not.toContain("rerun not attempted");
    expect(result.stdout).not.toContain("--restore");
    expect(result.stdout).toContain("action: prioritized");
  });
});

describe("restore dispatch revalidation through createClient", () => {
  async function restore(
    options: {
      initial?: Record<string, unknown>[];
      advance?: (runs: Record<string, unknown>[], request: string, jobReads: number) => void;
      afterMutation?: (runs: Record<string, unknown>[]) => void;
      incomplete?: boolean;
      failMutation?: boolean;
      cancelled?: { id: number }[];
    } = {},
  ) {
    const current = options.initial ?? [
      run(100, "CI", {
        status: "completed",
        conclusion: "failure",
        pull_requests: [{ number: 42 }],
      }),
    ];
    const calls: string[] = [];
    let jobReads = 0;
    const restoreClient = createClient("fixture/fixture", {
      apiJson: async (resource: string) => {
        calls.push("GET " + resource);
        if (resource.startsWith("actions/variables/")) {
          return { value: "" };
        }
        if (resource.startsWith("actions/runs?")) {
          const query = new URL(resource, "https://example.invalid/").searchParams;
          const branch = query.get("branch");
          const found = current.filter((entry) => !branch || branch === entry.head_branch);
          return {
            total_count: found.length + (branch && options.incomplete ? 1 : 0),
            workflow_runs: structuredClone(found),
          };
        }
        options.advance?.(current, resource, jobReads);
        return structuredClone(
          current.find((entry) => resource === "actions/runs/" + String(entry.id)),
        );
      },
      apiText: async (resource: string) => {
        calls.push("GET " + resource);
        jobReads++;
        options.advance?.(current, resource, jobReads);
        return deferredJobs.map((job) => JSON.stringify(job)).join(String.fromCharCode(10));
      },
      mutate: async (args: string[]) => {
        calls.push(args.join(" "));
        options.afterMutation?.(current);
        if (options.failMutation) {
          throw new Error("ambiguous transport failure");
        }
      },
    });
    const path = join(tempDirs.make("frv-restore-dispatch-"), "record.json");
    writeFileSync(
      path,
      JSON.stringify({
        kind: "openclaw.frv-release-priority",
        parentRunId: "77",
        recordedAt: "2026-09-22T11:00:00Z",
        cancelled: options.cancelled ?? [],
      }),
    );
    const result = await restoreReleasePriority(path, restoreClient);
    return { result, calls, writes: calls.filter((call) => call.startsWith("api -X POST")) };
  }

  it("dispatches an unchanged attempt once after fresh jobs and complete lane inventory", async () => {
    const { result, calls, writes } = await restore();
    expect(result).toMatchObject({ failures: [], rerun: [{ id: "100" }], skipped: [] });
    expect(writes).toEqual(["api -X POST repos/fixture/fixture/actions/runs/100/rerun"]);
    expect(calls.at(-2)).toContain("branch=feat%2Fthing");
    expect(calls.filter((call) => call.includes("/attempts/1/jobs"))).toHaveLength(2);
  });

  it.each([1, 2])(
    "rejects newer lane work appearing during awaited job read %s",
    async (jobRead) => {
      const { result, writes } = await restore({
        advance: (runs, request, reads) => {
          if (request.includes("/jobs") && reads === jobRead) {
            runs.push({ ...runs[0], id: 101, status: "in_progress", conclusion: null });
          }
        },
      });
      expect(result).toMatchObject({ failures: [], rerun: [], skipped: [{ id: "100" }] });
      expect(writes).toEqual([]);
    },
  );

  it.each([
    { run_attempt: 2 },
    { status: "in_progress", conclusion: null },
    { conclusion: "success" },
    { head_sha: "b".repeat(40) },
    { pull_requests: [{ number: 43 }] },
    { workflow_id: 7 },
    { event: "workflow_dispatch" },
    { head_repository: { id: 999 } },
  ])("rejects changed attempt, state or identity %j after selection", async (change) => {
    const { writes } = await restore({
      advance: (runs, request) => {
        if (request === "actions/runs/100") {
          Object.assign(runs[0]!, change);
        }
      },
    });
    expect(writes).toEqual([]);
  });

  it("rejects an attempt advancing while awaited job validation completes", async () => {
    const { writes } = await restore({
      advance: (runs, request, reads) => {
        if (request.includes("/jobs") && reads === 2) {
          runs[0]!.run_attempt = 2;
        }
      },
    });
    expect(writes).toEqual([]);
  });

  it("does not let manual dispatches or another fork suppress the PR; never restores draft CI", async () => {
    const deferred = run(100, "CI", {
      status: "completed",
      conclusion: "failure",
      pull_requests: [{ number: 42 }],
    });
    const { writes } = await restore({
      initial: [
        deferred,
        { ...deferred, id: 101, status: "in_progress", event: "workflow_dispatch" },
        {
          ...deferred,
          id: 102,
          conclusion: "success",
          head_repository: { id: 200 },
          pull_requests: [{ number: 43 }],
        },
        { ...deferred, id: 103, conclusion: "skipped", pull_requests: [{ number: 44 }] },
      ],
    });
    expect(writes).toEqual(["api -X POST repos/fixture/fixture/actions/runs/100/rerun"]);
  });

  it("rechecks every dispatch rather than validating the whole batch before its first POST", async () => {
    const first = run(100, "CI", {
      status: "completed",
      conclusion: "failure",
      pull_requests: [{ number: 42 }],
    });
    const second = { ...first, id: 200, pull_requests: [{ number: 43 }] };
    const { writes, result } = await restore({
      initial: [first, second],
      afterMutation: (runs) => {
        runs.push({ ...second, id: 201, status: "in_progress", conclusion: null });
      },
    });
    expect(writes).toEqual(["api -X POST repos/fixture/fixture/actions/runs/100/rerun"]);
    expect(result).toMatchObject({ skipped: [{ id: "200" }] });
  });

  it("rebinds a legacy cancellation without saved lane or attempt fields", async () => {
    const cancelled = run(100, "CI", { status: "completed", conclusion: "cancelled" });
    const { writes } = await restore({ initial: [cancelled], cancelled: [{ id: 100 }] });
    expect(writes).toHaveLength(1);
  });

  it("fails closed on incomplete inventory and ambiguous peer identity", async () => {
    const incomplete = await restore({ incomplete: true });
    expect(incomplete.writes).toEqual([]);
    expect(incomplete.result.failures).toEqual(["100: Incomplete GitHub Actions run inventory"]);
    const ambiguous = await restore({
      advance: (runs, request, reads) => {
        if (request.includes("/jobs") && reads === 1) {
          runs.push({ ...runs[0], id: 101, pull_requests: [], head_repository: null });
        }
      },
    });
    expect(ambiguous.writes).toEqual([]);
  });

  it("never retries an ambiguous rerun POST", async () => {
    const { writes, result } = await restore({ failMutation: true });
    expect(writes).toHaveLength(1);
    expect(result.failures).toEqual(["100: ambiguous transport failure"]);
  });
});
