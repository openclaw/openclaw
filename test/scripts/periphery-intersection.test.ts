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
  uses?: string;
  with?: { name?: string; script?: string; "artifact-ids"?: string };
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
const script = steps("intersect").find((step) => step.id === "producers")?.with?.script;
if (!script) {
  throw new Error("missing producer resolution");
}
const execute = compileFunction(`return (async () => {\n${script}\n})();`, [
  "github",
  "context",
  "core",
]);
const names = {
  ios: workflow.jobs!["ios-index"]!.name!,
  macos: workflow.jobs!["macos-index"]!.name!,
};
const producer = (name: string, run_attempt = 2) => {
  const platform = name.includes("macOS") ? "macos" : "ios";
  const stepNames = [
    "Set up job",
    ...steps(`${platform}-index`).map((step) => step.name!),
    "Post Setup Node environment",
    "Post Checkout",
    "Complete job",
  ];
  const started_at = `2026-10-29T0${run_attempt}:00:00Z`;
  const completed_at = `2026-10-29T0${run_attempt}:30:00Z`;
  return {
    id: run_attempt * 100 + (platform === "ios" ? 1 : 2),
    run_id: 123,
    head_sha: "current-head",
    name,
    run_attempt,
    status: "completed",
    conclusion: "success",
    started_at,
    completed_at,
    steps: stepNames.map((stepName, index) => ({
      number: platform === "macos" && index >= 13 ? index + 12 : index + 1,
      name: stepName,
      status: "completed",
      conclusion: "success",
      started_at: started_at as string | null,
      completed_at: completed_at as string | null,
    })),
  };
};
type Producer = ReturnType<typeof producer>;
const producers = () => [producer(names.ios, 1), producer(names.macos)];
const artifact = (platform: string, attempt: number) => ({
  id: attempt * 10 + (platform === "ios" ? 1 : 2),
  name: `shared-periphery-${platform}-123-${attempt}`,
  expired: false,
  workflow_run: { id: 123, head_sha: "current-head" },
});
const artifacts = () =>
  ["ios", "macos"].flatMap((platform) => [1, 2, 3].map((attempt) => artifact(platform, attempt)));
const resolve = async (
  jobs = producers(),
  reports = artifacts(),
  head = "current-head",
  jobPages = [jobs],
  artifactPages = [reports],
) => {
  const outputs = new Map<string, string>();
  const listJobsForWorkflowRun = () => {};
  const listWorkflowRunArtifacts = () => {};
  const actions = {
    listJobsForWorkflowRun,
    listWorkflowRunArtifacts,
    getWorkflowRun: async (params: unknown) => {
      expect(params).toMatchObject({ run_id: 123 });
      return { data: { head_sha: head } };
    },
  };
  await execute(
    {
      rest: { actions },
      paginate: async (request: unknown, params: unknown) => {
        expect(params).toMatchObject({ run_id: 123, per_page: 100 });
        if (request === listJobsForWorkflowRun) {
          expect(params).toMatchObject({ filter: "all" });
          return jobPages.flat();
        }
        expect(request).toBe(listWorkflowRunArtifacts);
        return artifactPages.flat();
      },
    },
    { repo: { owner: "openclaw", repo: "openclaw" }, runId: 123, sha: "current-head", payload: {} },
    { setOutput: (key: string, value: string) => outputs.set(key, value) },
  );
  return Object.fromEntries(outputs);
};

