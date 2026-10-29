import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compileFunction } from "node:vm";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildSummary,
  filterIgnoredFindings,
  formatAnnotation,
  intersectFindings,
  validateFindings,
} from "../../scripts/periphery-intersection.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const WORKFLOW_PATH = ".github/workflows/macos-periphery.yml";
const FINDING_SOURCE = "../shared/OpenClawKit/Sources/OpenClawKit/Example.swift";
const SOURCE_FILE = "apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WorkflowStep = {
  id?: string;
  name?: string;
  with?: { name?: string; script?: string };
};

type WorkflowJob = { name?: string; steps?: WorkflowStep[] };
type Workflow = { jobs?: Record<string, WorkflowJob> };
const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;

function finding(overrides: Record<string, unknown> = {}) {
  return {
    ids: ["s:11OpenClawKit7ExampleV"],
    kind: "struct",
    location: `${FINDING_SOURCE}:12:8`,
    name: "Example",
    ...overrides,
  };
}

it("sorts findings deterministically", () => {
  const later = finding({
    ids: ["s:11OpenClawKit5LaterV"],
    location: "../shared/OpenClawKit/Sources/OpenClawKit/Later.swift:2:1",
    name: "Later",
  });
  expect(intersectFindings([later, finding()], [finding(), later])).toEqual([finding(), later]);
});

it("honors bare Periphery ignore comments on or above declarations", () => {
  const root = tempDirs.make("openclaw-periphery-intersection-");
  const source = join(root, SOURCE_FILE);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(
    source,
    [
      "// periphery:ignore - exported package surface",
      "public struct Example {}",
      "",
      'public init(value: String = "value") {} // periphery:ignore - exported initializer',
    ].join("\n"),
  );
  const findings = [2, 4].map((line) => finding({ location: `${FINDING_SOURCE}:${line}:8` }));
  expect(filterIgnoredFindings(findings, root)).toEqual([]);
});

it.each([
  ["iOS", { ids: [] }, "has no usable Swift USR"],
  ["macOS", { location: "Sources/App.swift:1:1" }, "is outside shared OpenClawKit sources"],
] as const)("fails closed for invalid %s findings: %s", (label, overrides, error) => {
  expect(() => validateFindings([finding(overrides)], label)).toThrow(
    `${label} finding 0 ${error}`,
  );
});

it("maps relative scan locations to repository annotations", () => {
  expect(formatAnnotation(finding())).toBe(
    "::error file=apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift,line=12,col=8,title=Dead shared Swift code::struct Example",
  );
});

it("reports the zero-findings policy in the summary", () => {
  expect(buildSummary([])).toContain("No declarations were reported dead by both");
  expect(buildSummary([finding()])).toContain("Found 1 shared Swift declaration");
});

const steps = (job: string) => workflow.jobs?.[job]?.steps ?? [];
const artifactNames = (job: string) =>
  steps(job).flatMap(({ with: args }) =>
    args?.name?.startsWith("shared-periphery-") ? [args.name] : [],
  );
it("downloads each consumer report from its selected producer attempt", () => {
  const consumerNames = artifactNames("intersect").filter((name) =>
    name.includes("producers.outputs."),
  );
  const producerNames = ["ios-index", "macos-index"]
    .flatMap(artifactNames)
    .map((name) =>
      name.replace(
        "${{ github.run_attempt }}",
        `\${{ steps.producers.outputs.${name.split("-")[2]}-attempt }}`,
      ),
    );
  expect(producerNames).toHaveLength(2);
  expect(consumerNames.toSorted()).toEqual(producerNames.toSorted());
});
const script = steps("intersect").find((step) => step.id === "producers")?.with?.script;
if (!script) {
  throw new Error("missing producer resolution");
}
const parameters = ["github", "context", "core"];
const execute = compileFunction(`return (async () => {\n${script}\n})();`, parameters);
const jobMetadata = { run_id: 123, head_sha: "current-head", status: "completed" };
const producer = (name: string, run_attempt = 2) => ({
  ...jobMetadata,
  name,
  run_attempt,
  conclusion: "success",
});
const producers = () => [
  producer(workflow.jobs!["ios-index"]!.name!, 1),
  producer(workflow.jobs!["macos-index"]!.name!),
];
const resolve = async (jobs = producers(), head = "current-head") => {
  const outputs = new Map<string, string>();
  const listJobsForWorkflowRun = () => {};
  const repo = { owner: "openclaw", repo: "openclaw" };
  const actions = {
    listJobsForWorkflowRun,
    getWorkflowRun: async (params: unknown) => {
      expect(params).toMatchObject({ run_id: 123 });
      return { data: { head_sha: head } };
    },
  };
  await execute(
    {
      rest: { actions },
      paginate: async (request: unknown, params: unknown) => {
        expect(request).toBe(listJobsForWorkflowRun);
        expect(params).toMatchObject({ run_id: 123, filter: "all", per_page: 100 });
        return jobs;
      },
    },
    { repo, runId: 123, sha: "current-head", payload: {} },
    { setOutput: (key: string, value: string) => outputs.set(key, value) },
  );
  return Object.fromEntries(outputs);
};

it.each(["", "scan / "])(
  "retains actual producer attempts on an intersection-only rerun (%s)",
  async (prefix) => {
    await expect(
      resolve(producers().map((job) => Object.assign({}, job, { name: prefix + job.name }))),
    ).resolves.toEqual({ "ios-attempt": "1", "macos-attempt": "2" });
  },
);

it.each(["ios", "macos"] as const)(
  "selects the latest failed %s producer without falling back to an older artifact",
  async (platform) => {
    const jobs = producers();
    jobs.push({ ...jobs[platform === "ios" ? 0 : 1]!, run_attempt: 3, conclusion: "failure" });
    await expect(resolve(jobs)).resolves.toMatchObject({ [`${platform}-attempt`]: "3" });
  },
);

it("retains valid branch reports from completed producers whose siblings failed", async () => {
  await expect(
    resolve(producers().map((job) => Object.assign(job, { conclusion: "failure" }))),
  ).resolves.toEqual({
    "ios-attempt": "1",
    "macos-attempt": "2",
  });
});

it.each([
  ["missing", () => producers().slice(0, 1)],
  ["ambiguous", () => [...producers(), producer(`scan / ${producers()[1]!.name}`)]],
  ["wrong run", () => producers().map((job) => Object.assign({}, job, { run_id: 999 }))],
  ["wrong head", () => producers().map((job) => Object.assign({}, job, { head_sha: "old-head" }))],
  ["incomplete", () => producers().map((job) => Object.assign({}, job, { status: "queued" }))],
  ["invalid attempt", () => producers().map((job) => Object.assign({}, job, { run_attempt: 0 }))],
] as const)("fails closed for %s producer metadata", async (_label, jobs) => {
  await expect(resolve(jobs())).rejects.toThrow("Periphery producer");
});

it("rejects a run for another head before selecting reports", async () => {
  await expect(resolve(producers(), "old-head")).rejects.toThrow("producer head");
});
