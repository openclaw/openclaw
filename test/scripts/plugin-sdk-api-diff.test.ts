import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "../../scripts/lib/managed-child-process.mts";
import {
  expandPluginSdkApiDiffSet,
  selectPluginSdkApiReleaseEvidence,
  validatePluginSdkApiReleaseEvidence,
} from "../../scripts/plugin-sdk-api-release-evidence.mjs";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mjs";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { withTestTimeout } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const emptyDiff = {
  entrypointsAdded: [],
  entrypointsRemoved: [],
  exports: [],
  digest: "ff7b090f43d2d90e4cd883d95840d6b752475a7a1769e295fb4cbb558a6ffb64",
};

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "."]);
  git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--no-gpg-sign",
    "--quiet",
    "-m",
    message,
  ]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function runCli(repo: string, runnerTemp: string, binDir: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(scriptModuleEntrypoints.pluginSdkApiDiff),
      ),
      ...args,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        PNPM_MARKER: join(binDir, "installs"),
        RUNNER_TEMP: runnerTemp,
        TSX_TSCONFIG_PATH: resolve("tsconfig.json"),
      },
      timeout: 30_000,
    },
  );
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for Plugin SDK API diff child");
    }
    await new Promise((resolveWait) => {
      setTimeout(resolveWait, 25);
    });
  }
}

