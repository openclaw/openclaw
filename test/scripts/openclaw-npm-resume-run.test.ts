import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveOpenClawNpmResumeRun,
  runOpenClawNpmResumeGh,
  validateOpenClawNpmResumeRun,
} from "../../scripts/openclaw-npm-resume-run.mts";
import type { OpenClawNpmResumeValidationInput } from "../../scripts/openclaw-npm-resume-run.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

const SHA = "a".repeat(40);
const TAG_OBJECT_SHA = "b".repeat(40);
const BRANCH = `release-publish/${SHA.slice(0, 12)}-123`;
const URL = "https://github.com/openclaw/openclaw/actions/runs/456";
const WORKFLOW = ".github/workflows/openclaw-npm-release.yml";
const REPOSITORY = "openclaw/openclaw";
const RUN_API = `repos/${REPOSITORY}/actions/runs/456`;
const object = (sha = SHA, type = "commit") => ({ object: { sha, type } });
const identityError = "untrusted workflow identity";
const tagError = "not bound to a real";
const refError = "untrusted workflow ref";
const approvalError = "lacks successful parent release approval";
const runFixture = (run: OpenClawNpmResumeValidationInput["run"]) =>
  fixture({ run: { ...fixture().run, ...run } });

function fixture(
  overrides: Partial<OpenClawNpmResumeValidationInput> = {},
): OpenClawNpmResumeValidationInput {
  return {
    canonicalWorkflowId: 101,
    compareStatus: "identical",
    jobs: [
      { conclusion: "success", name: "validate_publish_request" },
      { conclusion: "success", name: "publish_openclaw_npm" },
    ],
    run: {
      id: 456,
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
      head_branch: BRANCH,
      head_sha: SHA,
      html_url: URL,
      path: WORKFLOW,
      workflow_id: 101,
      run_attempt: 1,
    },
    tag: { ...object(), verification: { verified: true } },
    tagRef: object(TAG_OBJECT_SHA, "tag"),
    trustedWorkflowFullRef: `refs/tags/${BRANCH}`,
    trustedWorkflowRef: BRANCH,
    ...overrides,
  };
}

