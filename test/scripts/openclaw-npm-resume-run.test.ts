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
      path: ".github/workflows/openclaw-npm-release.yml",
      workflow_id: 101,
      run_attempt: 1,
    },
    tag: {
      object: { sha: SHA, type: "commit" },
      verification: { verified: true },
    },
    tagRef: { object: { sha: TAG_OBJECT_SHA, type: "tag" } },
    trustedWorkflowFullRef: `refs/tags/${BRANCH}`,
    trustedWorkflowRef: BRANCH,
    ...overrides,
  };
}

describe("openclaw npm resume run identity", () => {
  function publicationRun(
    overrides: Record<string, unknown> = {},
    publish = true,
    latest: Record<string, unknown> = {},
  ) {
    return vi.fn((args: string[]) => {
      const endpoint = args[1];
      if (endpoint === "repos/openclaw/openclaw/actions/runs/456") {
        return JSON.stringify({ ...fixture().run, ...overrides, ...latest });
      }
      if (endpoint === "repos/openclaw/openclaw/actions/runs/456/attempts/1") {
        return JSON.stringify({ ...fixture().run, ...overrides });
      }
      if (endpoint === "repos/openclaw/openclaw/actions/workflows/openclaw-npm-release.yml") {
        return JSON.stringify({ id: 101 });
      }
      if (endpoint === `repos/openclaw/openclaw/git/ref/tags/${BRANCH}`) {
        return JSON.stringify({ object: { sha: SHA, type: "commit" } });
      }
      if (args[0] === "run") {
        return JSON.stringify([
          { conclusion: "success", name: "validate_publish_request" },
          { name: "publish_openclaw_npm", conclusion: publish ? "success" : "skipped" },
        ]);
      }
      throw new Error(`Unexpected gh invocation: ${args.join(" ")}`);
    });
  }

  function recover(publication = publicationEvidence(), runGh = publicationRun(), runId = "") {
    return resolveOpenClawNpmResumeRun({
      repo: "openclaw/openclaw",
      runGh,
      runId,
      publication,
    });
  }

  it("recovers the exact published version's original publisher after parent tooling changes", () => {
    expect(recover()).toMatchObject({
      runId: "456",
      workflowRef: `refs/tags/${BRANCH}`,
      workflowSha: SHA,
    });
  });

  it.each(["success", "failure"])(
    "retains the signed attempt after a later %s rerun",
    (conclusion) => {
      const runGh = publicationRun({}, true, { run_attempt: 2, conclusion });
      expect(recover(publicationEvidence(), runGh)).toMatchObject({ runId: "456", runAttempt: 1 });
      expect(
        runGh.mock.calls.some(([args]) =>
          args.includes("repos/openclaw/openclaw/actions/runs/456"),
        ),
      ).toBe(false);
      expect(runGh.mock.calls.find(([args]) => args[0] === "run")?.[0]).toContain("--attempt");
    },
  );

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
    ["different version", { version: "2026.9.6" }],
    ["different tarball", { tarballSha512: "e".repeat(128) }],
  ])("refuses discovery from a %s", (_name, overrides) => {
    expect(() => recover({ ...publicationEvidence(), ...overrides })).toThrow(
      "missing or ambiguous publisher evidence",
    );
  });

  it("rejects a supplied run id that contradicts the immutable publication receipt", () => {
    const runGh = publicationRun();
    expect(() => recover(publicationEvidence(), runGh, "999")).toThrow("original publisher");
    expect(runGh).not.toHaveBeenCalled();
  });

  it("rejects a publisher invocation from another repository", () => {
    expect(() =>
      recover(publicationEvidence("https://github.com/other/repo/actions/runs/456/attempts/1")),
    ).toThrow("this repository's npm release workflow");
  });

  it.each([
    ["failed", { conclusion: "failure" }, "untrusted workflow identity"],
    ["wrong attempt response", { run_attempt: 2 }, "SHA and attempt"],
    ["wrong run response", { id: 789 }, "SHA and attempt"],
    ["unfinished attempt", { status: "in_progress" }, "SHA and attempt"],
    ["changed workflow", { head_sha: "e".repeat(40) }, "SHA and attempt"],
  ])("rejects a %s original publisher", (_name, overrides, message) => {
    expect(() => recover(publicationEvidence(), publicationRun(overrides))).toThrow(message);
  });

  it("does not adopt a successful preflight-only run as the publisher", () => {
    expect(() => recover(publicationEvidence(), publicationRun({}, false))).toThrow(
      "successful npm publish job",
    );
  });
  it("bounds each GitHub lookup", () => {
    const execFileSyncImpl = vi.fn(() => "result");

    expect(
      runOpenClawNpmResumeGh(["api", "repos/openclaw/openclaw/actions/runs/456"], {
        execFileSyncImpl,
      }),
    ).toBe("result");
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "gh",
      ["api", "repos/openclaw/openclaw/actions/runs/456"],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
      },
    );
  });

  it("propagates GitHub lookup timeouts", () => {
    const timeoutError = Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });

    expect(() =>
      runOpenClawNpmResumeGh(["api", "repos/openclaw/openclaw/actions/runs/456"], {
        execFileSyncImpl: () => {
          throw timeoutError;
        },
      }),
    ).toThrow(timeoutError);
  });

  it("accepts a successful run bound to a signed main-reachable tooling tag", () => {
    expect(validateOpenClawNpmResumeRun(fixture())).toEqual({
      tagObjectSha: TAG_OBJECT_SHA,
      url: URL,
      workflowRef: `refs/tags/${BRANCH}`,
      workflowSha: SHA,
    });
  });

  it("accepts a successful run bound to the exact lightweight protected tooling tag", () => {
    expect(
      validateOpenClawNpmResumeRun(
        fixture({
          compareStatus: undefined,
          tag: {},
          tagRef: { object: { sha: SHA, type: "commit" } },
        }),
      ),
    ).toEqual({
      tagObjectSha: SHA,
      url: URL,
      workflowRef: `refs/tags/${BRANCH}`,
      workflowSha: SHA,
    });
  });

  it("accepts the canonical path shape returned by the Actions workflow run API", () => {
    expect(
      validateOpenClawNpmResumeRun(
        fixture({
          run: {
            conclusion: "success",
            event: "workflow_dispatch",
            head_branch: BRANCH,
            head_sha: SHA,
            html_url: URL,
            path: ".github/workflows/openclaw-npm-release.yml",
            workflow_id: 101,
          },
        }),
      ),
    ).toMatchObject({
      workflowRef: `refs/tags/${BRANCH}`,
      workflowSha: SHA,
    });
  });

  it.each([
    ["branch", { run: { ...fixture().run, head_branch: "main" } }, "untrusted workflow identity"],
    ["workflow", { run: { ...fixture().run, workflow_id: 999 } }, "untrusted workflow identity"],
    ["event", { run: { ...fixture().run, event: "push" } }, "untrusted workflow identity"],
    [
      "conclusion",
      { run: { ...fixture().run, conclusion: "failure" } },
      "untrusted workflow identity",
    ],
    [
      "path",
      { run: { ...fixture().run, path: ".github/workflows/ci.yml" } },
      "untrusted workflow identity",
    ],
    [
      "same-name branch full ref",
      { trustedWorkflowFullRef: `refs/heads/${BRANCH}` },
      "untrusted workflow ref",
    ],
    [
      "mismatched supplied ref",
      { trustedWorkflowRef: `release-publish/${SHA.slice(0, 12)}-124` },
      "untrusted workflow ref",
    ],
    [
      "tag kind",
      { tagRef: { object: { sha: TAG_OBJECT_SHA, type: "tree" } } },
      "not a protected tag",
    ],
    [
      "moved lightweight tag",
      {
        compareStatus: undefined,
        tag: {},
        tagRef: { object: { sha: "c".repeat(40), type: "commit" } },
      },
      "moved after dispatch",
    ],
    [
      "tag target",
      { tag: { ...fixture().tag, object: { sha: "c".repeat(40), type: "commit" } } },
      "not bound to a real",
    ],
    [
      "signature",
      { tag: { ...fixture().tag, verification: { verified: false } } },
      "not bound to a real",
    ],
    ["main ancestry", { compareStatus: "diverged" }, "not bound to a real"],
    [
      "approval",
      { jobs: [{ conclusion: "failure", name: "validate_publish_request" }] },
      "lacks successful parent release approval",
    ],
  ])("rejects an untrusted %s", (_label, overrides, message) => {
    expect(() => validateOpenClawNpmResumeRun(fixture(overrides))).toThrow(message);
  });

  it("loads the exact run, workflow, signed tag, ancestry, and approval job", () => {
    const responses = new Map<string, unknown>([
      [`api repos/openclaw/openclaw/actions/runs/456/attempts/1 --method GET`, fixture().run],
      [
        `api repos/openclaw/openclaw/actions/workflows/openclaw-npm-release.yml --method GET`,
        { id: 101 },
      ],
      [`api repos/openclaw/openclaw/git/ref/tags/${BRANCH} --method GET`, fixture().tagRef],
      [`api repos/openclaw/openclaw/git/tags/${TAG_OBJECT_SHA} --method GET`, fixture().tag],
      [`api repos/openclaw/openclaw/compare/${SHA}...main --method GET`, { status: "identical" }],
      [`run view 456 --repo openclaw/openclaw --attempt 1 --json jobs --jq .jobs`, fixture().jobs],
    ]);
    const runGh = vi.fn((args: string[]) => {
      const response = responses.get(args.join(" "));
      if (!response) {
        throw new Error(`Unexpected gh invocation: ${args.join(" ")}`);
      }
      return JSON.stringify(response);
    });

    expect(
      resolveOpenClawNpmResumeRun({
        repo: "openclaw/openclaw",
        runGh,
        runId: "456",
        publication: publicationEvidence(),
      }),
    ).toMatchObject({ workflowRef: `refs/tags/${BRANCH}`, workflowSha: SHA });
    expect(runGh).toHaveBeenCalledTimes(6);
  });

  it("loads a lightweight protected tag without requiring tag metadata or main ancestry", () => {
    const lightweight = fixture({
      compareStatus: undefined,
      tag: {},
      tagRef: { object: { sha: SHA, type: "commit" } },
    });
    const responses = new Map<string, unknown>([
      [`api repos/openclaw/openclaw/actions/runs/456/attempts/1 --method GET`, lightweight.run],
      [
        `api repos/openclaw/openclaw/actions/workflows/openclaw-npm-release.yml --method GET`,
        { id: 101 },
      ],
      [`api repos/openclaw/openclaw/git/ref/tags/${BRANCH} --method GET`, lightweight.tagRef],
      [
        `run view 456 --repo openclaw/openclaw --attempt 1 --json jobs --jq .jobs`,
        lightweight.jobs,
      ],
    ]);
    const runGh = vi.fn((args: string[]) => {
      const response = responses.get(args.join(" "));
      if (!response) {
        throw new Error(`Unexpected gh invocation: ${args.join(" ")}`);
      }
      return JSON.stringify(response);
    });

    expect(
      resolveOpenClawNpmResumeRun({
        repo: "openclaw/openclaw",
        runGh,
        runId: "456",
        publication: publicationEvidence(),
      }),
    ).toMatchObject({ workflowRef: `refs/tags/${BRANCH}`, workflowSha: SHA });
    expect(runGh).toHaveBeenCalledTimes(4);
    expect(runGh.mock.calls.flatMap(([args]) => args)).not.toContain(
      `repos/openclaw/openclaw/compare/${SHA}...main`,
    );
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
            repository: "https://github.com/openclaw/openclaw",
            path: ".github/workflows/openclaw-npm-release.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/openclaw/openclaw@refs/tags/${BRANCH}`,
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
    plugin_sdk_api_acknowledgement:
      "Owner's acknowledgement: `false` and $(touch injected)\nsecond line",
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
    GITHUB_REPOSITORY: "openclaw/openclaw",
    GITHUB_EVENT_PATH: event,
    GITHUB_STEP_SUMMARY: summary,
  };
  const printed = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; print_release_resume_command',
      "fixture",
      resolve("scripts/lib/release-publish-children.sh"),
    ],
    { cwd: root, env, encoding: "utf8" },
  );
  expect(printed.status, printed.stderr).toBe(0);
  const command = readFileSync(summary, "utf8").match(/```bash\n([\s\S]+?)\n```/u)?.[1];
  if (!command) {
    throw new Error("Release summary did not contain a resume command.");
  }
  const resumed = spawnSync(
    "bash",
    ["-c", `gh() { printf '%s\\n' "$@" > args; cat > inputs.json; }; ${command}`],
    { cwd: root, env, encoding: "utf8" },
  );
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(root, "inputs.json"), "utf8"))).toEqual(inputs);
  expect(readFileSync(join(root, "args"), "utf8").trim().split("\n")).toEqual([
    "workflow",
    "run",
    "openclaw-release-publish.yml",
    "--repo",
    "openclaw/openclaw",
    "--ref",
    BRANCH,
    "--json",
  ]);
  expect(existsSync(join(root, "injected"))).toBe(false);
});
