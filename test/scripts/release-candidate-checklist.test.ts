import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePublicationIntent } from "../../scripts/full-release-publication-contract.mjs";
import { stripLeadingPackageManagerSeparator } from "../../scripts/lib/arg-utils.mts";
import { parsePluginReleaseSelection } from "../../scripts/lib/plugin-npm-release.ts";
import {
  candidateCumulativeShippedPullRequests,
  loadCandidateShippedBaseline,
  validateCandidateChangelogProvenance,
  validateCandidateReleaseNotes,
} from "../../scripts/lib/release-candidate-changelog.mts";
import { splitChangelog } from "../../scripts/lib/release-changelog.mjs";
import { releaseBranchForTag } from "../../scripts/lib/release-context.mjs";
import {
  buildReleasePublishDispatchCommand,
  formatReleasePublishPreflight,
} from "../../scripts/lib/release-publish-preflight-interface.mts";
import { classifyReleaseTrain, parseReleaseVersion } from "../../scripts/lib/release-version.mjs";
import { validateReleaseButtonInputs } from "../../scripts/openclaw-release-ready.mjs";
import {
  PluginSdkApiAcknowledgementError,
  createPluginSdkApiReleaseEvidence,
  findPluginSdkApiReleaseNoteOmissions,
  validatePluginSdkApiReleaseEvidence,
} from "../../scripts/plugin-sdk-api-release-evidence.mjs";
import {
  buildReleaseCandidateState,
  buildPrepareCommand,
  buildTelegramArtifactInputs,
  assertReleaseCandidateTag,
  candidateParallelsShellCommand,
  githubApi,
  isDirectReleaseCandidateExecution,
  parseArgs,
  preflightCorePackageTarballs,
  preflightDependencyTarballs,
  reconcileReleaseCandidateState,
  resolveEarlyPluginSdkApiBases,
  resolveEarlyPluginSdkApiReviewPaths,
  resolveArtifactName,
  resolveReleaseCandidateOutputDir,
  requireRunIdFromDispatchOutput,
  run,
  validateCandidateCheckout,
  validateFullManifest,
  validateNpmPreflightRunSource,
  validateParallelsRegistryPackageArtifact,
  validatePreflightManifest,
  validateReleaseScenarioCatalogCompatibility,
  validateTrustedToolingPin,
  validateWindowsSourceRelease,
} from "../../scripts/release-candidate-checklist.mts";
import type { runReleasePublishPreflight } from "../../scripts/release-publish-preflight.mts";
import { isShaPinnedReleaseValidationBranch } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { stripNodeTypeScriptTypes } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const publishWorkflowRef = "release-publish/bbbbbbbbbbbb-123";
const checklistSource = readFileSync("scripts/release-candidate-checklist.mts", "utf8");

function checklistFunctions(...names: string[]) {
  return names
    .map((name) =>
      expectDefined(
        checklistSource.match(
          new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "mu"),
        )?.[0],
        `checklist function ${name}`,
      ),
    )
    .join("\n");
}

function candidateArgs(fields: Record<string, string | boolean>) {
  return Object.entries(fields).flatMap(([flag, value]) =>
    value === false ? [] : value === true ? [`--${flag}`] : [`--${flag}`, value],
  );
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value));
}

const coordinatorContext = {
  TRUSTED_TOOLING_SHA_ENV: "OPENCLAW_RELEASE_CANDIDATE_TRUSTED_TOOLING_SHA",
  UPGRADE_SURVIVOR_CATALOG_PATH: "scripts/lib/upgrade-survivor-scenarios.json",
  RELEASE_CANDIDATE_STATE_FILE: "release-candidate-state.json",
  RELEASE_CANDIDATE_STATE_VERSION: 2,
  assertReleaseCandidateTag: () => {},
  validateTrustedToolingPin,
  validateCandidateCheckout,
  validateReleaseScenarioCatalogCompatibility: () => ({ status: "passed", unsupported: [] }),
  buildReleaseCandidateState,
  reconcileReleaseCandidateState,
  existsSync,
  join,
};
const scenarioCatalog = (scenarios = ["base"], oldestSupportedBaseline: string | null = null) =>
  JSON.stringify({ oldestSupportedBaseline, scenarios, assertionOnlyScenarios: [] });
const windowsAssets = [
  { name: "OpenClawCompanion-Setup-x64.exe", digest: `sha256:${"a".repeat(64)}` },
  { name: "OpenClawCompanion-Setup-arm64.exe", digest: `sha256:${"b".repeat(64)}` },
];
const windowsReleaseUrl = "https://github.com/openclaw/openclaw-windows-node/releases/tag/v0.6.3";

function windowsReleaseResponse(override: Record<string, unknown> = {}) {
  return jsonResponse({
    tag_name: "v0.6.3",
    draft: false,
    prerelease: false,
    html_url: windowsReleaseUrl,
    assets: windowsAssets,
    ...override,
  });
}

function coreTarball(name: string) {
  return {
    packageName: `@openclaw/${name}`,
    packageVersion: "2026.7.1-beta.3",
    tarballName: `openclaw-${name}-2026.7.1-beta.3.tgz`,
    tarballSha256: `${name}-sha`,
  };
}

const preflightIdentity = {
  tag: "v2026.7.1-beta.3",
  targetSha: "candidate-sha",
  npmDistTag: "beta",
};

function preflightManifest(tarballs: Record<string, unknown>) {
  return {
    releaseTag: preflightIdentity.tag,
    releaseSha: preflightIdentity.targetSha,
    npmDistTag: preflightIdentity.npmDistTag,
    tarballName: "openclaw-2026.7.1-beta.3.tgz",
    tarballSha256: "root-sha",
    ...tarballs,
  };
}

function candidateState() {
  return buildReleaseCandidateState(parseArgs(["--tag", "v2026.7.1-beta.4"]), {
    targetSha: "a".repeat(40),
    toolingSha: "b".repeat(40),
  });
}

function candidateGitFixture(files: Record<string, string>) {
  const root = tempDirs.make("openclaw-candidate-");
  const git = (...args: string[]) => run("git", args, { cwd: root, capture: true }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release Fixture");
  git("config", "user.email", "release-fixture@example.com");
  git("config", "commit.gpgsign", "false");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  git("add", ".");
  git("commit", "-m", "test: seed candidate");
  return { root, git };
}

function candidateChangelog(provenance: string, rows: string[], exclusions?: string) {
  return `# Changelog

## 2026.7.1

### Highlights

- User-facing notes.

### Complete contribution record

${provenance}

${exclusions ? `${exclusions}\n\n` : ""}#### Pull requests

${rows.join("\n")}`;
}

function checkProvenance(
  changelog: string,
  overrides: Partial<Parameters<typeof validateCandidateChangelogProvenance>[0]> = {},
) {
  return validateCandidateChangelogProvenance({
    changelog,
    version: "2026.7.1",
    tag: "v2026.7.1-beta.3",
    targetSha: "a".repeat(40),
    isAncestor: () => true,
    ...overrides,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), init);
}

async function withGithubApiTimeoutEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS;
  process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS;
    } else {
      process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS = previous;
    }
  }
}

