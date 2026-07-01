import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyStableReleaseLinesTransition,
  serializeStableReleaseLines,
} from "../scripts/lib/stable-release-lines.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sourceCliPath = path.join(repositoryRoot, "scripts/verify-release-operation.mjs");
const canonicalUrl = "https://github.com/openclaw/openclaw.git";
const tempRoots: string[] = [];

type Operation =
  | "tag-preflight"
  | "sha-preflight"
  | "internal-validation"
  | "publish"
  | "postpublish"
  | "stable-closeout";

type Fixture = {
  root: string;
  policyRoot: string;
  cliPath: string;
  canonicalRepo: string;
  gitLog: string;
  policySha: string;
  unreachableSha: string;
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-operation-"));
  tempRoots.push(root);
  const source = path.join(root, "source");
  const canonicalRepo = path.join(root, "canonical.git");
  const policyRoot = path.join(root, "policy");
  const bin = path.join(root, "bin");
  const gitLog = path.join(root, "git-arguments.jsonl");
  mkdirSync(path.join(source, "scripts/lib"), { recursive: true });
  mkdirSync(path.join(source, "release"), { recursive: true });
  mkdirSync(bin, { recursive: true });

  for (const relativePath of [
    "scripts/verify-release-operation.mjs",
    "scripts/lib/npm-publish-plan.mjs",
    "scripts/lib/release-version-policy.mjs",
    "scripts/lib/stable-release-lines.mjs",
    "scripts/lib/release-policy-evidence.mjs",
  ]) {
    cpSync(path.join(repositoryRoot, relativePath), path.join(source, relativePath));
  }

  const stableLines = applyStableReleaseLinesTransition({
    metadata: null,
    dailyMonth: "2026.7",
    command: {
      operation: "plan",
      month: "2026.6",
      effectiveDate: "2026-06-30",
      rotationDate: "2026-07-31",
    },
  });
  writeFileSync(
    path.join(source, "release/stable-lines.json"),
    serializeStableReleaseLines(stableLines),
  );
  git(source, ["init", "--quiet", "--initial-branch=main"]);
  git(source, ["config", "user.name", "Release Operation Test"]);
  git(source, ["config", "user.email", "release-operation@example.test"]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "policy main"]);
  const policySha = git(source, ["rev-parse", "HEAD"]);
  for (const branch of ["release/2026.7.5", "release/2026.7.5-beta.1", "stable/2026.6.33"]) {
    git(source, ["branch", branch, policySha]);
  }
  git(source, ["branch", "tideclaw/alpha/2026-06-21-1200Z", policySha]);
  for (const version of ["2026.7.5", "2026.7.5-beta.1", "2026.7.5-alpha.1", "2026.6.33"]) {
    git(source, ["tag", `v${version}`, policySha]);
  }
  const tree = git(source, ["rev-parse", "HEAD^{tree}"]);
  const unreachableSha = execFileSync(
    "git",
    ["-C", source, "commit-tree", tree, "-m", "unreachable"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Release Operation Test",
        GIT_AUTHOR_EMAIL: "release-operation@example.test",
        GIT_COMMITTER_NAME: "Release Operation Test",
        GIT_COMMITTER_EMAIL: "release-operation@example.test",
      },
    },
  ).trim();
  git(source, ["tag", "v2026.7.6", unreachableSha]);
  execFileSync("git", ["clone", "--quiet", "--bare", source, canonicalRepo]);
  execFileSync("git", ["clone", "--quiet", canonicalRepo, policyRoot]);
  git(policyRoot, ["remote", "set-url", "origin", canonicalUrl]);

  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shim = path.join(bin, "git");
  writeFileSync(
    shim,
    `#!/usr/bin/env node\n` +
      `import { appendFileSync } from "node:fs";\n` +
      `import { spawnSync } from "node:child_process";\n` +
      `const original = process.argv.slice(2);\n` +
      `appendFileSync(process.env.TEST_GIT_LOG, JSON.stringify(original) + "\\n");\n` +
      `const translated = [];\n` +
      `for (let i = 0; i < original.length; i += 1) {\n` +
      `  if (original[i] === "-c" && original[i + 1] === "protocol.file.allow=never") { i += 1; continue; }\n` +
      `  translated.push(original[i] === ${JSON.stringify(canonicalUrl)} ? process.env.TEST_CANONICAL_REPO : original[i]);\n` +
      `}\n` +
      `const result = spawnSync(${JSON.stringify(realGit)}, translated, { stdio: "inherit", env: process.env });\n` +
      `process.exit(result.status ?? 70);\n`,
  );
  chmodSync(shim, 0o755);

  return {
    root,
    policyRoot,
    cliPath: path.join(policyRoot, "scripts/verify-release-operation.mjs"),
    canonicalRepo,
    gitLog,
    policySha,
    unreachableSha,
  };
}

