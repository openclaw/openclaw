import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { markdownToIR } from "../../packages/markdown-core/src/ir.js";
import type { WorkflowStep } from "./ci-workflow.test-support.js";

const WORKFLOW_PATH = ".github/workflows/ios-periphery-comment.yml";
const PRODUCER_WORKFLOW_PATH = ".github/workflows/ios-periphery.yml";
const MACOS_PRODUCER_WORKFLOW_PATH = ".github/workflows/macos-periphery.yml";
const ARTIFACT_NAME = "ios-periphery-dead-code-12345-2";

type Workflow = {
  name: string;
  "run-name": string;
  jobs?: Record<string, { "runs-on"?: string; steps?: WorkflowStep[] }>;
};

const artifactFixture = { expired: false, id: 77, name: ARTIFACT_NAME, size_in_bytes: 1 };
type Artifact = typeof artifactFixture;

type ExistingComment = { body?: string; id: number; user?: { login?: string } };

type WorkflowRun = {
  display_title?: string | null;
  event: string;
  name: string;
  repository: { full_name: string };
  status?: string;
  head_sha: string;
  id: number;
  pull_requests?: Array<{ number: number }>;
  run_attempt: number;
  run_number: number;
  workflow_id: number;
};

type ProducerEvent = {
  eventName: "pull_request" | "workflow_dispatch";
  action?: string;
  draft?: boolean;
};
const sourceEvents = {
  report: { eventName: "pull_request", action: "ready_for_review", draft: false },
  draft: { eventName: "pull_request", action: "converted_to_draft", draft: true },
  passive: { eventName: "pull_request", action: "synchronize", draft: true },
  manual: { eventName: "workflow_dispatch" },
} satisfies Record<string, ProducerEvent>;

const readWorkflow = (file: string) => parse(readFileSync(file, "utf8")) as Workflow;
const makeArtifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  ...artifactFixture,
  ...overrides,
});
const previousComments = (
  platform: "iOS" | "macOS" = "iOS",
  login = "github-actions[bot]",
): [ExistingComment] => [
  {
    id: 99,
    body: `<!-- openclaw-${platform.toLowerCase()}-periphery-dead-code -->\nprevious findings`,
    user: { login },
  },
];

function producerRunMetadata(
  platform: "iOS" | "macOS",
  source: ProducerEvent = sourceEvents.report,
) {
  const file = platform === "iOS" ? PRODUCER_WORKFLOW_PATH : MACOS_PRODUCER_WORKFLOW_PATH;
  const workflow = readWorkflow(file);
  const github = {
    workflow: workflow.name,
    event_name: source.eventName,
    event:
      source.eventName === "pull_request"
        ? {
            action: source.action,
            pull_request: {
              draft: source.draft,
              title: "Untrusted PR title [report]",
              body: "Untrusted body",
            },
          }
        : {},
  };
  // These expressions use only typed booleans, strings, equality, and &&/||,
  // whose semantics match JavaScript for the explicit event contexts below.
  const display_title = workflow["run-name"].replace(
    /\$\{\{([\s\S]*?)\}\}/gu,
    (_match, expression: string) =>
      String(compileFunction(`return (${expression});`, ["github"])(github)),
  );
  return { name: workflow.name, event: source.eventName, display_title };
}

const commenterScript = readWorkflow(WORKFLOW_PATH).jobs?.comment?.steps?.find(
  (candidate) => candidate.name === "Upsert Periphery PR comment",
)?.with?.script;
if (typeof commenterScript !== "string" || !commenterScript) {
  throw new Error("missing iOS Periphery commenter script");
}
const executeCommenter = compileFunction(`return (async () => {\n${commenterScript}\n})();`, [
  "require",
  "context",
  "core",
  "github",
]) as (require: NodeJS.Require, context: unknown, core: unknown, github: unknown) => Promise<void>;

