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
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  expandPluginSdkApiDiffSet as expandDiffs,
  decodePluginSdkApiArtifact as decode,
  selectPluginSdkApiReleaseEvidence as selectEvidence,
  validatePluginSdkApiReleaseEvidence as validateEvidence,
} from "../../scripts/plugin-sdk-api-release-evidence.mjs";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mjs";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { withinTest } from "../helpers/promise.js";
import { withRuntimePreload } from "../helpers/runtime-preload.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const pendingChildCompletions = new Set<Promise<unknown>>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    // Timed-out bodies can still be joining installers and deleting worktrees in finally.
    await Promise.allSettled(pendingChildCompletions);
    cleanup();
  }),
);

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
  git(repo, ["commit", "--no-gpg-sign", "--quiet", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function makeFixture(name: string) {
  const repo = tempDirs.make(`plugin-sdk-${name}-repo-`);
  const runnerTemp = tempDirs.make(`plugin-sdk-${name}-temp-`);
  const binDir = tempDirs.make(`plugin-sdk-${name}-bin-`);
  git(repo, ["init", "--quiet", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "core.hooksPath", "/dev/null"]);
  return { repo, runnerTemp, binDir };
}

function sdkSource(repo: string) {
  mkdirSync(join(repo, "src/plugin-sdk"), { recursive: true });
  mkdirSync(join(repo, "scripts/lib"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(join(repo, "package.json"), '{"version":"2026.8.2","type":"module"}');
  writeFileSync(
    join(repo, "tsconfig.json"),
    '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ESNext","types":[],"skipLibCheck":true}}',
  );
  writeFileSync(join(repo, "scripts/lib/plugin-sdk-entrypoints.json"), '["fixture"]');
  writeFileSync(join(repo, "scripts/lib/plugin-sdk-private-local-only-subpaths.json"), "[]");
  return join(repo, "src/plugin-sdk/fixture.ts");
}

function writePnpm(binDir: string, source: string) {
  const path = join(binDir, "pnpm");
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

type CliFlags = Record<string, string | true>;
function cliArgs(flags: CliFlags) {
  return [
    ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(scriptModuleEntrypoints.pluginSdkApiDiff)),
    ...Object.entries(flags).flatMap(([flag, value]) =>
      value === true ? [`--${flag}`] : [`--${flag}`, value],
    ),
  ];
}

function cliEnv(runnerTemp: string, binDir: string) {
  return {
    ...process.env,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    PNPM_MARKER: join(binDir, "installs"),
    RUNNER_TEMP: runnerTemp,
    TSX_TSCONFIG_PATH: resolve("tsconfig.json"),
  };
}

function runCli(repo: string, runnerTemp: string, binDir: string, flags: CliFlags) {
  return spawnSync(process.execPath, cliArgs(flags), {
    cwd: repo,
    encoding: "utf8",
    env: cliEnv(runnerTemp, binDir),
    timeout: 30_000,
  });
}

function startCli(repo: string, base: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, cliArgs({ base, head: "HEAD" }), {
    cwd: repo,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const state = { stderr: "", closed: false };
  assert(child.stderr);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    state.stderr += chunk;
  });
  const close = new Promise<number | null>((resolveClose) => {
    child.once("close", (code) => {
      state.closed = true;
      resolveClose(code);
    });
  }).finally(() => {
    pendingChildCompletions.delete(close);
  });
  pendingChildCompletions.add(close);
  return Object.assign(state, { child, close });
}

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

function writeInstallReceipt(binDir: string): string {
  const receiptPath = join(binDir, "install-receipt.mjs");
  writeFileSync(
    receiptPath,
    `${fixtureReceiptClientSource(receipts.endpoint)}
sendReceipt(process.argv[2], "ready");
// This reporter is a short-lived shell child: retain the socket until its write drains.
fixtureReceiptSocket.ref();
fixtureReceiptSocket.end();
`,
  );
  return `'${process.execPath.replace(/'/gu, `'\\''`)}' '${receiptPath.replace(/'/gu, `'\\''`)}'`;
}

async function installBeforeSettlement(
  marker: string,
  close: PromiseLike<unknown>,
  label = "Plugin SDK API diff child",
): Promise<void> {
  // The fixture writes its marker before reporting; socket delivery may follow CLI close.
  await Promise.race([
    receipts.waitFor(marker, "ready"),
    Promise.resolve(close).then(() => {
      if (!existsSync(marker)) {
        throw new Error(`timed out waiting for ${label}`);
      }
    }),
  ]);
}

it("finishes every revision install before starting declaration rendering", async ({ signal }) => {
  const { repo, runnerTemp, binDir } = makeFixture("install-order");
  const installClaim = join(binDir, "install-claim");
  const blockedMarker = join(binDir, "install-blocked");
  const releaseMarker = join(binDir, "install-release");
  const renderDuringInstall = join(binDir, "render-during-install");
  const renderStarted = join(binDir, "render-started");
  const source = sdkSource(repo);
  writeFileSync(source, "export type Fixture = string;\n");
  const baseSha = commit(repo, "base");
  writeFileSync(source, "export type Fixture = number;\n");
  commit(repo, "head");
  symlinkSync(resolve("node_modules"), join(repo, "node_modules"), "dir");

  writePnpm(
    binDir,
    `#!/bin/sh
if mkdir "$PNPM_MARKER" 2>/dev/null; then
  while [ ! -e "$PNPM_BLOCKED" ]; do sleep 0.05; done
  exit 0
fi
: > "$PNPM_BLOCKED"
${writeInstallReceipt(binDir)} "$PNPM_BLOCKED"
while [ ! -e "$PNPM_RELEASE" ]; do sleep 0.05; done
`,
  );
  const renderProbe = join(binDir, "render-probe.cjs");
  writeFileSync(
    renderProbe,
    `const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const os = require("node:os");
os.availableParallelism = () => 8;
os.totalmem = () => 32 * 1024 ** 3;
process.constrainedMemory = () => 32 * 1024 ** 3;
const originalSpawn = childProcess.spawn;
let activeInstalls = 0;
let installCount = 0;
childProcess.spawn = function (command, args, options) {
  const child = originalSpawn.call(this, command, args, options);
  if (command === "pnpm") {
    activeInstalls += 1;
    installCount += 1;
    child.once("close", () => {
      activeInstalls -= 1;
      setImmediate(() => fs.writeFileSync(process.env.PNPM_RELEASE, "release\\n"));
    });
  }
  if (args?.includes("--render-root") && (installCount < 2 || activeInstalls > 0)) {
    fs.writeFileSync(process.env.RENDER_DURING_INSTALL, "started early\\n");
  }
  return child;
};
syncBuiltinESMExports();
if (process.argv.includes("--render-root")) {
  fs.writeFileSync(process.env.RENDER_STARTED, "started\\n");
}
`,
  );
  const tracked = startCli(repo, baseSha, {
    ...withRuntimePreload(cliEnv(runnerTemp, binDir), renderProbe),
    PNPM_MARKER: installClaim,
    PNPM_BLOCKED: blockedMarker,
    PNPM_RELEASE: releaseMarker,
    RENDER_DURING_INSTALL: renderDuringInstall,
    RENDER_STARTED: renderStarted,
  });
  const { child, close } = tracked;

  let exitCode: number | null = null;
  try {
    await withinTest(
      installBeforeSettlement(blockedMarker, close, "second revision install"),
      signal,
    );
    exitCode = await withinTest(close, signal);
  } finally {
    writeFileSync(releaseMarker, "release\n");
    if (child.exitCode === null) {
      child.kill();
    }
    await close;
  }
  const progressLines = tracked.stderr.trim().split("\n");
  expect(progressLines).toHaveLength(8);
  for (const line of progressLines) {
    expect(line).toMatch(
      /^\[plugin-sdk-api-diff\] [a-f0-9]{40} (install|render) (started|completed in \d+ms)$/,
    );
  }
  expect(exitCode).toBe(0);
  expect(existsSync(blockedMarker)).toBe(true);
  expect(existsSync(renderStarted)).toBe(true);
  expect(existsSync(renderDuringInstall)).toBe(false);
}, 50_000);

it.each([
  { base: "same-commit", head: "HEAD", version: "2026.8.2", selectors: false },
  { base: "missing", head: "HEAD", version: "2026.8.2", selectors: false },
  { base: "HEAD", head: "missing", version: "2026.8.2", selectors: false },
  { base: "HEAD", head: "HEAD", version: "2026.8.2-beta.1", selectors: true },
  { base: "HEAD", head: "HEAD", version: "invalid", selectors: true },
])(
  "handles identical aliases and validates refs without installing or changing the caller: %j",
  (fixture) => {
    const { repo, runnerTemp, binDir } = makeFixture("no-render");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ version: fixture.version }));
    writeFileSync(join(repo, "README.md"), "committed\n");
    const headSha = commit(repo, "fixture");
    git(repo, ["tag", "same-commit"]);
    writeFileSync(join(repo, "README.md"), "uncommitted\n");
    const status = git(repo, ["status", "--porcelain"]);
    writePnpm(binDir, '#!/bin/sh\n: > "$PNPM_MARKER"\nexit 97\n');
    const worktrees = git(repo, ["worktree", "list", "--porcelain"]);
    const jsonPath = join(binDir, "diff.json");
    const evidencePath = join(binDir, "evidence.json");
    const summaryPath = join(binDir, "summary.md");
    const identical = fixture.base === "same-commit";
    const flags: CliFlags = identical
      ? {
          base: fixture.base,
          head: headSha,
          "require-acknowledgement": true,
          json: jsonPath,
          evidence: evidencePath,
          summary: summaryPath,
        }
      : {
          ...(fixture.selectors
            ? { "bases-json": JSON.stringify({ beta: fixture.base, latest: fixture.base }) }
            : { base: fixture.base }),
          head: fixture.head,
        };
    const child = runCli(repo, runnerTemp, binDir, flags);

    if (identical) {
      expect(child.status, child.stderr).toBe(0);
      expect(decode(JSON.parse(readFileSync(jsonPath, "utf8")))).toEqual(emptyDiff);
      expect(decode(JSON.parse(readFileSync(evidencePath, "utf8")))).toEqual({
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
    } else {
      expect(child.status).toBe(1);
      expect(child.stderr).not.toBe("");
      if (fixture.selectors) {
        expect(child.stderr).toContain("beta/latest SDK evidence requires a regular final release");
      }
      expect(child.stdout).toBe("");
    }
    expect(existsSync(join(binDir, "installs"))).toBe(false);
    expect(git(repo, ["status", "--porcelain"])).toBe(status);
    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(worktrees);
  },
  35_000,
);

