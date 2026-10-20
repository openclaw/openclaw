import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileFunction } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildSummary,
  filterIgnoredFindings,
  formatAnnotation,
  intersectFindings,
  parseRepoLocation,
  validateFindings,
} from "../../scripts/periphery-intersection.mjs";

const WORKFLOW_PATH = ".github/workflows/macos-periphery.yml";
const FINDING_SOURCE = "../shared/OpenClawKit/Sources/OpenClawKit/Example.swift";

type WorkflowStep = {
  id?: string;
  name?: string;
  run?: string;
  if?: string;
  with?: { name?: string; overwrite?: boolean; path?: string; script?: string };
};

type Workflow = {
  jobs?: Record<
    string,
    {
      name?: string;
      needs?: string[] | string;
      "runs-on"?: string;
      steps?: WorkflowStep[];
    }
  >;
};

function finding(overrides: Record<string, unknown> = {}) {
  return {
    ids: ["s:11OpenClawKit7ExampleV"],
    kind: "struct",
    location: `${FINDING_SOURCE}:12:8`,
    name: "Example",
    ...overrides,
  };
}

function withSharedSource(source: string, test: (repoRoot: string) => void) {
  const repoRoot = mkdtempSync(join(tmpdir(), "openclaw-periphery-intersection-"));
  const sourceFile = join(repoRoot, "apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift");
  mkdirSync(dirname(sourceFile), { recursive: true });
  writeFileSync(sourceFile, source);
  try {
    test(repoRoot);
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
}

describe("Periphery intersection", () => {
  it("sorts findings deterministically", () => {
    const later = finding({
      ids: ["s:11OpenClawKit5LaterV"],
      location: "../shared/OpenClawKit/Sources/OpenClawKit/Later.swift:2:1",
      name: "Later",
    });
    expect(intersectFindings([later, finding()], [finding(), later])).toEqual([finding(), later]);
  });

  it("honors bare Periphery ignore comments on or above declarations", () => {
    withSharedSource(
      [
        "// periphery:ignore - exported package surface",
        "public struct Example {}",
        "",
        'public init(value: String = "value") {} // periphery:ignore - exported initializer',
      ].join("\n"),
      (repoRoot) => {
        const declaration = finding({ location: `${FINDING_SOURCE}:2:8` });
        const inline = finding({ location: `${FINDING_SOURCE}:4:8` });
        expect(filterIgnoredFindings([declaration, inline], repoRoot)).toEqual([]);
      },
    );
  });

  it("fails closed when a finding has no USR", () => {
    expect(() => validateFindings([finding({ ids: [] })], "iOS")).toThrow(
      "iOS finding 0 has no usable Swift USR",
    );
  });

  it("rejects findings outside shared OpenClawKit", () => {
    expect(() =>
      validateFindings([finding({ location: "Sources/App.swift:1:1" })], "macOS"),
    ).toThrow("macOS finding 0 is outside shared OpenClawKit sources");
  });

  it("maps relative scan locations to repository annotations", () => {
    expect(parseRepoLocation(finding().location)).toEqual({
      column: "8",
      file: "apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift",
      line: "12",
    });
    expect(formatAnnotation(finding())).toBe(
      "::error file=apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift,line=12,col=8,title=Dead shared Swift code::struct Example",
    );
  });

  it("reports the zero-findings policy in the summary", () => {
    expect(buildSummary([])).toContain("No declarations were reported dead by both");
    expect(buildSummary([finding()])).toContain("Found 1 shared Swift declaration");
  });
});

describe("shared OpenClawKit Periphery workflow", () => {
  const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;

  it("runs two consumer scans and a same-run intersection", () => {
    expect(workflow.jobs?.["scan-ios"]?.name).toBe("Scan shared kit from iOS");
    expect(workflow.jobs?.["scan-macos"]?.name).toBe("Scan shared kit from macOS");
    expect(workflow.jobs?.intersect?.needs).toEqual(["scope", "scan-ios", "scan-macos"]);

    const iosUpload = workflow.jobs?.["scan-ios"]?.steps?.find(
      (step) => step.name === "Upload iOS consumer report",
    );
    const macosUpload = workflow.jobs?.["macos-index"]?.steps?.find(
      (step) => step.name === "Upload macOS consumer report",
    );
    const iosDownload = workflow.jobs?.intersect?.steps?.find(
      (step) => step.name === "Download iOS consumer report",
    );
    const macosDownload = workflow.jobs?.intersect?.steps?.find(
      (step) => step.name === "Download macOS consumer report",
    );
    const intersectionUpload = workflow.jobs?.intersect?.steps?.find(
      (step) => step.name === "Upload shared intersection",
    );

    expect(iosUpload?.with?.name).toBe(
      "shared-periphery-ios-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(macosUpload?.with?.name).toBe(
      "shared-periphery-macos-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(iosDownload?.with?.name).toBe(
      "shared-periphery-ios-${{ github.run_id }}-${{ steps.producers.outputs.ios-attempt }}",
    );
    expect(macosDownload?.with?.name).toBe(
      "shared-periphery-macos-${{ github.run_id }}-${{ steps.producers.outputs.macos-attempt }}",
    );
    expect(intersectionUpload?.with?.name).toBe(
      "shared-periphery-intersection-${{ github.run_id }}",
    );
    expect(intersectionUpload?.with?.overwrite).toBe(true);
  });
});

describe("Periphery producer attempt selection", () => {
  const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
  const script = workflow.jobs?.intersect?.steps?.find((step) => step.id === "producers")?.with
    ?.script;
  if (!script) {
    throw new Error("missing producer resolution");
  }
  const execute = compileFunction(`return (async () => {\n${script}\n})();`, [
    "github",
    "context",
    "core",
  ]);
  const producer = (name: string, run_attempt = 2) => ({
    name,
    run_attempt,
    run_id: 123,
    head_sha: "current-head",
    status: "completed",
  });
  const producers = () => [
    producer("Scan shared kit from iOS", 1),
    producer("Build macOS Periphery reports"),
  ];
  const resolve = async (jobs = producers(), head = "current-head") => {
    const outputs = new Map<string, string>();
    const listJobsForWorkflowRun = () => {};
    await execute(
      {
        rest: {
          actions: {
            listJobsForWorkflowRun,
            getWorkflowRun: async (params: unknown) => {
              expect(params).toMatchObject({ run_id: 123 });
              return { data: { head_sha: head } };
            },
          },
        },
        paginate: async (request: unknown, params: unknown) => {
          expect(request).toBe(listJobsForWorkflowRun);
          expect(params).toMatchObject({ run_id: 123, filter: "all", per_page: 100 });
          return jobs;
        },
      },
      {
        repo: { owner: "openclaw", repo: "openclaw" },
        runId: 123,
        sha: "current-head",
        payload: {},
      },
      { setOutput: (key: string, value: string) => outputs.set(key, value) },
    );
    return Object.fromEntries(outputs);
  };

  it.each(["", "scan / "])(
    "retains actual producer attempts on an intersection-only rerun (%s)",
    async (prefix) => {
      await expect(
        resolve(producers().map((job) => Object.assign({}, job, { name: prefix + job.name }))),
      ).resolves.toEqual({
        "ios-attempt": "1",
        "macos-attempt": "2",
      });
    },
  );

  it("selects a rerun producer even when its new artifact may be absent", async () => {
    const jobs = producers();
    jobs.push({ ...jobs[1]!, run_attempt: 3 });
    await expect(resolve(jobs)).resolves.toMatchObject({ "macos-attempt": "3" });
  });

  it.each([
    ["missing", () => producers().slice(0, 1)],
    ["ambiguous", () => [...producers(), producer("scan / Build macOS Periphery reports")]],
    ["wrong run", () => producers().map((job) => Object.assign({}, job, { run_id: 999 }))],
    [
      "wrong head",
      () => producers().map((job) => Object.assign({}, job, { head_sha: "old-head" })),
    ],
    ["incomplete", () => producers().map((job) => Object.assign({}, job, { status: "queued" }))],
    ["invalid attempt", () => producers().map((job) => Object.assign({}, job, { run_attempt: 0 }))],
  ] as const)("fails closed for %s producer metadata", async (_label, jobs) => {
    await expect(resolve(jobs())).rejects.toThrow("Periphery producer");
  });

  it("rejects a run for another head before selecting reports", async () => {
    await expect(resolve(producers(), "old-head")).rejects.toThrow("producer head");
  });
});