async function runCommenter(
  artifact: Artifact,
  archiveData: Buffer,
  options: {
    platform?: "iOS" | "macOS";
    sourceEvent?: ProducerEvent;
    run?: Partial<WorkflowRun>;
    liveDraft?: boolean;
    liveDraftAfter?: boolean;
    liveStateAfter?: string;
    liveRepositoryAfter?: string;
    existingComments?: ExistingComment[];
    commentErrorStatus?: number;
    liveHeadSha?: string;
    liveHeadShaAfter?: string;
    scanJobConclusion?: string;
    scanAttempt?: number;
    producerAttempt?: number;
    producerConclusion?: string;
    previousAttempts?: number[];
    scopeJobConclusion?: string;
    workflowRuns?: Partial<WorkflowRun>[];
  } = {},
) {
  const platform = options.platform ?? "iOS";
  const run: WorkflowRun = {
    ...producerRunMetadata(platform, options.sourceEvent),
    head_sha: "head-sha",
    id: 12345,
    pull_requests: [{ number: 123 }],
    repository: { full_name: "openclaw/openclaw" },
    run_attempt: 2,
    run_number: 8,
    workflow_id: 999,
    ...options.run,
  };
  const apiCalls: string[] = [];
  const core = {
    infos: [] as string[],
    warnings: [] as string[],
    info(message: string) {
      this.infos.push(message);
    },
    warning(message: string) {
      this.warnings.push(message);
    },
  };
  let pullGetCount = 0;
  const createdBodies: string[] = [];
  const updatedBodies: string[] = [];
  function writeComment(method: string, bodies: string[], body: string) {
    if (options.commentErrorStatus) {
      throw Object.assign(new Error("comment write failed"), {
        status: options.commentErrorStatus,
      });
    }
    apiCalls.push(method);
    bodies.push(body);
  }
  const github = {
    rest: {
      actions: {
        listJobsForWorkflowRun(this: void, params: Record<string, unknown>) {
          apiCalls.push("listJobs");
          expect(params).toMatchObject({ run_id: run.id, filter: "all" });
          return [
            ...(options.previousAttempts ?? []).flatMap((run_attempt) =>
              [
                {
                  name: `Detect ${platform} scan scope`,
                  conclusion: "success",
                  status: "completed",
                  run_attempt,
                },
                {
                  name: `Scan ${platform} dead code`,
                  conclusion: "skipped",
                  status: "completed",
                  run_attempt,
                },
              ].concat(
                platform === "macOS"
                  ? [
                      {
                        name: "Build macOS Periphery reports",
                        conclusion: "success",
                        status: "completed",
                        run_attempt,
                      },
                    ]
                  : [],
              ),
            ),
            {
              conclusion: options.scopeJobConclusion ?? "success",
              name: `Detect ${platform} scan scope`,
              run_attempt: run.run_attempt,
              status: "completed",
            },
            {
              conclusion: options.scanJobConclusion ?? "success",
              name: `Scan ${platform} dead code`,
              run_attempt: options.scanAttempt ?? options.producerAttempt ?? run.run_attempt,
              status: "completed",
            },
            ...(platform === "macOS"
              ? [
                  {
                    conclusion: options.producerConclusion ?? "success",
                    name: "Build macOS Periphery reports",
                    run_attempt: options.producerAttempt ?? run.run_attempt,
                    status: "completed",
                  },
                ]
              : []),
          ];
        },
        listWorkflowRunArtifacts(this: void, params: Record<string, unknown>) {
          apiCalls.push("listArtifacts");
          expect(params.run_id).toBe(run.id);
          return [
            {
              ...artifact,
              name:
                artifact.name ||
                `${platform.toLowerCase()}-periphery-dead-code-${run.id}-${run.run_attempt}`,
            },
          ];
        },
        listWorkflowRuns(this: void, params: Record<string, unknown>) {
          apiCalls.push("listRuns");
          expect(params).toMatchObject({
            workflow_id: run.workflow_id,
            event: "pull_request",
            head_sha: run.head_sha,
          });
          return options.workflowRuns?.map((candidate) => ({ ...run, ...candidate })) ?? [run];
        },
        async downloadArtifact() {
          apiCalls.push("downloadArtifact");
          return { data: archiveData };
        },
      },
      issues: {
        listComments(this: void, params: Record<string, unknown>) {
          expect(params.issue_number).toBe(123);
          apiCalls.push("listComments");
          return options.existingComments ?? [];
        },
        async createComment(params: { body: string }) {
          writeComment("createComment", createdBodies, params.body);
          options.existingComments?.push({
            id: 100,
            body: params.body,
            user: { login: "github-actions[bot]" },
          });
        },
        async updateComment(params: { body: string; comment_id: number }) {
          writeComment("updateComment", updatedBodies, params.body);
          const existing = options.existingComments?.find(
            (comment) => comment.id === params.comment_id,
          );
          if (existing) {
            existing.body = params.body;
          }
        },
      },
      pulls: {
        async get() {
          apiCalls.push("getPull");
          pullGetCount += 1;
          const after = pullGetCount > 1;
          const draft = options.liveDraft ?? false;
          const sha = options.liveHeadSha ?? "head-sha";
          return {
            data: {
              base: {
                repo: {
                  full_name: after
                    ? (options.liveRepositoryAfter ?? "openclaw/openclaw")
                    : "openclaw/openclaw",
                },
              },
              draft: after ? (options.liveDraftAfter ?? draft) : draft,
              head: { sha: after ? (options.liveHeadShaAfter ?? sha) : sha },
              number: 123,
              state: after ? (options.liveStateAfter ?? "open") : "open",
            },
          };
        },
      },
    },
    async paginate(request: unknown, params: Record<string, unknown>) {
      const handler = [
        github.rest.actions.listJobsForWorkflowRun,
        github.rest.actions.listWorkflowRunArtifacts,
        github.rest.actions.listWorkflowRuns,
        github.rest.issues.listComments,
      ].find((method) => method === request);
      if (!handler) {
        throw new Error(`unexpected paginate call: ${JSON.stringify(params)}`);
      }
      return handler(params);
    },
  };
  const context = { payload: { workflow_run: run }, repo: { owner: "openclaw", repo: "openclaw" } };

  await executeCommenter(createRequire(import.meta.url), context, core, github);

  return {
    apiCalls,
    artifactListCount: apiCalls.filter((call) => call === "listArtifacts").length,
    core,
    createdBodies,
    downloadCount: apiCalls.filter((call) => call === "downloadArtifact").length,
    jobListCount: apiCalls.filter((call) => call === "listJobs").length,
    pullGetCount,
    updatedBodies,
  };
}

