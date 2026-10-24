import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKnownMainRed,
  createMainFailureClassifier,
} from "../../scripts/ci-known-main-red.mjs";
import { formatFailureReport, reportPrFailures } from "../../scripts/ci-pr-failure-report.mjs";
import {
  extractNodeFailedTests,
  parseNodeFailureReport,
} from "../../scripts/lib/ci-node-test-evidence.mjs";
import {
  evaluateWorkflow,
  expectIncludes,
  readCiWorkflow,
  requiredWorkflowStep,
} from "./ci-workflow.test-support.js";

const repository = "openclaw/openclaw";
const headSha = "a".repeat(40);
const mainSha = "b".repeat(40);
const baseSha = "c".repeat(40);
const prContext = {
  repository,
  headRepository: repository,
  token: "synthetic-token",
  headSha,
  pullRequestNumber: 7,
  runId: 100,
  runAttempt: 1,
};
const file = "src/gateway/example.test.ts";
const title = "startup > recovers the session";
const report = (test = title) => `
2026-09-27T19:34:09.0000000Z [shard:gateway] begin
2026-09-27T19:34:10.0000000Z [shard:gateway] [test] starting test/vitest/vitest.gateway.config.ts
2026-09-27T19:34:16.6951018Z [shard:gateway]  FAIL   gateway  ${file} > ${test}
2026-09-27T19:34:16.6951669Z [shard:gateway] AssertionError: expected true to be false
2026-09-27T19:34:16.6981000Z [shard:gateway] Test Files 1 failed (1)
2026-09-27T19:34:16.6981653Z [shard:gateway] Tests 1 failed | 2 passed (3)
2026-09-27T19:34:17.0000000Z [shard:gateway] [test] failed 1 Vitest shard in 7s
2026-09-27T19:34:17.1000000Z [shard:gateway] [test] FAILED (exit 1)
2026-09-27T19:34:17.1500000Z [shard:gateway] end (exit 1)
2026-09-27T19:34:17.2000000Z [shard:completion] {"version":1,"planned":1,"completed":1,"invocations":1,"failedInvocations":1}
2026-09-27T19:34:16.7040403Z ##[error]AssertionError: expected true to be false
2026-09-27T19:34:18.6571653Z ##[error]Process completed with exit code 1.
`;
const mainRun = {
  id: 200,
  run_attempt: 1,
  run_number: 100,
  event: "schedule",
  path: ".github/workflows/ci.yml",
  head_branch: "main",
  head_sha: mainSha,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  status: "completed",
  conclusion: "failure",
};
const prRun = { ...mainRun, id: 100, event: "pull_request", head_sha: headSha };
const job = {
  id: 10,
  run_id: 100,
  run_attempt: 1,
  name: "checks-node-compact-small-1",
  status: "completed",
  conclusion: "failure",
  steps: [{ name: "Run Node test shard", conclusion: "failure" }],
};
const typeFile = "src/acp/control-plane/manager.preactive-cancellation.test.ts";
const typeDiagnostic = `${typeFile}(92,14): error TS2367: This comparison appears to be unintentional.`;
const staticReport = (
  kind: "tsgo" | "oxlint",
  config: string,
  diagnostic: string,
  exitCode: number,
) =>
  [
    `##[group]Run node scripts/${kind === "tsgo" ? "run-tsgo-core-test-shards" : "run-oxlint"}.mjs`,
    "##[endgroup]",
    diagnostic,
    `[ci-static:${kind}:leaf] ${JSON.stringify({
      version: 1,
      id: "batch:0",
      config,
      exitCode,
      stdout: `${diagnostic}\n`,
      stderr: "",
    })}`,
    `[ci-static:${kind}:completion] {"version":1,"id":"batch","planned":1,"completed":1,"leaves":["batch:0"]}`,
    `[ci-static:${kind}:step] {"version":1,"groups":1}`,
    `##[error]Process completed with exit code ${exitCode}.`,
  ].join("\n");
const typeReport = (diagnostic = typeDiagnostic) =>
  staticReport("tsgo", "test/tsconfig/tsconfig.core.test.agents-root.json", diagnostic, 2);
