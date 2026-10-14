import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_EVIDENCE_REPORTS,
  collectDependencyEvidenceSummaryCounts,
  createDependencyEvidenceManifest,
  generateDependencyReleaseEvidence,
  parseArgs,
  renderDependencyEvidenceStepSummary,
  renderDependencyEvidenceSummary,
  resolvePreviousReleaseTag,
  resolveReleaseTag,
} from "../../scripts/generate-dependency-release-evidence.mts";

async function writeJson(dir: string, fileName: string, value: unknown) {
  await writeFile(path.join(dir, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runCli(args: string[], env = process.env) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/generate-dependency-release-evidence.mts", ...args],
    {
      cwd: path.resolve("."),
      env,
      encoding: "utf8",
    },
  );
}

function expectNoNodeStack(stderr: string) {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

describe("generate-dependency-release-evidence", () => {
  it("creates the dependency evidence manifest shape", () => {
    const manifest = createDependencyEvidenceManifest({
      generatedAt: "2026-05-13T00:00:00.000Z",
      releaseTag: "v2026.5.13-beta.1",
      releaseRef: "v2026.5.13-beta.1",
      releaseSha: "abc123",
      npmDistTag: "beta",
      packageVersion: "2026.5.13-beta.1",
      workflowRunId: "123",
      workflowRunAttempt: "2",
      dependencyChangeBaseRef: "v2026.5.1",
    });

    expect(manifest).toEqual({
      schemaVersion: 1,
      generatedAt: "2026-05-13T00:00:00.000Z",
      releaseTag: "v2026.5.13-beta.1",
      releaseRef: "v2026.5.13-beta.1",
      releaseSha: "abc123",
      npmDistTag: "beta",
      packageName: "openclaw",
      packageVersion: "2026.5.13-beta.1",
      workflowRunId: "123",
      workflowRunAttempt: "2",
      dependencyChangeBaseRef: "v2026.5.1",
      reports: DEPENDENCY_EVIDENCE_REPORTS,
    });
  });

  it("records production advisories as non-blocking evidence alongside the npm lock report", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-release-lock-evidence-test-"));
    try {
      const source = path.join(dir, "source");
      const outputDir = path.join(dir, "evidence");
      const stepSummary = path.join(dir, "step-summary.md");
      await mkdir(source);
      await writeJson(source, "package.json", { version: "2026.9.1" });
      const reportData: Record<string, unknown> = {
        "dependency-vulnerability-gate.json": {
          blockers: [],
          findings: [
            {
              id: "GHSA-rfgv-xxqx-mfg5",
              packageName: "undici",
              severity: "high",
              graph: "production",
              lockfile: ".github/release/vercel-cli/package-lock.json",
              source: "github-repository",
              malware: false,
              url: "https://github.com/advisories/GHSA-rfgv-xxqx-mfg5",
            },
          ],
          coverage: {
            npm: "checked",
            upstream: {
              status: "checked",
              source: "fixture",
              mappedPackageVersions: 0,
              packageVersions: 0,
              checkedRepositories: 0,
              repositories: 0,
              issues: [],
            },
          },
        },
        "transitive-manifest-risk-report.json": {
          findingCount: 0,
          metadataFailures: [],
          workspaceExcludedFindingCount: 0,
        },
        "dependency-ownership-surface-report.json": {
          summary: { buildRiskPackageCount: 0, lockfilePackageCount: 0 },
        },
        "dependency-changes-report.json": {
          summary: {
            addedPackages: 0,
            changedPackages: 0,
            dependencyFileChanges: 0,
            removedPackages: 0,
          },
        },
        "npm-package-locks.json": {
          packagesWithOmittedWorkspaceDependencies: 1,
          packages: [
            { bundleRuntimeDependencies: false, omittedWorkspaceDependencies: ["@openclaw/ai"] },
            { bundleRuntimeDependencies: true, omittedWorkspaceDependencies: [] },
          ],
        },
      };
      const commands: string[] = [];
      const result = await generateDependencyReleaseEvidence({
        rootDir: source,
        outputDir,
        releaseRef: "v2026.9.1",
        npmDistTag: "latest",
        baseRef: "v2026.8.31",
        githubOutput: "",
        githubStepSummary: stepSummary,
        execFileSyncImpl: (command, commandArgs, options) => {
          const args = commandArgs ?? [];
          if (command === "git") {
            return "a".repeat(40);
          }
          expect(command).toBe("pnpm");
          expect(options).toMatchObject({ cwd: path.resolve(".") });
          expect(args[args.indexOf("--root") + 1]).toBe(source);
          commands.push(args[0]!);
          const jsonPath = args[args.indexOf("--json") + 1]!;
          const value = reportData[path.basename(jsonPath)];
          if (!value) {
            throw new Error(`Unexpected report ${jsonPath}`);
          }
          writeFileSync(jsonPath, JSON.stringify(value));
          writeFileSync(args[args.indexOf("--markdown") + 1]!, "# Fixture report\n");
          return null;
        },
      });
      expect(commands).toContain("deps:npm-lock:report");
      const manifest = JSON.parse(
        await readFile(path.join(outputDir, "dependency-evidence-manifest.json"), "utf8"),
      );
      expect(manifest.reports).toContainEqual({
        name: "npm package-lock mirrors",
        command: "pnpm deps:npm-lock:report",
        policy: "report-only",
        json: "npm-package-locks.json",
        markdown: "npm-package-locks.md",
      });
      expect(result.counts).toMatchObject({
        npmLockPackages: 2,
        npmLocklessPackages: 1,
        npmPartialLockPackages: 1,
      });
      for (const file of [stepSummary, path.join(outputDir, "dependency-evidence-summary.md")]) {
        const rendered = await readFile(file, "utf8");
        expect(rendered).toContain("- npm package-lock mirrors: 2");
        expect(rendered).toContain("- Lockless packages (bundleRuntimeDependencies=false): 1");
        expect(rendered).toContain("- Partial npm package-lock mirrors (workspace omissions): 1");
        expect(rendered).toContain("- Known malware findings (release-blocking): 0");
        expect(rendered).toMatch(/#+ Non-blocking advisory findings\n\nAdvisories never block/u);
        expect(rendered).toContain(
          "- HIGH `undici` (.github/release/vercel-cli/package-lock.json; production) id=GHSA-rfgv-xxqx-mfg5 source=github-repository https://github.com/advisories/GHSA-rfgv-xxqx-mfg5",
        );
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("uses a synthetic release tag for validation-only SHA preflight input", () => {
    expect(
      resolveReleaseTag({
        releaseRef: "0123456789abcdef0123456789abcdef01234567",
        packageVersion: "2026.5.13",
      }),
    ).toBe("v2026.5.13");
    expect(
      resolveReleaseTag({
        releaseRef: "v2026.5.13-beta.1",
        packageVersion: "2026.5.13-beta.1",
      }),
    ).toBe("v2026.5.13-beta.1");
  });

  it("rejects missing dependency evidence CLI option values", () => {
    const missingValues = [
      ["--output-dir", "--release-ref"],
      ["--output-dir", "-h"],
      ["--release-ref", "--npm-dist-tag"],
      ["--release-ref", "-h"],
      ["--npm-dist-tag", "-h"],
      ["--base-ref", undefined],
      ["--base-ref", "-h"],
      ["--github-output", "--github-step-summary"],
      ["--github-output", "-h"],
    ] satisfies Array<[string, string | undefined]>;
    for (const [flag, value] of missingValues) {
      expect(() => parseArgs(value === undefined ? [flag] : [flag, value])).toThrow(
        `Expected ${flag} <value>.`,
      );
    }
  });

  it("rejects duplicate dependency evidence CLI options", () => {
    for (const flag of [
      "--root",
      "--output-dir",
      "--release-ref",
      "--npm-dist-tag",
      "--base-ref",
      "--github-output",
      "--github-step-summary",
    ]) {
      expect(() => parseArgs([flag, "first", flag, "second"])).toThrow(
        `${flag} was provided more than once.`,
      );
    }
  });

  it("prints CLI help without generating evidence", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Usage: node --import tsx scripts/generate-dependency-release-evidence.mts",
    );
    expect(result.stderr).toBe("");
  });

  it("reports CLI argument errors without a Node stack trace", () => {
    for (const args of [["--wat"], ["wat", "--help"]]) {
      const result = runCli(args);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(
        `Unsupported argument: ${args[0]}\n[dependency-release-evidence] FAILED (exit 1)`,
      );
      expectNoNodeStack(result.stderr);
    }
  });

  it.skipIf(process.platform === "win32")(
    "uses trusted report tooling for a separate target and retains known-malware evidence",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "openclaw-release-dependency-failure-test-"));
      try {
        const binDir = path.join(dir, "bin");
        const outputDir = path.join(dir, "evidence");
        const sourceDir = path.join(dir, "candidate");
        const marker = path.join(dir, "pnpm-cwd");
        const githubOutput = path.join(dir, "github-output");
        await mkdir(binDir);
        await mkdir(sourceDir);
        await writeJson(sourceDir, "package.json", { version: "2026.5.13" });
        await writeFile(
          path.join(binDir, "git"),
          '#!/usr/bin/env node\nconsole.log("a".repeat(40));\n',
          { mode: 0o755 },
        );
        await writeFile(
          path.join(binDir, "pnpm"),
          [
            "#!/usr/bin/env node",
            'const { writeFileSync } = require("node:fs");',
            "const args = process.argv.slice(2);",
            "writeFileSync(process.env.RELEASE_TEST_MARKER, process.cwd());",
            'if (args[0] !== "deps:vuln:gate") throw new Error("Wrong report command");',
            'if (args[args.indexOf("--root") + 1] !== process.env.RELEASE_TEST_SOURCE_ROOT) throw new Error("Wrong report target");',
            'writeFileSync(args[args.indexOf("--json") + 1], JSON.stringify({ blockers: [{ id: "GHSA-fixture", malware: true }] }));',
            'writeFileSync(args[args.indexOf("--markdown") + 1], "# Known malware evidence\\n");',
            "process.exitCode = 1;",
          ].join("\n"),
          { mode: 0o755 },
        );

        const result = runCli(
          [
            "--root",
            sourceDir,
            "--output-dir",
            outputDir,
            "--release-ref",
            "v2026.5.13",
            "--npm-dist-tag",
            "latest",
            "--base-ref",
            "v2026.5.1",
            "--github-output",
            githubOutput,
            "--github-step-summary",
            "",
          ],
          {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            RELEASE_TEST_SOURCE_ROOT: sourceDir,
            RELEASE_TEST_MARKER: marker,
          },
        );

        await expect(readFile(marker, "utf8")).resolves.toBe(path.resolve("."));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Command failed: pnpm deps:vuln:gate");
        await expect(readFile(githubOutput, "utf8")).resolves.toBe(`dir=${outputDir}\n`);
        await expect(
          readFile(path.join(outputDir, "dependency-vulnerability-gate.json"), "utf8"),
        ).resolves.toBe(JSON.stringify({ blockers: [{ id: "GHSA-fixture", malware: true }] }));
        await expect(
          readFile(path.join(outputDir, "dependency-vulnerability-gate.md"), "utf8"),
        ).resolves.toBe("# Known malware evidence\n");
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

  it.each([true, false])(
    "fetches complete target release history without unrelated refs (shallow=%s)",
    async (shallow) => {
      const dir = await mkdtemp(path.join(tmpdir(), "openclaw-release-history-test-"));
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Release test",
            "-c",
            "user.email=release-test@example.invalid",
            "-c",
            "commit.gpgSign=false",
            ...args,
          ],
          { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
      try {
        const origin = path.join(dir, "origin");
        const target = path.join(dir, "target");
        await mkdir(origin);
        await mkdir(target);
        git(origin, "init", "--quiet", "--initial-branch=main");
        git(origin, "config", "uploadpack.allowFilter", "true");
        git(origin, "commit", "--quiet", "--allow-empty", "-m", "previous release");
        git(origin, "tag", "--no-sign", "-a", "v2026.5.1", "-m", "previous release");
        git(origin, "commit", "--quiet", "--allow-empty", "-m", "release target");
        const releaseSha = git(origin, "rev-parse", "HEAD");
        git(origin, "branch", "release-target");
        git(origin, "commit", "--quiet", "--allow-empty", "-m", "later main release");
        git(origin, "tag", "--no-sign", "v2026.6.1");
        git(origin, "tag", "--no-sign", "release-tooling-unrelated");
        git(origin, "branch", "unrelated");
        git(target, "init", "--quiet", "--initial-branch=consumer");
        git(target, "remote", "add", "origin", pathToFileURL(origin).href);
        git(target, "fetch", "--no-tags", ...(shallow ? ["--depth=1"] : []), "origin", releaseSha);
        git(target, "checkout", "--quiet", "--detach", "FETCH_HEAD");

        expect(() => resolvePreviousReleaseTag({ rootDir: target, fetchOnMiss: false })).toThrow(
          "Could not resolve a previous reachable release tag",
        );
        expect(
          git(target, "for-each-ref", "--format=%(refname)", "refs/tags", "refs/remotes"),
        ).toBe("");
        expect(resolvePreviousReleaseTag({ rootDir: target })).toBe("v2026.5.1");
        expect(git(target, "rev-parse", "HEAD")).toBe(releaseSha);
        expect(git(target, "rev-parse", "--is-shallow-repository")).toBe("false");
        expect(git(target, "rev-list", "--count", "HEAD")).toBe("2");
        expect(
          git(target, "for-each-ref", "--format=%(refname)", "refs/tags", "refs/remotes").split(
            "\n",
          ),
        ).toEqual(["refs/tags/v2026.5.1", "refs/tags/v2026.6.1"]);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

  it.each([
    {
      status: "partial",
      mappedPackageVersions: 100,
      checkedRepositories: 1,
      issues: [
        { subject: "unmapped-package@1.0.0", reason: "Unsupported repository URL" },
        { subject: "example/tool", reason: "GitHub API rate limit exceeded" },
      ],
    },
  ])(
    "collects report counts and renders $status upstream coverage in both summaries",
    async (upstream) => {
      const dir = await mkdtemp(path.join(tmpdir(), "openclaw-release-dependency-evidence-test-"));
      try {
        const coverage = {
          npm: "checked",
          upstream: {
            source: "github-public-repository-advisories",
            packageVersions: 101,
            repositories: 2,
            ...upstream,
          },
        };
        const findings = [
          { id: "GHSA-malware", lockfile: "pnpm-lock.yaml", source: "npm-bulk", malware: true },
          {
            id: "GHSA-malware",
            lockfile: ".github/release/vercel-cli/package-lock.json",
            source: "github-repository",
            matchedVersions: ["1.0.0", "1.1.0"],
            malware: true,
          },
          {
            id: "GHSA-report",
            packageName: "report-pkg",
            severity: "high",
            graph: "production",
            lockfile: ".github/release/clawhub-cli/package-lock.json",
            source: "github-repository",
            matchedVersions: ["2.0.0"],
            malware: false,
            url: null,
          },
        ];
        await writeJson(dir, "dependency-vulnerability-gate.json", {
          blockers: findings.slice(0, 2),
          findings,
          coverage,
        });
        await writeJson(dir, "transitive-manifest-risk-report.json", {
          findingCount: 17,
          workspaceExcludedFindingCount: 3,
          metadataFailures: [{ packageName: "missing" }],
        });
        await writeJson(dir, "dependency-ownership-surface-report.json", {
          summary: {
            lockfilePackageCount: 101,
            buildRiskPackageCount: 8,
          },
        });
        await writeJson(dir, "dependency-changes-report.json", {
          summary: {
            dependencyFileChanges: 4,
            addedPackages: 5,
            removedPackages: 6,
            changedPackages: 7,
          },
        });

        await writeJson(dir, "npm-package-locks.json", {
          packagesWithOmittedWorkspaceDependencies: 2,
          packages: [
            { bundleRuntimeDependencies: false, omittedWorkspaceDependencies: ["@openclaw/ai"] },
            {
              bundleRuntimeDependencies: true,
              omittedWorkspaceDependencies: ["@openclaw/gateway-protocol"],
            },
            { bundleRuntimeDependencies: false, omittedWorkspaceDependencies: [] },
          ],
        });
        const counts = await collectDependencyEvidenceSummaryCounts(dir);
        expect(counts).toEqual({
          malwareBlockers: 2,
          vulnerabilityFindings: 3,
          advisories: [findings[2]],
          vulnerabilityCoverage: coverage,
          upstreamOnlyVulnerabilityFindings: 2,
          transitiveRiskSignals: 17,
          workspaceExcludedTransitiveSignals: 3,
          transitiveMetadataFailures: 1,
          ownershipLockfilePackages: 101,
          ownershipBuildRiskPackages: 8,
          dependencyFileChanges: 4,
          dependencyAddedPackages: 5,
          dependencyRemovedPackages: 6,
          dependencyChangedPackages: 7,
          npmLockPackages: 3,
          npmLocklessPackages: 2,
          npmPartialLockPackages: 2,
        });

        const summary = renderDependencyEvidenceSummary({
          releaseTag: "v2026.5.13",
          releaseSha: "abc123",
          baseRef: "v2026.5.1",
          counts,
        });
        expect(summary).toContain("- Transitive manifest reported risk signals: 17");
        expect(summary).toContain("- Dependency change baseline: `v2026.5.1`");
        expect(summary).toContain("- Resolved package changes: +5 -6 changed 7");

        const stepSummary = renderDependencyEvidenceStepSummary({
          evidenceArtifactName: "openclaw-release-dependency-evidence-v2026.5.13",
          baseRef: "v2026.5.1",
          counts,
        });
        expect(stepSummary).toContain(
          "- Evidence artifact: `openclaw-release-dependency-evidence-v2026.5.13`",
        );
        expect(summary).toContain("- `npm-package-locks.md`");
        for (const rendered of [summary, stepSummary]) {
          expect(rendered).toContain("- npm package-lock mirrors: 3");
          expect(rendered).toContain("- Lockless packages (bundleRuntimeDependencies=false): 2");
          expect(rendered).toContain("- Partial npm package-lock mirrors (workspace omissions): 2");
          expect(rendered).toContain("- npm advisory coverage: checked");
          expect(rendered).toContain(
            `- Upstream public repository advisory coverage: ${upstream.status}`,
          );
          expect(rendered).toContain("- Upstream source: `github-public-repository-advisories`");
          expect(rendered).toContain(
            `- Upstream package versions mapped: ${upstream.mappedPackageVersions}/101`,
          );
          expect(rendered).toContain(
            `- Upstream repositories checked: ${upstream.checkedRepositories}/2`,
          );
          expect(rendered).toContain("- Known malware findings (release-blocking): 2");
          expect(rendered).toContain("- Non-blocking advisory findings: 1");
          expect(rendered).toContain(
            "- HIGH `report-pkg` (.github/release/clawhub-cli/package-lock.json; production) id=GHSA-report source=github-repository\n",
          );
          expect(rendered).toContain("- Advisory vulnerability total findings: 3");
          expect(rendered).toContain("- Upstream-only vulnerability findings: 2");
          expect(rendered).toContain(`- Upstream coverage issues: ${upstream.issues.length}`);
          for (const { subject, reason } of upstream.issues) {
            expect(rendered).toContain(`  - ${subject}: ${reason}`);
          }
          expect(rendered).toContain(
            "Coverage is limited to these advisory sources; zero findings do not prove that dependencies are unaffected.",
          );
        }
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );
});