async function runReport(
  archive: Buffer | Promise<Buffer>,
  options: Parameters<typeof runCommenter>[2] = {},
  artifactOptions: Partial<Artifact> = {},
) {
  const data = await archive;
  return runCommenter(
    makeArtifact({ size_in_bytes: data.length, ...artifactOptions }),
    data,
    options,
  );
}

function expectUnavailableComment(bodies: string[]): void {
  expect(bodies).toEqual([
    expect.stringContaining("Periphery did not complete or its report could not be safely read."),
  ]);
}

function expectNoWrite(result: Awaited<ReturnType<typeof runCommenter>>) {
  expect(result.createdBodies).toEqual([]);
  expect(result.updatedBodies).toEqual([]);
}

function makeZip(
  files: Record<string, string>,
  compression: "STORE" | "DEFLATE" = "STORE",
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, contents] of Object.entries(files)) {
    zip.file(name, contents, { createFolders: false, date: new Date("2026-01-01T00:00:00Z") });
  }
  return zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression });
}

function reportZip(
  findings: unknown = [],
  status = "0\n",
  compression: Parameters<typeof makeZip>[1] = "STORE",
) {
  return makeZip(
    { "periphery.json": JSON.stringify(findings), "periphery.status": status },
    compression,
  );
}

async function tamperFirstEntry(
  archive: Promise<Buffer>,
  options: { encrypted?: boolean; size?: number },
): Promise<Buffer> {
  const result = Buffer.from(await archive);
  const centralOffset = result.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (options.encrypted) {
    result.writeUInt16LE(1, centralOffset + 8);
  }
  if (options.size !== undefined) {
    result.writeUInt32LE(options.size, 22);
    result.writeUInt32LE(options.size, centralOffset + 24);
  }
  return result;
}