const typeJob = {
  ...job,
  name: "check-test-types-core-5",
  steps: [{ name: "Run hosted core test-types stripe", conclusion: "failure" }],
};
const lintFile = "extensions/workboard/browser/lib/workboard/card-alerts.ts";
const lintReport = `##[group]Run node scripts/run-oxlint.mjs
##[endgroup]
${lintFile}:1:10: error: unused import (eslint(no-unused-vars))
Found 0 warnings and 1 error.
##[error]Process completed with exit code 1.`;
const lintJob = {
  ...job,
  name: "check-lint-extensions-3",
  steps: [{ name: "Run hosted extension lint stripe", conclusion: "failure" }],
};
const completeLintReport = (message = "unused import") =>
  staticReport(
    "oxlint",
    "config/oxlint/typed.json",
    `${lintFile}:1:10: error: ${message} (eslint(no-unused-vars))\nFound 0 warnings and 1 error.`,
    1,
  );
const failedJob = (name: string, step: string, base = job) => ({
  ...base,
  name,
  steps: [{ name: step, conclusion: "failure" }],
});
const changedReport = (from: string | RegExp, to: string) => ({
  prReport: report().replace(from, to),
});
const appendedReport = (text: string) => ({ prReport: `${report()}\n${text}` });
const insertFailure = (anchor: string, message: string) =>
  changedReport(anchor, `Error: ${message}\n[shard:gateway] ${anchor}`);

function mockApi(
  responses: Record<string, unknown>,
  fallback?: (url: URL, path: string) => Response,
  unavailable?: string,
) {
  const api = vi.fn(async (input: string, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = new URL(input);
    const path = url.pathname.replace(`/repos/${repository}`, "");
    if (path === unavailable) {
      return new Response("Unavailable", { status: 503 });
    }
    if (Object.hasOwn(responses, path)) {
      const body = responses[path];
      return new Response(typeof body === "string" ? body : JSON.stringify(body));
    }
    if (fallback) {
      return fallback(url, path);
    }
    throw new Error(`Unexpected API request ${path}`);
  });
  vi.stubGlobal("fetch", api);
  return api;
}

function failureClassifier(
  options: {
    mainJobs?: (typeof job)[];
    runs?: (typeof mainRun)[];
    mainReport?: string;
    prReport?: string;
    unavailable?: string;
  } = {},
) {
  const runs = options.runs ?? [mainRun];
  const latest = runs.toSorted((a, b) => b.run_number - a.run_number)[0];
  const jobs = (options.mainJobs ?? [{ ...job, id: 20 }]).map((entry) =>
    Object.assign({}, entry, { run_id: latest?.id }),
  );
  const api = mockApi(
    {
      "/actions/workflows/ci.yml/runs": { workflow_runs: runs },
      [`/actions/runs/${latest?.id}/attempts/1/jobs`]: { total_count: jobs.length, jobs },
      "/actions/jobs/20/logs": options.mainReport ?? report(),
      "/actions/jobs/10/logs": options.prReport ?? report(),
    },
    undefined,
    options.unavailable,
  );
  return { api, ...createMainFailureClassifier({ repository, token: "synthetic-token" }) };
}