it("interrupts a running child and removes its registered worktree", async ({ signal }) => {
  // Keep revision checkout bounded so startup reaches the child this test cancels.
  const { repo, runnerTemp, binDir } = makeFixture("api-diff");
  const pnpmMarker = join(binDir, "pnpm-started");
  const invocationCounts = join(runnerTemp, ".git-invocation-counts.json");
  const runnerSentinel = join(runnerTemp, "runner-owned.txt");
  writeFileSync(invocationCounts, "{}\n");
  writeFileSync(runnerSentinel, "preserve\n");

  writeFileSync(join(repo, "README.md"), "fixture\n");
  const baseSha = commit(repo, "fixture");
  writeFileSync(join(repo, "README.md"), "changed fixture\n");
  commit(repo, "changed fixture");

  writePnpm(
    binDir,
    `#!/bin/sh\ntrap 'exit 143' INT TERM\n: > "$PNPM_MARKER"\n${writeInstallReceipt(binDir)} "$PNPM_MARKER"\nwhile :; do sleep 1; done\n`,
  );

  const tracked = startCli(repo, baseSha, {
    ...cliEnv(runnerTemp, binDir),
    PNPM_MARKER: pnpmMarker,
  });
  const { child, close } = tracked;

  try {
    await withinTest(installBeforeSettlement(pnpmMarker, close), signal);
    expect(tracked.closed, tracked.stderr).toBe(false);
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
    const exitCode = await withinTest(close, signal);

    expect(exitCode).toBe(143);
    expect(Date.now() - interruptedAt).toBeLessThan(5_000);
    expect(git(repo, ["worktree", "list"])).not.toContain(runnerTemp);
    // Cleanup owns its temporary root, not runner instrumentation beside it.
    expect(existsSync(temporaryRoot)).toBe(false);
    expect(existsSync(invocationCounts)).toBe(true);
    expect(readFileSync(runnerSentinel, "utf8")).toBe("preserve\n");
  } finally {
    if (!tracked.closed) {
      // Let the CLI join its installer and remove revision worktrees on test cancellation.
      child.kill("SIGTERM");
      await close;
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
    const { repo, runnerTemp, binDir } = makeFixture("selector");
    const installLog = join(binDir, "installs");
    const evidencePath = join(binDir, "evidence.json");
    const jsonPath = join(binDir, "diff.json");
    const source = sdkSource(repo);
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
    writePnpm(binDir, '#!/bin/sh\nprintf "%s\\n" "$PWD" >> "$PNPM_MARKER"\n');
    const worktrees = git(repo, ["worktree", "list", "--porcelain"]);
    const child = runCli(repo, runnerTemp, binDir, {
      "bases-json": JSON.stringify(bases),
      head: "HEAD",
      evidence: evidencePath,
      json: jsonPath,
    });
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
    expect(decode(bundle).schema).toBe("openclaw.plugin-sdk-api-release-evidence-set/v2");
    const reports = expandDiffs(JSON.parse(readFileSync(jsonPath, "utf8")));
    for (const [selector, ref] of Object.entries(bases)) {
      const evidence = selectEvidence({ evidence: bundle, npmDistTag: selector });
      expect(reports[selector]).toEqual(evidence.diff);
      const baseSha = git(repo, ["rev-parse", `${ref}^{commit}`]).trim();
      const changed = baseSha !== headSha;
      expect(evidence).toMatchObject({ baseRef: ref, baseSha, headSha, workflowSha: headSha });
      expect(
        validateEvidence({
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
