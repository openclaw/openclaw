import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKnownMainRed,
  createMainFailureClassifier,
} from "../../scripts/ci-known-main-red.mjs";
import { reportPrFailures } from "../../scripts/ci-pr-failure-report.mjs";

const repository = "openclaw/openclaw";
const headSha = "a".repeat(40);
const mainSha = "b".repeat(40);
const baseSha = "c".repeat(40);
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
const typeReport = (diagnostic = typeDiagnostic) =>
  [
    "##[group]Run node scripts/run-tsgo-core-test-shards.mjs",
    "##[endgroup]",
    diagnostic,
    `[ci-static:tsgo:leaf] ${JSON.stringify({
      version: 1,
      id: "batch:0",
      config: "test/tsconfig/tsconfig.core.test.agents-root.json",
      exitCode: 2,
      stdout: `${diagnostic}\n`,
      stderr: "",
    })}`,
    '[ci-static:tsgo:completion] {"version":1,"id":"batch","planned":1,"completed":1,"leaves":["batch:0"]}',
    '[ci-static:tsgo:step] {"version":1,"groups":1}',
    "##[error]Process completed with exit code 2.",
  ].join("\n");
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
const completeLintReport = (message = "unused import") => {
  const diagnostic = `${lintFile}:1:10: error: ${message} (eslint(no-unused-vars))\nFound 0 warnings and 1 error.`;
  return [
    "##[group]Run node scripts/run-oxlint.mjs",
    "##[endgroup]",
    diagnostic,
    `[ci-static:oxlint:leaf] ${JSON.stringify({
      version: 1,
      id: "batch:0",
      config: "config/oxlint/typed.json",
      exitCode: 1,
      stdout: `${diagnostic}\n`,
      stderr: "",
    })}`,
    '[ci-static:oxlint:completion] {"version":1,"id":"batch","planned":1,"completed":1,"leaves":["batch:0"]}',
    '[ci-static:oxlint:step] {"version":1,"groups":1}',
    "##[error]Process completed with exit code 1.",
  ].join("\n");
};

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
  const api = vi.fn(async (url: string) => {
    const path = new URL(url).pathname.replace(`/repos/${repository}`, "");
    if (path === options.unavailable) {
      return new Response("Unavailable", { status: 503 });
    }
    if (path === "/actions/workflows/ci.yml/runs") {
      return new Response(JSON.stringify({ workflow_runs: runs }));
    }
    if (path === `/actions/runs/${latest?.id}/attempts/1/jobs`) {
      const jobs = (options.mainJobs ?? [{ ...job, id: 20 }]).map((entry) => ({
        ...entry,
        run_id: latest!.id,
      }));
      return new Response(JSON.stringify({ total_count: jobs.length, jobs }));
    }
    if (path === "/actions/jobs/20/logs") {
      return new Response(options.mainReport ?? report());
    }
    if (path === "/actions/jobs/10/logs") {
      return new Response(options.prReport ?? report());
    }
    throw new Error(`Unexpected reporting request ${path}`);
  });
  vi.stubGlobal("fetch", api);
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
  const api = vi.fn(async (url: string) => {
    const path = new URL(url).pathname.replace(`/repos/${repository}`, "");
    let body: unknown;
    if (path === "/actions/runs/100") {
      body = {
        ...mainRun,
        id: 100,
        event: "pull_request",
        head_sha: headSha,
        head_repository: { full_name: options.headRepository ?? repository },
      };
    } else if (path === "/actions/runs/100/attempts/1/jobs") {
      body = { total_count: 1, jobs: [failureJob] };
    } else if (path === "/actions/workflows/ci.yml/runs") {
      body = {
        workflow_runs: [
          {
            ...mainRun,
            event: options.mainEvent ?? "schedule",
            conclusion: options.mainConclusion ?? "failure",
          },
        ],
      };
    } else if (path === "/pulls/7") {
      body = {
        state: "open",
        draft: false,
        changed_files: options.changedCount ?? changed.length,
        head: { sha: headSha, repo: { full_name: options.headRepository ?? repository } },
        base: { ref: "main", repo: { full_name: repository } },
      };
    } else if (path === "/pulls/7/files") {
      body = changed.map((filename) => ({ filename }));
    } else if (path === "/git/ref/heads/main") {
      body = { object: { sha: options.liveMainSha ?? mainSha } };
    } else if (path === `/compare/${options.liveMainSha ?? mainSha}...${headSha}`) {
      body = { merge_base_commit: { sha: baseSha } };
    } else if (path === `/compare/${baseSha}...${mainSha}`) {
      body = { status: options.age ?? "ahead" };
    } else if (options.liveMainSha && path === `/compare/${mainSha}...${options.liveMainSha}`) {
      body = {
        status: "ahead",
        files: (options.mainChanged ?? []).map((filename) => ({ filename })),
      };
    } else if (path === "/actions/runs/200/attempts/1/jobs") {
      body = { total_count: 1, jobs: [{ ...failureJob, id: 20, run_id: 200 }] };
    } else if (path === "/actions/jobs/20/logs") {
      return new Response(options.mainReport ?? report());
    } else if (path === "/actions/jobs/10/logs") {
      return new Response(options.prReport ?? report());
    } else if (path === `/contents/${signatureFile}` || path.startsWith("/contents/packages/")) {
      if (new URL(url).searchParams.get("ref") !== mainSha) {
        throw new Error("Subject source must use the immutable main evidence revision");
      }
      body = {
        type: "file",
        encoding: "base64",
        content: Buffer.from(
          path.endsWith("/package.json")
            ? JSON.stringify({ name: options.packageNames?.[path.split("/")[3]!] })
            : (options.source ??
                'import { it } from "vitest"; import { start } from "./subject.js";'),
        ).toString("base64"),
      };
    } else {
      throw new Error(`Unexpected evidence request ${path}`);
    }
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal("fetch", api);
  return createKnownMainRed({
    repository,
    headRepository: options.headRepository,
    token: "synthetic-token",
    headSha,
    pullRequestNumber: 7,
    runId: 100,
    runAttempt: 1,
  });
}

const classify = (options: Parameters<typeof gateFixture>[0] = {}) =>
  gateFixture(options).classifyJob(options.failureJob ?? job);

afterEach(() => vi.unstubAllGlobals());

const known = async (options: Parameters<typeof classify>[0] = {}) =>
  (await classify(options)).known;

describe("main failure attribution", () => {
  it.each([
    { name: "matching Node assertions", failure: job, expected: "pre-existing" },
    {
      name: "changed Node assertions",
      failure: job,
      prReport: report("startup > rejects the session"),
      expected: "new",
    },
    {
      name: "only a subset of main assertions",
      failure: job,
      mainReport: report() + report("startup > rejects the session"),
      expected: "new",
    },
    {
      name: "matching static types",
      failure: typeJob,
      mainReport: typeReport(),
      prReport: typeReport(),
      expected: "pre-existing",
    },
    {
      name: "changed static types",
      failure: typeJob,
      mainReport: typeReport(),
      prReport: typeReport(typeDiagnostic.replace("TS2367", "TS2554")),
      expected: "new",
    },
    {
      name: "matching legacy lint diagnostics",
      failure: lintJob,
      mainReport: lintReport,
      prReport: lintReport,
      expected: "pre-existing",
    },
    {
      name: "a Node setup failure without signatures",
      failure: { ...job, steps: [{ name: "Prepare workspace", conclusion: "failure" }] },
      expected: "unknown",
    },
    { name: "missing assertions", failure: job, prReport: "truncated log", expected: "unknown" },
    {
      name: "a timeout in a signature-capable job",
      failure: { ...job, conclusion: "timed_out" },
      expected: "unknown",
    },
    {
      name: "the same unparsed build failure",
      failure: { ...job, name: "build-artifacts" },
      expected: "pre-existing",
    },
    {
      name: "the same unparsed build timeout",
      failure: { ...job, name: "build-artifacts", conclusion: "timed_out" },
      expected: "pre-existing",
    },
  ])("classifies $name as $expected", async ({ failure, expected, ...options }) => {
    const classifier = failureClassifier({
      ...options,
      mainJobs: [{ ...failure, id: 20 }],
    });
    expect(await classifier.classifyJob(failure)).toMatchObject({
      job: failure.name,
      conclusion: failure.conclusion,
      class: expected,
      mainRunId: 200,
      mainJobId: 20,
    });
  });

  it.each([
    { name: "passed", conclusion: "success", expected: "new" },
    { name: "cancelled", conclusion: "cancelled", expected: "unknown" },
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
    expect(results.map((result) => result.mainRunId)).toEqual([201, 201]);
    expect(results.map((result) => result.class)).toEqual(["pre-existing", "unknown"]);
    expect(
      classifier.api.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/runs")),
    ).toHaveLength(1);
    expect(
      classifier.api.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/jobs")),
    ).toHaveLength(1);
  });
});

describe("known hourly main failures", () => {
  it.each([false, true])(
    "keeps report attribution separate from gate eligibility (changed=%s)",
    async (changed) => {
      gateFixture({ changed: [changed ? file : "src/channels/unrelated.ts"] });
      const result = await reportPrFailures({
        repository,
        headRepository: repository,
        token: "synthetic-token",
        headSha,
        pullRequestNumber: 7,
        runId: 100,
        runAttempt: 1,
      });
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
    expect(await known({ mainReport: detailed, prReport: detailed })).toBe(true);
    expect(
      await known({
        mainReport: detailed,
        prReport: detailed.replace("+ { value: 2 }", "+ { value: 3 }"),
      }),
    ).toBe(false);
  });

  it.each([repository, "contributor/openclaw"])(
    "accepts exact trusted main assertions for %s",
    async (headRepository) => {
      expect(await classify({ headRepository })).toMatchObject({ known: true, mainRunId: 200 });
    },
  );
  it.each([
    ["different test", { prReport: report("startup > opens a different session") }],
    ["different assertion", { prReport: report().replaceAll("true to be false", "42 to be 43") }],
    ["changed test", { changed: [file] }],
    ["changed direct subject", { changed: ["src/gateway/subject.ts"] }],
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
    ["computed mock subject", { source: "vi.mock(moduleName);" }],
    ["concatenated import subject", { source: 'await import("./subject" + suffix);' }],
    ["concatenated mock subject", { source: 'vi.mock("./subject" + suffix);' }],
    ["template subject", { source: "await import(`./subject${suffix}`);" }],
    [
      "root directory subject",
      { changed: ["runtime/index.ts"], source: 'import { start } from "../../runtime";' },
    ],
    ["computed subject", { source: "const subject = await import(name);" }],
    ["unreported failure", { prReport: report().replace("Tests 1 failed", "Tests 2 failed") }],
    ["missing test summary", { prReport: report().replace(/Tests 1 failed[^\n]+/u, "") }],
    ["failed suite", { prReport: `${report()}\nFailed Suites 1` }],
    ["unhandled rejection", { prReport: `${report()}\nUnhandled Rejection` }],
    ["extra failure annotation", { prReport: `${report()}\n##[error]worker crashed` }],
    [
      "missing execution receipt",
      { prReport: report().replace(/^.*\[shard:completion\].*\n/mu, "") },
    ],
    ["unfinished outer plan", { prReport: report().replace('"planned":1', '"planned":2') }],
    ["duplicate execution receipt", { prReport: `${report()}\n[shard:completion] {"version":1}` }],
    [
      "unknown stream before summary",
      { prReport: `[shard:coverage] Error: setup failed\n${report()}` },
    ],
    [
      "unknown stream without error header",
      { prReport: `[shard:coverage] setup failed\n${report()}` },
    ],
    [
      "failure before invocation start",
      { prReport: `[shard:gateway] Error: setup failed\n${report()}` },
    ],
    [
      "failure before first summary",
      {
        prReport: report().replace(
          "[shard:gateway] Test Files",
          "[shard:gateway] Error: coverage setup failed\n[shard:gateway] Test Files",
        ),
      },
    ],
    [
      "unknown later config",
      {
        prReport: report().replace(
          "[test] failed 1 Vitest shard in 7s",
          "[test] starting test/vitest/vitest.process.config.ts\n[shard:gateway] failed to load config\n[shard:gateway] [test] failed 2 Vitest shards in 7s",
        ),
      },
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
      { prReport: report().replace("failed 1 Vitest shard in", "failed 2 Vitest shards in") },
    ],
    [
      "failure after invocation terminal",
      {
        prReport: report().replace(
          "[test] FAILED (exit 1)",
          "Error: report close failed\n[shard:gateway] [test] FAILED (exit 1)",
        ),
      },
    ],
    [
      "failure during summaries",
      {
        prReport: report().replace(
          "[shard:gateway] Tests 1 failed",
          "[shard:gateway] Error: coverage finalization failed\n[shard:gateway] Tests 1 failed",
        ),
      },
    ],
    [
      "failure after summaries",
      {
        prReport: report().replace(
          "[test] failed 1 Vitest shard in 7s",
          "Error: report finalization failed\n[shard:gateway] [test] failed 1 Vitest shard in 7s",
        ),
      },
    ],
    ["outer failure after receipt", { prReport: `${report()}\nError: write failed` }],
    ["main has recovered", { mainConclusion: "success" }],
  ])("keeps %s blocking", async (_name, options) => {
    expect(await known(options)).toBe(false);
  });

  it.each([
    { mainChanged: ["docs/unrelated.md"], known: true },
    { mainChanged: [file], known: false },
    { mainChanged: ["src/gateway/subject.ts"], known: false },
    { mainChanged: ["scripts/run-vitest.mts"], known: false },
    { mainChanged: Array.from({ length: 300 }, (_, i) => `docs/page-${i}.md`), known: false },
  ])(
    "retires stale main evidence after subject changes: %j",
    async ({ mainChanged, known: expected }) => {
      expect(await known({ liveMainSha: "d".repeat(40), mainChanged })).toBe(expected);
    },
  );

  it("guards the verified workspace package", async () => {
    const options = {
      source: 'import { subject } from "@openclaw/acp-core/runtime/types";',
      packageNames: { "acp-core": "@openclaw/acp-core" },
    };
    expect(await known(options)).toBe(true);
    expect(await known({ ...options, changed: ["packages/acp-core/src/other.ts"] })).toBe(false);
    expect(await known({ ...options, changed: ["packages/unrelated/src/other.ts"] })).toBe(true);
    expect(await known({ ...options, packageNames: { "acp-core": "external-package" } })).toBe(
      false,
    );
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
      expect(await known(options)).toBe(true);
      expect(await known({ ...options, prReport: legacy })).toBe(false);
      if (failureJob === job) {
        expect(
          await known({ ...options, mainReport: `${legacy}\nError: another unknown failure` }),
        ).toBe(false);
      }
    },
  );

  it.each([
    typeJob,
    {
      ...typeJob,
      name: "check-prod-types",
      steps: [{ name: "Run check shard", conclusion: "failure" }],
    },
    {
      ...typeJob,
      name: "check-test-types",
      steps: [{ name: "Run check shard", conclusion: "failure" }],
    },
    lintJob,
    {
      ...lintJob,
      name: "check-lint-core-1",
      steps: [{ name: "Run hosted core lint stripe", conclusion: "failure" }],
    },
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
    expect(await known(options)).toBe(true);
    expect(await known({ ...options, prReport: mismatch })).toBe(false);
    expect(await known({ ...options, changed: [signatureFile] })).toBe(false);
    expect(await known({ ...options, changed: ["packages/acp-core/src/runtime/types.ts"] })).toBe(
      false,
    );
  });

  it.each([
    { ...typeJob, name: "other-check" },
    { ...typeJob, steps: [{ name: "Prepare workspace", conclusion: "failure" }] },
    { ...typeJob, steps: [...typeJob.steps, { name: "Cleanup", conclusion: "failure" }] },
    { ...lintJob, name: "check-lint", steps: [{ name: "Run check shard", conclusion: "failure" }] },
    { ...lintJob, steps: [{ name: "Run changed lint", conclusion: "failure" }] },
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

  it("keeps incomplete lint execution and PR-owned static subjects blocking", async () => {
    const options = {
      failureJob: lintJob,
      signatureFile: lintFile,
      mainReport: lintReport,
      prReport: completeLintReport(),
      source: 'import type { CardSessionState } from "./session-state.ts";',
    };
    expect(await known({ ...options, prReport: lintReport })).toBe(false);
    expect(await known(options)).toBe(true);
    expect(await known({ ...options, changed: [lintFile] })).toBe(false);
    expect(
      await known({
        ...options,
        changed: ["extensions/workboard/browser/lib/workboard/session-state.ts"],
      }),
    ).toBe(false);
    expect(
      await known({
        ...options,
        mainReport: lintReport.replace(
          "Found 0 warnings",
          "Error: unknown lint failure\nFound 0 warnings",
        ),
      }),
    ).toBe(false);
  });
});