function gateFixture(
  options: {
    changed?: string[];
    headRepository?: string;
    mainReport?: string;
    prReport?: string;
    mainEvent?: string;
    age?: string;
    source?: string;
    changedCount?: number;
    mainConclusion?: string;
    liveMainSha?: string;
    mainChanged?: string[];
    failureJob?: typeof job;
    signatureFile?: string;
    packageNames?: Record<string, string>;
  } = {},
) {
  const changed = options.changed ?? ["src/channels/unrelated.ts"];
  const failureJob = options.failureJob ?? job;
  const signatureFile = options.signatureFile ?? file;
  const responses: Record<string, unknown> = {
    "/actions/runs/100": {
      ...prRun,
      head_repository: { full_name: options.headRepository ?? repository },
    },
    "/actions/runs/100/attempts/1/jobs": { total_count: 1, jobs: [failureJob] },
    "/actions/workflows/ci.yml/runs": {
      workflow_runs: [
        {
          ...mainRun,
          event: options.mainEvent ?? "schedule",
          conclusion: options.mainConclusion ?? "failure",
        },
      ],
    },
    "/pulls/7": {
      state: "open",
      draft: false,
      changed_files: options.changedCount ?? changed.length,
      head: { sha: headSha, repo: { full_name: options.headRepository ?? repository } },
      base: { ref: "main", repo: { full_name: repository } },
    },
    "/pulls/7/files": changed.map((filename) => ({ filename })),
    "/git/ref/heads/main": { object: { sha: options.liveMainSha ?? mainSha } },
    [`/compare/${options.liveMainSha ?? mainSha}...${headSha}`]: {
      merge_base_commit: { sha: baseSha },
    },
    [`/compare/${baseSha}...${mainSha}`]: { status: options.age ?? "ahead" },
    "/actions/runs/200/attempts/1/jobs": {
      total_count: 1,
      jobs: [{ ...failureJob, id: 20, run_id: 200 }],
    },
    "/actions/jobs/20/logs": options.mainReport ?? report(),
    "/actions/jobs/10/logs": options.prReport ?? report(),
  };
  if (options.liveMainSha) {
    responses[`/compare/${mainSha}...${options.liveMainSha}`] = {
      status: "ahead",
      files: (options.mainChanged ?? []).map((filename) => ({ filename })),
    };
  }
  mockApi(responses, (url, path) => {
    if (path === `/contents/${signatureFile}` || path.startsWith("/contents/packages/")) {
      if (url.searchParams.get("ref") !== mainSha) {
        throw new Error("Subject source must use the immutable main evidence revision");
      }
      return new Response(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from(
            path.endsWith("/package.json")
              ? JSON.stringify({ name: options.packageNames?.[path.split("/")[3]!] })
              : (options.source ??
                  'import { it } from "vitest"; import { start } from "./subject.js";'),
          ).toString("base64"),
        }),
      );
    }
    throw new Error(`Unexpected evidence request ${path}`);
  });
  return createKnownMainRed({
    ...prContext,
    headRepository: options.headRepository,
  });
}

const classify = (options: Parameters<typeof gateFixture>[0] = {}) =>
  gateFixture(options).classifyJob(options.failureJob ?? job);

afterEach(() => vi.unstubAllGlobals());

const known = async (options: Parameters<typeof classify>[0] = {}) =>
  (await classify(options)).known;

async function expectKnown(options: Parameters<typeof classify>[0], expected = false) {
  expect(await known(options)).toBe(expected);
}