function baseInput(fixture: Fixture, operation: Operation = "tag-preflight") {
  const releaseVersion = "2026.7.5";
  const authorizedSourceRef = "refs/heads/main";
  const workflowPath =
    operation === "internal-validation"
      ? ".github/workflows/full-release-validation.yml"
      : operation === "publish" || operation === "postpublish"
        ? ".github/workflows/openclaw-release-publish.yml"
        : operation === "stable-closeout"
          ? ".github/workflows/openclaw-stable-main-closeout.yml"
          : ".github/workflows/openclaw-npm-release.yml";
  const executionRef = operation === "stable-closeout" ? "refs/heads/main" : authorizedSourceRef;
  return {
    schemaVersion: 1,
    operation,
    releaseVersion,
    releaseSelector: "daily",
    policyMode: "strict",
    expectedPolicySourceSha: fixture.policySha,
    execution: {
      event: operation === "stable-closeout" ? "push" : "workflow_dispatch",
      workflowPath,
      executionRef,
      runHeadSha: fixture.policySha,
      runId: "100",
      runAttempt: "1",
    },
    target:
      operation === "sha-preflight"
        ? {
            targetRef: null,
            targetSha: fixture.policySha,
            releaseTag: null,
            authorizedSourceRef: null,
          }
        : operation === "internal-validation"
          ? {
              targetRef: authorizedSourceRef,
              targetSha: fixture.policySha,
              releaseTag: null,
              authorizedSourceRef,
            }
          : {
              targetRef: `refs/tags/v${releaseVersion}`,
              targetSha: fixture.policySha,
              releaseTag: `v${releaseVersion}`,
              authorizedSourceRef,
            },
  };
}

