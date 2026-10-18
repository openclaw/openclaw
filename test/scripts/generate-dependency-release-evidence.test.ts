import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import {
  generateDependencyReleaseEvidence,
  parseArgs,
  resolvePreviousReleaseTag,
  resolveReleaseTag,
} from "../../scripts/generate-dependency-release-evidence.mts";

async function writeJson(dir: string, fileName: string, value: unknown) {
  await writeFile(path.join(dir, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const readText = (dir: string, name: string) => readFile(path.join(dir, name), "utf8");
const writeExecutable = (dir: string, name: string, source: string) =>
  writeFile(path.join(dir, name), `#!/usr/bin/env node\n${source}`, { mode: 0o755 });

function runCli(args: string[], env = process.env) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/generate-dependency-release-evidence.mts", ...args],
    { cwd: path.resolve("."), env, encoding: "utf8" },
  );
}

function advisory(packageName: string, id: string, tool: string, url: string | null = null) {
  return {
    id,
    packageName,
    severity: "high",
    graph: "production",
    lockfile: `.github/release/${tool}/package-lock.json`,
    source: "github-repository",
    malware: false,
    url,
  };
}

function makeReports(vulnerability: unknown, populated = false): Record<string, unknown> {
  const count = (value: number) => (populated ? value : 0);
  return {
    "dependency-vulnerability-gate.json": vulnerability,
    "transitive-manifest-risk-report.json": {
      findingCount: count(17),
      workspaceExcludedFindingCount: count(3),
      metadataFailures: populated ? [{}] : [],
    },
    "dependency-ownership-surface-report.json": {
      summary: { lockfilePackageCount: count(101), buildRiskPackageCount: count(8) },
    },
    "dependency-changes-report.json": {
      summary: {
        dependencyFileChanges: count(4),
        addedPackages: count(5),
        removedPackages: count(6),
        changedPackages: count(7),
      },
    },
    "npm-package-locks.json": {
      packagesWithOmittedWorkspaceDependencies: populated ? 2 : 1,
      packages: (populated ? [false, true, false] : [false, true]).map(
        (bundleRuntimeDependencies) => ({ bundleRuntimeDependencies }),
      ),
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
    const findings = malware
      ? [
          { id: "GHSA-malware", lockfile: "pnpm-lock.yaml", source: "npm-bulk", malware: true },
          {
            id: "GHSA-malware",
            lockfile: ".github/release/vercel-cli/package-lock.json",
            source: "github-repository",
            malware: true,
          },
          advisory("report-pkg", "GHSA-report", "clawhub-cli"),
        ]
      : [
          advisory(
            "undici",
            "GHSA-rfgv-xxqx-mfg5",
            "vercel-cli",
            "https://github.com/advisories/GHSA-rfgv-xxqx-mfg5",
          ),
        ];
    const reports = makeReports(
      { blockers: malware ? findings.slice(0, 2) : [], findings, coverage },
      malware,
    );
    const commands: string[] = [];
    const result = await generateDependencyReleaseEvidence({
      rootDir: source,
      outputDir,
      releaseRef: "v2026.5.13",
      npmDistTag: "latest",
      baseRef: "v2026.5.1",
      githubOutput: "",
      githubStepSummary: stepPath,
      execFileSyncImpl: (command, commandArgs, options) => {
        if (command === "git") {
          return "a".repeat(40);
        }
        const args = commandArgs ?? [];
        expect(command).toBe("pnpm");
        expect(options).toMatchObject({ cwd: path.resolve(".") });
        expect(args[args.indexOf("--root") + 1]).toBe(source);
        commands.push(args[0]!);
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
    expect(commands).toContain("deps:npm-lock:report");
    const manifest = JSON.parse(await readText(outputDir, "dependency-evidence-manifest.json"));
    expect(manifest.reports).toContainEqual({
      name: "npm package-lock mirrors",
      command: "pnpm deps:npm-lock:report",
      policy: "report-only",
      json: "npm-package-locks.json",
      markdown: "npm-package-locks.md",
    });
    expect(result.counts).toEqual({
      malwareBlockers: malware ? 2 : 0,
      vulnerabilityFindings: malware ? 3 : 1,
      advisories: malware ? [findings[2]] : findings,
      vulnerabilityCoverage: coverage,
      upstreamOnlyVulnerabilityFindings: malware ? 2 : 1,
      transitiveRiskSignals: malware ? 17 : 0,
      workspaceExcludedTransitiveSignals: malware ? 3 : 0,
      transitiveMetadataFailures: malware ? 1 : 0,
      ownershipLockfilePackages: malware ? 101 : 0,
      ownershipBuildRiskPackages: malware ? 8 : 0,
      dependencyFileChanges: malware ? 4 : 0,
      dependencyAddedPackages: malware ? 5 : 0,
      dependencyRemovedPackages: malware ? 6 : 0,
      dependencyChangedPackages: malware ? 7 : 0,
      npmLockPackages: malware ? 3 : 2,
      npmLocklessPackages: malware ? 2 : 1,
      npmPartialLockPackages: malware ? 2 : 1,
    });
    const summary = await readText(outputDir, "dependency-evidence-summary.md");
    const stepSummary = await readFile(stepPath, "utf8");
    expectContains(
      summary,
      `- Transitive manifest reported risk signals: ${malware ? 17 : 0}`,
      "- Dependency change baseline: `v2026.5.1`",
      `- Resolved package changes: +${malware ? 5 : 0} -${malware ? 6 : 0} changed ${malware ? 7 : 0}`,
      "- `npm-package-locks.md`",
    );
    expect(stepSummary).toContain(
      "- Evidence artifact: `openclaw-release-dependency-evidence-v2026.5.13`",
    );
    for (const rendered of [summary, stepSummary]) {
      expect(rendered).toMatch(/#+ Non-blocking advisory findings\n\nAdvisories never block/u);
      expectContains(
        rendered,
        `- npm package-lock mirrors: ${malware ? 3 : 2}`,
        `- Lockless packages (bundleRuntimeDependencies=false): ${malware ? 2 : 1}`,
        `- Partial npm package-lock mirrors (workspace omissions): ${malware ? 2 : 1}`,
        `- Known malware findings (release-blocking): ${malware ? 2 : 0}`,
        "- npm advisory coverage: checked",
        "- Upstream public repository advisory coverage: partial",
        "- Upstream source: `github-public-repository-advisories`",
        "- Upstream package versions mapped: 100/101",
        "- Upstream repositories checked: 1/2",
        "- Non-blocking advisory findings: 1",
        `- Advisory vulnerability total findings: ${malware ? 3 : 1}`,
        `- Upstream-only vulnerability findings: ${malware ? 2 : 1}`,
        "- Upstream coverage issues: 2",
        malware
          ? "- HIGH `report-pkg` (.github/release/clawhub-cli/package-lock.json; production) id=GHSA-report source=github-repository\n"
          : "- HIGH `undici` (.github/release/vercel-cli/package-lock.json; production) id=GHSA-rfgv-xxqx-mfg5 source=github-repository https://github.com/advisories/GHSA-rfgv-xxqx-mfg5",
        "Coverage is limited to these advisory sources; zero findings do not prove that dependencies are unaffected.",
      );
      for (const { subject, reason } of upstream.issues) {
        expect(rendered).toContain(`  - ${subject}: ${reason}`);
      }
    }
  },
);

it("uses a synthetic release tag for validation-only SHA preflight input", () => {
  for (const [releaseRef, packageVersion, expected] of [
    ["0123456789abcdef0123456789abcdef01234567", "2026.5.13", "v2026.5.13"],
    ["v2026.5.13-beta.1", "2026.5.13-beta.1", "v2026.5.13-beta.1"],
  ] as const) {
    expect(resolveReleaseTag({ releaseRef, packageVersion })).toBe(expected);
  }
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

it("prints CLI help without generating evidence", () => {
  const result = runCli(["--help"]);

  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout).toContain(
    "Usage: node --import tsx scripts/generate-dependency-release-evidence.mts",
  );
});

it("reports CLI argument errors without a Node stack trace", () => {
  for (const args of [["--wat"], ["wat", "--help"]]) {
    const result = runCli(args);

    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr.trim()).toBe(
      `Unsupported argument: ${args[0]}\n[dependency-release-evidence] FAILED (exit 1)`,
    );
    expect(result.stderr).not.toMatch(/Node\.js|\n {4}at /u);
  }
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