describe("main failure attribution", () => {
  it.each([
    { conclusion: "success", mainSelected: true, expected: "unknown" },
    { conclusion: "failure", mainSelected: true, expected: "unknown" },
    { conclusion: "success", mainSelected: false, expected: "new" },
  ])(
    "compares selected build verifiers against main $conclusion (other verifiers=$mainSelected)",
    async ({ conclusion, mainSelected, expected }) => {
      const build = { ...job, name: "build-artifacts" };
      const flags = (selected: boolean) =>
        [
          "RUN_CHANNELS",
          "RUN_DOCTOR_PLUGIN_INDEX",
          "RUN_DISCORD_COMPONENT_PROOF",
          "RUN_CORE_SUPPORT_BOUNDARY",
          "RUN_GATEWAY_WATCH",
          "RUN_SQLITE_SESSION_LIFECYCLE",
          "RUN_TUI_PTY",
        ]
          .map(
            (name) =>
              `2026-10-12T08:07:34.000Z   ${name}: ${name === "RUN_SQLITE_SESSION_LIFECYCLE" || selected}`,
          )
          .join("\n");
      const classifier = failureClassifier({
        mainJobs: [{ ...build, id: 20, conclusion }],
        mainReport: flags(mainSelected),
        prReport: flags(false),
      });
      expect(await classifier.classifyJob(build)).toMatchObject({
        class: expected,
        mainRunId: 200,
        mainJobId: 20,
        reason:
          expected === "unknown"
            ? "Selected scope differs from main; failure signatures not comparable"
            : "Matching main job passed",
      });
    },
  );

  it("does not call a changed-scope lint failure new against a passed full main lint", async () => {
    const lint = {
      ...job,
      name: "check-lint",
      steps: [{ name: "Run changed lint", conclusion: "failure" }],
    };
    const classifier = failureClassifier({
      mainJobs: [
        {
          ...lint,
          id: 20,
          conclusion: "success",
          steps: [{ name: "Run check shard", conclusion: "success" }],
        },
      ],
    });
    expect(await classifier.classifyJob(lint)).toMatchObject({
      class: "unknown",
      reason: "Selected scope differs from main; failure signatures not comparable",
    });
  });

  const unparsedReason =
    "Job name only (signatures not compared); check failing tests against main before attribution; selected scope not compared";
  const matchedReason = "Failure signatures match main; selected scope not compared";
  const rejected = report("startup > rejects the session");
  const changedTypes = typeReport(typeDiagnostic.replace("TS2367", "TS2554"));
  const build = { ...job, name: "build-artifacts" };
  it.each<[string, typeof job, string, string?, string?, string?]>([
    ["node match", job, "pre-existing", undefined, undefined, matchedReason],
    ["node mismatch", job, "new", undefined, rejected],
    ["node subset", job, "new", report() + rejected],
    ["tsgo match", typeJob, "pre-existing", typeReport(), typeReport()],
    ["tsgo mismatch", typeJob, "new", typeReport(), changedTypes],
    ["legacy lint", lintJob, "pre-existing", lintReport, lintReport],
    ["node setup", failedJob(job.name, "Prepare workspace"), "unknown"],
    ["truncated log", job, "unknown", undefined, "truncated log"],
    ["node timeout", { ...job, conclusion: "timed_out" }, "unknown"],
    ["build failure", build, "pre-existing", undefined, undefined, unparsedReason],
    [
      "build timeout",
      { ...build, conclusion: "timed_out" },
      "pre-existing",
      undefined,
      undefined,
      unparsedReason,
    ],
  ])("classifies %s", async (_name, failure, expected, mainReport, prReport, reason) => {
    const classifier = failureClassifier({
      mainReport,
      prReport,
      mainJobs: [{ ...failure, id: 20 }],
    });
    expect(await classifier.classifyJob(failure)).toMatchObject({
      job: failure.name,
      conclusion: failure.conclusion,
      class: expected,
      mainRunId: 200,
      mainJobId: 20,
      ...(reason ? { reason } : {}),
    });
  });

  it.each([
    { name: "passed", conclusion: "success", expected: "new" },
    { name: "skipped", conclusion: "skipped", expected: "unknown" },
    { name: "timed out", conclusion: "timed_out", expected: "unknown" },
    { name: "unfinished", conclusion: "failure", status: "in_progress", expected: "unknown" },
  ])("uses the matching main job that $name", async ({ conclusion, status, expected }) => {
    const classifier = failureClassifier({
      mainJobs: [{ ...job, id: 20, conclusion, status: status ?? "completed" }],
    });
    expect(await classifier.classifyJob(job)).toMatchObject({
      class: expected,
      mainRunId: 200,
      mainJobId: 20,
      ...(conclusion === "success"
        ? { reason: "Matching main job passed; selected scope not compared" }
        : {}),
    });
  });

  it.each([
    { name: "another shard", mainJobs: [{ ...job, id: 20, name: `${job.name}0` }] },
    {
      name: "duplicate job names",
      mainJobs: [
        { ...job, id: 20 },
        { ...job, id: 21 },
      ],
    },
    { name: "no main run", runs: [] },
    { name: "unavailable main inventory", unavailable: "/actions/runs/200/attempts/1/jobs" },
  ])("does not guess with $name", async (options) => {
    expect(await failureClassifier(options).classifyJob(job)).toMatchObject({
      class: "unknown",
      mainRunId: options.name === "no main run" ? null : 200,
      mainJobId: null,
    });
  });

  it("keeps the comparable job link when its logs are unavailable", async () => {
    const classifier = failureClassifier({ unavailable: "/actions/jobs/20/logs" });
    expect(await classifier.classifyJob(job)).toEqual({
      job: job.name,
      conclusion: "failure",
      class: "unknown",
      mainRunId: 200,
      mainJobId: 20,
      reason: "Failure signatures unavailable",
    });
  });

  it("pins the newest completed scheduled run and its inventory once for all rows", async () => {
    const classifier = failureClassifier({
      runs: [mainRun, { ...mainRun, id: 201, run_number: 101 }],
    });
    const results = await Promise.all([
      classifier.classifyJob(job),
      classifier.classifyJob({ ...job, id: 11, name: "not-planned-on-main" }),
    ]);
    expect(results).toMatchObject([
      { mainRunId: 201, class: "pre-existing" },
      { mainRunId: 201, class: "unknown" },
    ]);
    for (const suffix of ["/runs", "/jobs"]) {
      expect(
        classifier.api.mock.calls.filter(([url]) => new URL(url).pathname.endsWith(suffix)),
      ).toHaveLength(1);
    }
  });
});

