import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import {
  generateDependencyReleaseEvidence,
  resolvePreviousReleaseTag,
} from "../../scripts/generate-dependency-release-evidence.mts";

async function writeJson(dir: string, fileName: string, value: unknown) {
  await writeFile(path.join(dir, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const readText = (dir: string, name: string) => readFile(path.join(dir, name), "utf8");
const writeExecutable = (dir: string, name: string, source: string) =>
  writeFile(path.join(dir, name), `#!/usr/bin/env node\n${source}`, { mode: 0o755 });

function runCli(args: readonly string[], env = process.env) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/generate-dependency-release-evidence.mts", ...args],
    { cwd: path.resolve("."), env, encoding: "utf8" },
  );
}

function makeReports(vulnerability: unknown): Record<string, unknown> {
  return {
    "dependency-vulnerability-gate.json": vulnerability,
    "transitive-manifest-risk-report.json": {
      findingCount: 0,
      workspaceExcludedFindingCount: 0,
      metadataFailures: [],
    },
    "dependency-ownership-surface-report.json": {
      summary: { lockfilePackageCount: 0, buildRiskPackageCount: 0 },
    },
    "dependency-changes-report.json": {
      summary: {
        dependencyFileChanges: 0,
        addedPackages: 0,
        removedPackages: 0,
        changedPackages: 0,
      },
    },
    "npm-package-locks.json": {
      packagesWithOmittedWorkspaceDependencies: 1,
      packages: [false, true].map((bundleRuntimeDependencies) => ({ bundleRuntimeDependencies })),
    },
  };
}

async function tempDir(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { force: true, recursive: true }));
  return dir;
}

function expectContains(text: string, ...fragments: string[]) {
  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
}

it.each([false, true])(
  "generates advisory, lock and upstream evidence (malware=%s)",
  async (malware) => {
    const dir = await tempDir("release-evidence-");
    const source = path.join(dir, "source");
    const outputDir = path.join(dir, "evidence");
    const stepPath = path.join(dir, "step-summary.md");
    await mkdir(source);
    await writeJson(source, "package.json", { version: "2026.5.13" });
    const upstream = {
      source: "github-public-repository-advisories",
      packageVersions: 101,
      repositories: 2,
      status: "partial",
      mappedPackageVersions: 100,
      checkedRepositories: 1,
      issues: [
        { subject: "unmapped-package@1.0.0", reason: "Unsupported repository URL" },
        { subject: "example/tool", reason: "GitHub API rate limit exceeded" },
      ],
    };
    const coverage = { npm: "checked", upstream };
    const advisory = {
      id: "GHSA-report",
      packageName: "fixture",
      severity: "high",
      graph: "production",
      lockfile: ".github/release/vercel-cli/package-lock.json",
      source: "github-repository",
      malware: false,
      url: malware ? null : "https://github.com/advisories/GHSA-report",
    };
    const blockers = malware
      ? [
          { id: "GHSA-malware", lockfile: "pnpm-lock.yaml", source: "npm-bulk", malware: true },
          {
            id: "GHSA-malware",
            lockfile: advisory.lockfile,
            source: "github-repository",
            malware: true,
          },
        ]
      : [];
    const findings = [...blockers, advisory];
    const reports = makeReports({
      blockers,
      findings,
      coverage,
    });
    const releaseRef = malware ? "a".repeat(40) : "v2026.5.13-beta.1";
    const result = await generateDependencyReleaseEvidence({
      rootDir: source,
      outputDir,
      releaseRef,
      npmDistTag: "latest",
      baseRef: "v2026.5.1",
      githubOutput: "",
      githubStepSummary: stepPath,
      execFileSyncImpl: (command, commandArgs) => {
        if (command === "git") {
          return "a".repeat(40);
        }
        const args = commandArgs ?? [];
        const jsonPath = args[args.indexOf("--json") + 1]!;
        const report = reports[path.basename(jsonPath)];
        if (!report) {
          throw new Error(`Unexpected report ${jsonPath}`);
        }
        writeFileSync(jsonPath, JSON.stringify(report));
        writeFileSync(args[args.indexOf("--markdown") + 1]!, "# Fixture report\n");
        return null;
      },
    });
    expect(result.manifest.releaseTag).toBe(malware ? "v2026.5.13" : releaseRef);
    expect(result.counts).toMatchObject({
      malwareBlockers: malware ? 2 : 0,
      vulnerabilityFindings: malware ? 3 : 1,
      advisories: [advisory],
      vulnerabilityCoverage: coverage,
      upstreamOnlyVulnerabilityFindings: malware ? 2 : 1,
      npmLockPackages: 2,
      npmLocklessPackages: 1,
      npmPartialLockPackages: 1,
    });
    const summary = await readText(outputDir, "dependency-evidence-summary.md");
    const stepSummary = await readFile(stepPath, "utf8");
    expect(stepSummary).toContain(
      `- Evidence artifact: \`openclaw-release-dependency-evidence-${releaseRef}\``,
    );
    for (const rendered of [summary, stepSummary]) {
      expect(rendered).toMatch(/#+ Non-blocking advisory findings\n\nAdvisories never block/u);
      expectContains(
        rendered,
        `- Known malware findings (release-blocking): ${malware ? 2 : 0}`,
        "- npm advisory coverage: checked",
        "- Upstream public repository advisory coverage: partial",
        `- HIGH \`fixture\` (.github/release/vercel-cli/package-lock.json; production) id=GHSA-report source=github-repository${malware ? "\n" : " https://github.com/advisories/GHSA-report"}`,
        "Coverage is limited to these advisory sources; zero findings do not prove that dependencies are unaffected.",
      );
      for (const { subject, reason } of upstream.issues) {
        expect(rendered).toContain(`  - ${subject}: ${reason}`);
      }
    }
  },
);

it("prints CLI help without generating evidence", () => {
  const result = runCli(["--help"]);

  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout).toContain(
    "Usage: node --import tsx scripts/generate-dependency-release-evidence.mts",
  );
});