const findingArchive = reportZip(
  [{ kind: "function", location: "Sources/Test.swift:12", name: "unusedSyntheticFunction" }],
  "1\n",
);

describe("iOS Periphery comment workflow", () => {
  it("scopes the report artifact to the workflow attempt", () => {
    const workflow = readWorkflow(PRODUCER_WORKFLOW_PATH);
    const upload = workflow.jobs?.scan?.steps?.find(
      (step) => step.name === "Upload Periphery report",
    );

    expect(upload).toMatchObject({
      if: "always()",
      with: {
        name: "ios-periphery-dead-code-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/ios-periphery",
        "if-no-files-found": "error",
      },
    });
  });

  it("uses hosted macOS capacity for scans", () => {
    const iosWorkflow = readWorkflow(PRODUCER_WORKFLOW_PATH);
    const macosWorkflow = readWorkflow(MACOS_PRODUCER_WORKFLOW_PATH);
    expect(iosWorkflow.jobs?.scan?.["runs-on"]).toBe("xcode-27");
    expect(macosWorkflow.jobs?.["macos-index"]?.["runs-on"]).toBe("xcode-27");
    expect(macosWorkflow.jobs?.["scan-ios"]?.["runs-on"]).toBe("xcode-27");
  });

  it.each([
    [
      "oversized artifact metadata before download",
      () => Buffer.alloc(0),
      "compressed artifact size 1048577 exceeds the 1048576 byte limit.",
      1024 * 1024 + 1,
    ],
    [
      "deflated entries that inflate past the per-file limit",
      () =>
        tamperFirstEntry(
          makeZip(
            {
              "periphery.json": `${" ".repeat(2 * 1024 * 1024 + 1)}[]\n`,
              "periphery.status": "0\n",
            },
            "DEFLATE",
          ),
          { size: 1 },
        ),
      "periphery.json exceeded the per-file size limit while reading.",
      undefined,
    ],
    [
      "unexpected artifact paths",
      () => makeZip({ "../periphery.json": "[]\n", "periphery.status": "0\n" }),
      "unexpected artifact entry ../periphery.json.",
      undefined,
    ],
    [
      "encrypted artifact entries",
      () => tamperFirstEntry(reportZip(), { encrypted: true }),
      "periphery.json is encrypted.",
      undefined,
    ],
  ] as const)("rejects %s", async (_name, archive, warning, size) => {
    const result = await runReport(
      archive(),
      {},
      size === undefined ? {} : { size_in_bytes: size },
    );
    if (size !== undefined) {
      expect(result.downloadCount).toBe(0);
    }
    expectUnavailableComment(result.createdBodies);
    expect(result.core.warnings).toEqual([`Skipping ${ARTIFACT_NAME}; ${warning}`]);
  });

  it("does not read artifacts from a stale workflow run", async () => {
    const result = await runCommenter(makeArtifact(), Buffer.alloc(0), {
      liveHeadSha: "new-head",
      run: { head_sha: "old-head" },
    });

    expect(result).toMatchObject({ artifactListCount: 0, downloadCount: 0 });
  });

  it("does not reuse an artifact from an earlier workflow attempt", async () => {
    const result = await runCommenter(
      makeArtifact({ name: "ios-periphery-dead-code-12345-1" }),
      Buffer.alloc(0),
      { existingComments: previousComments() },
    );

    expect(result.downloadCount).toBe(0);
    expect(result.core.warnings).toEqual([`No ${ARTIFACT_NAME} artifact found.`]);
    expectUnavailableComment(result.updatedBodies);
  });

  it.each(["iOS", "macOS"] as const)(
    "reads the retained %s producer after an unrelated failed-job rerun",
    async (platform) => {
      const result = await runReport(
        findingArchive,
        {
          platform,
          run: { run_attempt: 3 },
          scanAttempt: platform === "macOS" ? 3 : 2,
          producerAttempt: 2,
        },
        { name: `${platform.toLowerCase()}-periphery-dead-code-12345-2` },
      );
      expect(result.downloadCount).toBe(1);
      expect(result.createdBodies[0]).toContain("unusedSyntheticFunction");
      expect(result.core.warnings).toEqual([]);
    },
  );

  it.each(["failure", "cancelled"])(
    "does not fall back to an old report after a %s macOS producer rerun",
    async (producerConclusion) => {
      const result = await runReport(
        findingArchive,
        {
          platform: "macOS",
          producerAttempt: 3,
          producerConclusion,
          previousAttempts: [1, 2],
          scanJobConclusion: producerConclusion === "cancelled" ? "skipped" : "failure",
          run: { run_attempt: 3 },
        },
        { name: "macos-periphery-dead-code-12345-2" },
      );
      expect(result.downloadCount).toBe(0);
      expectUnavailableComment(result.createdBodies);
      expect(result.core.warnings).toEqual([
        "No macos-periphery-dead-code-12345-3 artifact found.",
      ]);
    },
  );

  it("reads the newly produced macOS report after a producer rerun", async () => {
    const result = await runReport(
      findingArchive,
      { platform: "macOS", producerAttempt: 3, previousAttempts: [1, 2], run: { run_attempt: 3 } },
      { name: "macos-periphery-dead-code-12345-3" },
    );
    expect(result.downloadCount).toBe(1);
    expect(result.createdBodies[0]).toContain("unusedSyntheticFunction");
  });

  it("reads deflated findings and escapes them before creating a PR comment", async () => {
    const longName = `![click](https://example.invalid)\r\n@octocat|next${"a".repeat(260)}`;
    const archive = reportZip(
      [{ kind: "<script>*bold*</script>", location: "Sources/Test.swift:12", name: longName }],
      "1\n",
      "DEFLATE",
    );
    const result = await runReport(archive);

    expect(result).toMatchObject({ downloadCount: 1, core: { warnings: [] } });
    expect(result.createdBodies).toHaveLength(1);
    const body = result.createdBodies[0] ?? "";
    const parsed = markdownToIR(body, { linkify: true, tableMode: "bullets" });
    expect(body).not.toContain("\r");
    expect(parsed.text).toContain("<script>*bold*</script>");
    expect(parsed.text).toContain("![click](https://example.invalid) @octocat|next");
    expect(parsed.links).toEqual([]);
  });

  it("bounds the rendered comment after escaping", async () => {
    const repeated = "{".repeat(500);
    const archive = reportZip(
      Array.from({ length: 50 }, (_, index) => ({
        kind: repeated,
        location: `${repeated}${index}:${index}`,
        name: repeated,
      })),
      "1\n",
    );
    const result = await runReport(archive);

    expect(result.createdBodies).toHaveLength(1);
    expect(result.createdBodies[0]?.length).toBeLessThanOrEqual(60_000);
  });

  it("warns without failing when workflow_run token cannot write comments", async () => {
    const result = await runReport(findingArchive, { commentErrorStatus: 403 });

    expectNoWrite(result);
    expect(result.core.warnings).toContain(
      "Skipping Periphery PR comment for #123; GitHub token cannot write issue comments for this workflow_run.",
    );
  });

  it("does not overwrite a marker comment owned by another bot", async () => {
    const result = await runReport(findingArchive, {
      existingComments: previousComments("iOS", "another-app[bot]"),
    });

    expect(result.updatedBodies).toEqual([]);
    expect(result.createdBodies).toHaveLength(1);
  });
});

