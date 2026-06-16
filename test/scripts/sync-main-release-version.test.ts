import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  parseArgs,
  planMainReleaseVersionSync,
  syncMainReleaseVersion,
} from "../../scripts/sync-main-release-version.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function createRoot(version: string): string {
  const rootDir = makeTempDir(tempDirs, "openclaw-main-version-sync-");
  writeFileSync(
    path.join(rootDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version, private: true }, null, 2)}\n`,
  );
  return rootDir;
}

describe("parseArgs", () => {
  it("requires one stable release tag", () => {
    expect(parseArgs(["--tag", "v2026.6.8"])).toEqual({ tag: "v2026.6.8" });
    expect(() => parseArgs([])).toThrow("Usage:");
    expect(() => parseArgs(["--version", "2026.6.8"])).toThrow("Unknown argument: --version");
  });
});

describe("planMainReleaseVersionSync", () => {
  it("syncs an older main version to a stable release package version", () => {
    expect(
      planMainReleaseVersionSync({
        tag: "v2026.6.8",
        currentVersion: "2026.6.2",
        releasePackageVersion: "2026.6.8",
      }),
    ).toMatchObject({
      releasePackageVersion: "2026.6.8",
      shouldSync: true,
    });
  });

  it("accepts correction tags with a base or correction package version", () => {
    expect(
      planMainReleaseVersionSync({
        tag: "v2026.6.8-1",
        currentVersion: "2026.6.7",
        releasePackageVersion: "2026.6.8",
      }),
    ).toMatchObject({
      releasePackageVersion: "2026.6.8",
      shouldSync: true,
    });
    expect(
      planMainReleaseVersionSync({
        tag: "v2026.6.8-1",
        currentVersion: "2026.6.8",
        releasePackageVersion: "2026.6.8-1",
      }),
    ).toMatchObject({
      releasePackageVersion: "2026.6.8-1",
      shouldSync: true,
    });
  });

  it("does not downgrade main or replace a matching version", () => {
    expect(
      planMainReleaseVersionSync({
        tag: "v2026.6.8",
        currentVersion: "2026.6.8",
        releasePackageVersion: "2026.6.8",
      }).shouldSync,
    ).toBe(false);
    expect(
      planMainReleaseVersionSync({
        tag: "v2026.6.8",
        currentVersion: "2026.6.9-beta.1",
        releasePackageVersion: "2026.6.8",
      }).shouldSync,
    ).toBe(false);
  });

  it("rejects prerelease tags and tag/package mismatches", () => {
    expect(() =>
      planMainReleaseVersionSync({
        tag: "v2026.6.8-beta.2",
        currentVersion: "2026.6.2",
        releasePackageVersion: "2026.6.8-beta.2",
      }),
    ).toThrow("only supports stable release tags");
    expect(() =>
      planMainReleaseVersionSync({
        tag: "v2026.6.8",
        currentVersion: "2026.6.2",
        releasePackageVersion: "2026.6.7",
      }),
    ).toThrow("expects package version 2026.6.8");
  });
});

describe("syncMainReleaseVersion", () => {
  it("updates the root version and runs the canonical generators and checks", async () => {
    const rootDir = createRoot("2026.6.2");
    const calls: string[][] = [];

    const result = await syncMainReleaseVersion({
      rootDir,
      tag: "v2026.6.8",
      readReleaseVersion: () => "2026.6.8",
      runCommand: async ({ args }: { args: string[] }) => {
        calls.push(args);
        return 0;
      },
    });

    expect(result.shouldSync).toBe(true);
    expect(JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version).toBe(
      "2026.6.8",
    );
    expect(calls).toEqual([
      ["release:prep"],
      ["deps:shrinkwrap:generate"],
      ["deps:shrinkwrap:check"],
    ]);
  });

  it("leaves an equal or newer main version untouched", async () => {
    const rootDir = createRoot("2026.6.8");
    let commandRan = false;

    const result = await syncMainReleaseVersion({
      rootDir,
      tag: "v2026.6.8",
      readReleaseVersion: () => "2026.6.8",
      runCommand: async () => {
        commandRan = true;
        return 0;
      },
    });

    expect(result.shouldSync).toBe(false);
    expect(commandRan).toBe(false);
  });

  it("validates a stable tag before reading it from git", async () => {
    const rootDir = createRoot("2026.6.2");
    let releaseRead = false;

    await expect(
      syncMainReleaseVersion({
        rootDir,
        tag: "--help",
        readReleaseVersion: () => {
          releaseRead = true;
          return "2026.6.8";
        },
      }),
    ).rejects.toThrow('must start with "v"');

    expect(releaseRead).toBe(false);
  });
});

describe("stable main version sync workflows", () => {
  it("dispatches the repairable sync workflow only after a stable npm publish", () => {
    const npmWorkflow = parse(
      readFileSync(".github/workflows/openclaw-npm-release.yml", "utf8"),
    ) as {
      jobs?: Record<
        string,
        {
          permissions?: Record<string, string>;
          steps?: Array<{
            "continue-on-error"?: boolean;
            if?: string;
            name?: string;
            run?: string;
          }>;
        }
      >;
    };
    const publishJob = npmWorkflow.jobs?.publish_openclaw_npm;
    const dispatchStep = publishJob?.steps?.find(
      (step) => step.name === "Dispatch stable main version sync",
    );

    expect(publishJob?.permissions?.actions).toBe("write");
    expect(dispatchStep?.if).toContain("!contains(inputs.tag, '-alpha.')");
    expect(dispatchStep?.if).toContain("!contains(inputs.tag, '-beta.')");
    expect(dispatchStep?.["continue-on-error"]).toBe(true);
    expect(dispatchStep?.run).toContain(
      'gh workflow run sync-main-release-version.yml --ref main -f tag="${RELEASE_TAG}"',
    );
  });

  it("runs the generated metadata sync on current main and opens a PR", () => {
    const syncWorkflow = parse(
      readFileSync(".github/workflows/sync-main-release-version.yml", "utf8"),
    ) as {
      jobs?: Record<
        string,
        {
          if?: string;
          needs?: string;
          outputs?: Record<string, string>;
          permissions?: Record<string, string>;
          steps?: Array<{
            if?: string;
            name?: string;
            run?: string;
            with?: Record<string, string>;
          }>;
        }
      >;
    };
    const syncJob = syncWorkflow.jobs?.sync;
    const checkoutStep = syncJob?.steps?.find((step) => step.name === "Checkout current main");
    const validateStep = syncJob?.steps?.find((step) => step.name === "Validate stable tag input");
    const setupStep = syncJob?.steps?.find((step) => step.name === "Setup Node environment");
    const syncStep = syncJob?.steps?.find((step) => step.name === "Sync stable package metadata");
    const appTokenStep = syncJob?.steps?.find(
      (step) => step.name === "Create release sync app token",
    );
    const prStep = syncJob?.steps?.find(
      (step) => step.name === "Open or refresh main version sync PR",
    );
    const mergeJob = syncWorkflow.jobs?.merge;
    const waitStep = mergeJob?.steps?.find((step) => step.name === "Wait for generated PR checks");
    const mergeTokenStep = mergeJob?.steps?.find(
      (step) => step.name === "Create release sync merge app token",
    );
    const mergeStep = mergeJob?.steps?.find(
      (step) => step.name === "Squash-merge exact generated PR head",
    );

    expect(checkoutStep?.with?.ref).toBe("main");
    expect(checkoutStep?.with?.["persist-credentials"]).toBe(false);
    expect(checkoutStep?.with?.token).toBeUndefined();
    expect(validateStep?.run).toContain("Invalid stable release tag");
    expect(syncJob?.steps?.indexOf(validateStep ?? {})).toBeLessThan(
      syncJob?.steps?.indexOf(setupStep ?? {}) ?? -1,
    );
    expect(setupStep?.with?.["node-version"]).toBe("${{ env.NODE_VERSION }}");
    expect(syncStep?.run).toContain("git fetch");
    expect(syncStep?.run).toContain('pnpm release:sync-main-version -- --tag "${RELEASE_TAG}"');
    expect(appTokenStep?.if).toContain("steps.sync.outputs.changed == 'true'");
    expect(syncJob?.steps?.indexOf(appTokenStep ?? {})).toBeGreaterThan(
      syncJob?.steps?.indexOf(syncStep ?? {}) ?? -1,
    );
    expect(prStep?.run).toContain('branch="automation/sync-main-${PACKAGE_VERSION}"');
    expect(prStep?.run).not.toContain('branch="release/');
    expect(prStep?.run).toContain("gh auth setup-git");
    expect(prStep?.run).toContain('git push --force-with-lease origin "HEAD:refs/heads/${branch}"');
    expect(prStep?.run).toContain("gh pr create");
    expect(prStep?.run).toContain("gh pr edit");
    expect(syncJob?.outputs?.base_sha).toBe("${{ steps.pr.outputs.base_sha }}");
    expect(syncJob?.outputs?.head_sha).toBe("${{ steps.pr.outputs.head_sha }}");
    expect(syncJob?.outputs?.pr_url).toBe("${{ steps.pr.outputs.pr_url }}");
    expect(prStep?.run).toContain('echo "base_sha=${base_sha}" >> "$GITHUB_OUTPUT"');
    expect(prStep?.run).toContain('echo "head_sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"');
    expect(prStep?.run).toContain('echo "pr_url=${pr_url}" >> "$GITHUB_OUTPUT"');

    expect(mergeJob?.needs).toBe("sync");
    expect(mergeJob?.if).toContain("needs.sync.outputs.changed == 'true'");
    expect(mergeJob?.permissions?.actions).toBe("write");
    expect(mergeJob?.permissions?.checks).toBe("read");
    expect(mergeJob?.permissions?.contents).toBe("read");
    expect(mergeJob?.permissions?.["pull-requests"]).toBe("read");
    expect(waitStep?.run).toContain('.name == "preflight" and .workflow == "CI"');
    expect(waitStep?.run).toContain('gh pr checks "${PR_URL}" --watch --fail-fast');
    expect(mergeTokenStep?.if).toBeUndefined();
    expect(mergeJob?.steps?.indexOf(mergeTokenStep ?? {})).toBeGreaterThan(
      mergeJob?.steps?.indexOf(waitStep ?? {}) ?? -1,
    );
    expect(mergeStep?.run).toContain('GH_TOKEN="${WORKFLOW_TOKEN}" gh pr checks "${PR_URL}"');
    expect(mergeStep?.run).toContain('current_main="$(GH_TOKEN="${WORKFLOW_TOKEN}" gh api');
    expect(mergeStep?.run).toContain("main advanced before merge");
    expect(mergeStep?.run).toContain("gh workflow run sync-main-release-version.yml");
    expect(mergeStep?.run).toContain('--repo "${GITHUB_REPOSITORY}"');
    expect(mergeStep?.run).toContain(
      'gh pr merge "${PR_URL}" --squash --delete-branch --match-head-commit "${EXPECTED_HEAD_SHA}"',
    );
  });
});