describe("openclaw npm resume run identity", () => {
  function publicationRun(
    overrides: Record<string, unknown> = {},
    publish = true,
    jobs?: OpenClawNpmResumeValidationInput["jobs"],
    annotated = false,
  ) {
    const input = fixture();
    const responses = new Map<string, unknown>();
    const api = (path: string, value: unknown) =>
      responses.set(`api repos/openclaw/openclaw/${path} --method GET`, value);
    api("actions/runs/456/attempts/1", { ...input.run, ...overrides });
    api("actions/workflows/openclaw-npm-release.yml", { id: 101 });
    api(`git/ref/tags/${BRANCH}`, annotated ? input.tagRef : object());
    if (annotated) {
      api(`git/tags/${TAG_OBJECT_SHA}`, input.tag);
      api(`compare/${SHA}...main`, { status: "identical" });
    }
    const publishJobs = input.jobs.map((job) =>
      Object.assign(job, {
        conclusion: job.name === "publish_openclaw_npm" && !publish ? "skipped" : "success",
      }),
    );
    responses.set(
      "run view 456 --repo openclaw/openclaw --attempt 1 --json jobs --jq .jobs",
      jobs ?? publishJobs,
    );
    return vi.fn((args: string[]) => {
      const response = responses.get(args.join(" "));
      if (response) {
        return JSON.stringify(response);
      }
      throw new Error(`Unexpected gh invocation: ${args.join(" ")}`);
    });
  }

  function recover(publication = publicationEvidence(), runGh = publicationRun(), runId = "") {
    return resolveOpenClawNpmResumeRun({ repo: REPOSITORY, runGh, runId, publication });
  }

  it.each([false, true])("readback recovery with extra failure: %s", (otherFailure) => {
    const jobs = [
      { conclusion: "success", name: "validate_publish_request", steps: [] },
      {
        conclusion: "failure",
        name: "publish_openclaw_npm",
        steps: [
          { conclusion: "success", name: "Publish" },
          { conclusion: "failure", name: "Verify extended-stable registry readback" },
        ],
      },
      ...(otherFailure ? [{ conclusion: "failure", name: "unexpected_failure", steps: [] }] : []),
    ];
    const runGh = publicationRun({ conclusion: "failure" }, true, jobs);
    if (otherFailure) {
      expect(() =>
        validateOpenClawNpmResumeRun({ ...runFixture({ conclusion: "failure" }), jobs }),
      ).toThrow("untrusted workflow identity");
    } else {
      expect(recover(publicationEvidence(), runGh)).toMatchObject({
        runId: "456",
        runAttempt: 1,
        workflowRef: `refs/tags/${BRANCH}`,
        workflowSha: SHA,
      });
    }
  });

  it("accepts repeated receipts only when they identify the same publisher", () => {
    const publication = publicationEvidence();
    publication.document.attestations.push(...publication.document.attestations);
    expect(recover(publication).runId).toBe("456");
    publication.document.attestations.push(
      ...publicationEvidence(`${URL}7/attempts/1`).document.attestations,
    );
    expect(() => recover(publication)).toThrow("ambiguous publisher evidence");
  });

  it.each([
    ["version", "2026.9.6"],
    ["tarballSha512", "e".repeat(128)],
  ])("rejects different %s", (key, value) => {
    expect(() => recover({ ...publicationEvidence(), [key]: value })).toThrow(
      "missing or ambiguous publisher evidence",
    );
  });
  it("rejects a contradictory supplied run before any lookup", () => {
    const runGh = publicationRun();
    expect(() => recover(publicationEvidence(), runGh, "999")).toThrow("original publisher");
    expect(runGh).not.toHaveBeenCalled();
  });
  it("rejects another repository", () => {
    const evidence = publicationEvidence(
      "https://github.com/other/repo/actions/runs/456/attempts/1",
    );
    expect(() => recover(evidence)).toThrow("this repository's npm release workflow");
  });
  it.each([
    ["failed publisher", { conclusion: "failure" }, identityError],
    ["wrong attempt response", { run_attempt: 2 }, "SHA and attempt"],
    ["wrong run response", { id: 789 }, "SHA and attempt"],
    ["unfinished attempt", { status: "in_progress" }, "SHA and attempt"],
    ["changed workflow", { head_sha: "e".repeat(40) }, "SHA and attempt"],
  ] as const)("rejects %s", (_label, overrides, message) => {
    expect(() => recover(publicationEvidence(), publicationRun(overrides))).toThrow(message);
  });
  it("rejects a preflight-only publisher", () => {
    expect(() => recover(publicationEvidence(), publicationRun({}, false))).toThrow(
      "successful npm publish job",
    );
  });

  it.each([false, true])("bounds GitHub lookups and propagates timeouts: %s", (timeout) => {
    const error = Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" });
    const execFileSyncImpl = vi.fn(() => {
      if (timeout) {
        throw error;
      }
      return "result";
    });
    const lookup = () => runOpenClawNpmResumeGh(["api", RUN_API], { execFileSyncImpl });
    if (timeout) {
      expect(lookup).toThrow(error);
    } else {
      expect(lookup()).toBe("result");
    }
    expect(execFileSyncImpl).toHaveBeenCalledWith("gh", ["api", RUN_API], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
  });

  it.each<[string, OpenClawNpmResumeValidationInput["run"]]>([
    ["branch", { head_branch: "main" }],
    ["workflow", { workflow_id: 999 }],
    ["event", { event: "push" }],
    ["path", { path: ".github/workflows/ci.yml" }],
  ])("rejects an untrusted %s", (_label, run) => {
    expect(() => validateOpenClawNpmResumeRun(runFixture(run))).toThrow(identityError);
  });
  it.each([
    ["branch ref", { trustedWorkflowFullRef: `refs/heads/${BRANCH}` }, refError],
    ["supplied ref", { trustedWorkflowRef: `${BRANCH}4` }, refError],
    ["tag kind", { tagRef: object(TAG_OBJECT_SHA, "tree") }, "not a protected tag"],
    ["moved lightweight tag", { tagRef: object("c".repeat(40)) }, "moved after dispatch"],
    ["tag target", { tag: { ...fixture().tag, ...object("c".repeat(40)) } }, tagError],
    ["signature", { tag: { ...fixture().tag, verification: { verified: false } } }, tagError],
    ["main ancestry", { compareStatus: "diverged" }, tagError],
    [
      "approval",
      { jobs: [{ conclusion: "failure", name: "validate_publish_request" }] },
      approvalError,
    ],
  ])("rejects an untrusted %s", (_label, overrides, message) => {
    expect(() => validateOpenClawNpmResumeRun(fixture(overrides))).toThrow(message);
  });

  it.each([true, false])("loads the immutable publisher with an annotated tag: %s", (annotated) => {
    const runGh = publicationRun({}, true, undefined, annotated);
    expect(recover(publicationEvidence(), runGh, "456")).toEqual({
      runId: "456",
      runAttempt: 1,
      tagObjectSha: annotated ? TAG_OBJECT_SHA : SHA,
      url: URL,
      workflowRef: `refs/tags/${BRANCH}`,
      workflowSha: SHA,
    });
  });
});

function publicationEvidence(invocationId = `${URL}/attempts/1`) {
  const statement = {
    subject: [{ name: "pkg:npm/openclaw@2026.9.5", digest: { sha512: "d".repeat(128) } }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: `refs/tags/${BRANCH}`,
            repository: `https://github.com/${REPOSITORY}`,
            path: WORKFLOW,
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/${REPOSITORY}@refs/tags/${BRANCH}`,
            digest: { gitCommit: SHA },
          },
        ],
      },
      runDetails: { metadata: { invocationId } },
    },
  };
  return {
    version: "2026.9.5",
    tarballSha512: "d".repeat(128),
    document: {
      attestations: [
        {
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: {
            dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") },
          },
        },
      ],
    },
  };
}

it("prints an executable resume command that preserves all inputs without shell expansion", () => {
  const root = createTempDir("release-resume-command-");
  const inputs = {
    tag: "v2026.9.5",
    publish_openclaw_npm: "true",
    stable_soak_waiver: "Owner's reason: `false` and $(touch injected)\nsecond line",
    prepared_plugins: JSON.stringify({ receipt: "approved" }),
    openclaw_npm_resume_run_id: "",
  };
  const event = join(root, "event.json");
  const summary = join(root, "summary.md");
  writeFileSync(event, JSON.stringify({ inputs }));
  const env = {
    PATH: process.env.PATH,
    GITHUB_REF: `refs/tags/${BRANCH}`,
    GITHUB_REF_NAME: BRANCH,
    PARENT_WORKFLOW_SHA: SHA,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_EVENT_PATH: event,
    GITHUB_STEP_SUMMARY: summary,
  };
  const shell = (script: string, ...args: string[]) =>
    spawnSync("bash", ["-c", script, ...args], { cwd: root, env, encoding: "utf8" });
  const printed = shell(
    'source "$1"; print_release_resume_command',
    "fixture",
    resolve("scripts/lib/release-publish-children.sh"),
  );
  expect(printed.status, printed.stderr).toBe(0);
  const command = readFileSync(summary, "utf8").match(/```bash\n([\s\S]+?)\n```/u)?.[1];
  if (!command) {
    throw new Error("Release summary did not contain a resume command.");
  }
  const resumed = shell(`gh() { printf '%s\\n' "$@" > args; cat > inputs.json; }; ${command}`);
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(root, "inputs.json"), "utf8"))).toEqual(inputs);
  expect(readFileSync(join(root, "args"), "utf8").trim().split("\n")).toEqual(
    `workflow run openclaw-release-publish.yml --repo ${REPOSITORY} --ref ${BRANCH} --json`.split(
      " ",
    ),
  );
  expect(existsSync(join(root, "injected"))).toBe(false);
});