describe("known hourly main failures", () => {
  it("keeps one complete failure signature when the shard runner replays diagnostics", () => {
    const log = `${report()}\n${[
      "[shard-failure:gateway] FAILED (exit 1)",
      `[shard-failure:gateway:tail] FAIL gateway ${file} > ${title}`,
      "[shard-failure:gateway:tail] AssertionError: expected true to be false",
      "[shard-failure:gateway:tail] Test Files 1 failed (1)",
      "[shard-failure:gateway:tail] Tests 1 failed | 2 passed (3)",
      "[shard-failure:gateway:tail] [test] FAILED (exit 1)",
    ].join("\n")}`;
    expect(parseNodeFailureReport(log, true)).toEqual([
      { kind: "vitest", file, test: `${title} :: AssertionError: expected true to be false` },
    ]);
    expect(extractNodeFailedTests(log)).toEqual([{ file, tests: [title] }]);
  });

  it.each([false, true])(
    "keeps report attribution separate from gate eligibility (changed=%s)",
    async (changed) => {
      gateFixture({ changed: [changed ? file : "src/channels/unrelated.ts"] });
      const result = await reportPrFailures(prContext);
      expect(result.failures[0]).toMatchObject({
        class: "pre-existing",
        mainRunId: 200,
        mainJobId: 20,
      });
      expect(result.knownMainRed).toBe(!changed);
      expect(result.failureJobId).toBe(changed ? "10" : "");
    },
  );

  it("distinguishes different assertion details after the same headline", async () => {
    const detailed = report().replace(
      "Test Files 1 failed",
      "- Expected\n[shard:gateway] + Received\n[shard:gateway] - { value: 1 }\n[shard:gateway] + { value: 2 }\n[shard:gateway] Test Files 1 failed",
    );
    await expectKnown({ mainReport: detailed, prReport: detailed }, true);
    await expectKnown({
      mainReport: detailed,
      prReport: detailed.replace("+ { value: 2 }", "+ { value: 3 }"),
    });
  });

  it.each([repository, "contributor/openclaw"])(
    "accepts exact trusted main assertions for %s",
    async (headRepository) => {
      expect(await classify({ headRepository })).toMatchObject({ known: true, mainRunId: 200 });
    },
  );
  it.each([
    ["different test", { prReport: report("startup > opens a different session") }],
    ["changed test", { changed: [file] }],
    [
      "changed external subject",
      { changed: ["src/infra/session.ts"], source: 'import { start } from "../infra/session.js";' },
    ],
    ["changed workflow", { changed: [".github/workflows/ci.yml"] }],
    ["changed dependency", { changed: ["pnpm-lock.yaml"] }],
    ["truncated diff", { changedCount: 2 }],
    ["non-main event", { mainEvent: "pull_request" }],
    ["main predates merge base", { age: "behind" }],
    ["unresolved subject alias", { source: 'import { start } from "@openclaw/runtime";' }],
    ["escaped relative module", { source: 'await import("./\\u002e\\u002e/subject.js");' }],
    ["concatenated import subject", { source: 'await import("./subject" + suffix);' }],
    [
      "root directory subject",
      { changed: ["runtime/index.ts"], source: 'import { start } from "../../runtime";' },
    ],
    ["computed subject", { source: "const subject = await import(name);" }],
    ["unreported failure", changedReport("Tests 1 failed", "Tests 2 failed")],
    ["missing test summary", changedReport(/Tests 1 failed[^\n]+/u, "")],
    ["failed suite", appendedReport("Failed Suites 1")],
    ["unhandled rejection", appendedReport("Unhandled Rejection")],
    ["extra failure annotation", appendedReport("##[error]worker crashed")],
    ["missing execution receipt", changedReport(/^.*\[shard:completion\].*\n/mu, "")],
    ["unfinished outer plan", changedReport('"planned":1', '"planned":2')],
    ["duplicate execution receipt", appendedReport('[shard:completion] {"version":1}')],
    [
      "unknown stream without error header",
      { prReport: `[shard:coverage] setup failed\n${report()}` },
    ],
    [
      "failure before invocation start",
      { prReport: `[shard:gateway] Error: setup failed\n${report()}` },
    ],
    ["before summaries", insertFailure("Test Files", "coverage setup failed")],
    [
      "unknown later config",
      changedReport(
        "[test] failed 1 Vitest shard in 7s",
        "[test] starting test/vitest/vitest.process.config.ts\n[shard:gateway] failed to load config\n[shard:gateway] [test] failed 2 Vitest shards in 7s",
      ),
    ],
    [
      "unknown second child",
      {
        prReport:
          report().replace(
            '"invocations":1,"failedInvocations":1',
            '"invocations":2,"failedInvocations":2',
          ) +
          "\n[shard:other] ERR_PNPM_MISSING_SCRIPT\n[shard:other] [test] failed 0 Vitest shards in 1s\n[shard:other] [test] FAILED (exit 1)",
      },
    ],
    [
      "unreported failed config",
      changedReport("failed 1 Vitest shard in", "failed 2 Vitest shards in"),
    ],
    ["after terminal", insertFailure("[test] FAILED (exit 1)", "report close failed")],
    ["during summaries", insertFailure("Tests 1 failed", "coverage finalization failed")],
    [
      "after summaries",
      insertFailure("[test] failed 1 Vitest shard in 7s", "report finalization failed"),
    ],
    ["outer failure after receipt", appendedReport("Error: write failed")],
    ["main has recovered", { mainConclusion: "success" }],
  ])("keeps %s blocking", async (_name, options) => {
    await expectKnown(options);
  });

  it.each([
    { mainChanged: ["docs/unrelated.md"], known: true },
    { mainChanged: [file], known: false },
    { mainChanged: ["scripts/run-vitest.mts"], known: false },
    { mainChanged: Array.from({ length: 300 }, (_, i) => `docs/page-${i}.md`), known: false },
  ])(
    "retires stale main evidence after subject changes: %j",
    async ({ mainChanged, known: expected }) => {
      await expectKnown({ liveMainSha: "d".repeat(40), mainChanged }, expected);
    },
  );

  it("guards the verified workspace package", async () => {
    const options = {
      source: 'import { subject } from "@openclaw/acp-core/runtime/types";',
      packageNames: { "acp-core": "@openclaw/acp-core" },
    };
    await expectKnown(options, true);
    await expectKnown({ ...options, changed: ["packages/acp-core/src/other.ts"] });
    await expectKnown({ ...options, changed: ["packages/unrelated/src/other.ts"] }, true);
    await expectKnown({ ...options, packageNames: { "acp-core": "external-package" } });
  });

  it.each([
    {
      failureJob: job,
      signatureFile: file,
      legacy: report().replace(/^.*\[shard:completion\].*\n/mu, ""),
      complete: report(),
    },
    {
      failureJob: typeJob,
      signatureFile: typeFile,
      legacy: `##[group]Run typecheck\n##[endgroup]\n${typeDiagnostic}\n##[error]Process completed with exit code 2.`,
      complete: typeReport(),
    },
  ])(
    "uses legacy $failureJob.name evidence only from main",
    async ({ failureJob, signatureFile, legacy, complete }) => {
      const options = { failureJob, signatureFile, mainReport: legacy, prReport: complete };
      await expectKnown(options, true);
      await expectKnown({ ...options, prReport: legacy });
      if (failureJob === job) {
        await expectKnown({ ...options, mainReport: `${legacy}\nError: another unknown failure` });
      }
    },
  );

  it.each([
    typeJob,
    failedJob("check-prod-types", "Run check shard", typeJob),
    failedJob("check-test-types", "Run check shard", typeJob),
    lintJob,
    failedJob("check-lint-core-1", "Run hosted core lint stripe", lintJob),
  ])("requires complete matching diagnostics for $name", async (failureJob) => {
    const lint = failureJob.name.startsWith("check-lint");
    const signatureFile = lint ? lintFile : typeFile;
    const options = {
      failureJob,
      signatureFile,
      mainReport: lint ? lintReport : typeReport(),
      prReport: lint ? completeLintReport() : typeReport(),
      source: 'import type { Event } from "@openclaw/acp-core/runtime/types";',
      packageNames: { "acp-core": "@openclaw/acp-core" },
    };
    const mismatch = lint
      ? completeLintReport("unused variable")
      : typeReport(typeDiagnostic.replace("TS2367", "TS2554"));
    await expectKnown(options, true);
    await expectKnown({ ...options, prReport: mismatch });
    await expectKnown({ ...options, changed: [signatureFile] });
    await expectKnown({ ...options, changed: ["packages/acp-core/src/runtime/types.ts"] });
  });

  it.each([
    { ...typeJob, name: "other-check" },
    failedJob(typeJob.name, "Prepare workspace", typeJob),
    { ...typeJob, steps: [...typeJob.steps, { name: "Cleanup", conclusion: "failure" }] },
    failedJob("check-lint", "Run check shard", lintJob),
    failedJob(lintJob.name, "Run changed lint", lintJob),
  ])("keeps unowned static execution blocking: %j", async (failureJob) => {
    const lint = failureJob.name.startsWith("check-lint");
    expect(
      await known({
        failureJob,
        signatureFile: lint ? lintFile : typeFile,
        mainReport: lint ? lintReport : typeReport(),
        prReport: lint ? completeLintReport() : typeReport(),
      }),
    ).toBe(false);
  });
});