it.each([
  [["--wat"], "Unsupported argument: --wat"],
  [["--base-ref"], "Expected --base-ref <value>."],
] as const)("reports CLI argument errors without a Node stack trace: %s", (args, error) => {
  const result = runCli(args);

  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(result.stderr.trim()).toBe(`${error}\n[dependency-release-evidence] FAILED (exit 1)`);
  expect(result.stderr).not.toMatch(/Node\.js|\n {4}at /u);
});

it.skipIf(process.platform === "win32")(
  "uses trusted report tooling for a separate target and retains known-malware evidence",
  async () => {
    const dir = await tempDir("openclaw-release-dependency-failure-test-");
    const binDir = path.join(dir, "bin");
    const outputDir = path.join(dir, "evidence");
    const sourceDir = path.join(dir, "candidate");
    const marker = path.join(dir, "pnpm-cwd");
    const githubOutput = path.join(dir, "github-output");
    await Promise.all([mkdir(binDir), mkdir(sourceDir)]);
    await writeJson(sourceDir, "package.json", { version: "2026.5.13" });
    await writeExecutable(binDir, "git", 'console.log("a".repeat(40));\n');
    await writeExecutable(
      binDir,
      "pnpm",
      [
        'const { writeFileSync } = require("node:fs");',
        "const args = process.argv.slice(2);",
        "writeFileSync(process.env.RELEASE_TEST_MARKER, process.cwd());",
        'if (args[0] !== "deps:vuln:gate") throw new Error("Wrong report command");',
        'if (args[args.indexOf("--root") + 1] !== process.env.RELEASE_TEST_SOURCE_ROOT) throw new Error("Wrong report target");',
        'writeFileSync(args[args.indexOf("--json") + 1], JSON.stringify({ blockers: [{ id: "GHSA-fixture", malware: true }] }));',
        'writeFileSync(args[args.indexOf("--markdown") + 1], "# Known malware evidence\\n");',
        "process.exitCode = 1;",
      ].join("\n"),
    );

    const result = runCli(
      Object.entries({
        root: sourceDir,
        "output-dir": outputDir,
        "release-ref": "v2026.5.13",
        "npm-dist-tag": "latest",
        "base-ref": "v2026.5.1",
        "github-output": githubOutput,
        "github-step-summary": "",
      }).flatMap(([flag, value]) => [`--${flag}`, value]),
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
    await expect(readText(outputDir, "dependency-vulnerability-gate.json")).resolves.toBe(
      JSON.stringify({ blockers: [{ id: "GHSA-fixture", malware: true }] }),
    );
    await expect(readText(outputDir, "dependency-vulnerability-gate.md")).resolves.toBe(
      "# Known malware evidence\n",
    );
  },
);

it.each([true, false])(
  "fetches complete target release history without unrelated refs (shallow=%s)",
  async (shallow) => {
    const dir = await tempDir("openclaw-release-history-test-");
    const gitConfig = [
      "core.hooksPath=/dev/null",
      "user.name=Release test",
      "user.email=release-test@example.invalid",
      "commit.gpgSign=false",
    ].flatMap((value) => ["-c", value]);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", [...gitConfig, ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const origin = path.join(dir, "origin");
    const target = path.join(dir, "target");
    const refs = () =>
      git(target, "for-each-ref", "--format=%(refname)", "refs/tags", "refs/remotes");
    await Promise.all([mkdir(origin), mkdir(target)]);
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
    expect(refs()).toBe("");
    expect(resolvePreviousReleaseTag({ rootDir: target })).toBe("v2026.5.1");
    expect(git(target, "rev-parse", "HEAD")).toBe(releaseSha);
    expect(git(target, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(git(target, "rev-list", "--count", "HEAD")).toBe("2");
    expect(refs().split("\n")).toEqual(["refs/tags/v2026.5.1", "refs/tags/v2026.6.1"]);
  },
);