describe("release candidate checklist", () => {
  it("scopes default candidate output by target SHA and honors explicit legacy paths", () => {
    const tag = "v2026.9.1-beta.2";
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const output = (targetSha: string, outputDir = "") =>
      resolveReleaseCandidateOutputDir({ outputDir, tag, targetSha });
    expect(output(first)).toBe(join(".artifacts", "release-candidate", tag, first));
    expect(output(second)).toBe(join(".artifacts", "release-candidate", tag, second));
    expect(output(first, "/retained-release-request")).toBe("/retained-release-request");
  });

  it("resolves the early Plugin SDK review against the publication selectors", () => {
    expect(
      resolveEarlyPluginSdkApiBases({
        distTags: { beta: "2026.10.20-beta.1", latest: "2026.10.19" },
        npmDistTag: "latest",
        packageVersion: "2026.10.21",
      }),
    ).toEqual({ beta: "v2026.10.20-beta.1", latest: "v2026.10.19" });
    expect(
      resolveEarlyPluginSdkApiBases({
        distTags: { beta: "2026.10.20-beta.1", latest: "2026.10.19" },
        npmDistTag: "beta",
        packageVersion: "2026.10.21-beta.1",
      }),
    ).toEqual({ beta: "v2026.10.20-beta.1" });
  });

  it("keeps early Plugin SDK artifacts in the candidate output when tooling has another cwd", () => {
    const candidateRoot = tempDirs.make("candidate-sdk-review-");
    const outputDir = join(".artifacts", "release-candidate", "v2026.10.21", "candidate-sha");
    const paths = resolveEarlyPluginSdkApiReviewPaths({ outputDir, targetRoot: candidateRoot });
    expect(paths.reviewDir).toBe(join(candidateRoot, outputDir, "plugin-sdk-api-early-review"));
    for (const artifactPath of [paths.evidencePath, paths.reportPath, paths.diffPath]) {
      expect(dirname(artifactPath)).toBe(paths.reviewDir);
    }
  });

  it.each<[string[], string]>([
    [
      ["--workflow-sha", "b".repeat(40), "--publish-workflow-ref", publishWorkflowRef],
      "--workflow-sha and --publish-workflow-ref are mutually exclusive",
    ],
    [["--workflow-sha", "b".repeat(12)], "--workflow-sha must be a full lowercase commit SHA"],
    [["--target-sha", "not-a-sha"], "--target-sha must be a full lowercase commit SHA"],
    [["--publish-workflow-ref", "main"], "protected release-publish tag"],
    [
      ["--run-parallels", "--skip-parallels"],
      "--run-parallels and --skip-parallels cannot be combined",
    ],
    [["--skip-dispatch"], "--skip-dispatch requires --full-release-validation-run-id"],
    [["--full-release-validation-run-id", "111", "--full-release-run", "222"], "do not combine"],
    [["--workflow-ref", "release/2026.5.14"], "--workflow-ref must be main"],
    [["--tag", "v2026.7.1-alpha.3"], "Alpha releases are retired;"],
    [
      ["--tag", "v2026.5.14-beta.4", "--tag", "v2026.5.14-beta.3"],
      "--tag was provided more than once",
    ],
    [["--plugin-sdk-api-acknowledgement", "ABC"], "8-character lowercase digest"],
    [
      ["--windows-node-tag", "latest"],
      "--windows-node-tag must be an explicit version tag, not latest",
    ],
    [["--plugin-publish-scope", "selected"], "--plugin-publish-scope selected requires --plugins"],
    [
      ["--plugin-publish-scope", "selected", "--plugins", "@openclaw/diffs"],
      "release candidates publish OpenClaw with --plugin-publish-scope all-publishable",
    ],
  ])("rejects invalid candidate options %j: %s", (flags, message) => {
    expect(() =>
      parseArgs(flags.includes("--tag") ? flags : ["--tag", "v2026.5.14-beta.3", ...flags]),
    ).toThrow(message);
  });

  it("keeps help short-circuiting before deprecated alias conflict checks", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/release-candidate-checklist.mts",
        "--help",
        "--full-release-validation-run-id",
        "111",
        "--full-release-run",
        "222",
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: pnpm release:candidate");
  });

  it("requires an explicit prepared route and preserves historical normal state semantics", () => {
    const normal = parseArgs(["--tag", "v2026.9.1", "--publish-workflow-ref", publishWorkflowRef]);
    expect(normal.publicationRoute).toBe("normal");
    const prepared = parseArgs([
      "--tag",
      "v2026.9.1",
      "--publish-workflow-ref",
      publishWorkflowRef,
      "--publication-route",
      "prepared",
    ]);
    expect(prepared.publicationRoute).toBe("prepared");
    const identity = { targetSha: "a".repeat(40), toolingSha: "b".repeat(40) };
    const saved = { ...buildReleaseCandidateState(normal, identity), fullReleaseRunId: "111" };
    expect(() =>
      reconcileReleaseCandidateState(saved, buildReleaseCandidateState(prepared, identity)),
    ).toThrow("publicationRoute");
    const { publicationRoute: _route, ...historical } = saved;
    expect(reconcileReleaseCandidateState(historical, saved).publicationRoute).toBe("normal");
    expect(() =>
      reconcileReleaseCandidateState(historical, buildReleaseCandidateState(prepared, identity)),
    ).toThrow("publicationRoute");
    expect(() => parseArgs(["--tag", "v2026.9.1", "--publication-route", "prepared"])).toThrow(
      "protected tooling",
    );
  });

  it("reads cumulative frozen shipped records after split prose changes", () => {
    const target = "a".repeat(40);
    const section = (version: string, number: number) =>
      `## ${version}\n\n### Complete contribution record\n\nThis audited record covers the complete v2026.5.1..${target} history: 1 in-range PR + 0 retained seed-only PRs = 1 unique PR.\n\n#### Pull requests\n\n- **PR #${number}** fix: example.\n`;
    const { root, git } = candidateGitFixture({
      "CHANGELOG.md": `${section("2026.7.1", 12)}\n${section("2026.6.1", 11)}`,
    });
    git("tag", "v2026.7.1-beta.1");
    expect(loadCandidateShippedBaseline("v2026.7.1-beta.1", root).pullRequests).toEqual(
      new Set([12, 11]),
    );
    splitChangelog({ rootDir: root });
    writeFileSync(
      join(root, "CHANGELOG/2026.7.1.md"),
      "## 2026.7.1\n\n<!-- openclaw-docs-mirror-v1 {} -->\n\nPublished reader prose without accounting rows.\n",
    );
    git("add", ".");
    git("commit", "-m", "docs: replace visible prose");
    git("tag", "v2026.7.1-beta.2");
    expect(loadCandidateShippedBaseline("v2026.7.1-beta.2", root).pullRequests).toEqual(
      new Set([12, 11]),
    );
  });

  type QualificationCase = {
    tag?: string;
    pin?: string;
    expected?: "passed" | "warning";
    failedRegistry?: string;
    launch?: "fresh" | "npm-only" | "reuse" | "saved-full" | "saved-npm" | "mismatch";
    distTag?: string;
    routingError?: string;
    stopAtRegistry?: boolean;
    publicationRoute?: string;
    registryAdmission?: boolean;
    preflightFailure?: boolean;
    workflowSha?: string;
    savedToolingTag?: string;
    savedToolingSha?: string;
    telegramRunId?: string;
    sdkAcknowledgement?: string;
    sdkReport?: boolean;
    generatedFailure?: boolean;
    changelogFailure?: boolean;
    mismatchedRun?: boolean;
    defaultOutput?: boolean;
  };

  it.each<QualificationCase>([
    ...["", "deadbeef", "f4b495f3"].map<QualificationCase>((sdkAcknowledgement) => ({
      sdkAcknowledgement,
      sdkReport: sdkAcknowledgement === "",
    })),
    { launch: "npm-only", generatedFailure: true },
    { launch: "npm-only", changelogFailure: true },
    { mismatchedRun: true },
    { defaultOutput: true },
    { workflowSha: "b".repeat(40), savedToolingTag: "release-publish/bbbbbbbbbbbb-100" },
    {
      workflowSha: "b".repeat(40),
      savedToolingSha: "a".repeat(40),
      savedToolingTag: "release-publish/aaaaaaaaaaaa-100",
    },
    { workflowSha: "c".repeat(40) },
    { pin: "2026.7.4", expected: "warning" },
    ...["normal", "prepared"].map<QualificationCase>((publicationRoute) => ({
      publicationRoute,
      workflowSha: "b".repeat(40),
      telegramRunId: "555",
    })),
    { tag: "v2026.9.1-beta.1", pin: "2026.7.4" },
    { failedRegistry: "npm", registryAdmission: true },
    { launch: "reuse", registryAdmission: true },
    {
      launch: "fresh",
      distTag: "extended-stable",
      routingError: "Fresh extended-stable checklist launches are not supported",
    },
    {
      tag: "v2026.9.33",
      pin: "2026.9.33",
      launch: "saved-npm",
      routingError: "Fresh extended-stable checklist launches are not supported",
    },
    {
      tag: "v2026.9.33-1",
      pin: "2026.9.33",
      launch: "fresh",
      routingError: "Extended-stable correction suffixes are invalid",
    },
    ...(["saved-full", "mismatch"] as const).map<QualificationCase>((launch) => ({
      tag: "v2026.9.33",
      pin: "2026.9.33",
      launch,
      distTag: "extended-stable",
      stopAtRegistry: true,
    })),
    { tag: "v2026.9.1-1", launch: "npm-only", distTag: "latest" },
    {
      launch: "npm-only",
      distTag: "latest",
      publicationRoute: "prepared",
      preflightFailure: true,
    },
  ])(
    "qualifies candidate %j",
    async ({
      tag = "v2026.9.1",
      pin = "2026.9.1",
      expected = "passed",
      failedRegistry,
      launch,
      distTag,
      routingError,
      stopAtRegistry,
      publicationRoute = "normal",
      registryAdmission = false,
      preflightFailure = false,
      workflowSha,
      savedToolingTag,
      savedToolingSha,
      telegramRunId,
      sdkAcknowledgement,
      sdkReport,
      generatedFailure,
      changelogFailure,
      mismatchedRun,
      defaultOutput,
    }) => {
      const { root: targetRoot, git } = candidateGitFixture({
        "package.json": JSON.stringify({ version: tag.slice(1) }),
        "apps/android/version.json": JSON.stringify({ version: pin, versionCode: 2026070401 }),
        "CHANGELOG.md": "# Fixture changelog\n\n## 2026.9.1\n\nFixture notes.\n",
      });
      const targetSha = git("rev-parse", "HEAD");
      // The target ref is authoritative even if another checkout has prepared a newer pin.
      writeJson(join(targetRoot, "apps/android/version.json"), { version: "2099.1.1" });
      const candidateArgv = candidateArgs({
        tag,
        "publication-route": publicationRoute,
        ...(!launch || launch === "reuse" ? { "full-release-run": "111" } : {}),
        ...(!launch || launch === "reuse" || launch === "npm-only"
          ? { "npm-preflight-run": "222" }
          : {}),
        "skip-dispatch": !launch,
        ...(distTag ? { "npm-dist-tag": distTag } : {}),
        "skip-parallels": true,
        "skip-telegram": true,
        "skip-local-generated-check": true,
        ...(workflowSha
          ? { "workflow-sha": workflowSha }
          : { "publish-workflow-ref": publishWorkflowRef }),
        ...(sdkAcknowledgement ? { "plugin-sdk-api-acknowledgement": sdkAcknowledgement } : {}),
        "output-dir": `${targetRoot}/evidence 'quoted' $(literal)`,
      });
      const options = parseArgs(candidateArgv);
      if (failedRegistry) {
        options.fullReleaseRunId = "";
        options.skipDispatch = false;
      }
      const outputDir = defaultOutput
        ? join(targetRoot, ".artifacts", "release-candidate", tag, targetSha)
        : join(targetRoot, "evidence");
      options.outputDir = defaultOutput ? "" : outputDir;
      mkdirSync(join(outputDir, "npm-preflight"), { recursive: true });
      writeFileSync(join(outputDir, "npm-preflight", "openclaw.tgz"), "fixture");
      const log = vi.fn();
      const writeState = vi.fn<(path: string, state: unknown) => void>(
        workflowSha
          ? runInNewContext(
              stripNodeTypeScriptTypes(
                `${checklistFunctions("writeReleaseCandidateState")}\nwriteReleaseCandidateState;`,
              ),
              { mkdirSync, join, process, writeFileSync, renameSync },
            )
          : () => {},
      );
      const updateState = vi.fn((_path: string, state: unknown) => state);
      const generatedChecks = vi.fn(() => {
        if (generatedFailure) {
          throw new Error("fixture generated-check failure");
        }
        return { status: "skipped" };
      });
      const publishCommand = vi.fn(buildPrepareCommand);
      const waitedRuns: string[] = [];
      const toolingSha = "b".repeat(40);
      const runReleaseToolingGh = vi.fn();
      const ensureToolingTag = vi.fn(() => ({ tag: publishWorkflowRef, created: true }));
      const statePath = join(outputDir, "release-candidate-state.json");
      const savedState =
        launch === "saved-full" || launch === "saved-npm" || launch === "mismatch"
          ? {
              ...buildReleaseCandidateState(options, { targetSha, toolingSha }),
              fullReleaseRunId: launch === "saved-npm" ? "" : "333",
              npmPreflightRunId: "444",
              ...(launch === "mismatch" ? { targetSha: "c".repeat(40) } : {}),
            }
          : savedToolingTag
            ? {
                ...buildReleaseCandidateState(options, { targetSha, toolingSha }),
                publishWorkflowRef: savedToolingTag,
                toolingSha: savedToolingSha ?? toolingSha,
              }
            : undefined;
      if (savedState) {
        writeJson(statePath, savedState);
      }
      const sdkPayload = {
        entrypointsAdded: [],
        entrypointsRemoved: [],
        exports: sdkAcknowledgement === undefined ? [] : [{ change: "added", exportName: "send" }],
      };
      const sdkEvidence = createPluginSdkApiReleaseEvidence({
        baseRef: "v2026.8.1",
        baseSha: "a".repeat(40),
        headSha: targetSha,
        workflowSha: targetSha,
        diff: {
          ...sdkPayload,
          digest: createHash("sha256").update(JSON.stringify(sdkPayload)).digest("hex"),
        },
      });
      const npmManifest = {
        tarballName: "openclaw.tgz",
        tarballSha256: "fixture-digest",
        corePackageTarballs: [],
        dependencyTarballs: [],
        pluginSdkApi: sdkEvidence,
      };
      const fullManifest = {
        workflowName: "Full Release Validation",
        targetSha,
        releaseProfile: options.releaseProfile,
      };
      const authenticatedEvidence = {
        source: "direct",
        publicationAdmission: registryAdmission
          ? {
              observations: {
                plans: {
                  npm: { all: [{ packageName: "@openclaw/example", version: "2026.9.1" }] },
                  clawhub: { all: [] },
                },
              },
            }
          : null,
      };
      const preflight = vi.fn<typeof runReleasePublishPreflight>(async (input) => ({
        rows: [],
        command: buildReleasePublishDispatchCommand(input, "1", input.workflowRef, "777"),
        failed: preflightFailure,
      }));
      // Run the real coordinator and evidence writers; unrelated remote release gates are fixtures.
      const dispatches: string[][] = [];
      const completion = runInNewContext(
        stripNodeTypeScriptTypes(
          `${checklistFunctions("checkCandidateAndroidVersion", "publicationSelectionForChecklist", "canUpdateReleaseCandidateState", "savedPublishWorkflowRef", "dispatchFullReleaseUsingHelper", "shellQuote", "formatPluginSdkApiAcknowledgementFailure", "main")}\nmain();`,
        ),
        {
          ...coordinatorContext,
          process: {
            argv: ["node", "scripts/release-candidate-checklist.mts", ...candidateArgv],
            cwd: () => targetRoot,
            env: {},
            execPath: process.execPath,
          },
          TextDecoder,
          DEFAULT_REPO: "openclaw/openclaw",
          resolvePath: (...paths: string[]) => join(...paths),
          console: { log, warn: log },
          TOOLING_ROOT: "/trusted/tooling",
          PUBLISH_TOOLING_TAG_PATTERN: /^release-publish\/[a-f0-9]{12}-[1-9][0-9]*$/u,
          parseArgs: () => options,
          resolveReleaseCandidateOutputDir: (
            params: Parameters<typeof resolveReleaseCandidateOutputDir>[0],
          ) => {
            if (defaultOutput) {
              expect(params).toEqual({ outputDir: "", tag, targetSha });
            }
            return resolvePath(targetRoot, resolveReleaseCandidateOutputDir(params));
          },
          gitTopLevel: (root: string) => root,
          gitRevParse: (_ref: string, root: string) =>
            root === targetRoot ? targetSha : toolingSha,
          fetchTrustedWorkflowSha: () => toolingSha,
          ensureReleasePublishToolingTag: ensureToolingTag,
          runReleaseToolingGh,
          // The protected publish tag is verified against live GitHub refs in production.
          verifyReleaseToolingIdentity: () => ({
            workflowRef: options.publishWorkflowRef,
            workflowSha: toolingSha,
          }),
          gitTrackedStatus: () => "",
          writeReleaseCandidateState: writeState,
          updateReleaseCandidateState: updateState,
          run: (command: string, args: string[]) => {
            if (
              command === "git" &&
              args[0] === "show" &&
              args[1]?.endsWith(":scripts/lib/upgrade-survivor-scenarios.json")
            ) {
              return scenarioCatalog();
            }
            if (args[0]?.endsWith("full-release-validation-at-sha.mjs")) {
              expect(generatedChecks).toHaveBeenCalledOnce();
              dispatches.push(args);
              writeJson(join(options.outputDir, "frv-request.json"), {
                phase: "observed",
                run: { id: 111, attempt: 1 },
              });
              return "";
            }
            return args[0] === "fetch"
              ? ""
              : run(command, args, { cwd: targetRoot, capture: true });
          },
          parseReleaseVersion,
          classifyReleaseTrain,
          normalizePublicationIntent,
          parsePluginReleaseSelection,
          isRecord,
          requireString: (value: string) => value,
          validateCandidateChangelog: () => {
            if (changelogFailure) {
              throw new Error("candidate changelog rejected");
            }
            return {
              releaseNotesText: "Fixture notes.",
              releaseNotesCheck: { status: "passed" },
              releaseNotesProvenance: { status: "passed", shippedBaselines: [] },
            };
          },
          runLocalGeneratedCheckIfNeeded: generatedChecks,
          runEarlyPluginSdkApiReview: () => {},
          releaseBranchForTag,
          readFileSync: (file: string) =>
            file.endsWith("plugin-sdk-api-release-diff.md")
              ? readFileSync(file)
              : readFileSync(".github/workflows/full-release-validation.yml", "utf8"),
          waitForSuccessfulRun: async (_repo: string, runId: string) => {
            if (dispatches.length === 0) {
              expect(generatedChecks).not.toHaveBeenCalled();
            }
            waitedRuns.push(runId);
            return {
              run: { headSha: mismatchedRun ? "d".repeat(40) : targetSha, runAttempt: 1 },
              source: { workflowRef: options.workflowRef },
            };
          },
          downloadArtifact: (_repo: string, _runId: string, name: string, artifactDir: string) => {
            if (sdkReport && name.startsWith("plugin-sdk-api-release-diff-")) {
              mkdirSync(artifactDir, { recursive: true });
              writeFileSync(
                join(artifactDir, "plugin-sdk-api-release-diff.md"),
                "# Plugin SDK API diff\n\nlatest: v2026.8.1 → fixture\n\nAcknowledgement digest: `f4b495f3`\n\n## Exports added (1)\n\n- `openclaw/plugin-sdk` — `send`\n",
              );
            }
          },
          readJson: (file: string) =>
            file === statePath || file.endsWith("frv-request.json")
              ? JSON.parse(readFileSync(file, "utf8"))
              : file.endsWith("preflight-manifest.json")
                ? npmManifest
                : file.endsWith("full-release-validation-manifest.json")
                  ? fullManifest
                  : sdkEvidence,
          authenticateFullReleaseValidationEvidence: async (identity: {
            expectedTargetSha: string;
            expectedReleaseTag: string;
          }) => {
            expect(identity).toMatchObject({
              expectedTargetSha: targetSha,
              expectedReleaseTag: tag,
            });
            if (registryAdmission && failedRegistry) {
              throw new Error(`${failedRegistry} registry unavailable`);
            }
            return authenticatedEvidence;
          },
          downloadResolvedArtifact: async () => ({ name: "npm-preflight" }),
          verifyNpmPreflightProducer: () => ({}),
          isDeepStrictEqual,
          sha256: () => "fixture-digest",
          validatePreflightManifest: () => {},
          findPluginSdkApiReleaseNoteOmissions,
          validatePluginSdkApiReleaseEvidence,
          PluginSdkApiAcknowledgementError,
          stripLeadingPackageManagerSeparator,
          validateFullManifest: () => {},
          preflightCorePackageTarballs,
          preflightDependencyTarballs,
          runParallelsIfNeeded: async () => ({ status: "skipped" }),
          runTelegramIfNeeded: async () =>
            telegramRunId ? { status: "passed", runId: telegramRunId } : { status: "skipped" },
          collectPluginPlanWithRetry: async (script: string) => {
            expect(generatedChecks).toHaveBeenCalledOnce();
            if (registryAdmission) {
              throw new Error("B must not perform a local registry sweep");
            }
            if (routingError || stopAtRegistry) {
              throw new Error(`fixture registry-plan sentinel: ${script}`);
            }
            return { all: [] };
          },
          buildPrepareCommand: publishCommand,
          runReleasePublishPreflight: preflight,
          formatReleasePublishPreflight,
          formatJsonValue: String,
          formatShippedBaselineExclusions: () => "",
          formatPluginPlanSummary: () => [],
          basename,
          mkdirSync,
          writeFileSync,
        },
      );
      if (sdkAcknowledgement !== undefined && sdkAcknowledgement !== "f4b495f3") {
        const error = await completion.catch((cause: Error) => cause);
        expect(error.message).toContain(
          "Plugin SDK API changes require acknowledgement digest f4b495f3",
        );
        if (sdkReport) {
          expect(error.message).toContain("## Exports added (1)");
          expect(error.message).toContain("- `openclaw/plugin-sdk` — `send`");
        } else {
          expect(error.message).toContain(
            "Review the Plugin SDK API diff artifact before rerunning.",
          );
        }
        const command = error.message.split("\n").at(-1);
        const decoded = execFileSync(
          "bash",
          ["-c", `pnpm() { printf '%s\\0' "$@"; }\n${command}`],
          { encoding: "utf8", timeout: 10_000 },
        )
          .split("\0")
          .filter(Boolean);
        expect(decoded.slice(0, 2)).toEqual(["release:candidate", "--"]);
        expect(parseArgs(decoded.slice(2))).toEqual({
          ...parseArgs(candidateArgv),
          pluginSdkApiAcknowledgement: "f4b495f3",
        });
        expect(generatedChecks).not.toHaveBeenCalled();
        expect(preflight).not.toHaveBeenCalled();
        expect(publishCommand).not.toHaveBeenCalled();
        return;
      }
      const badTooling = Boolean(workflowSha && workflowSha !== toolingSha);
      const expectedError = changelogFailure
        ? "candidate changelog rejected"
        : mismatchedRun
          ? "run SHA mismatch"
          : generatedFailure
            ? "fixture generated-check failure"
            : badTooling
              ? `--workflow-sha ${workflowSha} does not match tooling checkout ${toolingSha}`
              : routingError ||
                (stopAtRegistry
                  ? launch === "mismatch"
                    ? "release candidate state mismatch for targetSha"
                    : "fixture registry-plan sentinel: scripts/plugin-npm-release-plan.ts"
                  : failedRegistry
                    ? `${failedRegistry} registry unavailable`
                    : "");
      if (expectedError) {
        await expect(completion).rejects.toThrow(expectedError);
        expect(preflight).not.toHaveBeenCalled();
        expect(publishCommand).not.toHaveBeenCalled();
        expect(existsSync(join(options.outputDir, "release-candidate-evidence.json"))).toBe(false);
        if (badTooling || routingError || launch === "mismatch") {
          expect(writeState).not.toHaveBeenCalled();
          expect(updateState).not.toHaveBeenCalled();
          expect(waitedRuns).toEqual([]);
        }
        if (badTooling) {
          expect(ensureToolingTag).not.toHaveBeenCalled();
        }
        if (stopAtRegistry && launch === "saved-full") {
          expect(waitedRuns).toEqual(["333", "444"]);
        } else if (!failedRegistry) {
          expect(dispatches).toEqual([]);
          expect(generatedChecks).toHaveBeenCalledTimes(generatedFailure ? 1 : 0);
        }
        if (savedState) {
          expect(readFileSync(statePath, "utf8")).toBe(JSON.stringify(savedState));
        }
        return;
      }
      if (preflightFailure) {
        await expect(completion).rejects.toThrow("Publish preflight failed");
      } else {
        await completion;
      }
      const evidence = JSON.parse(
        readFileSync(join(options.outputDir, "release-candidate-evidence.json"), "utf8"),
      );
      if (savedToolingSha) {
        // Repaired tooling resumes the same state with its own publication tag.
        expect(options.publishWorkflowRef).toBe(publishWorkflowRef);
        expect(ensureToolingTag).toHaveBeenCalledOnce();
        expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
          toolingSha,
          publishWorkflowRef,
          fullReleaseRunId: savedState?.fullReleaseRunId,
        });
      }
      if (telegramRunId) {
        expect(evidence.npmTelegram).toMatchObject({ status: "passed", runId: telegramRunId });
        expect(evidence.prepareCommand ?? evidence.publishCommand).not.toContain(
          "npm_telegram_run_id",
        );
      }
      if (launch === "npm-only") {
        expect(dispatches).toHaveLength(1);
        const dispatched = expectDefined(dispatches[0], "FRV dispatch");
        expect(dispatched[dispatched.indexOf("--target-ref") + 1]).toBe(releaseBranchForTag(tag));
        expect(dispatched).toEqual(
          expect.arrayContaining([
            "--sha",
            targetSha,
            "--workflow-sha",
            targetSha,
            "--trusted-workflow-ref",
            "candidate",
            "--admission-workflow-sha",
            toolingSha,
            "--admission-workflow-ref",
            options.publishWorkflowRef || options.workflowRef,
            "--request-file",
            join(options.outputDir, "frv-request.json"),
            "validation_purpose=publish",
          ]),
        );
        const selection = dispatched.find((arg) => arg.startsWith("publication_selection_json="));
        expect(JSON.parse(selection!.slice("publication_selection_json=".length))).toMatchObject({
          route: publicationRoute,
          npmDistTag: options.npmDistTag,
          publishOpenclawNpm: true,
          pluginPublishScope: "all-publishable",
          plugins: [],
        });
        expect(evidence.publicationRoute).toBe(publicationRoute);
        expect(
          evidence[publicationRoute === "prepared" ? "publishCommand" : "prepareCommand"],
        ).toBeUndefined();
      }
      expect(waitedRuns).toEqual(["111", "222"]);
      expect(
        readFileSync(join(options.outputDir, "release-candidate-evidence.md"), "utf8"),
      ).toContain(tag);
      const output = log.mock.calls.map(([line]) => line).join("\n");
      if (workflowSha) {
        // A resumed candidate keeps its recorded tag even though a newer tag exists at the SHA.
        const reusedToolingTag =
          savedToolingTag && (!savedToolingSha || savedToolingSha === toolingSha);
        const toolingTag = reusedToolingTag ? savedToolingTag : publishWorkflowRef;
        expect(JSON.parse(readFileSync(statePath, "utf8")).publishWorkflowRef).toBe(toolingTag);
        expect(evidence.publishWorkflowIdentity).toMatchObject({
          workflowRef: toolingTag,
          workflowSha: toolingSha,
        });
      } else {
        expect(ensureToolingTag).not.toHaveBeenCalled();
      }
      expect(evidence.publishPreflight.failed).toBe(preflightFailure);
      if (publicationRoute === "prepared") {
        expect(evidence.publishPreflight.command).toBe(evidence.prepareCommand);
        expect(output).not.toContain("openclaw-release-publish.yml");
      }
      if (preflightFailure) {
        expect(output).not.toContain("direct publication / recovery command:");
        expect(output).not.toContain("prepare once for the release button");
        expect(updateState).not.toHaveBeenCalledWith(statePath, expect.anything(), "completed");
        return;
      }
      expect(updateState).toHaveBeenCalledWith(statePath, expect.anything(), "completed");
      if (tag.includes("-beta.")) {
        expect(evidence.androidVersionCheck).toBeUndefined();
        return;
      }
      expect(evidence.androidVersionCheck).toMatchObject({
        status: expected,
        androidVersion: pin,
        targetVersion: "2026.9.1",
      });
    },
  );

  it.each([
    "isolated graph",
    "install failure",
    "child failure",
    "worktree removal failure",
    "pinned ancestor",
    "untrusted SHA",
    "candidate SHA",
  ])("prepares and cleans trusted tooling dependencies: %s", (scenario) => {
    const manifest = { version: "2026.9.1", dependencies: { yaml: "2.8.1" } };
    const { root: targetRoot, git } = candidateGitFixture({
      ".gitignore": "node_modules\n",
      "package.json": JSON.stringify(manifest),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "scripts/release-candidate-checklist.mts": [
        'import { parse } from "yaml";',
        'console.log(JSON.stringify({ parsed: parse("ready: true"), cwd: process.cwd() }));',
        'if (process.argv.includes("--fail")) process.exit(7);',
      ].join("\n"),
    });
    const trustedToolingSha = git("rev-parse", "HEAD");
    // The tooling worktree never borrows the target graph, even for a version-only target commit.
    writeFileSync(
      join(targetRoot, "package.json"),
      JSON.stringify({ ...manifest, version: "2026.9.2" }),
    );
    writeFileSync(join(targetRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# changed\n");
    git("commit", "-am", "test: target differs from tooling");
    expect(git("rev-parse", "HEAD")).not.toBe(trustedToolingSha);
    const latestToolingSha = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", latestToolingSha);
    const workflowSha =
      scenario === "pinned ancestor"
        ? trustedToolingSha
        : scenario === "untrusted SHA"
          ? git("commit-tree", "HEAD^{tree}", "-m", "test: unrelated tooling")
          : scenario === "candidate SHA"
            ? (git("commit", "--allow-empty", "-m", "test: release candidate"),
              git("rev-parse", "HEAD"))
            : "";
    const installedModules = realpathSync("node_modules");
    symlinkSync(installedModules, join(targetRoot, "node_modules"), "junction");
    const ancestry = readFileSync("scripts/lib/release-candidate-changelog.mts", "utf8")
      .match(/^export function gitIsAncestor\([\s\S]*?^\}/mu)?.[0]
      .replace(/^export /u, "");
    const cleanupWarning = vi.fn();
    let toolingRoot = "";
    let toolingAdminDir = "";
    const installs = vi.fn(
      (_command: string, args: string[], options: Parameters<typeof run>[2]) => {
        expect(args).toEqual([
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--prefer-offline",
        ]);
        const root = options?.cwd ?? "";
        toolingRoot = root;
        toolingAdminDir = run("git", ["rev-parse", "--absolute-git-dir"], {
          cwd: root,
          capture: true,
        }).trim();
        expect(root).not.toBe(targetRoot);
        expect(existsSync(join(root, "node_modules"))).toBe(false);
        expect(run("git", ["rev-parse", "HEAD"], { cwd: root, capture: true }).trim()).toBe(
          trustedToolingSha,
        );
        if (scenario === "install failure") {
          throw new Error("fixture install failed");
        }
        // Stand in for pnpm's output; never install or modify the shared ready install.
        mkdirSync(join(root, "node_modules"));
        for (const dependency of ["tsx", "yaml"]) {
          symlinkSync(
            join(installedModules, dependency),
            join(root, "node_modules", dependency),
            "junction",
          );
        }
        return "";
      },
    );
    let childOutput = "";
    const execute = () =>
      runInNewContext(
        stripNodeTypeScriptTypes(
          `${checklistFunctions("readJson", "runFromTrustedTooling")}\n${ancestry}\nrunFromTrustedTooling(argv, { targetRoot, workflowRef: "main", workflowSha });`,
        ),
        {
          existsSync,
          mkdirSync,
          mkdtempSync,
          readFileSync,
          rmSync: (...args: Parameters<typeof rmSync>) => {
            rmSync(...args);
            if (scenario === "child failure") {
              throw new Error("fixture cleanup failed");
            }
          },
          symlinkSync,
          createRequire,
          pathToFileURL,
          tmpdir,
          join,
          isRecord,
          process,
          console: { ...console, warn: cleanupWarning },
          targetRoot,
          workflowSha,
          argv: [scenario === "child failure" ? "--fail" : "--help"],
          TRUSTED_TOOLING_SHA_ENV: "OPENCLAW_RELEASE_CANDIDATE_TRUSTED_TOOLING_SHA",
          fetchTrustedWorkflowSha: () => (workflowSha ? latestToolingSha : trustedToolingSha),
          run: (command: string, args: string[], options: Parameters<typeof run>[2]) =>
            command === "pnpm" ? installs(command, args, options) : run(command, args, options),
          spawnSync: (
            command: string,
            args: string[],
            options: Parameters<typeof spawnSync>[2],
          ) => {
            if (
              scenario === "worktree removal failure" &&
              command === "git" &&
              args[0] === "worktree"
            ) {
              return { status: 1, stderr: "fixture worktree removal failed" };
            }
            if (command === process.execPath) {
              const entrypoint = args[2];
              if (!entrypoint) {
                throw new Error("missing trusted tooling entrypoint");
              }
              toolingRoot = dirname(dirname(entrypoint));
              const child = spawnSync(command, args, {
                ...options,
                encoding: "utf8",
                stdio: "pipe",
              });
              childOutput = child.stdout;
              return child;
            }
            return spawnSync(command, args, options);
          },
        },
      );
    if (scenario === "untrusted SHA" || scenario === "candidate SHA") {
      expect(execute).toThrow(`--workflow-sha ${workflowSha} is not reachable from trusted main.`);
      expect(installs).not.toHaveBeenCalled();
      expect(git("worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
      return;
    }
    if (scenario === "install failure") {
      expect(execute).toThrow("fixture install failed");
    } else if (scenario === "child failure") {
      expect(execute).toThrow("trusted release candidate tooling failed with 7");
      expect(cleanupWarning).toHaveBeenCalledWith(
        expect.stringContaining("fixture cleanup failed"),
      );
    } else {
      execute();
      expect(JSON.parse(childOutput)).toEqual({ parsed: { ready: true }, cwd: targetRoot });
    }
    expect(installs).toHaveBeenCalledTimes(1);
    if (scenario === "worktree removal failure") {
      try {
        expect(cleanupWarning).toHaveBeenCalledWith(
          expect.stringContaining("fixture worktree removal failed"),
        );
        expect(existsSync(join(toolingRoot, ".git"))).toBe(true);
        expect(existsSync(toolingAdminDir)).toBe(true);
        expect(git("worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(2);
      } finally {
        if (existsSync(join(toolingRoot, ".git"))) {
          git("worktree", "remove", "--force", toolingRoot);
        } else {
          git("worktree", "prune");
        }
        rmSync(dirname(toolingRoot), { force: true, recursive: true });
      }
    } else if (toolingRoot) {
      expect(existsSync(dirname(toolingRoot))).toBe(false);
      expect(existsSync(toolingAdminDir)).toBe(false);
    }
    if (scenario !== "child failure" && scenario !== "worktree removal failure") {
      expect(cleanupWarning).not.toHaveBeenCalled();
    }
    expect(git("worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
    expect(existsSync(join(installedModules, "yaml"))).toBe(true);
  });

  it("keeps plugin plan warnings advisory and visible", () => {
    const warning = "example-runtime is behind npm latest";
    const plan = { all: [{ packageName: "@openclaw/example" }], warnings: [warning] };
    const log = vi.fn();
    const result = runInNewContext(
      stripNodeTypeScriptTypes(
        `${checklistFunctions("formatPluginPlanSummary", "collectPluginPlan")}\ncollectPluginPlan("scripts/plugin-npm-release-plan.ts", { pluginPublishScope: "all-publishable" })`,
      ),
      {
        TOOLING_ROOT: "/trusted/tooling",
        console: { log },
        isRecord,
        join,
        run: () => JSON.stringify(plan),
      },
    );
    expect(result).toEqual(plan);
    expect(log).toHaveBeenCalledWith(
      "- scripts/plugin-npm-release-plan.ts: 1 packages\n- Warning: " + warning,
    );
  });

  it.each(["v2026.9.1"])("refuses to print a main-sourced publish command for %s", (tag) => {
    const options = parseArgs(["--tag", tag]);
    const producer = { status: "passed", headSha: "a".repeat(40), workflowRef: "main" };
    for (const source of [undefined, producer]) {
      expect(() => buildPrepareCommand(options, source)).toThrow(
        "--publish-workflow-ref release-publish/<sha12>-<epoch>",
      );
      expect(buildPrepareCommand({ ...options, publishWorkflowRef }, source)).toContain(
        `'--ref' '${publishWorkflowRef}'`,
      );
    }
  });

  it("recognizes direct execution through a symlinked temporary root", () => {
    const realpath = vi.fn((value: string) => value.replace(/^\/tmp\//u, "/private/tmp/"));

    expect(
      isDirectReleaseCandidateExecution(
        "/tmp/openclaw-release-tooling/checkout/scripts/release-candidate-checklist.mts",
        "/private/tmp/openclaw-release-tooling/checkout/scripts/release-candidate-checklist.mts",
        realpath,
      ),
    ).toBe(true);
    expect(isDirectReleaseCandidateExecution(undefined, "/private/tmp/script.mjs", realpath)).toBe(
      false,
    );
  });

  it.each<[string, Record<string, unknown>]>([
    [`--tag v2026.7.1-beta.4 --target-sha ${"a".repeat(40)}`, { targetSha: "a".repeat(40) }],
    ["--tag v2026.5.14-beta.3", { workflowRef: "main" }],
    [
      "--tag v2026.5.14-beta.3 --run-parallels",
      { parallelsMode: "run", parallelsSkipReason: "", skipParallels: false },
    ],
    ["--tag v2026.5.14", { parallelsMode: "auto", parallelsSkipReason: "", skipParallels: false }],
    [
      "--tag v2026.5.14 --release-profile full",
      { parallelsMode: "auto", parallelsSkipReason: "", skipParallels: false },
    ],
    [
      "--tag v2026.7.1-beta.3 --parallels-registry-package-artifact /tmp/codex --parallels-registry-package-artifact /tmp/matrix",
      { parallelsRegistryPackageArtifactDirs: ["/tmp/codex", "/tmp/matrix"] },
    ],
    [
      "--tag v2026.5.14-beta.3 -- --plugin-publish-scope selected",
      { pluginPublishScope: "all-publishable" },
    ],
    [
      "-- --tag v2026.5.14-beta.3 --skip-parallels",
      { tag: "v2026.5.14-beta.3", skipParallels: true },
    ],
  ])("parses candidate options %s", (flags, expected) => {
    expect(parseArgs(flags.split(" "))).toMatchObject(expected);
  });

  it("accepts absent and exact lightweight or annotated tags, rejecting mismatches and lookup errors", () => {
    const { root, git } = candidateGitFixture({ "package.json": "{}" });
    git("remote", "add", "origin", root);
    const targetSha = git("rev-parse", "HEAD");
    expect(() => assertReleaseCandidateTag("v2026.7.1-beta.4", targetSha, root)).not.toThrow();
    git("tag", "v2026.7.1-beta.4");
    git("-c", "tag.gpgSign=false", "tag", "-a", "v2026.7.1-beta.5", "-m", "candidate");
    for (const tag of ["v2026.7.1-beta.4", "v2026.7.1-beta.5"]) {
      expect(() => assertReleaseCandidateTag(tag, targetSha, root)).not.toThrow();
      expect(() => assertReleaseCandidateTag(tag, "f".repeat(40), root)).toThrow("expected");
    }
    git("remote", "set-url", "origin", join(root, "missing-origin"));
    expect(() => assertReleaseCandidateTag("v2026.7.1-beta.4", targetSha, root)).toThrow(
      "could not resolve release candidate tag",
    );
  });

  it("rejects stale or conflicting release candidate state", () => {
    const expected = candidateState();

    expect(() =>
      reconcileReleaseCandidateState({ ...expected, targetSha: "c".repeat(40) }, expected),
    ).toThrow("state mismatch for targetSha");
    expect(() =>
      reconcileReleaseCandidateState(
        { ...expected, fullReleaseRunId: "111" },
        { ...expected, fullReleaseRunId: "333" },
      ),
    ).toThrow("state mismatch for fullReleaseRunId");
  });

  it.each(["unbound", "retained request", "full run", "npm run", "later phase"])(
    "updates candidate planning flags only before qualification is bound: %s",
    (scenario) => {
      const saved = candidateState();
      const expected = {
        ...saved,
        skipParallels: true,
        windowsNodeTag: "v0.6.3",
        toolingSha: scenario === "unbound" ? "c".repeat(40) : saved.toolingSha,
      };
      if (scenario === "full run") {
        saved.fullReleaseRunId = "111";
      }
      if (scenario === "npm run") {
        saved.npmPreflightRunId = "222";
      }
      if (scenario === "later phase") {
        saved.phase = "waiting";
      }
      const reconcile = () =>
        reconcileReleaseCandidateState(saved, expected, scenario === "retained request");
      if (scenario === "unbound") {
        expect(reconcile()).toEqual(expected);
      } else {
        expect(reconcile).toThrow("release candidate state mismatch");
      }
    },
  );

  it.each([
    {
      name: "captures changelogs larger than the Node spawnSync default buffer",
      script: "process.stdout.write('x'.repeat(2 * 1024 * 1024))",
      env: undefined,
      expectedLength: 2 * 1024 * 1024,
    },
    {
      name: "passes scoped environment overrides to release child commands",
      script: "process.stdout.write(process.env.OPENCLAW_RELEASE_TEST_VALUE ?? '')",
      env: { OPENCLAW_RELEASE_TEST_VALUE: "passed" },
      expected: "passed",
    },
  ])("$name", ({ script, env, expected, expectedLength }) => {
    const output = run(process.execPath, ["-e", script], { capture: true, env });
    if (expectedLength !== undefined) {
      expect(output).toHaveLength(expectedLength);
    } else {
      expect(output).toBe(expected);
    }
  });

  it("keeps the frozen release target separate from clean trusted workflow tooling", () => {
    const checkout = {
      targetSha: "a".repeat(40),
      targetHeadSha: "a".repeat(40),
      targetTrackedStatus: "",
      toolingSha: "b".repeat(40),
      trustedToolingSha: "b".repeat(40),
      toolingTrackedStatus: "",
      workflowRef: "main",
    };
    expect(validateCandidateCheckout(checkout)).toEqual({
      status: "passed",
      targetSha: checkout.targetSha,
      toolingSha: checkout.toolingSha,
      workflowRef: "main",
    });
    const rejections = [
      [{ targetHeadSha: "c".repeat(40) }, "target worktree HEAD"],
      [{ targetTrackedStatus: " M package.json" }, "clean tracked target worktree"],
      [{ trustedToolingSha: "c".repeat(40) }, "does not match trusted main"],
      [
        { toolingTrackedStatus: " M scripts/release-candidate-checklist.mts" },
        "clean tracked tooling checkout",
      ],
    ] as const;
    for (const [override, error] of rejections) {
      expect(() => validateCandidateCheckout({ ...checkout, ...override })).toThrow(error);
    }
  });

  it("keeps the exact pinned trusted tooling valid when main advances", () => {
    const isAncestor = vi.fn(() => true);
    const pin = {
      toolingSha: "a".repeat(40),
      pinnedToolingSha: "a".repeat(40),
      latestTrustedToolingSha: "b".repeat(40),
      isAncestor,
    };
    expect(validateTrustedToolingPin(pin)).toBe(pin.toolingSha);
    expect(isAncestor).toHaveBeenCalledWith("a".repeat(40), "b".repeat(40));
    expect(() => validateTrustedToolingPin({ ...pin, pinnedToolingSha: "b".repeat(40) })).toThrow(
      "does not match pinned tooling",
    );
    expect(() => validateTrustedToolingPin({ ...pin, isAncestor: () => false })).toThrow(
      "pinned release candidate tooling",
    );
  });

  it.each([
    [false, true],
    [true, true],
    [true, false],
  ])("checks catalogue skew (candidate extra=%s, latest extra=%s)", (extra, supported) => {
    const catalog = (withExtra: boolean) =>
      scenarioCatalog(withExtra ? ["base", "extra"] : ["base"], "2026.6.34");
    const pinned = "a".repeat(40);
    const latest = "b".repeat(40);
    const check = () =>
      validateReleaseScenarioCatalogCompatibility({
        candidateCatalog: catalog(extra),
        toolingCatalog: catalog(!extra),
        latestTrustedToolingCatalog: catalog(supported),
        toolingSha: pinned,
        latestTrustedToolingSha: latest,
        workflowRef: "main",
      });
    if (extra) {
      expect(check).toThrow(
        supported
          ? `Pinned release tooling ${pinned} cannot consume candidate upgrade-survivor scenarios: extra. Trusted main tooling ${latest} supports this catalogue; rerun with --workflow-sha ${latest}.`
          : `Trusted main tip ${latest} also lacks support; land the catalogue consumer before qualifying this candidate.`,
      );
    } else {
      expect(check()).toEqual({ status: "passed", unsupported: [] });
    }
  });

  it("validates the exact tag changelog before dispatching the release matrix", () => {
    const check = validateCandidateReleaseNotes({
      changelog: candidateChangelog("", [`- **PR #123** ${"record ".repeat(20_000)}`]).replace(
        "## 2026.7.1",
        "## 2026.7.1-beta.3",
      ),
      repository: "openclaw/openclaw",
      tag: "v2026.7.1-beta.3",
    });
    expect(() =>
      validateCandidateReleaseNotes({
        changelog: "## 2026.7.1\n\n- Cumulative stale notes.",
        repository: "openclaw/openclaw",
        tag: "v2026.7.1-beta.3",
      }),
    ).toThrow("does not contain ## 2026.7.1-beta.3");
    expect(check).toMatchObject({ status: "passed", mode: "compact" });
  });

  it("rejects contribution-record provenance outside the release tag history", () => {
    const base = "v2026.6.11";
    const recordedTarget = "a".repeat(40);
    const targetSha = "b".repeat(40);
    const changelog = candidateChangelog(
      `This audited record covers the complete ${base}..${recordedTarget} history: 1 merged PR.`,
      ["- **PR #123** fix: example."],
    );
    const reachable = vi.fn((ancestor: string, target: string) => {
      return ancestor === base && target === recordedTarget;
    });

    expect(() => checkProvenance(changelog, { targetSha, isAncestor: reachable })).toThrow(
      `contribution record target ${recordedTarget} is not reachable`,
    );
  });

  it.each([
    {
      name: "duplicate contribution rows even when the declared count matches",
      count: "1 merged PR.",
      rows: ["- **PR #123** fix: example.", "- **PR #123** fix: duplicate."],
      error: "duplicate contribution record PR #123",
    },
    {
      name: "canonical provenance whose unique total does not match the PR rows",
      count: "1 in-range PR + 1 retained seed-only PR = 2 unique PRs.",
      rows: ["- **PR #123** fix: example."],
      error: "contribution record row count 1 != 2",
    },
  ])("rejects $name", ({ count, rows, error }) => {
    const targetSha = "b".repeat(40);
    const changelog = candidateChangelog(
      `This audited record covers the complete base..${targetSha} history: ${count}`,
      rows,
    );

    expect(() => checkProvenance(changelog, { targetSha })).toThrow(error);
  });

  it("uses numbered historical record rows and skips Unreleased baseline rows", () => {
    const section = (version: string, count: number, row: string) =>
      candidateChangelog(
        `This audited record covers the complete base..HEAD history: ${count} merged PRs.`,
        [row],
      ).replace("## 2026.7.1", `## ${version}`);
    const changelog = `${section("Unreleased", 99, "- **PR #1** fix: not shipped.")}\n\n${section("2026.6.11", 0, "- **PR #2** fix: shipped.")}`;

    expect([...candidateCumulativeShippedPullRequests(changelog, "test baseline")]).toEqual([2]);
  });

  it("validates cumulative shipped baseline exclusion metadata", () => {
    const base = "66e676d29b92d040716376a75aca32bad655cfac";
    const recordedTarget = "a".repeat(40);
    const changelog = candidateChangelog(
      `This audited record covers the complete ${base}..${recordedTarget} history: 1 merged PR.`,
      ["- **PR #123** fix: example."],
      "Shipped baseline exclusions: v2026.6.11 (2 PRs: #101, #102).",
    );
    const shippedPullRequests = new Set([101, 102]);
    const loadShippedBaseline = vi.fn(() => ({
      ref: "v2026.6.11",
      pullRequests: shippedPullRequests,
    }));
    const validate = (
      source = changelog,
      loader: Parameters<
        typeof validateCandidateChangelogProvenance
      >[0]["loadShippedBaseline"] = loadShippedBaseline,
    ) => checkProvenance(source, { targetSha: recordedTarget, loadShippedBaseline: loader });
    expect(validate()).toEqual({
      status: "passed",
      base,
      target: recordedTarget,
      shippedBaselines: [
        {
          ref: "v2026.6.11",
          count: 2,
          pullRequests: [101, 102],
        },
      ],
    });
    expect(() => validate(changelog.replace("2 PRs:", "2 pull requests:"))).toThrow(
      "malformed shipped baseline exclusion",
    );
    expect(() =>
      validate(changelog, () => ({
        ref: "v2026.6.11",
        pullRequests: new Set([...shippedPullRequests].slice(1)),
      })),
    ).toThrow("lists PRs absent from shipped baseline v2026.6.11: #101");
    expect(() =>
      validate(
        changelog.replace("- **PR #123** fix: example.", "- **PR #101** fix: already shipped."),
      ),
    ).toThrow("still contains shipped PRs from v2026.6.11: #101");
  });

  it("requires contribution records for beta candidates", () => {
    const betaChangelog = "# Changelog\n\n## 2026.7.1\n\n### Highlights\n\n- User-facing notes.";
    expect(() => checkProvenance(betaChangelog)).toThrow(
      "missing ### Complete contribution record",
    );
  });

  it("defaults beta Parallels to postpublish confidence", () => {
    const beta = parseArgs(["--tag", "v2026.5.14-beta.3"]);
    expect(beta).toMatchObject({
      releaseProfile: "beta",
      parallelsMode: "auto",
      skipParallels: true,
      parallelsSkipReason: "deferred to postpublish release:beta-smoke",
    });
  });

  it("runs Parallels against the exact prepared candidate tarball with the candidate harness", async () => {
    const command = candidateParallelsShellCommand(
      ".artifacts/preflight/openclaw candidate.tgz",
      "/opt/homebrew/bin/gtimeout",
      [],
      [],
      "",
      "/candidate",
    );
    expect(command).toContain(
      `set -a; source "$HOME/.profile" >/dev/null 2>&1 || true; set +a; export PATH='${dirname(process.execPath)}':"$PATH"; exec '/opt/homebrew/bin/gtimeout' --foreground 150m pnpm`,
    );
    expect(command).toContain("'/candidate/scripts/e2e/parallels/npm-update-smoke.ts'");
    expect(command).not.toMatch(
      /--dependency-tarball|--registry-package-tarball|--macos-snapshot-hint/u,
    );
    expect(
      candidateParallelsShellCommand(
        ".artifacts/preflight/openclaw candidate.tgz",
        "/opt/homebrew/bin/gtimeout",
        ["ai candidate.tgz"],
        ["codex candidate.tgz"],
        "macOS 26.5 Node 24",
        "/candidate",
      ),
    ).toContain(
      "'--target-tarball' '.artifacts/preflight/openclaw candidate.tgz' '--dependency-tarball' 'ai candidate.tgz' '--registry-package-tarball' 'codex candidate.tgz' '--macos-snapshot-hint' 'macOS 26.5 Node 24' '--json'",
    );
    const caller = checklistSource.match(
      /const parallels = await runParallelsIfNeeded\([\s\S]*?\);/u,
    )?.[0];
    const runLocal = vi.fn(() => "/opt/homebrew/bin/gtimeout");
    await runInNewContext(
      stripNodeTypeScriptTypes(
        `async function fixture() {\n${checklistFunctions("runParallelsIfNeeded")}\n${caller}\n}\nfixture();`,
      ),
      {
        options: parseArgs(["--tag", "v2026.9.1"]),
        tarballPath: ".artifacts/preflight/openclaw candidate.tgz",
        dependencyTarballPaths: [],
        revalidatedRegistryArtifacts: [],
        targetRoot: "/candidate",
        TOOLING_ROOT: "/trusted/tooling",
        candidateParallelsShellCommand,
        run: runLocal,
        process,
        join,
      },
    );
    expect(runLocal).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringContaining("'/candidate/scripts/e2e/parallels/npm-update-smoke.ts'")],
      {
        cwd: "/candidate",
        env: { OPENCLAW_PARALLELS_ARTIFACT_ROOT: "/candidate/.artifacts/parallels" },
      },
    );
  });

  it("binds Parallels registry packages to plugin preflight manifests", () => {
    const artifactDir = tempDirs.make("openclaw-plugin-preflight-");
    const tarballName = "openclaw-codex-2026.7.1-beta.3.tgz";
    const tarballPath = join(artifactDir, tarballName);
    const sourceDir = join(artifactDir, "source");
    const packageDir = join(sourceDir, "package");
    const pack = (name: string) => {
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        `${JSON.stringify({ name, version: "2026.7.1-beta.3" })}\n`,
      );
      execFileSync("tar", ["-czf", tarballPath, "-C", sourceDir, "package"]);
      rmSync(sourceDir, { force: true, recursive: true });
      return createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
    };
    const tarballSha256 = pack("@openclaw/codex");
    const manifestPath = join(artifactDir, "plugin-publication-manifest.json");
    const manifest = {
      schema: "openclaw.plugin-publication-artifact/v1",
      schemaVersion: 1,
      targetSha: "candidate-sha",
      package: { name: "@openclaw/codex", version: "2026.7.1-beta.3" },
      artifact: {
        name: "plugin-npm-package-codex",
        tarball: tarballName,
        sha256: tarballSha256,
      },
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    const validate = () =>
      validateParallelsRegistryPackageArtifact(artifactDir, {
        targetSha: "candidate-sha",
        targetVersion: "2026.7.1-beta.3",
      });
    expect(validate()).toMatchObject({
      artifactName: "plugin-npm-package-codex",
      packageName: "@openclaw/codex",
      packageVersion: "2026.7.1-beta.3",
      tarballPath,
      tarballSha256,
    });
    const mismatchedSha256 = pack("@openclaw/matrix");
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        ...manifest,
        artifact: { ...manifest.artifact, sha256: mismatchedSha256 },
      })}\n`,
    );
    expect(validate).toThrow("tarball identity mismatch");
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, targetSha: "other-sha" })}\n`);
    expect(validate).toThrow("artifact identity is invalid");
  });

  it("requires exact dependency tarball metadata in npm preflight manifests", () => {
    const aiTarball = coreTarball("ai");
    const validate = (dependencyTarballs: unknown) =>
      validatePreflightManifest(preflightManifest({ dependencyTarballs }), preflightIdentity);
    expect(() => validate([aiTarball])).not.toThrow();
    expect(() => validate(undefined)).toThrow("missing dependency tarball metadata");
    expect(() => validate([{ ...aiTarball, tarballName: "../openclaw-ai.tgz" }])).toThrow(
      "invalid dependency tarball metadata",
    );
  });

  it("prefers the complete core package tarball set with legacy manifest fallback", () => {
    const ai = coreTarball("ai");
    const core = [ai, coreTarball("gateway-protocol")];
    const select = (overrides: Parameters<typeof preflightCorePackageTarballs>[0] = {}) =>
      preflightCorePackageTarballs({ dependencyTarballs: [ai], ...overrides });
    expect(select({ corePackageTarballs: core })).toEqual(core);
    expect(select()).toEqual([ai]);
    expect(() => select({ corePackageTarballs: null })).toThrow(
      "missing dependency tarball metadata",
    );
  });

  it("passes only root dependency tarballs to Parallels with legacy fallback", () => {
    const aiTarball = coreTarball("ai");
    const gatewayProtocolTarball = coreTarball("gateway-protocol");
    const corePackageTarballs = [aiTarball, gatewayProtocolTarball];

    expect(
      preflightDependencyTarballs({
        corePackageTarballs,
        dependencyTarballs: [aiTarball],
      }),
    ).toEqual([aiTarball]);
    expect(preflightDependencyTarballs({ corePackageTarballs })).toEqual(corePackageTarballs);
    const manifest = preflightManifest({
      corePackageTarballs,
      dependencyTarballs: [aiTarball],
    });
    expect(() => validatePreflightManifest(manifest, preflightIdentity)).not.toThrow();
    expect(() =>
      validatePreflightManifest(
        {
          ...manifest,
          dependencyTarballs: [
            {
              ...aiTarball,
              tarballName: gatewayProtocolTarball.tarballName,
              tarballSha256: gatewayProtocolTarball.tarballSha256,
            },
          ],
        },
        preflightIdentity,
      ),
    ).toThrow("does not match the core package manifest");
    expect(() =>
      preflightDependencyTarballs({
        corePackageTarballs,
        dependencyTarballs: null,
      }),
    ).toThrow("missing dependency tarball metadata");
  });

  describe("npm preflight source", () => {
    const repo = "openclaw/openclaw";
    const headSha = "a".repeat(40);
    const protectedRef = "release-publish/aaaaaaaaaaaa-123";
    const workflowRun = {
      databaseId: 456,
      runAttempt: 2,
      repository: repo,
      workflowName: "OpenClaw NPM Release",
      workflowPath: ".github/workflows/openclaw-npm-release.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      headSha,
    };
    const tagRef = { ref: `refs/tags/${protectedRef}`, object: { type: "commit", sha: headSha } };
    const api = (tag: unknown = tagRef, branches: unknown = []) => ({
      token: "",
      fetchImpl: async (url: string) => {
        if (url.includes(`/repos/${repo}/git/ref/tags/`)) {
          return jsonResponse(tag);
        }
        if (url.includes(`/repos/${repo}/git/matching-refs/heads/`)) {
          return jsonResponse(branches);
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const validate = (
      override: Partial<typeof workflowRun> = {},
      apiOptions: Parameters<typeof validateNpmPreflightRunSource>[1] = api(),
      isTrustedWorkflowAncestor: (ancestor: string, target: string) => boolean = () => true,
    ) =>
      validateNpmPreflightRunSource(
        {
          repository: repo,
          runId: "456",
          workflowRef: "main",
          workflowRun: { ...workflowRun, ...override },
          isTrustedWorkflowAncestor,
        },
        apiOptions,
      );

    it("retains the exact trusted-main source", async () => {
      const ancestry = vi.fn(() => true);
      await expect(validate({}, api(), ancestry)).resolves.toEqual({
        status: "passed",
        headSha,
        workflowRef: "main",
      });
      expect(ancestry).toHaveBeenCalledWith(headSha, "refs/remotes/origin/main");
    });
    it("accepts a protected tag as the preparation source", async () => {
      const source = await validate({ headBranch: protectedRef });
      expect(source).toEqual({ status: "passed", headSha, workflowRef: protectedRef });
      expect(buildPrepareCommand(parseArgs(["--tag", "v2026.7.1-beta.3"]), source)).toContain(
        `'--ref' '${protectedRef}'`,
      );
    });
    it.each<[string, unknown, unknown, string]>([
      [
        "moved tag",
        { ...tagRef, object: { type: "commit", sha: "b".repeat(40) } },
        [],
        "protected release tooling tag",
      ],
      [
        "annotated tag",
        { ...tagRef, object: { type: "tag", sha: headSha } },
        [],
        "protected release tooling tag",
      ],
      ["missing tag", null, [], "protected release tooling tag"],
      ["same-name branch", tagRef, [{ ref: `refs/heads/${protectedRef}` }], "ambiguous"],
      ["non-array branches", tagRef, {}, "ambiguous"],
      ["malformed branch", tagRef, [{}], "ambiguous"],
    ])("rejects %s", async (_name, tag, branches, message) => {
      await expect(validate({ headBranch: protectedRef }, api(tag, branches))).rejects.toThrow(
        message,
      );
    });
    it("rejects unreadable tag provenance", async () => {
      await expect(
        validate(
          { headBranch: protectedRef },
          {
            token: "",
            fetchImpl: async () => jsonResponse({}, { status: 503 }),
          },
        ),
      ).rejects.toThrow("failed with 503");
    });
    it.each([
      { databaseId: 457 },
      { runAttempt: 0 },
      { repository: "other/openclaw" },
      { workflowName: "Other workflow" },
      { workflowPath: ".github/workflows/unrelated.yml" },
      { event: "push" },
      { status: "in_progress" },
      { conclusion: "failure" },
      { headSha: "not-a-sha" },
      { headBranch: "release/2026.7.1" },
      { headBranch: "release-publish/bbbbbbbbbbbb-123" },
      { headBranch: "release-publish/aaaaaaaaaaaa-0" },
      { workflowPath: ".github/workflows/openclaw-npm-release.yml@refs/heads/other" },
    ])("rejects mismatched workflow identity %j", async (override) => {
      await expect(validate(override)).rejects.toThrow();
    });
    it("rejects workflow code outside trusted main", async () => {
      await expect(validate({}, api(), () => false)).rejects.toThrow(
        "is not reachable from trusted main",
      );
    });
  });

  it("keeps release validation context on the canonical release branch", () => {
    expect(releaseBranchForTag("v2026.7.1-beta.4")).toBe("release/2026.7.1");
    expect(releaseBranchForTag("v2026.7.1")).toBe("release/2026.7.1");
    expect(releaseBranchForTag("v2026.7.1-1")).toBe("release/2026.7.1-1");
    expect(releaseBranchForTag("v2026.7.1-alpha.4")).toBe("");
  });

  it.each(["stable", "full"])(
    "requires soak but leaves performance advisory for %s",
    (releaseProfile) => {
      const manifest = {
        workflowName: "Full Release Validation",
        targetSha: "candidate-sha",
        releaseProfile,
        rerunGroup: "all",
        runReleaseSoak: "true",
        controls: { performanceBlocking: false },
        childRuns: { productPerformance: { conclusion: "failure" } },
      };
      const params = { targetSha: "candidate-sha", releaseProfile };
      expect(() => validateFullManifest(manifest, params)).not.toThrow();
      expect(() => validateFullManifest({ ...manifest, runReleaseSoak: "false" }, params)).toThrow(
        "runReleaseSoak=true",
      );
    },
  );

  it.each<
    [
      string,
      {
        coveragePolicy?: string;
        profile?: string;
        source?: string;
        separatePackage?: boolean;
        providerMode?: string;
        waived?: boolean;
        qualificationSha?: string;
        qualificationRef?: string;
        transport?: "missing" | "moved";
        returnedSha?: string;
      },
      string | RegExp,
    ]
  >([
    [
      "stable package proof",
      { coveragePolicy: "npm-stable-v1" },
      "covered-by-full-release-validation",
    ],
    ["beta deferral", { coveragePolicy: "npm-beta-v1", profile: "beta" }, "deferred-postpublish"],
    [
      "admitted full package proof",
      { profile: "full", source: "candidate-owned-admission-v1" },
      "covered-by-full-release-validation",
    ],
    ["historical full", { profile: "full" }, "passed"],
    [
      "separately packed bytes",
      { coveragePolicy: "npm-stable-v1", separatePackage: true },
      "passed",
    ],
    ["live provider", { coveragePolicy: "npm-stable-v1", providerMode: "live-frontier" }, "passed"],
    ["waiver", { coveragePolicy: "npm-stable-v1", waived: true }, "waived"],
    ["missing transport", { transport: "missing" }, /qualification ref/],
    ["moved transport", { transport: "moved" }, /qualification ref/],
    [
      "legacy Q differs from C",
      { qualificationSha: "a".repeat(40), qualificationRef: "release-ci/aaaaaaaaaaaa-123" },
      /candidate-owned Full Release Validation/,
    ],
    ["unfrozen main", { qualificationRef: "main" }, /candidate-owned Full Release Validation/],
    ["dispatch race", { returnedSha: "a".repeat(40) }, /Telegram qualification SHA mismatch/],
  ])("qualifies Telegram: %s", async (_name, scenario, outcome) => {
    const telegramOwner = checklistFunctions("runTelegramIfNeeded");
    const telegramCall = checklistSource.match(
      /const npmTelegram = await runTelegramIfNeeded\([\s\S]*?\);/u,
    )?.[0];
    expect(telegramCall).toBeDefined();
    const options = {
      ...parseArgs([
        "--tag",
        scenario.profile === "beta" ? "v2026.7.1-beta.1" : "v2026.7.1",
        "--release-profile",
        scenario.profile ?? "stable",
        "--workflow-sha",
        "b".repeat(40),
        "--telegram-provider-mode",
        scenario.providerMode ?? "mock-openai",
      ]),
      npmPreflightRunId: "222",
      publishWorkflowRef,
    };
    expect(options.workflowRef).toBe("main");
    const targetSha = "c".repeat(40);
    const qualificationRef = scenario.qualificationRef ?? "release-ci/cccccccccccc-123";
    const dispatchWorkflow = vi.fn(() => "333");
    const lookupQualificationRef = vi.fn(async () => {
      if (scenario.transport === "missing") {
        throw new Error("404 missing qualification ref");
      }
      return {
        ref: `refs/heads/${qualificationRef}`,
        object: {
          type: "commit",
          sha: scenario.transport === "moved" ? "d".repeat(40) : targetSha,
        },
      };
    });
    const waitForSuccessfulRun = vi.fn(async () => ({
      run: {
        headSha: scenario.returnedSha ?? targetSha,
        url: "https://github.com/openclaw/openclaw/actions/runs/333",
      },
    }));
    // Execute the private owner and its real caller without exporting a test-only API.
    const completion = runInNewContext(
      stripNodeTypeScriptTypes(
        `async function fixture() {\n${telegramOwner}\n${telegramCall}\nreturn npmTelegram;\n}\nfixture();`,
      ),
      {
        buildTelegramArtifactInputs,
        dispatchWorkflow,
        githubApi: lookupQualificationRef,
        isRecord,
        isShaPinnedReleaseValidationBranch,
        waitForSuccessfulRun,
        options,
        npmArtifact: {
          id: 9,
          name: "npm-package",
          digest: `sha256:${"a".repeat(64)}`,
          workflowRunId: 444,
        },
        npmManifest: {
          tarballName: "openclaw.tgz",
          tarballSha256: "b".repeat(64),
          packageVersion: options.tag.slice(1),
        },
        npmRun: { runAttempt: 1 },
        targetSha,
        npmUsesFullRun: !scenario.separatePackage,
        fullValidationEvidence: {
          coveragePolicy: scenario.coveragePolicy,
          source: scenario.source ?? "sha-pinned-main",
          run: { headSha: scenario.qualificationSha ?? targetSha, headBranch: qualificationRef },
          evidence: {
            current: {
              manifest: {
                releaseProfile: options.releaseProfile,
                waivers: scenario.waived
                  ? [
                      {
                        childRole: "releaseChecksCandidate",
                        jobName:
                          "Run package acceptance / Telegram package acceptance / Run package Telegram E2E",
                        reason: "reviewed fixture outage",
                      },
                    ]
                  : [],
              },
            },
          },
        },
      },
    ) as Promise<{ status: string; runId?: string }>;
    if (outcome instanceof RegExp) {
      await expect(completion).rejects.toThrow(outcome);
      expect(dispatchWorkflow).toHaveBeenCalledTimes(scenario.returnedSha ? 1 : 0);
      return;
    }
    const result = await completion;
    expect(result.status).toBe(outcome);
    if (outcome !== "passed") {
      expect(dispatchWorkflow).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({ status: "passed", runId: "333" });
    expect(lookupQualificationRef).toHaveBeenCalledWith(
      `repos/${options.repo}/git/ref/heads/${qualificationRef}`,
    );
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      options.repo,
      "npm-telegram-beta-e2e.yml",
      qualificationRef,
      expect.objectContaining({
        harness_ref: targetSha,
        package_artifact_id: 9,
        package_artifact_name: "npm-package",
        package_artifact_digest: "a".repeat(64),
        package_artifact_run_attempt: 1,
        package_artifact_run_id: "444",
        package_file_name: "openclaw.tgz",
        package_sha256: "b".repeat(64),
        package_source_sha: "c".repeat(40),
        package_version: options.tag.slice(1),
      }),
    );
  });

  it("round-trips the prepared command into the full release button contract", () => {
    const preparedWorkflowRef = "release-publish/bbbbbbbbbbbb-123";
    const windowsNodeInstallerDigests = JSON.stringify({
      "OpenClawCompanion-Setup-x64.exe": `sha256:${"a".repeat(64)}`,
      "OpenClawCompanion-Setup-arm64.exe": `sha256:${"b".repeat(64)}`,
    });
    const options = {
      ...parseArgs([
        "--tag",
        "v2026.9.2",
        "--npm-dist-tag",
        "latest",
        "--publish-workflow-ref",
        preparedWorkflowRef,
        "--full-release-validation-run-id",
        "111",
        "--npm-preflight-run",
        "222",
        "--plugin-sdk-api-acknowledgement",
        "a1b2c3d4",
        "--windows-node-tag",
        "v0.6.3",
      ]),
      fullReleaseRunAttempt: 2,
      npmTelegramRunId: "333",
      windowsNodeInstallerDigests,
    };
    const command = buildPrepareCommand(options);
    // A shell-local gh captures real argument decoding without dispatching anything.
    const args = execFileSync("bash", ["-c", `gh() { printf '%s\\0' "$@"; }\n${command}`], {
      encoding: "utf8",
      timeout: 10_000,
    })
      .split("\0")
      .filter(Boolean);
    expect(args.slice(0, 7)).toEqual([
      "workflow",
      "run",
      "openclaw-release-prepare.yml",
      "--repo",
      "openclaw/openclaw",
      "--ref",
      preparedWorkflowRef,
    ]);
    const field = args[args.indexOf("-f") + 1] ?? "";
    expect(field.startsWith("publish_inputs=")).toBe(true);
    const preparedInputs = validateReleaseButtonInputs(
      JSON.parse(field.slice("publish_inputs=".length)),
    );
    expect(preparedInputs).toMatchObject({
      tag: "v2026.9.2",
      npm_dist_tag: "latest",
      preflight_run_id: "222",
      npm_telegram_run_id: "333",
      full_release_validation_run_id: "111",
      full_release_validation_run_attempt: "2",
      plugin_sdk_api_acknowledgement: "a1b2c3d4",
      windows_node_tag: "v0.6.3",
      windows_node_installer_digests: windowsNodeInstallerDigests,
      plugin_publish_scope: "all-publishable",
      release_evidence_mode: "full-release-validation",
      wait_for_clawhub: "true",
    });
    expect(preparedInputs).not.toHaveProperty("finalize_release_before_docker");
  });

  it.each([
    [{}, undefined],
    [{ draft: true }, "must be published"],
    [{ prerelease: true }, "must not be a prerelease"],
    [{ tag_name: "v0.6.4" }, "Windows source release tag mismatch: expected v0.6.3, got v0.6.4"],
    [
      { assets: [] },
      "must contain exactly one required asset OpenClawCompanion-Setup-x64.exe; found 0",
    ],
    [
      {
        assets: [
          { name: "OpenClawCompanion-Setup-x64.exe", digest: "" },
          { name: "OpenClawCompanion-Setup-arm64.exe", digest: `sha256:${"b".repeat(64)}` },
        ],
      },
      "asset OpenClawCompanion-Setup-x64.exe is missing its SHA-256 digest",
    ],
  ])("validates stable Windows source release %j", async (override, message) => {
    const result = validateWindowsSourceRelease("v0.6.3", {
      fetchImpl: async () => windowsReleaseResponse(override),
      timeoutMs: 1234,
      token: "test-token",
    });
    if (message === undefined) {
      await expect(result).resolves.toEqual({
        tag: "v0.6.3",
        url: windowsReleaseUrl,
        assets: windowsAssets,
      });
    } else {
      await expect(result).rejects.toThrow(message);
    }
  });

  it("fails closed when gh dispatch output does not include the run url", () => {
    expect(() =>
      requireRunIdFromDispatchOutput(
        "Created workflow_dispatch event for full-release-validation.yml",
        "full-release-validation.yml",
      ),
    ).toThrow("refusing to guess from recent workflow_dispatch runs");
  });

  it("falls back to a single compatible artifact from the same run", () => {
    expect(
      resolveArtifactName(
        [{ name: "openclaw-npm-preflight-dba00", expired: false }],
        "openclaw-npm-preflight-v2026.5.16-beta.2",
        "openclaw-npm-preflight-",
      ),
    ).toBe("openclaw-npm-preflight-dba00");
  });

  it("rejects Telegram artifacts without a bound producer run", () => {
    expect(() =>
      buildTelegramArtifactInputs({
        artifact: { id: 123, name: "npm-package", digest: `sha256:${"a".repeat(64)}` },
        manifest: {},
        runAttempt: 1,
        runId: "undefined",
        sourceSha: "c".repeat(40),
      }),
    ).toThrow("belongs to run");
  });

  it("uses a positive integer GitHub API timeout env", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe("https://api.github.com/repos/openclaw/openclaw/actions/runs");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toMatchObject({
        Accept: "application/vnd.github+json",
        Authorization: "Bearer test-token",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      return jsonResponse({ workflow_runs: [] });
    });

    await withGithubApiTimeoutEnv("2500", async () => {
      await expect(
        githubApi("repos/openclaw/openclaw/actions/runs", {
          fetchImpl,
          token: "test-token",
        }),
      ).resolves.toEqual({ workflow_runs: [] });
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["1e3"])("rejects malformed GitHub API timeout env %s", async (raw) => {
    const fetchImpl = vi.fn();

    await withGithubApiTimeoutEnv(raw, async () => {
      await expect(
        githubApi("repos/openclaw/openclaw/actions/runs", {
          fetchImpl,
          token: "test-token",
        }),
      ).rejects.toThrow(
        "OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS must be a positive integer",
      );
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds GitHub API error bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("x".repeat(65), {
        headers: { "content-length": "65" },
        status: 500,
      });
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs", {
        fetchImpl,
        maxBodyBytes: 64,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).rejects.toThrow(
      "GitHub API repos/openclaw/openclaw/actions/runs response body exceeded 64 bytes",
    );
  });

  it("keeps GitHub API timeouts active while reading response bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
      });
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs", {
        fetchImpl,
        timeoutMs: 25,
        token: "test-token",
      }),
    ).rejects.toThrow("GitHub API repos/openclaw/openclaw/actions/runs timed out after 25ms");
  });
});

describe("GitHub API public fallback", () => {
  it.each([403, 429])(
    "retries anonymously after an authenticated rate limit response %s",
    async (status) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await expect(
        githubApi("repos/openclaw/openclaw/actions/runs/123", {
          token: "x",
          fetchImpl,
        }),
      ).resolves.toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer x" });
      expect(fetchImpl.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Authorization");
    },
  );
});

describe("release run environment approval diagnostics", () => {
  it.each([
    { capability: true, unavailable: false, empty: false },
    { capability: false, unavailable: false, empty: false },
    { capability: undefined, unavailable: false, empty: false },
    { capability: undefined, unavailable: true, empty: false },
    { capability: undefined, unavailable: false, empty: true },
  ])(
    "reports approval capability $capability (unavailable=$unavailable, empty=$empty)",
    async ({ capability, unavailable, empty }) => {
      const owners = checklistFunctions(
        "runInfo",
        "pendingDeployments",
        "summarizePendingDeployments",
        "summarizeFailedRun",
        "waitForSuccessfulRun",
      );
      const log = vi.fn();
      let reads = 0;
      const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
        if (path.endsWith("/pending_deployments")) {
          if (unavailable && new Headers(init?.headers).has("Authorization")) {
            return jsonResponse(
              { message: "API rate limit exceeded; credential-private fixture error" },
              { status: 403 },
            );
          }
          return jsonResponse(
            empty || reads > 1
              ? []
              : [
                  {
                    environment: { id: 7, name: "npm-release" },
                    current_user_can_approve: unavailable ? false : capability,
                  },
                ],
          );
        }
        if (path.includes("/jobs?")) {
          return jsonResponse({ jobs: [] });
        }
        reads++;
        return jsonResponse({
          id: 123,
          name: "Release",
          head_branch: "main",
          status: reads === 1 ? "waiting" : "completed",
          conclusion: reads === 1 ? null : "success",
          html_url: "https://github.com/fixture/repo/actions/runs/123",
        });
      });
      await runInNewContext(
        stripNodeTypeScriptTypes(
          `${owners}\nwaitForSuccessfulRun("fixture/repo", "123", { workflowName: "Release", workflowRef: "main" });`,
        ),
        {
          githubApi: (path: string, options: Parameters<typeof githubApi>[1]) =>
            githubApi(path, { ...options, token: "test-token", fetchImpl }),
          isRecord,
          formatJsonValue: JSON.stringify,
          console: { log },
          wait: async () => {},
        },
      );
      const output = log.mock.calls.map(([line]) => line).join("\n");
      if (unavailable) {
        expect(output).toContain("environment approval status unavailable");
        expect(output).toContain("not proof that no approval is pending");
        expect(output).not.toContain("credential-private");
      } else if (empty) {
        expect(output).not.toContain("pending approval");
        expect(output).not.toContain("approval status unavailable");
      } else {
        expect(output).toContain('pending approval: env="npm-release"');
        expect(output).toContain(
          "Environment approval is separate from repository write, organization membership, branch-policy read, CI bypass, and production deployment authority",
        );
        expect(output.includes("approve: gh api -X POST")).toBe(capability === true);
        if (capability !== true) {
          expect(output).toContain("ask an eligible environment reviewer");
          expect(output).toContain(
            capability === false
              ? "authenticated caller cannot approve"
              : "Caller approval capability is unknown",
          );
        }
      }
    },
  );
});