function runVerify(fixture: Fixture, input: unknown, environment: Record<string, string> = {}) {
  const inputPath = path.join(fixture.root, `input-${Math.random()}.json`);
  writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
  const execution = (input as ReturnType<typeof baseInput>).execution;
  return spawnSync(
    process.execPath,
    [
      fixture.cliPath,
      "verify",
      "--contract-version",
      "1",
      "--policy-root",
      fixture.policyRoot,
      "--input",
      inputPath,
    ],
    {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(fixture.root, "bin")}:${process.env.PATH}`,
        TEST_CANONICAL_REPO: fixture.canonicalRepo,
        TEST_GIT_LOG: fixture.gitLog,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_EVENT_NAME: execution.event,
        GITHUB_WORKFLOW_REF: `openclaw/openclaw/${execution.workflowPath}@${execution.executionRef}`,
        GITHUB_REF: execution.executionRef,
        GITHUB_SHA: execution.runHeadSha,
        GITHUB_RUN_ID: execution.runId,
        GITHUB_RUN_ATTEMPT: execution.runAttempt,
        ...environment,
      },
    },
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("verify-release-operation CLI", () => {
  it("prints the exact offline v1 contract", () => {
    const result = spawnSync(process.execPath, [sourceCliPath, "contract", "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      '{"schemaVersion":1,"supportedContractVersions":[1],"repository":"openclaw/openclaw","canonicalFetchUrl":"https://github.com/openclaw/openclaw.git"}\n',
    );
  });

  it("authenticates policy and target independently and emits canonical daily evidence", () => {
    const fixture = createFixture();
    const input = baseInput(fixture);
    const result = runVerify(fixture, input);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      schemaVersion: 1,
      ok: true,
      operation: "tag-preflight",
      releaseVersion: "2026.7.5",
      releaseClass: "daily",
      releaseSelector: "daily",
      policyMode: "strict",
      policySource: {
        sha: fixture.policySha,
        blobs: { stableLinesSha256: null },
      },
      execution: input.execution,
      target: {
        ...input.target,
        authorizedSourceTipSha: fixture.policySha,
        targetReachableFromAuthorizedSource: true,
      },
    });
    expect(result.stdout).toBe(`${JSON.stringify(output)}\n`);
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout).not.toMatch(/npmDistTag|mirrorDistTags|tarball|registry/u);

    const gitCalls = readFileSync(fixture.gitLog, "utf8");
    expect(gitCalls).toContain("credential.helper=");
    expect(gitCalls).toContain("protocol.file.allow=never");
    expect(gitCalls).toContain(canonicalUrl);
  });

  it.each([
    "sha-preflight",
    "internal-validation",
    "publish",
    "postpublish",
    "stable-closeout",
  ] as const)("accepts the exact %s matrix entry", (operation) => {
    const fixture = createFixture();
    const input = baseInput(fixture, operation);
    if (operation === "stable-closeout") {
      input.releaseVersion = "2026.6.33";
      input.releaseSelector = "stable";
      input.target = {
        targetRef: "refs/tags/v2026.6.33",
        targetSha: fixture.policySha,
        releaseTag: "v2026.6.33",
        authorizedSourceRef: "refs/heads/stable/2026.6.33",
      };
    }
    const result = runVerify(fixture, input);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operation });
  });

  it("uses stable metadata as the sole exact stable branch authority", () => {
    const fixture = createFixture();
    const input = baseInput(fixture, "tag-preflight");
    input.releaseVersion = "2026.6.33";
    input.releaseSelector = "stable";
    input.execution.executionRef = "refs/heads/stable/2026.6.33";
    input.execution.runHeadSha = fixture.policySha;
    input.target = {
      targetRef: "refs/tags/v2026.6.33",
      targetSha: fixture.policySha,
      releaseTag: "v2026.6.33",
      authorizedSourceRef: "refs/heads/stable/2026.6.33",
    };
    const result = runVerify(fixture, input);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      releaseClass: "stable-base",
      policySource: { blobs: { stableLinesSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) } },
    });

    input.execution.executionRef = "refs/heads/stable/not-authorized";
    input.target.authorizedSourceRef = "refs/heads/stable/not-authorized";
    const rejected = runVerify(fixture, input);
    expect(rejected.status).toBe(4);
    expect(JSON.parse(rejected.stderr).error.code).toBe("target-not-authorized");
  });

  it.each([
    {
      releaseVersion: "2026.7.5-alpha.1",
      releaseSelector: "alpha",
      sourceRef: "refs/heads/tideclaw/alpha/2026-06-21-1200Z",
    },
    {
      releaseVersion: "2026.7.5-beta.1",
      releaseSelector: "beta",
      sourceRef: "refs/heads/main",
    },
    {
      releaseVersion: "2026.7.5-beta.1",
      releaseSelector: "beta",
      sourceRef: "refs/heads/release/2026.7.5",
    },
    {
      releaseVersion: "2026.7.5",
      releaseSelector: "daily",
      sourceRef: "refs/heads/release/2026.7.5",
    },
  ])(
    "accepts internal validation for $releaseSelector at $sourceRef",
    ({ releaseVersion, releaseSelector, sourceRef }) => {
      const fixture = createFixture();
      const input = baseInput(fixture, "internal-validation");
      input.releaseVersion = releaseVersion;
      input.releaseSelector = releaseSelector;
      input.execution.executionRef = sourceRef;
      input.target = {
        targetRef: sourceRef,
        targetSha: fixture.policySha,
        releaseTag: null,
        authorizedSourceRef: sourceRef,
      };

      const result = runVerify(fixture, input);
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.each([
    "refs/heads/release/not-exact",
    "refs/heads/stable/2026.6.33",
    "refs/heads/release-ci/0123456789ab-20260621-1200Z",
  ])("rejects a non-authoritative daily source ref: %s", (sourceRef) => {
    const fixture = createFixture();
    const input = baseInput(fixture, "internal-validation");
    input.execution.executionRef = sourceRef;
    input.target = {
      targetRef: sourceRef,
      targetSha: fixture.policySha,
      releaseTag: null,
      authorizedSourceRef: sourceRef,
    };

    const result = runVerify(fixture, input);
    expect(result.status).toBe(4);
    expect(JSON.parse(result.stderr).error.code).toBe("target-not-authorized");
  });

  it("rejects a canonical target that is not reachable from its authorized source", () => {
    const fixture = createFixture();
    const input = baseInput(fixture);
    input.releaseVersion = "2026.7.6";
    input.target = {
      targetRef: "refs/tags/v2026.7.6",
      targetSha: fixture.unreachableSha,
      releaseTag: "v2026.7.6",
      authorizedSourceRef: "refs/heads/main",
    };

    const result = runVerify(fixture, input);
    expect(result.status).toBe(4);
    expect(JSON.parse(result.stderr).error.code).toBe("target-not-reachable");
  });

  it("rejects closed-input, repository, execution, and target mismatches with closed errors", () => {
    const fixture = createFixture();
    const input = baseInput(fixture);

    const unknown = runVerify(fixture, { ...input, npmDistTag: "latest" });
    expect(unknown.status).toBe(2);
    expect(unknown.stdout).toBe("");
    expect(JSON.parse(unknown.stderr).error.code).toBe("invalid-input");

    const repository = runVerify(fixture, input, { GITHUB_REPOSITORY: "fork/openclaw" });
    expect(repository.status).toBe(3);
    expect(JSON.parse(repository.stderr).error.code).toBe("repository-identity-mismatch");

    const execution = runVerify(fixture, input, { GITHUB_REF: "refs/heads/release/2026.7.5" });
    expect(execution.status).toBe(4);
    expect(JSON.parse(execution.stderr).error.code).toBe("execution-not-authorized");

    const target = runVerify(fixture, {
      ...input,
      target: { ...input.target, targetSha: "f".repeat(40) },
    });
    expect(target.status).toBe(4);
    expect(JSON.parse(target.stderr).error.code).toBe("target-not-authorized");
  });

  it("rejects a dirty or non-canonical policy checkout", () => {
    const dirtyFixture = createFixture();
    writeFileSync(path.join(dirtyFixture.policyRoot, "untracked"), "dirty\n");
    const dirty = runVerify(dirtyFixture, baseInput(dirtyFixture));
    expect(dirty.status).toBe(3);
    expect(JSON.parse(dirty.stderr).error.code).toBe("policy-checkout-mismatch");

    const originFixture = createFixture();
    git(originFixture.policyRoot, ["remote", "set-url", "origin", originFixture.canonicalRepo]);
    const origin = runVerify(originFixture, baseInput(originFixture));
    expect(origin.status).toBe(3);
    expect(JSON.parse(origin.stderr).error.code).toBe("policy-checkout-mismatch");
  });
});
