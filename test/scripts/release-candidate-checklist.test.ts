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
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { normalizePublicationIntent } from "../../scripts/full-release-publication-contract.mjs";
import { stripLeadingPackageManagerSeparator } from "../../scripts/lib/arg-utils.mts";
import { parsePluginReleaseSelection } from "../../scripts/lib/plugin-npm-release.ts";
import { splitChangelog } from "../../scripts/lib/release-changelog.mjs";
import { releaseBranchForTag } from "../../scripts/lib/release-context.mjs";
import {
  buildReleasePublishDispatchCommand,
  formatReleasePublishPreflight,
  type PreflightReport,
} from "../../scripts/lib/release-publish-preflight-interface.mts";
import { classifyReleaseTrain, parseReleaseVersion } from "../../scripts/lib/release-version.mjs";
import { validateReleaseButtonInputs } from "../../scripts/openclaw-release-ready.mjs";
import {
  PluginSdkApiAcknowledgementError,
  createPluginSdkApiReleaseEvidence,
  validatePluginSdkApiReleaseEvidence,
} from "../../scripts/plugin-sdk-api-release-evidence.mjs";
import {
  buildReleaseCandidateState,
  buildPrepareCommand,
  buildTelegramArtifactInputs,
  assertReleaseCandidateTag,
  candidateCumulativeShippedPullRequests,
  candidateParallelsArgs,
  candidateParallelsShellCommand,
  githubApi,
  isDirectReleaseCandidateExecution,
  loadCandidateShippedBaseline,
  parseArgs,
  preflightCorePackageTarballs,
  preflightDependencyTarballs,
  reconcileReleaseCandidateState,
  resolveArtifactName,
  requireRunIdFromDispatchOutput,
  run,
  validateCandidateChangelogProvenance,
  validateCandidateCheckout,
  validateCandidateReleaseNotes,
  validateFullManifest,
  validateNpmPreflightRunSource,
  validateParallelsRegistryPackageArtifact,
  validatePreflightManifest,
  validateTrustedToolingPin,
  validateWindowsSourceRelease,
} from "../../scripts/release-candidate-checklist.mts";
import type { runReleasePublishPreflight } from "../../scripts/release-publish-preflight.mts";
import { loadReleaseNotesForTag } from "../../scripts/render-github-release-notes.mts";
import { isShaPinnedReleaseValidationBranch } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { stripNodeTypeScriptTypes } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const publishWorkflowRef = "release-publish/bbbbbbbbbbbb-123";
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
  return [
    "# Changelog",
    "",
    "## 2026.7.1",
    "",
    "### Highlights",
    "",
    "- User-facing notes.",
    "",
    "### Complete contribution record",
    "",
    provenance,
    "",
    ...(exclusions ? [exclusions, ""] : []),
    "#### Pull requests",
    "",
    ...rows,
  ].join("\n");
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

function omitToolingRebinds<T extends { toolingRebinds: unknown }>(state: T) {
  const { toolingRebinds: _rebinds, ...legacy } = state;
  return legacy;
}

