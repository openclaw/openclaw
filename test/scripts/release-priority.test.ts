import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createClient, restoreReleasePriority } from "../../scripts/frv.mjs";
import { RELEASE_PRIORITY_VARIABLE } from "../../scripts/lib/release-priority.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

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

function completed(
  id: number,
  conclusion: string,
  overrides: Record<string, unknown> = {},
  name = "CI",
) {
  return run(id, name, {
    created_at: "2026-09-22T12:01:00Z",
    status: "completed",
    conclusion,
    ...overrides,
  });
}

function candidate(id = 100) {
  return run(id, "CI", {
    status: "completed",
    conclusion: "failure",
    pull_requests: [{ number: 42 }],
  });
}

function priorityRecord(recordedAt: string, cancelled: Record<string, unknown>[] = []) {
  return JSON.stringify({
    kind: "openclaw.frv-release-priority",
    parentRunId: "77",
    recordedAt,
    cancelled,
  });
}

describe("pnpm frv prioritize --restore", () => {
  it("restores newest-per-lane runs from a historical record", async () => {
    const { result, calls } = await restore({
      cancelled: [1, 15, 8].map((id) => ({ id })),
      variable: "77",
      initial: [
        completed(1, "cancelled"),
        completed(3, "failure"),
        completed(4, "failure"),
        completed(5, "skipped", { event: "pull_request_target" }, "Labeler"),
        completed(8, "cancelled", { head_branch: "later" }),
        completed(9, "failure", { head_branch: "later" }),
        completed(10, "", { status: "in_progress", conclusion: null, head_branch: "later" }),
        completed(11, "success", {}, "Labeler"),
        completed(12, "skipped", { head_branch: "feat/release/x" }, "Labeler"),
        completed(13, "failure", { head_branch: "manual-shared" }),
        completed(14, "", {
          conclusion: null,
          status: "in_progress",
          head_branch: "manual-shared",
          event: "workflow_dispatch",
        }),
        completed(15, "success", { head_branch: "already-restored" }),
        completed(17, "failure", {
          head_branch: "main",
          head_repository: { id: 201 },
          pull_requests: [{ number: 501 }],
        }),
        completed(18, "success", {
          head_branch: "main",
          head_repository: { id: 202 },
          pull_requests: [{ number: 502 }],
        }),
        completed(19, "failure", { head_branch: "failed-job" }),
        completed(20, "failure", { head_branch: "empty-jobs" }),
        run(21, "Labeler", {
          status: "completed",
          conclusion: "skipped",
          head_branch: "before-pause",
          created_at: "2026-09-22T11:59:59Z",
        }),
        ...["release/x", "release-ci/x", "release-publish/x"].map((head_branch, index) =>
          completed(22 + index, "failure", { head_branch }),
        ),
      ],
      jobs: {
        "3": [...deferredJobs, { name: "security-fast", conclusion: "success" }],
        "4": [
          { name: "preflight", conclusion: "success" },
          { name: "openclaw/ci-gate", conclusion: "failure" },
        ],
        "9": deferredJobs,
        "13": deferredJobs,
        "17": deferredJobs,
        "19": [...deferredJobs, { name: "macos-node", conclusion: "failure" }],
        "20": [],
      },
    });
    expect(result).toMatchObject({
      action: "restored",
      cleared: true,
      failures: [],
      skipped: [],
      rerun: [{ id: "12" }, { id: "13" }, { id: "17" }],
    });
    expect(calls.filter((call) => !call.startsWith("GET "))).toEqual([
      `variable delete ${RELEASE_PRIORITY_VARIABLE} --repo fixture/fixture`,
      ...[12, 13, 17].map((id) => `api -X POST repos/fixture/fixture/actions/runs/${id}/rerun`),
    ]);
  });

  it("keeps a foreign variable", async () => {
    const { result, calls } = await restore({ variable: "99" });
    expect(result).toMatchObject({ cleared: false });
    expect(calls.some((call) => call.startsWith("variable delete "))).toBe(false);
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const deferredJobs = [
  { name: "preflight", conclusion: "skipped" },
  { name: "openclaw/ci-gate", conclusion: "failure" },
];

async function restore(
  options: {
    initial?: Record<string, unknown>[];
    advance?: (runs: Record<string, unknown>[], request: string, jobReads: number) => void;
    afterMutation?: (runs: Record<string, unknown>[]) => void;
    incomplete?: boolean;
    failMutation?: boolean;
    cancelled?: Record<string, unknown>[];
    variable?: string;
    jobs?: Record<string, Record<string, unknown>[]>;
  } = {},
) {
  const current = options.initial ?? [candidate()];
  const calls: string[] = [];
  let jobReads = 0;
  const restoreClient = createClient("fixture/fixture", {
    apiJson: async (resource: string) => {
      calls.push("GET " + resource);
      if (resource.startsWith("actions/variables/")) {
        return { value: options.variable ?? "" };
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
      return (options.jobs?.[resource.split("/")[2]!] ?? deferredJobs)
        .map((job) => JSON.stringify(job))
        .join("\n");
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
  writeFileSync(path, priorityRecord("2026-09-22T12:00:00Z", options.cancelled));
  const result = await restoreReleasePriority(path, restoreClient);
  return { result, calls, writes: calls.filter((call) => call.startsWith("api -X POST")) };
}

// Exercise main(), the real client and the printer; only gh's external transport is synthetic.
function priorityCli({
  args = [],
  skipped = [100],
  allowed = true,
}: { args?: string[]; skipped?: number[]; allowed?: boolean } = {}) {
  const directory = tempDirs.make("frv-priority-cli-");
  const recordPath = join(directory, "record.json");
  const record = priorityRecord("2020-01-01T00:00:00Z");
  writeFileSync(recordPath, record);
  const runs = [...skipped, ...(allowed ? [200] : [])].map((id) =>
    run(id, "CI", {
      created_at: "2020-01-01T01:00:00Z",
      head_branch: `branch-${id}`,
      status: "completed",
      conclusion: "failure",
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
const reject = () => { throw new Error("unplanned fixture request: " + JSON.stringify(args)); };
if (args[0] === "variable") {
  reject();
} else if (args[0] === "api" && args[1] === "-X") {
  if (JSON.stringify(args) !== JSON.stringify(["api", "-X", "POST", "repos/fixture/fixture/actions/runs/200/rerun"])) reject();
} else {
  if (args[0] !== "api" || !args.includes("--include") || !args.includes("Cache-Control: max-age=0")) reject();
  const resource = args.find(arg => arg.startsWith("repos/fixture/fixture/")).replace("repos/fixture/fixture/", "");
  const query = new URL(resource, "https://example.invalid").searchParams;
  let value;
  if (resource === "actions/variables/${RELEASE_PRIORITY_VARIABLE}") value = { value: "" };
  else if (resource.startsWith("actions/runs?")) {
    const branch = query.get("branch");
    const found = runs.filter(run => !branch || run.head_branch === branch);
    if (branch) for (const run of [...found]) {
      if (skipped.includes(run.id)) found.push({ ...run, id: run.id + 1, status: "in_progress", conclusion: null });
    }
    if (query.has("status")) reject();
    value = { total_count: found.length, workflow_runs: found };
  } else if (runs.some(run => resource === "actions/runs/" + run.id + "/attempts/1/jobs?per_page=100")) {
    if (!args.includes("--paginate") || !args.includes(".jobs[] | @json")) reject();
    value = ${JSON.stringify(deferredJobs)};
  } else {
    value = runs.find(run => resource === "actions/runs/" + run.id);
    if (!value) reject();
  }
  process.stdout.write("HTTP/2.0 200 OK\nContent-Type: application/json\r\n\r\n");
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
      "--restore",
      recordPath,
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
  expect(readFileSync(recordPath, "utf8")).toBe(record);
  const calls: string[][] = readFileSync(join(directory, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const mutations = calls.filter((call) => call[0] === "variable" || call.includes("POST"));
  return { stdout: result.stdout, calls, mutations };
}

describe("release-priority CLI output", () => {
  it.each([
    { label: "attempted and skipped siblings", skipped: [100], allowed: true, dryRun: false },
    { label: "only skipped candidates", skipped: [100, 300], allowed: false, dryRun: false },
    { label: "no skipped candidates", skipped: [], allowed: true, dryRun: false },
    { label: "dry-run", skipped: [100], allowed: true, dryRun: true },
  ])("reports $label without misrepresenting dispatch", ({ dryRun, ...row }) => {
    const result = priorityCli({ ...row, args: dryRun ? ["--dry-run"] : [] });
    expect(result.mutations).toEqual(
      row.allowed && !dryRun
        ? [["api", "-X", "POST", "repos/fixture/fixture/actions/runs/200/rerun"]]
        : [],
    );
    const line = (id: number) => `CI ${id} branch-${id} https://example.invalid/runs/${id}\n`;
    const dispatched = row.allowed ? line(200) : "";
    const skipped = row.skipped
      .map((id) => `${dryRun ? "" : "skipped (rerun not attempted): "}${line(id)}`)
      .join("");
    if (dryRun || !row.skipped.length) {
      expect(result.stdout).toBe(
        `${skipped}${dispatched}action: ${dryRun ? "would-restore" : "restored"}\n`,
      );
    } else {
      expect(result.stdout).toContain(`${dispatched}${skipped}`);
      expect(result.stdout).toContain("Inspect the skipped runs and their latest PR checks");
      expect(result.stdout).toContain("pnpm frv prioritize --restore <record> --dry-run");
      expect(result.stdout).toContain("same --repo");
      expect(result.stdout).toContain("action: restored");
    }
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
});

describe("restore dispatch revalidation through createClient", () => {
  it.each(["independent peers", "legacy cancellation"])(
    "dispatches only the eligible original run: %s",
    async (scenario) => {
      const original =
        scenario === "legacy cancellation"
          ? run(100, "CI", { status: "completed", conclusion: "cancelled" })
          : candidate();
      const { result, writes } = await restore({
        initial:
          scenario === "independent peers"
            ? [
                original,
                { ...original, id: 101, status: "in_progress", event: "workflow_dispatch" },
                {
                  ...original,
                  id: 102,
                  conclusion: "success",
                  head_repository: { id: 200 },
                  pull_requests: [{ number: 43 }],
                },
                { ...original, id: 103, conclusion: "skipped", pull_requests: [{ number: 44 }] },
              ]
            : [original],
        cancelled: scenario === "legacy cancellation" ? [{ id: 100 }] : [],
      });
      expect(result).toMatchObject({ failures: [], rerun: [{ id: "100" }], skipped: [] });
      expect(writes).toEqual(["api -X POST repos/fixture/fixture/actions/runs/100/rerun"]);
    },
  );

  const staleAuthorityCases: {
    label: string;
    jobRead: number;
    peer?: boolean;
    change?: Record<string, unknown>;
  }[] = [
    ...[1, 2].map((jobRead) => ({
      label: `new lane work during job read ${jobRead}`,
      jobRead,
      peer: true,
    })),
    { label: "attempt advances during validation", jobRead: 2, change: { run_attempt: 2 } },
    {
      label: "ambiguous peer identity",
      jobRead: 1,
      peer: true,
      change: { pull_requests: [], head_repository: null },
    },
    ...[
      { run_attempt: 2 },
      { status: "in_progress", conclusion: null },
      { conclusion: "success" },
      { head_sha: "b".repeat(40) },
      { pull_requests: [{ number: 43 }] },
      { workflow_id: 7 },
      { event: "workflow_dispatch" },
      { head_repository: { id: 999 } },
    ].map((change) => ({ label: JSON.stringify(change), jobRead: 0, change })),
  ];
  it.each(staleAuthorityCases)("rejects stale dispatch authority: $label", async (row) => {
    const { result, writes } = await restore({
      advance: (runs, request, reads) => {
        if (
          row.jobRead
            ? request.includes("/jobs") && reads === row.jobRead
            : request === "actions/runs/100"
        ) {
          if (row.peer) {
            runs.push({
              ...runs[0],
              id: 101,
              status: "in_progress",
              conclusion: null,
              ...row.change,
            });
          } else if (row.change) {
            Object.assign(runs[0]!, row.change);
          }
        }
      },
    });
    expect(writes).toEqual([]);
    expect(result).toMatchObject({ failures: [], rerun: [], skipped: [{ id: "100" }] });
  });

  it("rechecks every dispatch rather than validating the whole batch before its first POST", async () => {
    const first = candidate();
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

  it("fails closed on incomplete inventory", async () => {
    const { writes, result } = await restore({ incomplete: true });
    expect(writes).toEqual([]);
    expect(result.failures).toEqual(["100: Incomplete GitHub Actions run inventory"]);
  });

  it("never retries an ambiguous rerun POST", async () => {
    const { writes, result } = await restore({ failMutation: true });
    expect(writes).toHaveLength(1);
    expect(result.failures).toEqual(["100: ambiguous transport failure"]);
  });
});