describe("loose CI failure discovery", () => {
  it("extracts project labels, ANSI, multiple shards and repeated names", () => {
    const log = [
      `2026-10-12T08:00:00Z [shard:gateway] \u001b[31m FAIL \u001b[0m gateway-server (gateway-server-parallel) ${file} > native session > denies`,
      `2026-10-12T08:00:01Z [shard:other] FAIL ${file} > native session > denies`,
      `2026-10-12T08:00:02Z [shard:other] FAIL test/second.test.ts > fails too`,
    ].join("\n");
    expect(extractNodeFailedTests(log)).toEqual([
      { file, tests: ["native session > denies"] },
      { file: "test/second.test.ts", tests: ["fails too"] },
    ]);
    expect(parseNodeFailureReport(log, false)).toEqual([]);
  });

  it("reruns whole files for suite and unhandled failures without leaking across shards", () => {
    const log = [
      `[shard:a] FAIL ${file} > named failure`,
      "[shard:a] ⎯ Failed Suites 1 ⎯",
      `[shard:a] FAIL gateway (parallel) ${file} [ ${file} ]`,
      "[shard:b] Unhandled Rejection",
      "[shard:b] This error originated in test/unhandled.test.ts test file.",
      "[shard:c] FAIL test/named.test.ts > still named",
      "[shard:c] FAIL ../../outside.test.ts > ignore",
      "[shard:c] PASS test/pass.test.ts > ignore",
    ].join("\n");
    expect(extractNodeFailedTests(log)).toEqual([
      { file, tests: [] },
      { file: "test/named.test.ts", tests: ["still named"] },
      { file: "test/unhandled.test.ts", tests: [] },
    ]);
    expect(parseNodeFailureReport(log, false)).toEqual([]);
  });
});