it("downloads validated artifact IDs without a competing name selector", () => {
  for (const platform of ["ios", "macos"]) {
    const download = steps("intersect").find(
      (step) => step.name === `Download ${platform === "ios" ? "iOS" : "macOS"} consumer report`,
    )!;
    expect(download.uses).toBe(
      "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
    );
    expect(download.with?.["artifact-ids"]).toBe(
      `\${{ steps.producers.outputs.${platform}-artifact-id }}`,
    );
    expect(download.with).not.toHaveProperty("name");
    expect(
      steps(`${platform}-index`).some(
        (step) =>
          step.with?.name ===
          `shared-periphery-${platform}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
      ),
    ).toBe(true);
  }
});

it("keeps the physical producer selector identical across trusted workflow boundaries", () => {
  const commentWorkflow = parse(
    readFileSync(".github/workflows/ios-periphery-comment.yml", "utf8"),
  ) as Workflow;
  const commentScript = commentWorkflow.jobs?.comment?.steps?.find(
    (step) => step.name === "Upsert Periphery PR comment",
  )?.with?.script;
  const selector = (source: string) =>
    source.slice(
      source.indexOf("const producerAttempt ="),
      source.indexOf("\n};", source.indexOf("const producerAttempt =")) + 3,
    );
  expect(selector(script)).toContain("executionKey");
  expect(selector(commentScript!)).toBe(selector(script));
});

it.each(["", "scan / "])("retains original producer attempts (%s)", async (prefix) => {
  await expect(
    resolve(
      producers().map((job) => {
        job.name = prefix + job.name;
        return job;
      }),
    ),
  ).resolves.toEqual({
    "ios-attempt": "1",
    "ios-artifact-id": "11",
    "macos-attempt": "2",
    "macos-artifact-id": "22",
  });
});

it.each(["ios", "macos"] as const)(
  "uses the earliest physical %s execution despite a later partial-rerun projection",
  async (platform) => {
    const original = producer(names[platform], 2);
    // The API retains all sixteen steps, including GitHub's post-job number gaps.
    expect(producer(names.macos).steps.map((step) => step.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 25, 26, 27,
    ]);
    const projected = {
      ...original,
      id: 999,
      run_attempt: 3,
      name: `scan / ${original.name}`,
      url: "https://api.github.com/projected-job",
      html_url: "https://github.com/projected-job",
    };
    const jobs = [producer(names[platform === "ios" ? "macos" : "ios"]), original, projected];
    await expect(resolve(jobs)).resolves.toMatchObject({
      [`${platform}-attempt`]: "2",
      [`${platform}-artifact-id`]: String(artifact(platform, 2).id),
    });
  },
);

it("normalizes equivalent timestamps, including skipped steps with null timestamps", async () => {
  const original = producer(names.macos);
  original.steps[5] = {
    ...original.steps[5]!,
    conclusion: "skipped",
    started_at: null,
    completed_at: null,
  };
  const projected = {
    ...original,
    id: 999,
    run_attempt: 3,
    started_at: original.started_at.replace("Z", ".000Z"),
    completed_at: original.completed_at.replace("Z", "+00:00"),
    steps: original.steps.map((step) => ({
      ...step,
      started_at: step.started_at?.replace("Z", ".000Z") ?? null,
      completed_at: step.completed_at?.replace("Z", "+00:00") ?? null,
    })),
  };
  await expect(resolve([producer(names.ios, 1), projected, original])).resolves.toMatchObject({
    "macos-attempt": "2",
    "macos-artifact-id": "22",
  });
});

it("does not use a newer artifact when the physical execution's artifact is missing", async () => {
  const original = producer(names.macos);
  const projected = { ...original, id: 999, run_attempt: 3 };
  await expect(
    resolve(
      [producer(names.ios, 1), original, projected],
      artifacts().filter((item) => item.name !== "shared-periphery-macos-123-2"),
    ),
  ).rejects.toThrow("shared-periphery-macos-123-2 artifact");
});

it.each([
  ["job start", (job: Producer) => ({ ...job, started_at: "2026-10-29T02:00:01Z" })],
  ["job end", (job: Producer) => ({ ...job, completed_at: "2026-10-29T02:30:01Z" })],
  ...(["number", "name", "status", "conclusion", "started_at", "completed_at"] as const).map(
    (field) =>
      [
        `intermediate step ${field}`,
        (job: Producer) => ({
          ...job,
          steps: job.steps.map((step, index) =>
            index !== 5
              ? step
              : {
                  ...step,
                  [field]:
                    field === "number"
                      ? 6.5
                      : field === "name"
                        ? "Changed producer step"
                        : field === "status"
                          ? "queued"
                          : field === "conclusion"
                            ? "failure"
                            : "2026-10-29T02:01:00Z",
                },
          ),
        }),
      ] as const,
  ),
] as const)("does not alias changed %s metadata", async (_label, change) => {
  const original = producer(names.macos);
  const changed = { ...change(original), run_attempt: 3 };
  if (
    changed.steps.some((step) => step.status !== "completed" || !Number.isSafeInteger(step.number))
  ) {
    await expect(resolve([producer(names.ios, 1), original, changed])).rejects.toThrow(
      "producer execution",
    );
  } else {
    await expect(resolve([producer(names.ios, 1), original, changed])).resolves.toMatchObject({
      "macos-attempt": "3",
      "macos-artifact-id": "32",
    });
  }
});

it.each(["ios", "macos"] as const)(
  "does not rescue a new failed %s execution with an older artifact",
  async (platform) => {
    const jobs = producers();
    jobs.push({ ...producer(names[platform], 3), conclusion: "failure" });
    await expect(
      resolve(
        jobs,
        artifacts().filter((item) => !item.name.endsWith("-3")),
      ),
    ).rejects.toThrow(`shared-periphery-${platform}-123-3 artifact`);
    await expect(resolve(jobs)).resolves.toMatchObject({ [`${platform}-attempt`]: "3" });
  },
);

it("retains independent reports from completed failed producers", async () => {
  await expect(
    resolve(
      producers().map((job) => {
        job.conclusion = "failure";
        for (const step of job.steps) {
          if (step.name.startsWith("Scan shared kit")) {
            step.conclusion = "failure";
          }
        }
        return job;
      }),
    ),
  ).resolves.toMatchObject({
    "ios-attempt": "1",
    "macos-attempt": "2",
  });
});

it("checks duplicates in older attempts across all paginated history before grouping", async () => {
  const original = producer(names.macos, 1);
  const newer = producer(names.macos, 3);
  const duplicate = { ...original, id: 999, name: `scan / ${original.name}` };
  await expect(
    resolve([], artifacts(), "current-head", [
      [producer(names.ios, 1), newer],
      [original],
      [duplicate],
    ]),
  ).rejects.toThrow("ambiguous Periphery producer attempt");
});

it("finds the earliest cohort and exact artifact across pages in any history order", async () => {
  const original = producer(names.macos, 1);
  const projected = { ...original, id: 999, run_attempt: 3 };
  await expect(
    resolve(
      [],
      [],
      "current-head",
      [[projected], [producer(names.ios, 1)], [original]],
      [[artifact("ios", 1)], [artifact("macos", 3)], [artifact("macos", 1)]],
    ),
  ).resolves.toMatchObject({ "macos-attempt": "1", "macos-artifact-id": "12" });
});

it.each([
  ["missing", () => producers().slice(0, 1)],
  ["ambiguous", () => [...producers(), producer(`scan / ${names.macos}`)]],
  [
    "wrong run",
    () =>
      producers().map((job) => {
        job.run_id = 999;
        return job;
      }),
  ],
  [
    "wrong head",
    () =>
      producers().map((job) => {
        job.head_sha = "old-head";
        return job;
      }),
  ],
  [
    "incomplete",
    () =>
      producers().map((job) => {
        job.status = "queued";
        return job;
      }),
  ],
  [
    "invalid attempt",
    () =>
      producers().map((job) => {
        job.run_attempt = 0;
        return job;
      }),
  ],
  [
    "missing start",
    () =>
      producers().map((job) => {
        job.started_at = "";
        return job;
      }),
  ],
  [
    "invalid end",
    () =>
      producers().map((job) => {
        job.completed_at = "not a date";
        return job;
      }),
  ],
  [
    "missing steps",
    () =>
      producers().map((job) => {
        job.steps = [];
        return job;
      }),
  ],
  [
    "non-skipped null timestamp",
    () =>
      producers().map((job) => {
        for (const step of job.steps) {
          step.started_at = null;
        }
        return job;
      }),
  ],
  [
    "unordered steps",
    () =>
      producers().map((job) => {
        job.steps = job.steps.toReversed();
        return job;
      }),
  ],
] as const)("fails closed for %s producer metadata", async (_label, jobs) => {
  await expect(resolve(jobs())).rejects.toThrow("Periphery producer");
});

it.each([
  ["duplicate name", () => [...artifacts(), { ...artifact("ios", 1), id: 999 }]],
  ["duplicate ID", () => [...artifacts(), { ...artifact("ios", 1), name: "unrelated" }]],
  [
    "invalid ID",
    () =>
      artifacts().map((item) => {
        item.id = 0;
        return item;
      }),
  ],
  [
    "wrong run",
    () =>
      artifacts().map((item) => {
        item.workflow_run.id = 999;
        return item;
      }),
  ],
  [
    "wrong head",
    () =>
      artifacts().map((item) => {
        item.workflow_run.head_sha = "old-head";
        return item;
      }),
  ],
  [
    "expired",
    () =>
      artifacts().map((item) => {
        item.expired = true;
        return item;
      }),
  ],
] as const)("rejects %s artifact identity", async (_label, reports) => {
  await expect(resolve(producers(), reports())).rejects.toThrow("artifact");
});

it("rejects another run head before selecting reports", async () => {
  await expect(resolve(producers(), artifacts(), "old-head")).rejects.toThrow("producer head");
});