describe("release candidate checklist", () => {
  it.each([
    {
      flags: [
        "--tag",
        "v2026.9.1",
        "--workflow-sha",
        "b".repeat(40),
        "--publish-workflow-ref",
        publishWorkflowRef,
      ],
      message: "--workflow-sha and --publish-workflow-ref are mutually exclusive",
    },
    {
      flags: ["--tag", "v2026.9.1", "--workflow-sha", "b".repeat(12)],
      message: "--workflow-sha must be a full lowercase commit SHA",
    },
  ])("rejects invalid tooling SHA selection: $message", ({ flags, message }) => {
    expect(() => parseArgs(flags)).toThrow(message);
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
      [
        `## ${version}`,
        "",
        "### Complete contribution record",
        "",
        `This audited record covers the complete v2026.5.1..${target} history: 1 in-range PR + 0 retained seed-only PRs = 1 unique PR.`,
        "",
        "#### Pull requests",
        "",
        `- **PR #${number}** fix: example.`,
        "",
      ].join("\n");
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
    savedToolingAncestor?: boolean;
    telegramRunId?: string;
    retainedHelperRequest?: boolean;
    sdkAcknowledgement?: string;
    generatedFailure?: boolean;
  };

  it.each<QualificationCase>([
    ...["", "deadbeef", "f4b495f3"].map<QualificationCase>((sdkAcknowledgement) => ({
      sdkAcknowledgement,
    })),
    { launch: "npm-only", generatedFailure: true },
    { workflowSha: "b".repeat(40), savedToolingTag: "release-publish/bbbbbbbbbbbb-100" },
    ...[false, true].map<QualificationCase>((retainedHelperRequest) => ({
      workflowSha: "b".repeat(40),
      savedToolingSha: "a".repeat(40),
      savedToolingTag: "release-publish/aaaaaaaaaaaa-100",
      launch: "npm-only",
      retainedHelperRequest,
    })),
    ...[false, true].map<QualificationCase>((savedToolingAncestor) => ({
      workflowSha: "b".repeat(40),
      savedToolingSha: "a".repeat(40),
      savedToolingTag: "release-publish/aaaaaaaaaaaa-100",
      savedToolingAncestor,
    })),
    { workflowSha: "b".repeat(40) },
    { workflowSha: "c".repeat(40) },
    { pin: "2026.7.4", expected: "warning" },
    { failedRegistry: "npm", registryAdmission: true },
    { launch: "reuse", registryAdmission: true },
    {
      tag: "v2026.9.1",
      pin: "2026.9.1",
      expected: "passed",
      launch: "npm-only",
      retainedHelperRequest: true,
    },
    {
      tag: "v2026.9.1",
      pin: "2026.9.1",
      expected: "passed",
      workflowSha: "b".repeat(40),
      savedToolingTag: "release-publish/bbbbbbbbbbbb-100",
    },
    ...["normal", "prepared"].map<QualificationCase>((publicationRoute) => ({
      tag: "v2026.9.1",
      pin: "2026.9.1",
      expected: "passed",
      publicationRoute,
      workflowSha: "b".repeat(40),
      telegramRunId: "555",
    })),
    { tag: "v2026.9.1", pin: "2026.9.1", workflowSha: "c".repeat(40) },
    { tag: "v2026.9.1", pin: "2026.7.4", expected: "warning", failedRegistry: "" },
    { tag: "v2026.9.1-1", pin: "2026.9.1", expected: "passed", failedRegistry: "" },
    { tag: "v2026.9.1-beta.1", pin: "2026.7.4", expected: undefined, failedRegistry: "" },
    ...["npm", "clawhub"].map<QualificationCase>((failedRegistry) => ({
      tag: "v2026.9.1",
      pin: "2026.9.1",
      expected: "passed",
      failedRegistry,
      registryAdmission: true,
    })),
    ...(["npm-only", "reuse"] as const).map<QualificationCase>((launch) => ({
      tag: "v2026.9.1",
      pin: "2026.9.1",
      expected: "passed",
      launch,
      registryAdmission: true,
    })),
    {
      tag: "v2026.9.1",
      pin: "2026.9.1",
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
      savedToolingAncestor = false,
      telegramRunId,
      retainedHelperRequest,
      sdkAcknowledgement,
      generatedFailure,
    }) => {
      const { root: targetRoot, git } = candidateGitFixture({
        "package.json": JSON.stringify({ version: tag.slice(1) }),
        "apps/android/version.json": JSON.stringify({ version: pin, versionCode: 2026070401 }),
        "CHANGELOG.md": "# Fixture changelog\n\n## 2026.9.1\n\nFixture notes.\n",
      });
      const targetSha = git("rev-parse", "HEAD");
      // The target ref is authoritative even if another checkout has prepared a newer pin.
      writeFileSync(
        join(targetRoot, "apps/android/version.json"),
        JSON.stringify({ version: "2099.1.1" }),
      );
      const candidateArgv = [
        "--tag",
        tag,
        "--publication-route",
        publicationRoute,
        ...(!launch || launch === "reuse"
          ? ["--full-release-run", "111", "--npm-preflight-run", "222"]
          : []),
        ...(!launch ? ["--skip-dispatch"] : []),
        ...(launch === "npm-only" ? ["--npm-preflight-run", "222"] : []),
        ...(distTag ? ["--npm-dist-tag", distTag] : []),
        "--skip-parallels",
        "--skip-telegram",
        "--skip-local-generated-check",
        ...(workflowSha
          ? ["--workflow-sha", workflowSha]
          : ["--publish-workflow-ref", publishWorkflowRef]),
        ...(sdkAcknowledgement ? ["--plugin-sdk-api-acknowledgement", sdkAcknowledgement] : []),
        "--output-dir",
        `${targetRoot}/evidence 'quoted' $(literal)`,
      ];
      const options = parseArgs(candidateArgv);
      if (failedRegistry) {
        options.fullReleaseRunId = "";
        options.skipDispatch = false;
      }
      options.outputDir = join(targetRoot, "evidence");
      mkdirSync(join(options.outputDir, "npm-preflight"), { recursive: true });
      writeFileSync(join(options.outputDir, "npm-preflight", "openclaw.tgz"), "fixture");
      if (retainedHelperRequest) {
        writeFileSync(
          join(options.outputDir, "frv-request.json"),
          JSON.stringify({ phase: "attempted" }),
        );
      }
      const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
      const main = source.match(/^async function main\(\)[\s\S]*?^\}/mu)?.[0];
      const helperDispatch =
        source.match(/^function dispatchFullReleaseUsingHelper\([\s\S]*?^\}/mu)?.[0] ?? "";
      const android =
        source.match(/^function checkCandidateAndroidVersion\([\s\S]*?^\}/mu)?.[0] ?? "";
      const selectPublication =
        source.match(/^function publicationSelectionForChecklist\([\s\S]*?^\}/mu)?.[0] ?? "";
      const savedTagReader =
        source.match(/^function savedPublishWorkflowRef\([\s\S]*?^\}/mu)?.[0] ?? "";
      const statePlanning =
        source.match(/^function canUpdateReleaseCandidateState\([\s\S]*?^\}/mu)?.[0] ?? "";
      const toolingRebind =
        source
          .match(/^export function assertReleaseCandidateToolingRebind\([\s\S]*?^\}/mu)?.[0]
          ?.replace(/^export /u, "") ?? "";
      const shellQuote = source.match(/^function shellQuote\([\s\S]*?^\}/mu)?.[0] ?? "";
      const log = vi.fn();
      const stages: string[] = [];
      const writeState = vi.fn<(path: string, state: unknown) => void>(
        workflowSha
          ? runInNewContext(
              stripNodeTypeScriptTypes(
                `${source.match(/^function writeReleaseCandidateState\([\s\S]*?^\}/mu)?.[0]}\nwriteReleaseCandidateState;`,
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
      const statePath = join(options.outputDir, "release-candidate-state.json");
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
                // State files written before tooling rebinds existed have no rebind history.
                ...omitToolingRebinds(
                  buildReleaseCandidateState(options, { targetSha, toolingSha }),
                ),
                publishWorkflowRef: savedToolingTag,
                toolingSha: savedToolingSha ?? toolingSha,
                ...(launch === "npm-only" ? { fullReleaseRunId: "", npmPreflightRunId: "" } : {}),
              }
            : undefined;
      if (savedState) {
        writeFileSync(statePath, JSON.stringify(savedState));
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
      const preflightRows: PreflightReport["rows"] = [
        {
          id: "npm.bootstrap",
          status: preflightFailure ? "FAIL" : "PASS",
          message: preflightFailure ? "Bootstrap approval is missing." : "Bootstrap is ready.",
          remediation: preflightFailure ? "Obtain the exact bootstrap approval." : "",
        },
      ];
      const preflight = vi.fn<typeof runReleasePublishPreflight>(async (input, context) => {
        stages.push("publish-preflight");
        expect(context?.manifest).toBe(fullManifest);
        expect(context?.npmManifest).toBe(npmManifest);
        expect(context?.fullValidationEvidence).toBe(authenticatedEvidence);
        expect(context).toMatchObject({
          manifestPath: join(
            options.outputDir,
            "full-release-validation/full-release-validation-manifest.json",
          ),
          npmManifestPath: join(options.outputDir, "npm-preflight/preflight-manifest.json"),
          targetSha,
          toolingSha,
          allowPlannedTag: true,
          run: { headSha: targetSha, runAttempt: 1 },
          npmPreflightRun: { headSha: targetSha, runAttempt: 1 },
        });
        expect(input).toMatchObject({
          fullReleaseValidationRunId: "111",
          fullReleaseValidationRunAttempt: 1,
          preflightRunId: "222",
          tag,
          publicationRoute,
          workflowRef: options.publishWorkflowRef || options.workflowRef,
        });
        expect(input.npmTelegramRunId).toBeUndefined();
        return {
          rows: preflightRows,
          command: buildReleasePublishDispatchCommand(input, "1", input.workflowRef, "777"),
          failed: preflightFailure,
        };
      });
      // Run the real coordinator and evidence writers; unrelated remote release gates are fixtures.
      const dispatches: string[][] = [];
      const completion = runInNewContext(
        stripNodeTypeScriptTypes(
          `${android}\n${selectPublication}\n${statePlanning}\n${toolingRebind}\n${savedTagReader}\n${helperDispatch}\n${shellQuote}\n${main}\nmain();`,
        ),
        {
          process: {
            argv: ["node", "scripts/release-candidate-checklist.mts", ...candidateArgv],
            cwd: () => targetRoot,
            env: {},
            execPath: process.execPath,
          },
          DEFAULT_REPO: "openclaw/openclaw",
          resolvePath: (...paths: string[]) => join(...paths),
          console: { log, warn: log },
          TOOLING_ROOT: "/trusted/tooling",
          PUBLISH_TOOLING_TAG_PATTERN: /^release-publish\/[a-f0-9]{12}-[1-9][0-9]*$/u,
          TRUSTED_TOOLING_SHA_ENV: "OPENCLAW_RELEASE_CANDIDATE_TRUSTED_TOOLING_SHA",
          RELEASE_CANDIDATE_STATE_FILE: "release-candidate-state.json",
          RELEASE_CANDIDATE_STATE_VERSION: 2,
          parseArgs: () => options,
          gitTopLevel: (root: string) => root,
          gitRevParse: (_ref: string, root: string) =>
            root === targetRoot ? targetSha : toolingSha,
          fetchTrustedWorkflowSha: () => toolingSha,
          gitIsAncestor: (ancestor: string, target: string) =>
            savedToolingAncestor && ancestor === savedToolingSha && target === toolingSha,
          ensureReleasePublishToolingTag: ensureToolingTag,
          runReleaseToolingGh,
          // The protected publish tag is verified against live GitHub refs in production.
          verifyReleaseToolingIdentity: () => ({
            workflowRef: options.publishWorkflowRef,
            workflowSha: toolingSha,
          }),
          gitTrackedStatus: () => "",
          assertReleaseCandidateTag: () => {},
          validateTrustedToolingPin,
          validateCandidateCheckout,
          buildReleaseCandidateState,
          reconcileReleaseCandidateState,
          writeReleaseCandidateState: writeState,
          updateReleaseCandidateState: updateState,
          run: (command: string, args: string[]) => {
            if (args[0]?.endsWith("full-release-validation-at-sha.mjs")) {
              expect(generatedChecks).toHaveBeenCalledOnce();
              dispatches.push(args);
              stages.push("dispatch");
              writeFileSync(
                join(options.outputDir, "frv-request.json"),
                JSON.stringify({ phase: "observed", run: { id: 111, attempt: 1 } }),
              );
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
          releaseNotesVersionForTag: () => "2026.9.1",
          loadReleaseNotesForTag,
          validateCandidateReleaseNotes: () => ({ status: "passed" }),
          validateCandidateChangelogProvenance: () => ({ status: "passed", shippedBaselines: [] }),
          runLocalGeneratedCheckIfNeeded: generatedChecks,
          releaseBranchForTag,
          readFileSync: () => readFileSync(".github/workflows/full-release-validation.yml", "utf8"),
          waitForSuccessfulRun: async (_repo: string, runId: string) => {
            if (dispatches.length === 0) {
              expect(generatedChecks).not.toHaveBeenCalled();
            }
            stages.push("wait");
            waitedRuns.push(runId);
            return {
              run: { headSha: targetSha, runAttempt: 1 },
              source: { workflowRef: options.workflowRef },
            };
          },
          downloadArtifact: () => {},
          readJson: (file: string) =>
            file === statePath || file.endsWith("frv-request.json")
              ? JSON.parse(readFileSync(file, "utf8"))
              : file.endsWith("preflight-manifest.json")
                ? npmManifest
                : file.endsWith("full-release-validation-manifest.json")
                  ? fullManifest
                  : sdkEvidence,
          authenticateFullReleaseValidationEvidence: async () => {
            stages.push("authenticate");
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
          validatePluginSdkApiReleaseEvidence,
          PluginSdkApiAcknowledgementError,
          stripLeadingPackageManagerSeparator,
          validateFullManifest: () => stages.push("evidence-validated"),
          preflightCorePackageTarballs,
          preflightDependencyTarballs,
          runParallelsIfNeeded: async () => ({ status: "skipped" }),
          runTelegramIfNeeded: async () =>
            telegramRunId ? { status: "passed", runId: telegramRunId } : { status: "skipped" },
          collectPluginPlanWithRetry: async (script: string) => {
            expect(generatedChecks).toHaveBeenCalledOnce();
            stages.push(script);
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
          join,
          basename,
          existsSync,
          mkdirSync,
          writeFileSync,
        },
      );
      if (generatedFailure) {
        await expect(completion).rejects.toThrow("fixture generated-check failure");
        expect(generatedChecks).toHaveBeenCalledOnce();
        expect(dispatches).toEqual([]);
        expect(stages).toEqual([]);
        expect(preflight).not.toHaveBeenCalled();
        return;
      }
      if (sdkAcknowledgement !== undefined && sdkAcknowledgement !== "f4b495f3") {
        const error = await completion.catch((cause: Error) => cause);
        expect(error.message).toContain(
          "Plugin SDK API changes require acknowledgement digest f4b495f3",
        );
        expect(error.message).toContain("Review the Plugin SDK API diff before rerunning.");
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
        expect(stages).toEqual(["wait", "wait", "authenticate"]);
        expect(generatedChecks).not.toHaveBeenCalled();
        expect(preflight).not.toHaveBeenCalled();
        expect(publishCommand).not.toHaveBeenCalled();
        return;
      }
      if (workflowSha && workflowSha !== toolingSha) {
        await expect(completion).rejects.toThrow(
          `--workflow-sha ${workflowSha} does not match tooling checkout ${toolingSha}`,
        );
        expect(ensureToolingTag).not.toHaveBeenCalled();
        expect(writeState).not.toHaveBeenCalled();
        expect(stages).toEqual([]);
        return;
      }
      if (
        savedToolingSha &&
        (launch === "npm-only" ? retainedHelperRequest : !savedToolingAncestor)
      ) {
        await expect(completion).rejects.toThrow(
          launch === "npm-only"
            ? "An unobserved Full Release Validation request is retained"
            : "Tooling may only move forward from the saved commit",
        );
        expect(ensureToolingTag).not.toHaveBeenCalled();
        expect(writeState).not.toHaveBeenCalled();
        expect(stages).toEqual([]);
        return;
      }
      if (routingError || stopAtRegistry) {
        await expect(completion).rejects.toThrow(
          launch === "mismatch"
            ? "release candidate state mismatch for targetSha"
            : routingError || "fixture registry-plan sentinel: scripts/plugin-npm-release-plan.ts",
        );
        if (routingError || launch === "mismatch") {
          expect(stages).toEqual([]);
          expect(writeState).not.toHaveBeenCalled();
          expect(generatedChecks).not.toHaveBeenCalled();
        } else {
          // Retained recovery reaches its old planner; this does not certify monthly publication.
          expect(stages).toEqual([
            "wait",
            "wait",
            "authenticate",
            "scripts/plugin-npm-release-plan.ts",
          ]);
          expect(writeState).toHaveBeenCalledWith(
            statePath,
            expect.objectContaining({
              fullReleaseRunId: "333",
              npmPreflightRunId: "444",
            }),
          );
        }
        if (routingError || launch === "mismatch") {
          expect(updateState).not.toHaveBeenCalled();
          expect(waitedRuns).toEqual([]);
        } else {
          expect(waitedRuns).toEqual(["333", "444"]);
        }
        expect(publishCommand).not.toHaveBeenCalled();
        expect(preflight).not.toHaveBeenCalled();
        expect(existsSync(join(options.outputDir, "release-candidate-evidence.json"))).toBe(false);
        expect(existsSync(join(options.outputDir, "release-candidate-evidence.md"))).toBe(false);
        expect(log.mock.calls.flat().join("\n")).not.toContain("publication / recovery command:");
        expect(existsSync(statePath)).toBe(Boolean(savedState));
        if (savedState) {
          expect(readFileSync(statePath, "utf8")).toBe(JSON.stringify(savedState));
        }
        return;
      }
      if (failedRegistry) {
        await expect(completion).rejects.toThrow(`${failedRegistry} registry unavailable`);
        expect(stages).toEqual(["dispatch", "wait", "wait", "authenticate"]);
        expect(preflight).not.toHaveBeenCalled();
        expect(existsSync(join(options.outputDir, "release-candidate-evidence.json"))).toBe(false);
        expect(log.mock.calls.flat().join("\n")).not.toContain("publish command:");
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
        expect(options.publishWorkflowRef).toBe(publishWorkflowRef);
        expect(ensureToolingTag).toHaveBeenCalledOnce();
        // Bound runs survive a forward repair; the move itself is recorded.
        expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
          toolingSha,
          toolingRebinds: savedToolingAncestor ? [{ from: savedToolingSha, to: toolingSha }] : [],
          ...(savedToolingAncestor ? { fullReleaseRunId: "111", npmPreflightRunId: "222" } : {}),
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
            ...(!retainedHelperRequest
              ? [
                  "--workflow-sha",
                  targetSha,
                  "--trusted-workflow-ref",
                  "candidate",
                  "--admission-workflow-sha",
                  toolingSha,
                  "--admission-workflow-ref",
                  options.publishWorkflowRef || options.workflowRef,
                ]
              : []),
            "--request-file",
            join(options.outputDir, "frv-request.json"),
            "validation_purpose=publish",
          ]),
        );
        if (retainedHelperRequest) {
          expect(dispatched).not.toContain("--workflow-sha");
          expect(dispatched).not.toContain("--trusted-workflow-ref");
          expect(dispatched).not.toContain("--admission-workflow-sha");
          expect(dispatched).not.toContain("--resume-request");
        }
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
      expect(stages).toEqual([
        ...(launch === "npm-only" ? ["dispatch"] : []),
        "wait",
        "wait",
        "authenticate",
        ...(registryAdmission
          ? []
          : ["scripts/plugin-npm-release-plan.ts", "scripts/plugin-clawhub-release-plan.ts"]),
        "evidence-validated",
        "publish-preflight",
      ]);
      expect(waitedRuns).toEqual(["111", "222"]);
      const summary = readFileSync(
        join(options.outputDir, "release-candidate-evidence.md"),
        "utf8",
      );
      const output = log.mock.calls.map(([line]) => line).join("\n");
      if (workflowSha) {
        // A resumed candidate keeps its recorded tag even though a newer tag exists at the SHA.
        const reusedToolingTag =
          savedToolingTag && (!savedToolingSha || savedToolingSha === toolingSha);
        const toolingTag = reusedToolingTag ? savedToolingTag : publishWorkflowRef;
        if (reusedToolingTag) {
          expect(ensureToolingTag).not.toHaveBeenCalled();
        } else {
          expect(ensureToolingTag).toHaveBeenCalledExactlyOnceWith({
            runGh: runReleaseToolingGh,
            repo: "openclaw/openclaw",
            toolingSha,
          });
        }
        expect(output).toContain(
          `${reusedToolingTag ? "reusing" : "created"} protected tooling tag ${toolingTag} at ${toolingSha}`,
        );
        expect(output).toContain(
          publicationRoute === "prepared" ? `'--ref' '${toolingTag}'` : `--ref ${toolingTag}`,
        );
        expect(writeState).toHaveBeenCalledWith(
          statePath,
          expect.objectContaining({ publishWorkflowRef: toolingTag }),
        );
        expect(JSON.parse(readFileSync(statePath, "utf8")).publishWorkflowRef).toBe(toolingTag);
        expect(evidence.publishWorkflowIdentity).toMatchObject({
          workflowRef: toolingTag,
          workflowSha: toolingSha,
        });
      } else {
        expect(ensureToolingTag).not.toHaveBeenCalled();
      }
      expect(generatedChecks).toHaveBeenCalledOnce();
      expect(preflight).toHaveBeenCalledOnce();
      expect(evidence.publishPreflight.rows).toEqual(preflightRows);
      expect(evidence.publishPreflight.failed).toBe(preflightFailure);
      expect(summary).toContain("npm.bootstrap");
      expect(output).toContain("npm.bootstrap");
      if (publicationRoute === "normal") {
        expect(evidence.publishCommand).toContain("openclaw_npm_resume_run_id=777");
      } else {
        expect(evidence.publishPreflight.command).toBe(evidence.prepareCommand);
        expect(evidence.publishPreflight.command).toContain("openclaw-release-prepare.yml");
        expect(output).not.toContain("openclaw-release-publish.yml");
      }
      if (preflightFailure) {
        expect(output).toContain("Obtain the exact bootstrap approval.");
        expect(output).not.toContain("direct publication / recovery command:");
        expect(output).not.toContain("prepare once for the release button");
        expect(updateState).not.toHaveBeenCalledWith(statePath, expect.anything(), "completed");
        return;
      }
      expect(updateState).toHaveBeenCalledWith(statePath, expect.anything(), "completed");
      if (registryAdmission) {
        expect(evidence.pluginNpmPlan).toEqual(
          evidence.publicationAdmission.observations.plans.npm,
        );
        expect(evidence.pluginClawHubPlan).toEqual(
          evidence.publicationAdmission.observations.plans.clawhub,
        );
        expect(summary).toContain(
          "Pending owner actions and final publisher checks remain required",
        );
      } else {
        expect(evidence.publicationAdmission).toBeNull();
      }
      expect(
        evidence[publicationRoute === "prepared" ? "prepareCommand" : "publishCommand"],
      ).toContain(
        publicationRoute === "prepared"
          ? "openclaw-release-prepare.yml"
          : "openclaw-release-publish.yml",
      );
      if (tag.includes("-beta.")) {
        expect(evidence.androidVersionCheck).toBeUndefined();
        expect(summary).not.toContain("Android version");
        return;
      }
      expect(evidence.androidVersionCheck).toMatchObject({
        status: expected,
        androidVersion: pin,
        targetVersion: "2026.9.1",
      });
      const message = evidence.androidVersionCheck.message;
      expect(message).toContain(
        expected === "warning" ? "WARNING: Android version" : "PASS: Android version",
      );
      expect(summary).toContain(message);
      expect(output).toContain(message);
      if (expected === "warning") {
        expect(message).toContain("2026.7.4");
        expect(message).toContain(
          "scripts/android-pin-version.ts --version 2026.9.1 before tagging",
        );
        expect(message).toContain("or accept that Android will not ship for this release");
      }
    },
  );

  it.each([
    "pnpm-lock.yaml",
    "missing node_modules",
    "install failure",
    "child failure",
    "worktree removal failure",
    "pinned ancestor",
    "untrusted SHA",
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
      JSON.stringify({
        ...manifest,
        version: "2026.9.2",
        ...([
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ].includes(scenario)
          ? { [scenario]: { yaml: "2.8.2" } }
          : {}),
      }),
    );
    if (["pnpm-lock.yaml", "install failure"].includes(scenario)) {
      writeFileSync(join(targetRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# changed\n");
    }
    git("commit", "-am", "test: target differs from tooling");
    expect(git("rev-parse", "HEAD")).not.toBe(trustedToolingSha);
    const latestToolingSha = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", latestToolingSha);
    const workflowSha =
      scenario === "pinned ancestor"
        ? trustedToolingSha
        : scenario === "untrusted SHA"
          ? git("commit-tree", "HEAD^{tree}", "-m", "test: unrelated tooling")
          : "";
    const installedModules = realpathSync("node_modules");
    if (scenario !== "missing node_modules") {
      symlinkSync(installedModules, join(targetRoot, "node_modules"), "junction");
    }
    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
    const owner = source.match(/^function runFromTrustedTooling\([\s\S]*?^\}/mu)?.[0];
    const jsonReader = source.match(/^function readJson\([\s\S]*?^\}/mu)?.[0];
    const ancestry = source.match(/^function gitIsAncestor\([\s\S]*?^\}/mu)?.[0];
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
          `${jsonReader}\n${ancestry}\n${owner}\nrunFromTrustedTooling(argv, { targetRoot, workflowRef: "main", workflowSha });`,
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
              expect(child.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
              return child;
            }
            return spawnSync(command, args, options);
          },
        },
      );
    if (scenario === "untrusted SHA") {
      expect(execute).toThrow(`--workflow-sha ${workflowSha} is not reachable from trusted main`);
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

  it.each([
    {
      warnings: [
        '@openclaw/example@2026.9.1: example-runtime pinned "1.2.3", npm latest is "1.2.4".',
      ],
    },
  ])("keeps plugin plan warnings advisory and visible: $warnings", ({ warnings }) => {
    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
    const owner = source.match(/^function collectPluginPlan\([\s\S]*?^\}/mu)?.[0];
    const summary = source.match(/^function formatPluginPlanSummary\([\s\S]*?^\}/mu)?.[0];
    expect(owner).toBeDefined();
    expect(summary).toBeDefined();
    const log = vi.fn();
    const runPlanner = vi.fn((_command, args, options) =>
      JSON.stringify({ args, options, all: [{ packageName: "@openclaw/example" }], warnings }),
    );
    const result = runInNewContext(
      stripNodeTypeScriptTypes(
        `${summary}\n${owner}\ncollectPluginPlan("scripts/plugin-npm-release-plan.ts", { pluginPublishScope: "all-publishable" })`,
      ),
      {
        TOOLING_ROOT: "/trusted/tooling",
        console: { log },
        isRecord,
        join,
        run: runPlanner,
      },
    );
    expect(result.args).toEqual([
      "--import",
      "tsx",
      "/trusted/tooling/scripts/plugin-npm-release-plan.ts",
      "--selection-mode",
      "all-publishable",
    ]);
    expect(result.options).not.toHaveProperty("cwd");
    expect(result.warnings).toEqual(warnings);
    expect(runPlanner).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      [
        "- scripts/plugin-npm-release-plan.ts: 1 packages",
        ...warnings.map((warning) => `- Warning: ${warning}`),
      ].join("\n"),
    );
  });

  it.each(["main"])("rejects an unprotected publisher selector %s", (ref) => {
    expect(() => parseArgs(["--tag", "v2026.8.2-beta.1", "--publish-workflow-ref", ref])).toThrow(
      "protected release-publish tag",
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

  it("treats the release tag as a planned post-validation identity", () => {
    const options = parseArgs(["--tag", "v2026.7.1-beta.4", "--target-sha", "a".repeat(40)]);

    expect(options.targetSha).toBe("a".repeat(40));
    expect(() => parseArgs(["--tag", "v2026.7.1-beta.4", "--target-sha", "not-a-sha"])).toThrow(
      "--target-sha must be a full lowercase commit SHA",
    );
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
    const options = parseArgs(["--tag", "v2026.7.1-beta.4"]);
    const expected = buildReleaseCandidateState(options, {
      targetSha: "a".repeat(40),
      toolingSha: "b".repeat(40),
    });

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

  it("rebinds qualified state only to descendant tooling and records the move", () => {
    const options = parseArgs(["--tag", "v2026.9.1"]);
    const [oldTooling, newTooling] = ["a".repeat(40), "b".repeat(40)];
    // A version-2 state file written before rebinds were recorded.
    const saved = {
      ...omitToolingRebinds(
        buildReleaseCandidateState(options, { targetSha: "c".repeat(40), toolingSha: oldTooling }),
      ),
      phase: "completed",
      publishWorkflowRef: "release-publish/aaaaaaaaaaaa-100",
      fullReleaseRunId: "111",
      npmPreflightRunId: "222",
    };
    const expected = {
      ...saved,
      phase: "validated",
      toolingSha: newTooling,
      publishWorkflowRef: "release-publish/bbbbbbbbbbbb-200",
      fullReleaseRunId: "",
      npmPreflightRunId: "",
    };
    const descends = (ancestor: string, target: string) =>
      ancestor === oldTooling && target === newTooling;

    expect(
      reconcileReleaseCandidateState(
        saved,
        { ...expected, toolingSha: oldTooling, publishWorkflowRef: saved.publishWorkflowRef },
        true,
      ),
    ).toMatchObject({ toolingSha: oldTooling, fullReleaseRunId: "111", toolingRebinds: [] });
    const rebound = reconcileReleaseCandidateState(saved, expected, true, descends);
    expect(rebound).toMatchObject({
      toolingSha: newTooling,
      publishWorkflowRef: "release-publish/bbbbbbbbbbbb-200",
      fullReleaseRunId: "111",
      npmPreflightRunId: "222",
      toolingRebinds: [{ from: oldTooling, to: newTooling }],
    });
    // A restart on the rebound state resumes without recording another move.
    expect(
      reconcileReleaseCandidateState(JSON.parse(JSON.stringify(rebound)), expected, true, () => {
        throw new Error("unexpected ancestry probe");
      }),
    ).toEqual(rebound);
    // Candidate-bound inputs stay frozen across a tooling repair.
    expect(() =>
      reconcileReleaseCandidateState(
        saved,
        { ...expected, skipParallels: !saved.skipParallels },
        false,
        descends,
      ),
    ).toThrow("state mismatch for skipParallels");
    expect(() => reconcileReleaseCandidateState(saved, expected, false, () => false)).toThrow(
      "Tooling may only move forward from the saved commit",
    );
    expect(() =>
      reconcileReleaseCandidateState({ ...saved, fullReleaseRunId: "" }, expected, true, descends),
    ).toThrow("An unobserved Full Release Validation request is retained");
  });

  it.each(["unbound", "retained request", "full run", "npm run", "later phase"])(
    "updates candidate planning flags only before qualification is bound: %s",
    (scenario) => {
      const options = parseArgs(["--tag", "v2026.9.1"]);
      const saved = buildReleaseCandidateState(options, {
        targetSha: "a".repeat(40),
        toolingSha: "b".repeat(40),
      });
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

  it("captures changelogs larger than the Node spawnSync default buffer", () => {
    const output = run(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
      { capture: true },
    );

    expect(output).toHaveLength(2 * 1024 * 1024);
  });

  it("passes scoped environment overrides to release child commands", () => {
    const output = run(
      process.execPath,
      ["-e", "process.stdout.write(process.env.OPENCLAW_RELEASE_TEST_VALUE ?? '')"],
      { capture: true, env: { OPENCLAW_RELEASE_TEST_VALUE: "passed" } },
    );

    expect(output).toBe("passed");
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
    expect(() => validateCandidateCheckout({ ...checkout, targetHeadSha: "c".repeat(40) })).toThrow(
      "target worktree HEAD",
    );
    expect(() =>
      validateCandidateCheckout({ ...checkout, targetTrackedStatus: " M package.json" }),
    ).toThrow("clean tracked target worktree");
    expect(() =>
      validateCandidateCheckout({ ...checkout, trustedToolingSha: "c".repeat(40) }),
    ).toThrow("does not match trusted main");
    expect(() =>
      validateCandidateCheckout({
        ...checkout,
        toolingTrackedStatus: " M scripts/release-candidate-checklist.mts",
      }),
    ).toThrow("clean tracked tooling checkout");
    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
    expect(source).toContain('const TOOLING_ROOT = fileURLToPath(new URL("../", import.meta.url))');
    expect(source).toContain("`+refs/heads/${workflowRef}:${remoteRef}`");
    expect(source).toContain(
      "const latestTrustedToolingSha = fetchTrustedWorkflowSha(options.workflowRef, TOOLING_ROOT)",
    );
    expect(source).toContain('targetHeadSha: gitRevParse("HEAD", targetRoot)');
    expect(source).toContain("toolingTrackedStatus: gitTrackedStatus(TOOLING_ROOT)");
  });

  it("keeps the exact pinned trusted tooling valid when main advances", () => {
    const isAncestor = vi.fn(() => true);

    expect(
      validateTrustedToolingPin({
        toolingSha: "a".repeat(40),
        pinnedToolingSha: "a".repeat(40),
        latestTrustedToolingSha: "b".repeat(40),
        isAncestor,
      }),
    ).toBe("a".repeat(40));
    expect(isAncestor).toHaveBeenCalledWith("a".repeat(40), "b".repeat(40));
    expect(() =>
      validateTrustedToolingPin({
        toolingSha: "a".repeat(40),
        pinnedToolingSha: "b".repeat(40),
        latestTrustedToolingSha: "b".repeat(40),
        isAncestor: () => true,
      }),
    ).toThrow("does not match pinned tooling");
    expect(() =>
      validateTrustedToolingPin({
        toolingSha: "a".repeat(40),
        pinnedToolingSha: "a".repeat(40),
        latestTrustedToolingSha: "c".repeat(40),
        isAncestor: () => false,
      }),
    ).toThrow("pinned release candidate tooling");
  });

  it("validates the exact tag changelog before dispatching the release matrix", () => {
    const check = validateCandidateReleaseNotes({
      changelog: [
        "# Changelog",
        "",
        "## 2026.7.1-beta.3",
        "",
        "### Highlights",
        "",
        "- User-facing notes.",
        "",
        "### Complete contribution record",
        "",
        `- **PR #123** ${"record ".repeat(20_000)}`,
      ].join("\n"),
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
    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
    const validationIndex = source.indexOf(
      "const releaseNotesCheck = validateCandidateReleaseNotes",
    );
    const fullMatrixDispatchIndex = source.indexOf(
      "options.fullReleaseRunId = dispatchFullReleaseUsingHelper(",
    );

    expect(check).toMatchObject({ status: "passed", mode: "compact" });
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(fullMatrixDispatchIndex).toBeGreaterThan(validationIndex);
    expect(source).toContain("const releaseChangelog = loadReleaseNotesForTag({");
    expect(source).toContain("ref: targetSha,");
    expect(source).toContain("changelog: releaseChangelog.record ?? releaseChangelog.section,");
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

    expect(() =>
      validateCandidateChangelogProvenance({
        changelog,
        version: "2026.7.1",
        tag: "v2026.7.1-beta.3",
        targetSha,
        isAncestor: reachable,
      }),
    ).toThrow(`contribution record target ${recordedTarget} is not reachable`);
    expect(reachable).toHaveBeenCalledWith(base, recordedTarget);
    expect(reachable).toHaveBeenCalledWith(recordedTarget, targetSha);
  });

  it("rejects duplicate contribution record rows even when the declared count matches", () => {
    const targetSha = "b".repeat(40);
    const changelog = candidateChangelog(
      `This audited record covers the complete base..${targetSha} history: 1 merged PR.`,
      ["- **PR #123** fix: example.", "- **PR #123** fix: duplicate."],
    );

    expect(() =>
      validateCandidateChangelogProvenance({
        changelog,
        version: "2026.7.1",
        tag: "v2026.7.1-beta.3",
        targetSha,
        isAncestor: () => true,
      }),
    ).toThrow("duplicate contribution record PR #123");
  });

  it("rejects canonical provenance whose unique total does not match the PR rows", () => {
    const targetSha = "b".repeat(40);
    const changelog = candidateChangelog(
      `This audited record covers the complete base..${targetSha} history: 1 in-range PR + 1 retained seed-only PR = 2 unique PRs.`,
      ["- **PR #123** fix: example."],
    );

    expect(() =>
      validateCandidateChangelogProvenance({
        changelog,
        version: "2026.7.1",
        tag: "v2026.7.1-beta.3",
        targetSha,
        isAncestor: () => true,
      }),
    ).toThrow("contribution record row count 1 != 2");
  });

  it("uses numbered historical record rows and skips Unreleased baseline rows", () => {
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "### Complete contribution record",
      "",
      "This audited record covers the complete base..HEAD history: 99 merged PRs.",
      "",
      "#### Pull requests",
      "",
      "- **PR #1** fix: not shipped.",
      "",
      "## 2026.6.11",
      "",
      "### Complete contribution record",
      "",
      "This audited record covers the complete base..HEAD history: 0 merged PRs.",
      "",
      "#### Pull requests",
      "",
      "- **PR #2** fix: shipped.",
    ].join("\n");

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
    const provenance = {
      version: "2026.7.1",
      tag: "v2026.7.1-beta.3",
      targetSha: recordedTarget,
      isAncestor: () => true,
    };
    expect(
      validateCandidateChangelogProvenance({
        changelog,
        ...provenance,
        loadShippedBaseline,
      }),
    ).toEqual({
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
    expect(loadShippedBaseline).toHaveBeenCalledWith("v2026.6.11");

    expect(() =>
      validateCandidateChangelogProvenance({
        changelog: changelog.replace("2 PRs:", "2 pull requests:"),
        ...provenance,
        loadShippedBaseline,
      }),
    ).toThrow("malformed shipped baseline exclusion");
    expect(() =>
      validateCandidateChangelogProvenance({
        changelog,
        ...provenance,
        loadShippedBaseline: () => ({
          ref: "v2026.6.11",
          pullRequests: new Set([...shippedPullRequests].slice(1)),
        }),
      }),
    ).toThrow("lists PRs absent from shipped baseline v2026.6.11: #101");
    expect(() =>
      validateCandidateChangelogProvenance({
        changelog: changelog.replace(
          "- **PR #123** fix: example.",
          "- **PR #101** fix: already shipped.",
        ),
        ...provenance,
        loadShippedBaseline,
      }),
    ).toThrow("still contains shipped PRs from v2026.6.11: #101");
  });

  it("requires contribution records for beta candidates", () => {
    const betaChangelog = [
      "# Changelog",
      "",
      "## 2026.7.1",
      "",
      "### Highlights",
      "",
      "- User-facing notes.",
    ].join("\n");
    expect(() =>
      validateCandidateChangelogProvenance({
        changelog: betaChangelog,
        version: "2026.7.1",
        tag: "v2026.7.1-beta.3",
        targetSha: "a".repeat(40),
      }),
    ).toThrow("missing ### Complete contribution record");
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

  it("supports explicit and profile-default Parallels execution", () => {
    const beta = parseArgs(["--tag", "v2026.5.14-beta.3", "--run-parallels"]);
    const stable = parseArgs(["--tag", "v2026.5.14", "--windows-node-tag", "v0.6.3"]);
    const full = parseArgs([
      "--tag",
      "v2026.5.14",
      "--windows-node-tag",
      "v0.6.3",
      "--release-profile",
      "full",
    ]);

    expect(beta).toMatchObject({
      parallelsMode: "run",
      parallelsSkipReason: "",
      skipParallels: false,
    });
    for (const options of [stable, full]) {
      expect(options.parallelsMode).toBe("auto");
      expect(options.skipParallels).toBe(false);
      expect(options.parallelsSkipReason).toBe("");
    }
  });

  it("rejects conflicting Parallels modes", () => {
    expect(() =>
      parseArgs(["--tag", "v2026.5.14-beta.3", "--run-parallels", "--skip-parallels"]),
    ).toThrow("--run-parallels and --skip-parallels cannot be combined");
  });

  it("runs Parallels against the exact prepared candidate tarball with the candidate harness", async () => {
    expect(candidateParallelsArgs(".artifacts/preflight/openclaw.tgz", [], "/trusted")).toEqual([
      "exec",
      "tsx",
      "/trusted/scripts/e2e/parallels/npm-update-smoke.ts",
      "--target-tarball",
      ".artifacts/preflight/openclaw.tgz",
      "--json",
    ]);
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
    expect(
      candidateParallelsShellCommand(
        ".artifacts/preflight/openclaw candidate.tgz",
        "/opt/homebrew/bin/gtimeout",
        [".artifacts/preflight/openclaw-ai candidate.tgz"],
      ),
    ).toContain("'--target-tarball' '.artifacts/preflight/openclaw candidate.tgz'");
    expect(
      candidateParallelsArgs(
        ".artifacts/preflight/openclaw.tgz",
        [".artifacts/preflight/openclaw-ai.tgz"],
        "/trusted",
        [".artifacts/preflight/openclaw-codex.tgz"],
        "macOS 26.5 Node 24",
      ),
    ).toEqual([
      "exec",
      "tsx",
      "/trusted/scripts/e2e/parallels/npm-update-smoke.ts",
      "--target-tarball",
      ".artifacts/preflight/openclaw.tgz",
      "--dependency-tarball",
      ".artifacts/preflight/openclaw-ai.tgz",
      "--registry-package-tarball",
      ".artifacts/preflight/openclaw-codex.tgz",
      "--macos-snapshot-hint",
      "macOS 26.5 Node 24",
      "--json",
    ]);
    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
    const owner = source.match(/^async function runParallelsIfNeeded\([\s\S]*?^\}/mu)?.[0];
    const caller = source.match(/const parallels = await runParallelsIfNeeded\([\s\S]*?\);/u)?.[0];
    const runLocal = vi.fn(() => "/opt/homebrew/bin/gtimeout");
    await runInNewContext(
      stripNodeTypeScriptTypes(`async function fixture() {\n${owner}\n${caller}\n}\nfixture();`),
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

  it("accepts repeatable candidate registry package artifacts", () => {
    expect(
      parseArgs([
        "--tag",
        "v2026.7.1-beta.3",
        "--parallels-registry-package-artifact",
        "/tmp/codex-artifact",
        "--parallels-registry-package-artifact",
        "/tmp/matrix-artifact",
      ]).parallelsRegistryPackageArtifactDirs,
    ).toEqual(["/tmp/codex-artifact", "/tmp/matrix-artifact"]);
  });

  it("binds Parallels registry packages to plugin preflight manifests", () => {
    const artifactDir = tempDirs.make("openclaw-plugin-preflight-");
    const tarballName = "openclaw-codex-2026.7.1-beta.3.tgz";
    const tarballPath = join(artifactDir, tarballName);
    const sourceDir = join(artifactDir, "source");
    const packageDir = join(sourceDir, "package");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({ name: "@openclaw/codex", version: "2026.7.1-beta.3" })}\n`,
    );
    execFileSync("tar", ["-czf", tarballPath, "-C", sourceDir, "package"]);
    rmSync(sourceDir, { force: true, recursive: true });
    const tarballSha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
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

    expect(
      validateParallelsRegistryPackageArtifact(artifactDir, {
        targetSha: "candidate-sha",
        targetVersion: "2026.7.1-beta.3",
      }),
    ).toMatchObject({
      artifactName: "plugin-npm-package-codex",
      packageName: "@openclaw/codex",
      packageVersion: "2026.7.1-beta.3",
      tarballPath,
      tarballSha256,
    });
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({ name: "@openclaw/matrix", version: "2026.7.1-beta.3" })}\n`,
    );
    execFileSync("tar", ["-czf", tarballPath, "-C", sourceDir, "package"]);
    rmSync(sourceDir, { force: true, recursive: true });
    const mismatchedSha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        ...manifest,
        artifact: { ...manifest.artifact, sha256: mismatchedSha256 },
      })}\n`,
    );
    expect(() =>
      validateParallelsRegistryPackageArtifact(artifactDir, {
        targetSha: "candidate-sha",
        targetVersion: "2026.7.1-beta.3",
      }),
    ).toThrow("tarball identity mismatch");
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, targetSha: "other-sha" })}\n`);
    expect(() =>
      validateParallelsRegistryPackageArtifact(artifactDir, {
        targetSha: "candidate-sha",
        targetVersion: "2026.7.1-beta.3",
      }),
    ).toThrow("artifact identity is invalid");
  });

  it("requires exact dependency tarball metadata in npm preflight manifests", () => {
    const manifest = {
      releaseTag: "v2026.7.1-beta.3",
      releaseSha: "candidate-sha",
      npmDistTag: "beta",
      tarballName: "openclaw-2026.7.1-beta.3.tgz",
      tarballSha256: "root-sha",
      dependencyTarballs: [
        {
          packageName: "@openclaw/ai",
          packageVersion: "2026.7.1-beta.3",
          tarballName: "openclaw-ai-2026.7.1-beta.3.tgz",
          tarballSha256: "ai-sha",
        },
      ],
    };
    const params = {
      tag: "v2026.7.1-beta.3",
      targetSha: "candidate-sha",
      npmDistTag: "beta",
    };

    expect(() => validatePreflightManifest(manifest, params)).not.toThrow();
    expect(() =>
      validatePreflightManifest({ ...manifest, dependencyTarballs: undefined }, params),
    ).toThrow("missing dependency tarball metadata");
    expect(() =>
      validatePreflightManifest(
        {
          ...manifest,
          dependencyTarballs: [
            {
              ...manifest.dependencyTarballs[0],
              tarballName: "../openclaw-ai.tgz",
            },
          ],
        },
        params,
      ),
    ).toThrow("invalid dependency tarball metadata");
  });

  it("prefers the complete core package tarball set with legacy manifest fallback", () => {
    const legacyTarball = coreTarball("ai");
    const gatewayProtocolTarball = coreTarball("gateway-protocol");

    expect(
      preflightCorePackageTarballs({
        corePackageTarballs: [legacyTarball, gatewayProtocolTarball],
        dependencyTarballs: [legacyTarball],
      }),
    ).toEqual([legacyTarball, gatewayProtocolTarball]);
    expect(preflightCorePackageTarballs({ dependencyTarballs: [legacyTarball] })).toEqual([
      legacyTarball,
    ]);
    expect(() =>
      preflightCorePackageTarballs({
        corePackageTarballs: null,
        dependencyTarballs: [legacyTarball],
      }),
    ).toThrow("missing dependency tarball metadata");
  });

  it("passes only root dependency tarballs to Parallels with legacy fallback", () => {
    const aiTarball = coreTarball("ai");
    const gatewayProtocolTarball = coreTarball("gateway-protocol");
    const gatewayClientTarball = coreTarball("gateway-client");
    const corePackageTarballs = [aiTarball, gatewayProtocolTarball, gatewayClientTarball];

    expect(
      preflightDependencyTarballs({
        corePackageTarballs,
        dependencyTarballs: [aiTarball],
      }),
    ).toEqual([aiTarball]);
    expect(preflightDependencyTarballs({ corePackageTarballs })).toEqual(corePackageTarballs);
    const manifest = {
      releaseTag: "v2026.7.1-beta.3",
      releaseSha: "candidate-sha",
      npmDistTag: "beta",
      tarballName: "openclaw-2026.7.1-beta.3.tgz",
      tarballSha256: "root-sha",
      corePackageTarballs,
      dependencyTarballs: [aiTarball],
    };
    const params = {
      tag: manifest.releaseTag,
      targetSha: manifest.releaseSha,
      npmDistTag: manifest.npmDistTag,
    };
    expect(() => validatePreflightManifest(manifest, params)).not.toThrow();
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
        params,
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
    const protectedRef = `release-publish/${headSha.slice(0, 12)}-123`;
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
    const source = {
      repository: repo,
      runId: "456",
      workflowRef: "main",
      workflowRun,
      isTrustedWorkflowAncestor: () => true,
    };
    const tagRef = {
      ref: `refs/tags/${protectedRef}`,
      object: { type: "commit", sha: headSha },
    };
    const api = (tag: unknown = tagRef, branches: unknown = []) => ({
      token: "",
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes(`/repos/${repo}/git/ref/tags/`)) {
          return jsonResponse(tag);
        }
        if (url.includes(`/repos/${repo}/git/matching-refs/heads/`)) {
          return jsonResponse(branches);
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    });

    it.each(["main"])("retains the exact %s npm workflow source", async (workflowRef) => {
      const isTrustedWorkflowAncestor = vi.fn(() => true);
      expect(
        await validateNpmPreflightRunSource({
          ...source,
          workflowRef,
          workflowRun: { ...workflowRun, headBranch: workflowRef },
          isTrustedWorkflowAncestor,
        }),
      ).toEqual({ status: "passed", headSha, workflowRef });
      expect(isTrustedWorkflowAncestor).toHaveBeenCalledWith(
        headSha,
        `refs/remotes/origin/${workflowRef}`,
      );
    });

    it("accepts and records a protected npm preflight tag from trusted main", async () => {
      const validated = await validateNpmPreflightRunSource(
        { ...source, workflowRun: { ...workflowRun, headBranch: protectedRef } },
        api(),
      );
      expect(validated).toEqual({ status: "passed", headSha, workflowRef: protectedRef });
      expect(buildPrepareCommand(parseArgs(["--tag", "v2026.7.1-beta.3"]), validated)).toContain(
        `'--ref' '${protectedRef}'`,
      );
    });

    it.each([
      ["moved", { ...tagRef, object: { type: "commit", sha: "b".repeat(40) } }],
      ["annotated", { ...tagRef, object: { type: "tag", sha: headSha } }],
      ["missing", null],
    ])("rejects a %s protected npm preflight tag", async (_label, tag) => {
      await expect(
        Promise.resolve().then(() =>
          validateNpmPreflightRunSource(
            {
              ...source,
              workflowRun: { ...workflowRun, headBranch: protectedRef },
            },
            api(tag),
          ),
        ),
      ).rejects.toThrow("protected release tooling tag");
    });

    it("rejects a same-name branch instead of inferring tag provenance", async () => {
      await expect(
        Promise.resolve().then(() =>
          validateNpmPreflightRunSource(
            {
              ...source,
              workflowRun: { ...workflowRun, headBranch: protectedRef },
            },
            api(tagRef, [{ ref: `refs/heads/${protectedRef}` }]),
          ),
        ),
      ).rejects.toThrow("ambiguous");
    });

    it.each([{}, [{}]])("rejects malformed branch lookup data %j", async (branches) => {
      await expect(
        validateNpmPreflightRunSource(
          {
            ...source,
            workflowRun: { ...workflowRun, headBranch: protectedRef },
          },
          api(tagRef, branches),
        ),
      ).rejects.toThrow("ambiguous");
    });

    it.each([503])("rejects unreadable tag provenance with HTTP %s", async (status) => {
      await expect(
        validateNpmPreflightRunSource(
          {
            ...source,
            workflowRun: { ...workflowRun, headBranch: protectedRef },
          },
          { token: "", fetchImpl: async () => jsonResponse({}, { status }) },
        ),
      ).rejects.toThrow(`failed with ${status}`);
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
      { headBranch: `release-publish/${"b".repeat(12)}-123` },
      { headBranch: `release-publish/${"a".repeat(12)}-0` },
      { workflowPath: ".github/workflows/openclaw-npm-release.yml@refs/heads/other" },
    ])("rejects mismatched npm preflight identity %j", async (override) => {
      await expect(
        Promise.resolve().then(() =>
          validateNpmPreflightRunSource(
            {
              ...source,
              workflowRun: { ...workflowRun, ...override },
            },
            api(),
          ),
        ),
      ).rejects.toThrow();
    });

    it("rejects npm preflight workflow code outside the trusted ref", async () => {
      await expect(
        Promise.resolve().then(() =>
          validateNpmPreflightRunSource({
            ...source,
            isTrustedWorkflowAncestor: () => false,
          }),
        ),
      ).rejects.toThrow("is not reachable from trusted main");
    });
  });

  it("requires run ids when dispatch is disabled", () => {
    expect(() => parseArgs(["--tag", "v2026.5.14-beta.3", "--skip-dispatch"])).toThrow(
      "--skip-dispatch requires --full-release-run",
    );
  });

  it("uses trusted main for regular release workflow tooling", () => {
    expect(parseArgs(["--tag", "v2026.5.14-beta.3"]).workflowRef).toBe("main");
    expect(() =>
      parseArgs(["--tag", "v2026.5.14-beta.3", "--workflow-ref", "release/2026.5.14"]),
    ).toThrow("--workflow-ref must be main");
  });

  it("keeps release validation context on the canonical release branch", () => {
    expect(releaseBranchForTag("v2026.7.1-beta.4")).toBe("release/2026.7.1");
    expect(releaseBranchForTag("v2026.7.1")).toBe("release/2026.7.1");
    expect(releaseBranchForTag("v2026.7.1-1")).toBe("release/2026.7.1-1");
    expect(releaseBranchForTag("v2026.7.1-alpha.4")).toBe("");
  });

  it.each([["--tag", "v2026.7.1-alpha.3"]])(
    "rejects retired alpha candidate inputs %j",
    (...flags) => {
      expect(() => parseArgs(flags)).toThrow("Alpha releases are retired;");
    },
  );

  it("rejects duplicate release candidate CLI options", () => {
    expect(() => parseArgs(["--tag", "v2026.5.14-beta.3", "--tag", "v2026.5.14-beta.4"])).toThrow(
      "--tag was provided more than once",
    );
  });

  it("requires stable validation evidence to include soak", () => {
    const stableManifest = {
      workflowName: "Full Release Validation",
      targetSha: "candidate-sha",
      releaseProfile: "stable",
      rerunGroup: "all",
      runReleaseSoak: "true",
      controls: { performanceBlocking: true },
    };

    expect(() =>
      validateFullManifest(stableManifest, {
        targetSha: "candidate-sha",
        releaseProfile: "stable",
      }),
    ).not.toThrow();

    expect(() =>
      validateFullManifest(
        {
          ...stableManifest,
          runReleaseSoak: "false",
        },
        {
          targetSha: "candidate-sha",
          releaseProfile: "stable",
        },
      ),
    ).toThrow("runReleaseSoak=true");
  });

  it.each(["full"])("keeps product performance advisory for %s release candidates", (profile) => {
    expect(() =>
      validateFullManifest(
        {
          workflowName: "Full Release Validation",
          targetSha: "candidate-sha",
          releaseProfile: profile,
          rerunGroup: "all",
          runReleaseSoak: profile === "beta" ? "false" : "true",
          controls: { performanceBlocking: false },
          childRuns: { productPerformance: { conclusion: "failure" } },
        },
        {
          targetSha: "candidate-sha",
          releaseProfile: profile,
        },
      ),
    ).not.toThrow();
  });

  it.each<{
    name: string;
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
    status?: string;
    error?: string;
  }>([
    {
      name: "stable FRV package proof with --workflow-sha and default workflow ref",
      coveragePolicy: "npm-stable-v1",
      status: "covered-by-full-release-validation",
    },
    {
      name: "beta coverage defers Telegram",
      coveragePolicy: "npm-beta-v1",
      profile: "beta",
      status: "deferred-postpublish",
    },
    {
      name: "admitted full coverage includes package Telegram without a named npm policy",
      profile: "full",
      source: "candidate-owned-admission-v1",
      status: "covered-by-full-release-validation",
    },
    {
      name: "historical full evidence needs supplemental qualification",
      profile: "full",
      status: "passed",
    },
    {
      name: "a separately packed tarball needs its own exact-byte qualification",
      coveragePolicy: "npm-stable-v1",
      separatePackage: true,
      status: "passed",
    },
    {
      name: "mock FRV proof cannot cover an explicit live-provider check",
      coveragePolicy: "npm-stable-v1",
      providerMode: "live-frontier",
      status: "passed",
    },
    {
      name: "waived Telegram does not count as package Telegram proof",
      coveragePolicy: "npm-stable-v1",
      waived: true,
      status: "passed",
    },
    { name: "missing Q transport", transport: "missing", error: "qualification ref" },
    { name: "moved Q transport", transport: "moved", error: "qualification ref" },
    {
      name: "legacy Q differs from C",
      qualificationSha: "a".repeat(40),
      qualificationRef: "release-ci/aaaaaaaaaaaa-123",
      error: "candidate-owned Full Release Validation",
    },
    {
      name: "main is not a frozen Q transport",
      qualificationRef: "main",
      error: "candidate-owned Full Release Validation",
    },
    {
      name: "dispatch race changed Q",
      returnedSha: "a".repeat(40),
      error: "Telegram qualification SHA mismatch",
    },
  ])("qualifies Telegram with frozen candidate evidence: $name", async (scenario) => {
    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
    const telegramOwner = source.match(/^async function runTelegramIfNeeded\([\s\S]*?^\}/mu)?.[0];
    const telegramCall = source.match(
      /const npmTelegram = await runTelegramIfNeeded\([\s\S]*?\);/u,
    )?.[0];
    expect(telegramOwner).toBeDefined();
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
                validationInputs: { telegramWaiver: scenario.waived ? "reviewed waiver" : "" },
              },
            },
          },
        },
      },
    ) as Promise<{ status: string; runId?: string }>;
    if (scenario.error) {
      await expect(completion).rejects.toThrow(scenario.error);
      expect(dispatchWorkflow).toHaveBeenCalledTimes(scenario.returnedSha ? 1 : 0);
      return;
    }
    const result = await completion;
    expect(result.status).toBe(scenario.status);
    if (scenario.status !== "passed") {
      expect(dispatchWorkflow).not.toHaveBeenCalled();
      expect(lookupQualificationRef).not.toHaveBeenCalled();
      expect(waitForSuccessfulRun).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({ status: "passed", runId: "333" });
    expect(lookupQualificationRef).toHaveBeenCalledWith(
      `repos/${options.repo}/git/ref/heads/${qualificationRef}`,
    );
    expect(dispatchWorkflow).toHaveBeenCalledOnce();
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      options.repo,
      "npm-telegram-beta-e2e.yml",
      qualificationRef,
      expect.objectContaining({
        harness_ref: targetSha,
        package_artifact_id: 9,
        package_artifact_run_id: "444",
        package_source_sha: "c".repeat(40),
      }),
    );
    expect(waitForSuccessfulRun).toHaveBeenCalledWith(options.repo, "333", {
      workflowName: "NPM Telegram Beta E2E",
      workflowRef: qualificationRef,
    });
  });

  it("binds SHA-pinned full validation evidence through its manifest", () => {
    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");

    expect(source).toContain("allowShaPinnedWorkflowRef: true");
    expect(source).toContain(
      "const fullValidationEvidence = await authenticateFullReleaseValidationEvidence({",
    );
    expect(source).not.toContain("runStrictReleaseEvidenceValidation");
    expect(source).toContain("expectedReleaseTag: options.tag");
    expect(source).toContain("refs/heads/main:refs/remotes/origin/main");
    expect(source).toContain(
      'fullValidationEvidence.source === "direct" && fullRun.headSha !== targetSha',
    );
  });

  it("stops parsing options after the argument terminator", () => {
    const options = parseArgs([
      "--tag",
      "v2026.5.14-beta.3",
      "--full-release-run",
      "111",
      "--npm-preflight-run",
      "222",
      "--skip-dispatch",
      "--",
      "--plugin-publish-scope",
      "selected",
    ]);

    expect(options.pluginPublishScope).toBe("all-publishable");
  });

  it("accepts package-manager argument separators before script options", () => {
    const options = parseArgs([
      "--",
      "--tag",
      "v2026.5.14-beta.3",
      "--full-release-run",
      "111",
      "--npm-preflight-run",
      "222",
      "--skip-dispatch",
      "--skip-parallels",
    ]);

    expect(options.tag).toBe("v2026.5.14-beta.3");
    expect(options.skipParallels).toBe(true);
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
        "--full-release-run",
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
    const workflow = parse(
      readFileSync(".github/workflows/openclaw-release-prepare.yml", "utf8"),
    ) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
    };
    for (const match of command.matchAll(/'-f' '([^=']+)=/gu)) {
      expect(workflow.on.workflow_dispatch.inputs).toHaveProperty(
        expectDefined(match[1], "release command input"),
      );
    }
  });

  it("validates Plugin SDK acknowledgement digests", () => {
    expect(() =>
      parseArgs(["--tag", "v2026.5.14-beta.3", "--plugin-sdk-api-acknowledgement", "ABC"]),
    ).toThrow("8-character lowercase digest");
  });

  it("rejects an unpinned Windows source release", () => {
    expect(() => parseArgs(["--tag", "v2026.5.14", "--windows-node-tag", "latest"])).toThrow(
      "--windows-node-tag must be an explicit version tag, not latest",
    );
  });

  it("validates the stable Windows source release and immutable installer digests", async () => {
    await expect(
      validateWindowsSourceRelease("v0.6.3", {
        fetchImpl: async () => windowsReleaseResponse(),
        token: "test-token",
        timeoutMs: 1234,
      }),
    ).resolves.toEqual({ tag: "v0.6.3", url: windowsReleaseUrl, assets: windowsAssets });
  });

  it.each([
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
  ])("rejects an invalid stable Windows source release", async (override, message) => {
    await expect(
      validateWindowsSourceRelease("v0.6.3", {
        fetchImpl: async () => windowsReleaseResponse(override),
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).rejects.toThrow(message);
  });

  it("requires explicit plugin names for selected plugin publish scope", () => {
    expect(() =>
      parseArgs(["--tag", "v2026.5.14-beta.3", "--plugin-publish-scope", "selected"]),
    ).toThrow("--plugin-publish-scope selected requires --plugins");
  });

  it("rejects selected plugin publish scope for release candidates", () => {
    expect(() =>
      parseArgs([
        "--tag",
        "v2026.5.14-beta.3",
        "--plugin-publish-scope",
        "selected",
        "--plugins",
        "@openclaw/diffs",
      ]),
    ).toThrow("release candidates publish OpenClaw with --plugin-publish-scope all-publishable");
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

  it("builds the complete immutable Telegram artifact identity tuple", () => {
    const input = {
      artifact: {
        digest: `sha256:${"a".repeat(64)}`,
        id: 123,
        name: "openclaw-npm-preflight-v2026.7.2-beta.1",
        workflowRunId: 456,
      },
      manifest: {
        packageVersion: "2026.7.2-beta.1",
        tarballName: "openclaw-2026.7.2-beta.1.tgz",
        tarballSha256: "b".repeat(64),
      },
      runAttempt: 2,
      runId: "456",
      sourceSha: "c".repeat(40),
    };
    expect(buildTelegramArtifactInputs(input)).toEqual({
      package_artifact_digest: "a".repeat(64),
      package_artifact_id: 123,
      package_artifact_name: "openclaw-npm-preflight-v2026.7.2-beta.1",
      package_artifact_run_attempt: 2,
      package_artifact_run_id: "456",
      package_file_name: "openclaw-2026.7.2-beta.1.tgz",
      package_sha256: "b".repeat(64),
      package_source_sha: "c".repeat(40),
      package_version: "2026.7.2-beta.1",
    });
    expect(() =>
      buildTelegramArtifactInputs({
        ...input,
        artifact: { ...input.artifact, workflowRunId: undefined },
        runId: "undefined",
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