describe("Plugin SDK API diff CLI", () => {
  it("reports identical commit aliases without installing or changing a dirty caller", () => {
    const repo = tempDirs.make("plugin-sdk-identical-repo-");
    const runnerTemp = tempDirs.make("plugin-sdk-identical-temp-");
    const binDir = tempDirs.make("plugin-sdk-identical-bin-");
    git(repo, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(repo, "README.md"), "committed\n");
    const headSha = commit(repo, "fixture");
    git(repo, ["tag", "same-commit"]);
    writeFileSync(join(repo, "README.md"), "uncommitted\n");
    const status = git(repo, ["status", "--porcelain"]);
    const worktrees = git(repo, ["worktree", "list", "--porcelain"]);
    const fakePnpm = join(binDir, "pnpm");
    writeFileSync(fakePnpm, '#!/bin/sh\n: > "$PNPM_MARKER"\nexit 97\n');
    chmodSync(fakePnpm, 0o755);
    const jsonPath = join(binDir, "diff.json");
    const evidencePath = join(binDir, "evidence.json");
    const summaryPath = join(binDir, "summary.md");
    const child = runCli(repo, runnerTemp, binDir, [
      "--base",
      "same-commit",
      "--head",
      headSha,
      "--require-acknowledgement",
      "--json",
      jsonPath,
      "--evidence",
      evidencePath,
      "--summary",
      summaryPath,
    ]);

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(readFileSync(jsonPath, "utf8"))).toEqual(emptyDiff);
    expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toEqual({
      schema: "openclaw.plugin-sdk-api-release-evidence/v1",
      status: "checked",
      baseRef: "same-commit",
      baseSha: headSha,
      headSha,
      hasChanges: false,
      digest: emptyDiff.digest,
      diff: emptyDiff,
      workflowSha: headSha,
    });
    expect(child.stdout).toContain("No Plugin SDK API changes.");
    expect(child.stdout).toContain("Acknowledgement digest: `ff7b090f`");
    expect(readFileSync(summaryPath, "utf8")).toBe(child.stdout);
    expect(existsSync(join(binDir, "installs"))).toBe(false);
    expect(git(repo, ["status", "--porcelain"])).toBe(status);
    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(worktrees);
  }, 35_000);

  it.each([
    { base: "missing", head: "HEAD", version: "2026.8.2", selectors: false },
    { base: "HEAD", head: "missing", version: "2026.8.2", selectors: false },
    { base: "HEAD", head: "HEAD", version: "2026.8.2-beta.1", selectors: true },
    { base: "HEAD", head: "HEAD", version: "invalid", selectors: true },
  ])(
    "validates refs and release versions before skipping renders: %j",
    (fixture) => {
      const repo = tempDirs.make("plugin-sdk-invalid-repo-");
      const runnerTemp = tempDirs.make("plugin-sdk-invalid-temp-");
      const binDir = tempDirs.make("plugin-sdk-invalid-bin-");
      git(repo, ["init", "--quiet", "--initial-branch=main"]);
      writeFileSync(join(repo, "package.json"), JSON.stringify({ version: fixture.version }));
      commit(repo, "fixture");
      const fakePnpm = join(binDir, "pnpm");
      writeFileSync(fakePnpm, '#!/bin/sh\n: > "$PNPM_MARKER"\nexit 97\n');
      chmodSync(fakePnpm, 0o755);
      const worktrees = git(repo, ["worktree", "list", "--porcelain"]);
      const child = runCli(repo, runnerTemp, binDir, [
        ...(fixture.selectors
          ? ["--bases-json", JSON.stringify({ beta: fixture.base, latest: fixture.base })]
          : ["--base", fixture.base]),
        "--head",
        fixture.head,
      ]);

      expect(child.status).toBe(1);
      expect(child.stderr).not.toBe("");
      if (fixture.selectors) {
        expect(child.stderr).toContain("beta/latest SDK evidence requires a regular final release");
      }
      expect(child.stdout).toBe("");
      expect(existsSync(join(binDir, "installs"))).toBe(false);
      expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(worktrees);
    },
    35_000,
  );

  it("interrupts a running child and removes its registered worktree", async () => {
    // Keep revision checkout bounded so startup reaches the child this test cancels.
    const repo = tempDirs.make("plugin-sdk-api-diff-repo-");
    const runnerTemp = tempDirs.make("plugin-sdk-api-diff-temp-");
    const binDir = tempDirs.make("plugin-sdk-api-diff-bin-");
    const pnpmMarker = join(binDir, "pnpm-started");
    const invocationCounts = join(runnerTemp, ".git-invocation-counts.json");
    const runnerSentinel = join(runnerTemp, "runner-owned.txt");
    writeFileSync(invocationCounts, "{}\n");
    writeFileSync(runnerSentinel, "preserve\n");

    git(repo, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    const baseSha = commit(repo, "fixture");
    writeFileSync(join(repo, "README.md"), "changed fixture\n");
    commit(repo, "changed fixture");

    const fakePnpm = join(binDir, "pnpm");
    writeFileSync(
      fakePnpm,
      "#!/bin/sh\n: > \"$PNPM_MARKER\"\ntrap 'exit 143' INT TERM\nwhile :; do sleep 1; done\n",
    );
    chmodSync(fakePnpm, 0o755);

    const child = spawn(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(scriptModuleEntrypoints.pluginSdkApiDiff),
        ),
        "--base",
        baseSha,
        "--head",
        "HEAD",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          PNPM_MARKER: pnpmMarker,
          RUNNER_TEMP: runnerTemp,
          // The fixture owns Git state; the source CLI still needs its workspace aliases.
          TSX_TSCONFIG_PATH: resolve("tsconfig.json"),
        },
        // Own the CLI and its pnpm/sleep descendants even if an assertion fails.
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let closed = false;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const close = new Promise<number | null>((resolveClose) => {
      child.once("close", (code) => {
        closed = true;
        resolveClose(code);
      });
    });
    try {
      await waitFor(() => existsSync(pnpmMarker) || closed, 10_000);
      expect(closed, stderr).toBe(false);
      const revisionRoot = git(repo, ["worktree", "list", "--porcelain", "-z"])
        .split("\0")
        .filter((record) => record.startsWith("worktree "))
        .map((record) => resolve(record.slice("worktree ".length)))
        .find((root) => dirname(dirname(root)) === runnerTemp);
      assert(revisionRoot, "expected a registered revision worktree under runner temp");
      const temporaryRoot = dirname(revisionRoot);
      expect(existsSync(temporaryRoot)).toBe(true);
      const interruptedAt = Date.now();
      child.kill("SIGTERM");
      const exitCode = await withTestTimeout(close, 5_000, "Plugin SDK API diff ignored SIGTERM");

      expect(exitCode).toBe(143);
      // The interrupted stage must survive even though no report was produced.
      expect(stderr).toContain("[plugin-sdk-api-diff] resources ");
      expect(stderr).toContain(`[plugin-sdk-api-diff] ${baseSha} worktree elapsedMs=`);
      expect(stderr).toContain(`[plugin-sdk-api-diff] ${baseSha} install elapsedMs=`);
      expect(stderr).not.toContain(" render elapsedMs=");
      expect(Date.now() - interruptedAt).toBeLessThan(5_000);
      expect(git(repo, ["worktree", "list"])).not.toContain(runnerTemp);
      // Cleanup owns its temporary root, not runner instrumentation beside it.
      expect(existsSync(temporaryRoot)).toBe(false);
      expect(existsSync(invocationCounts)).toBe(true);
      expect(readFileSync(runnerSentinel, "utf8")).toBe("preserve\n");
    } finally {
      // A failed assertion can bypass the CLI's cooperative SIGTERM handler.
      // Reap its owned group even if the leader has already closed.
      terminateManagedChild(child, "SIGKILL", { processGroupFallback: "never" });
      await withTestTimeout(close, 5_000, "Plugin SDK API diff cleanup did not close");
      if (process.platform !== "win32") {
        expect(
          await waitForManagedProcessGroupExit(child, 5_000, {
            errorPolicy: "alive-on-eperm",
          }),
          "Plugin SDK API diff descendants survived cleanup",
        ).toBe(true);
      }
    }
  }, 15_000);

  it.each([
    { beta: "v2026.8.1-beta.1", latest: "v2026.7.31" },
    { beta: "v2026.7.31", latest: "v2026.7.31" },
    { beta: "candidate", latest: "v2026.7.31" },
    { beta: "candidate", latest: "HEAD" },
  ])(
    "renders only unique revisions needed by changed selectors: %j",
    (bases) => {
      const repo = tempDirs.make("plugin-sdk-selector-repo-");
      const runnerTemp = tempDirs.make("plugin-sdk-selector-temp-");
      const binDir = tempDirs.make("plugin-sdk-selector-bin-");
      const installLog = join(binDir, "installs");
      const evidencePath = join(binDir, "evidence.json");
      const jsonPath = join(binDir, "diff.json");
      git(repo, ["init", "--quiet", "--initial-branch=main"]);
      mkdirSync(join(repo, "src/plugin-sdk"), { recursive: true });
      mkdirSync(join(repo, "scripts/lib"), { recursive: true });
      writeFileSync(join(repo, ".gitignore"), "node_modules\n");
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ version: "2026.8.2", type: "module" }),
      );
      writeFileSync(
        join(repo, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ESNext",
            types: [],
            skipLibCheck: true,
          },
        }),
      );
      writeFileSync(join(repo, "scripts/lib/plugin-sdk-entrypoints.json"), '["fixture"]');
      writeFileSync(join(repo, "scripts/lib/plugin-sdk-private-local-only-subpaths.json"), "[]");
      const source = join(repo, "src/plugin-sdk/fixture.ts");
      writeFileSync(source, "export type Fixture = string;\n");
      const latestSha = commit(repo, "latest");
      git(repo, ["tag", "v2026.7.31"]);
      writeFileSync(source, "export type Fixture = number;\n");
      const betaSha = commit(repo, "beta");
      git(repo, ["tag", "v2026.8.1-beta.1"]);
      writeFileSync(source, "export type Fixture = boolean;\n");
      const headSha = commit(repo, "candidate");
      git(repo, ["tag", "candidate"]);
      writeFileSync(source, "export type Fixture = uncommitted;\n");
      symlinkSync(resolve("node_modules"), join(repo, "node_modules"), "dir");
      const fakePnpm = join(binDir, "pnpm");
      writeFileSync(fakePnpm, '#!/bin/sh\nprintf "%s\\n" "$PWD" >> "$PNPM_MARKER"\n');
      chmodSync(fakePnpm, 0o755);
      const worktrees = git(repo, ["worktree", "list", "--porcelain"]);
      const child = runCli(repo, runnerTemp, binDir, [
        "--bases-json",
        JSON.stringify(bases),
        "--head",
        "HEAD",
        "--evidence",
        evidencePath,
        "--json",
        jsonPath,
      ]);
      expect(child.status, child.stderr).toBe(0);
      const installed = existsSync(installLog)
        ? readFileSync(installLog, "utf8")
            .trim()
            .split("\n")
            .map((path) => basename(path))
        : [];
      expect(installed.toSorted()).toEqual(
        (bases.latest === "HEAD"
          ? []
          : [latestSha, ...(bases.beta === "v2026.8.1-beta.1" ? [betaSha] : []), headSha]
        ).toSorted(),
      );
      const bundle = JSON.parse(readFileSync(evidencePath, "utf8"));
      expect(bundle.schema).toBe("openclaw.plugin-sdk-api-release-evidence-set/v2");
      const reports = expandPluginSdkApiDiffSet(JSON.parse(readFileSync(jsonPath, "utf8")));
      for (const [selector, ref] of Object.entries(bases)) {
        const evidence = selectPluginSdkApiReleaseEvidence({
          evidence: bundle,
          npmDistTag: selector,
        });
        expect(reports[selector]).toEqual(evidence.diff);
        const baseSha = git(repo, ["rev-parse", `${ref}^{commit}`]).trim();
        const changed = baseSha !== headSha;
        expect(evidence).toMatchObject({ baseRef: ref, baseSha, headSha, workflowSha: headSha });
        expect(
          validatePluginSdkApiReleaseEvidence({
            acknowledgement: changed ? evidence.digest.slice(0, 8) : "",
            evidence: bundle,
            expectedHeadSha: headSha,
            expectedWorkflowSha: headSha,
            npmDistTag: selector,
          }),
        ).toMatchObject({ hasChanges: changed, status: "checked" });
        if (changed) {
          expect(evidence.diff.exports[0].before.declaration).toContain(
            baseSha === betaSha ? "number" : "string",
          );
          expect(evidence.diff.exports[0].after.declaration).toContain("boolean");
        } else {
          expect(evidence.diff).toEqual(emptyDiff);
        }
      }
      expect(readFileSync(source, "utf8")).toBe("export type Fixture = uncommitted;\n");
      expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(worktrees);
    },
    35_000,
  );
});