describe("PR failure reporting", () => {
  const reportJob = (id: number, name: string, conclusion: string | null = "success") => ({
    ...job,
    id,
    name,
    conclusion,
    steps: [],
    status: conclusion === null ? "in_progress" : "completed",
  });
  const runReport = (overrides: Record<string, unknown> = {}) =>
    reportPrFailures({ ...prContext, ...overrides });
  const passedPrerequisites = { preflightResult: "success", securityFastResult: "success" };
  function fixture(rows: ReturnType<typeof reportJob>[], currentRun = prRun) {
    const mainJobs = [reportJob(20, "build-artifacts", "failure"), reportJob(21, "checks-ui")].map(
      (entry) => Object.assign({}, entry, { run_id: 200 }),
    );
    return mockApi({
      "/actions/runs/100": currentRun,
      "/actions/runs/100/attempts/1/jobs": { total_count: rows.length, jobs: rows },
      "/actions/runs/100/attempts/2/jobs": { total_count: rows.length, jobs: rows },
      "/actions/workflows/ci.yml/runs": { workflow_runs: [mainRun] },
      "/actions/runs/200/attempts/1/jobs": { total_count: mainJobs.length, jobs: mainJobs },
    });
  }

  it.each([
    [repository, "c".repeat(40)],
    ["contributor/openclaw", "main"],
  ])(
    "checks out trusted reporter code for %s despite a stale event base",
    (headRepository, ref) => {
      const checkout = requiredWorkflowStep(
        readCiWorkflow().jobs["pr-failure-report"].steps,
        "Checkout CI failure reporter",
      );
      expect(checkout.with.repository ?? repository).toBe(repository);
      expect(
        evaluateWorkflow(checkout.with.ref, {
          headRepository,
          sha: "c".repeat(40),
          githubEvent: {
            pull_request: {
              head: { repo: { full_name: headRepository }, sha: headSha },
              base: { ref: "main", sha: mainSha },
            },
          },
        }),
      ).toBe(ref);
    },
  );

  it("uses complete successful prerequisite results without enumerating jobs", async () => {
    const api = fixture([reportJob(1, "checks-ui")]);
    const result = await runReport({
      ...passedPrerequisites,
      jobResults: ["success", "success", "success", "skipped"],
    });
    expect(result).toMatchObject({ failures: [], knownMainRed: false, failureJobId: "" });
    expect(formatFailureReport(result, prContext)).toContain("prerequisite results");
    expect(api.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      `/repos/${repository}/actions/runs/100`,
    ]);
  });

  it.each(["failure", undefined])("enumerates jobs for prerequisite %s", async (result) => {
    const api = fixture([reportJob(1, "checks-ui", "timed_out")]);
    const outcome = await runReport({
      ...passedPrerequisites,
      jobResults: ["success", "success", result],
    });
    expect(outcome).toMatchObject({
      failures: [{ job: "checks-ui", conclusion: "timed_out" }],
      knownMainRed: false,
      failureJobId: "1",
    });
    expect(api.mock.calls.some(([url]) => url.includes("/attempts/1/jobs"))).toBe(true);
  });

  it("reports every failure without cancellation and preserves a blocking gate result", async () => {
    fixture([
      reportJob(1, "preflight"),
      reportJob(2, "build-artifacts", "failure"),
      reportJob(3, "checks-ui", "failure"),
      reportJob(4, "platform-only", "timed_out"),
      reportJob(5, "not-selected", "skipped"),
      reportJob(6, "pr-failure-report", null),
      reportJob(7, "openclaw/ci-gate", null),
    ]);
    const result = await runReport();
    expect(result).toMatchObject({
      failures: [
        { job: "build-artifacts", class: "pre-existing", mainRunId: 200, mainJobId: 20 },
        { job: "checks-ui", class: "new", mainRunId: 200, mainJobId: 21 },
        { job: "platform-only", class: "unknown", mainRunId: 200, mainJobId: null },
      ],
      knownMainRed: false,
      failureJobId: "2",
    });
    expect(formatFailureReport(result, prContext)).toContain(
      "https://github.com/openclaw/openclaw/actions/runs/200/job/20",
    );
  });

  it("does not grant the first-attempt allowance on a retry", async () => {
    fixture([], { ...prRun, run_attempt: 2 });
    expect(await runReport({ runAttempt: 2 })).toMatchObject({
      failures: [],
      knownMainRed: false,
      failureJobId: "",
    });
  });

  it("waits for all validation jobs and rejects mismatched run identity", async () => {
    fixture([reportJob(1, "checks-ui", null)]);
    await expect(runReport()).rejects.toThrow("not all completed");
    fixture([], { ...prRun, head_sha: mainSha });
    await expect(runReport()).rejects.toThrow("identity changed");
  });

  it("escapes job-controlled table text", () => {
    const summary = formatFailureReport(
      {
        jobs: [{ id: 1 }],
        failures: [
          {
            job: "[bad]|<br>\nnext",
            conclusion: "failure",
            class: "unknown",
            mainRunId: null,
            mainJobId: null,
            reason: "a|b",
          },
        ],
      },
      prContext,
    );
    expectIncludes(summary, ["&#91;bad&#93;&#124;&lt;br&gt; next", "a&#124;b"]);
  });
});