describe("Periphery publication admission", () => {
  const platform = "iOS";
  const name = `${platform} Periphery Dead Code`;
  const report = producerRunMetadata(platform);
  const passive = producerRunMetadata(platform, sourceEvents.passive);
  const draft = producerRunMetadata(platform, sourceEvents.draft);
  const newerRun = (metadata: Partial<WorkflowRun> = {}): Partial<WorkflowRun> => ({
    id: 54321,
    run_number: 9,
    ...metadata,
  });
  const publish = (options: Parameters<typeof runCommenter>[2] = {}) =>
    runReport(findingArchive, { platform, ...options }, { name: "" });

  describe.each(["iOS", "macOS"] as const)("%s producer admission", (producerPlatform) => {
    it.each(["report", "draft", "passive", "manual"] as const)(
      "publishes according to producer intent %s",
      async (intent) => {
        const sourceEvent: ProducerEvent = sourceEvents[intent];
        const metadata = producerRunMetadata(producerPlatform, sourceEvent);
        expect(metadata.display_title).toBe(`${producerPlatform} Periphery Dead Code [${intent}]`);
        const result = await publish({
          platform: producerPlatform,
          sourceEvent,
          liveDraft: sourceEvent.draft,
          existingComments: previousComments(producerPlatform),
          scanJobConclusion: sourceEvent.draft ? "skipped" : "success",
        });
        if (intent === "report" || intent === "draft") {
          expect(result.updatedBodies).toHaveLength(1);
          expect(result.updatedBodies[0]).toContain(
            intent === "report" ? "unusedSyntheticFunction" : "pull request is a draft",
          );
        } else {
          expect(result.apiCalls).toEqual([]);
        }
      },
    );
  });

  it.each(["ready then passive", "passive then ready"])(
    "preserves ready findings: %s",
    async (order) => {
      const existingComments = previousComments();
      const ready = { ...report, id: 201, run_number: 10, run_attempt: 1 };
      const delayedPassive = { ...passive, id: 202, run_number: 11, run_attempt: 1 };
      const callbacks =
        order === "ready then passive" ? [ready, delayedPassive] : [delayedPassive, ready];
      for (const run of callbacks) {
        const result = await publish({
          run,
          existingComments,
          workflowRuns: [delayedPassive, ready],
          scanJobConclusion: run === delayedPassive ? "skipped" : "success",
        });
        if (run === delayedPassive) {
          expect(result.apiCalls).toEqual([]);
          expectNoWrite(result);
        } else {
          expect(result.updatedBodies).toHaveLength(1);
          expect(result.updatedBodies[0]).toContain("unusedSyntheticFunction");
          expect(result.apiCalls.slice(-2)).toEqual(["getPull", "updateComment"]);
        }
      }
      expect(existingComments[0].body).toContain("unusedSyntheticFunction");
    },
  );

  it.each([true, false])("explicit draft cleanup respects live draft=%s", async (liveDraft) => {
    const existingComments = previousComments();
    const result = await publish({
      run: draft,
      liveDraft,
      existingComments,
      scanJobConclusion: "skipped",
    });
    expect(result).toMatchObject({
      artifactListCount: 0,
      jobListCount: 0,
      downloadCount: 0,
      createdBodies: [],
    });
    if (liveDraft) {
      expect(result.updatedBodies).toHaveLength(1);
      expect(existingComments[0].body).toContain("pull request is a draft");
      expect(existingComments[0].body).not.toContain("no longer touches");
    } else {
      expect(result.updatedBodies).toEqual([]);
      expect(existingComments[0].body).toContain("previous findings");
    }
  });

  it.each([
    ["passive", `${name} [passive]`],
    ["missing", undefined],
    ["trailing text", `${name} [report] extra`],
    ["wrong workflow", `Other Periphery Dead Code [report]`],
  ])("records %s metadata as a no-op without API work", async (_label, display_title) => {
    const result = await publish({
      run: { display_title },
      existingComments: previousComments(),
      scanJobConclusion: "skipped",
    });
    expect(result.apiCalls).toEqual([]);
    expect(result.core.infos.length).toBeGreaterThan(0);
    expectNoWrite(result);
  });

  it.each([
    ["pending report", newerRun({ status: "queued" }), true],
    ["pending attempt", { run_attempt: 3, status: "in_progress" }, true],
    ["other PR", newerRun({ pull_requests: [{ number: 456 }] }), false],
    ["passive", newerRun(passive), false],
    ["delayed converted_to_draft", newerRun(draft), false],
    ["missing admission", newerRun({ display_title: undefined }), false],
    ["malformed admission", newerRun({ display_title: `${name} [report] suffix` }), false],
  ] satisfies Array<[string, Partial<WorkflowRun>, boolean]>)(
    "supersession eligibility: %s",
    async (_label, candidate, supersedes) => {
      const result = await publish({ workflowRuns: [candidate] });
      expect(result.createdBodies).toHaveLength(supersedes ? 0 : 1);
      expect(result.updatedBodies).toEqual([]);
    },
  );

  it.each([
    ["new draft", draft, true],
    ["stale report", report, false],
    ["passive draft", passive, false],
  ])("draft cleanup supersession: %s", async (_label, candidate, supersedes) => {
    const result = await publish({
      run: draft,
      liveDraft: true,
      existingComments: previousComments(),
      workflowRuns: [newerRun({ ...candidate, status: "queued" })],
    });
    expect(result.updatedBodies).toHaveLength(supersedes ? 0 : 1);
    expect(result.artifactListCount).toBe(0);
  });

  it.each([
    ["create/head", { liveHeadShaAfter: "new-head" }, false],
    ["create/draft", { liveDraftAfter: true }, false],
    ["update/head", { liveHeadShaAfter: "new-head" }, true],
    ["update/ready to draft", { liveDraftAfter: true }, true],
    [
      "draft to ready",
      { liveDraft: true, liveDraftAfter: false, run: draft, scanJobConclusion: "skipped" },
      true,
    ],
    ["update/closed", { liveStateAfter: "closed" }, true],
    ["update/repository", { liveRepositoryAfter: "other/repository" }, true],
  ] satisfies Array<[string, Parameters<typeof runCommenter>[2], boolean]>)(
    "rejects %s changes before writing",
    async (_label, options, existing) => {
      const result = await publish({
        ...options,
        existingComments: existing ? previousComments() : undefined,
      });
      expect(result.pullGetCount).toBe(2);
      expect(result.apiCalls.at(-1)).toBe("getPull");
      expectNoWrite(result);
    },
  );

  it("does not consume an admitted report while the PR is draft", async () => {
    const result = await publish({ liveDraft: true });
    expect(result).toMatchObject({ jobListCount: 0, artifactListCount: 0, createdBodies: [] });
  });

  it.each(["iOS", "macOS"] as const)(
    "cleans up genuine %s scope loss on the report path",
    async (reportPlatform) => {
      const result = await publish({
        platform: reportPlatform,
        existingComments: previousComments(reportPlatform),
        scanJobConclusion: "skipped",
      });
      expect(result.jobListCount).toBe(1);
      expect(result.artifactListCount).toBe(0);
      expect(result.updatedBodies).toHaveLength(1);
      expect(result.updatedBodies[0]).toContain(`no longer touches ${reportPlatform} scan scope`);
      expect(result.updatedBodies[0]).not.toContain("is a draft");
    },
  );

  it.each([
    ["scope failure", "failure", "skipped"],
    ["scan failure", "success", "failure"],
  ])(
    "reports unavailable for %s without a report",
    async (_label, scopeJobConclusion, scanJobConclusion) => {
      const result = await runCommenter(makeArtifact({ name: "wrong-attempt" }), Buffer.alloc(0), {
        platform,
        scopeJobConclusion,
        scanJobConclusion,
      });
      expectUnavailableComment(result.createdBodies);
    },
  );
});
