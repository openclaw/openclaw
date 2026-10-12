import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageBundledPluginRuntime } from "../scripts/stage-bundled-plugin-runtime.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let scratch: string;
let workdir: string;
let shimDir: string;
let invocationLog: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function commitFixture(cwd: string, message: string) {
  git(
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    message,
  );
}

function writeShim(name: string, body: string) {
  const file = path.join(shimDir, name);
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function runUpdater(overrides: Record<string, string> = {}) {
  const env = { ...process.env, ...overrides };
  for (const name of ["OPENCLAW_UPDATE_RESTART_CMD", "OPENCLAW_UPDATE_STOP_CMD"]) {
    if (!Object.hasOwn(overrides, name)) {
      delete env[name];
    }
  }
  return spawnSync("/bin/bash", [path.join(workdir, "scripts/update-gateway.sh")], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...env,
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      UPDATE_TEST_LOG: invocationLog,
      UPDATE_TEST_BIN: shimDir,
      UPDATE_TEST_LIVE_ROOT: workdir,
    },
  });
}

const calls = () =>
  fs.existsSync(invocationLog)
    ? fs.readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)
    : [];

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-gateway-"));
  workdir = path.join(scratch, "checkout");
  shimDir = path.join(scratch, "bin");
  invocationLog = path.join(scratch, "calls");
  fs.mkdirSync(shimDir);
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe("source updater lifecycle preflight", () => {
  beforeEach(() => {
    const seed = path.join(scratch, "seed");
    const origin = path.join(scratch, "origin.git");
    fs.mkdirSync(path.join(seed, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "scripts/update-gateway.sh"),
      path.join(seed, "scripts/update-gateway.sh"),
    );
    // Use the real lifecycle adapter; only the fixture transport and terminal
    // Git/package-manager commands are controlled by this shell scenario.
    fs.writeFileSync(
      path.join(seed, "scripts/tsx.mjs"),
      `import ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/tsx.mjs")).href)};\n`,
    );
    fs.writeFileSync(
      path.join(seed, "scripts/update-gateway-build.mts"),
      `import { runUpdateGatewayBuild } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/update-gateway-build.mts")).href)};\nprocess.exitCode = await runUpdateGatewayBuild(...process.argv.slice(2));\n`,
    );
    fs.writeFileSync(
      path.join(seed, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.1", packageManager: "pnpm@12.4.0" }),
    );
    fs.writeFileSync(
      path.join(seed, ".gitignore"),
      "dist/\ndist-runtime/\nnode_modules/\n.artifacts/\n",
    );
    git(seed, "init", "-q", "-b", "main");
    git(seed, "add", ".");
    commitFixture(seed, "fixture");
    git(scratch, "clone", "-q", "--bare", seed, origin);
    git(scratch, "clone", "-q", origin, workdir);
    writeShim("git", 'echo "git $*" >> "$UPDATE_TEST_LOG"\nPATH="${PATH#*:}" exec git "$@"');
    writeShim(
      "corepack",
      'echo "corepack $*" >> "$UPDATE_TEST_LOG"\nln -s "$UPDATE_TEST_BIN/pnpm" "$3/pnpm"',
    );
    fs.writeFileSync(
      path.join(shimDir, "write-runtime.cjs"),
      String.raw`
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const head = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
fs.mkdirSync('dist/control-ui', {recursive:true});
fs.writeFileSync('dist/entry.js', '// synthetic runtime\n');
fs.writeFileSync('dist/control-ui/index.html', 'ready');
fs.writeFileSync('dist/build-info.json', JSON.stringify({commit:head,buildId:'fixture-'+head}));
for (const name of ['.buildstamp','.runtime-postbuildstamp']) fs.writeFileSync(path.join('dist',name),JSON.stringify({head}));
fs.writeFileSync('dist/marker', process.argv[2] || 'new');
`,
    );
    writeShim(
      "pnpm",
      'if [ "$1" = --version ]; then echo 12.4.0; exit 0; fi\necho "pnpm $*" >> "$UPDATE_TEST_LOG"',
    );
    writeShim("openclaw", 'echo "openclaw $*" >> "$UPDATE_TEST_LOG"');
  });

  it.each([
    ["stop only", { OPENCLAW_UPDATE_STOP_CMD: "custom-stop" }],
    [
      "blank stop",
      { OPENCLAW_UPDATE_STOP_CMD: " \t\n", OPENCLAW_UPDATE_RESTART_CMD: "custom-restart" },
    ],
    [
      "manual with automatic stop",
      { OPENCLAW_UPDATE_STOP_CMD: "custom-stop", OPENCLAW_UPDATE_RESTART_CMD: "" },
    ],
  ] satisfies Array<[string, Record<string, string>]>)(
    "rejects %s before effects",
    (_name, overrides) => {
      const result = runUpdater(overrides);
      expect(result.status).toBe(1);
      expect(calls()).toEqual([]);
    },
  );

  function runRefusedSourceUpdate(
    buildSteps: readonly string[] = [],
    overrides: Record<string, string> = {},
  ) {
    const seed = path.join(scratch, "seed");
    fs.writeFileSync(path.join(seed, "target.txt"), "new tracked source\n");
    git(seed, "add", "target.txt");
    commitFixture(seed, "target");
    git(seed, "push", "-q", path.join(scratch, "origin.git"), "main");
    const original = git(workdir, "rev-parse", "HEAD");
    fs.mkdirSync(path.join(workdir, "node_modules"));
    const dependency = path.join(workdir, "node_modules", "serving-marker");
    fs.writeFileSync(dependency, "original dependency\n");
    writeShim(
      "pnpm",
      [
        'if [ "$1" = --version ]; then echo 12.4.0; exit 0; fi',
        'echo "pnpm $*" >> "$UPDATE_TEST_LOG"',
        'if [ "$1" = install ]; then if [ "$PWD" = "$UPDATE_TEST_LIVE_ROOT" ]; then echo live-install >> "$UPDATE_TEST_LOG"; fi; mkdir -p node_modules; echo changed > node_modules/serving-marker; fi',
        'if [ "$1" = build ]; then',
        'node "$UPDATE_TEST_BIN/write-runtime.cjs" new',
        ...buildSteps,
        "fi",
      ].join("\n"),
    );
    writeShim("refuse-stop", 'echo stop-refused >> "$UPDATE_TEST_LOG"\nexit 23');
    writeShim("restart-proof", 'echo unexpected-restart >> "$UPDATE_TEST_LOG"');
    const result = runUpdater({
      OPENCLAW_UPDATE_STOP_CMD: "refuse-stop",
      OPENCLAW_UPDATE_RESTART_CMD: "restart-proof",
      ...overrides,
    });
    return { result, original, dependency };
  }

  it("preserves changed live artifacts under inspected custody", () => {
    const seed = path.join(scratch, "seed");
    fs.writeFileSync(
      path.join(seed, "scripts/stage-bundled-plugin-runtime.mts"),
      `export { prepareBundledPluginRuntime } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/stage-bundled-plugin-runtime.mts")).href)};\n`,
    );
    git(seed, "add", "scripts/stage-bundled-plugin-runtime.mts");
    commitFixture(seed, "runtime inspector");
    git(seed, "push", "-q", path.join(scratch, "origin.git"), "main");
    git(workdir, "pull", "--ff-only", "-q");
    fs.mkdirSync(path.join(workdir, "dist/extensions/demo"), { recursive: true });
    fs.writeFileSync(
      path.join(workdir, "dist/extensions/demo/index.js"),
      "export const current = true;\n",
    );
    stageBundledPluginRuntime({ repoRoot: workdir });
    const serving = path.join(workdir, "dist-runtime/extensions/demo/index.js");
    fs.writeFileSync(serving, "previous serving generation\n");
    const before = { bytes: fs.readFileSync(serving), ino: fs.statSync(serving).ino };
    const probe = path.join(shimDir, "inspect-artifacts.mts");
    fs.writeFileSync(
      probe,
      `
import fs from "node:fs";
import path from "node:path";
import { preflightInstalledSourceArtifacts } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/lib/source-update-artifact-preflight.mts")).href)};
import { withDistArtifactOwnership, resolveDistArtifactLockPath } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/lib/dist-artifact-ownership.mts")).href)};
const owner = path.join(resolveDistArtifactLockPath(process.env.UPDATE_TEST_LIVE_ROOT), "owner.json");
const original = fs.readFileSync(owner, "utf8");
await withDistArtifactOwnership(process.cwd(), async () => {
  await preflightInstalledSourceArtifacts(process.env);
  if (fs.readFileSync(owner, "utf8") !== original) throw new Error("Installed artifact ownership changed");
  fs.appendFileSync(process.env.UPDATE_TEST_LOG, "artifact-fact:" + process.env.sourceRuntimePrepared + "\\n");
});
`,
    );
    const { result, original, dependency } = runRefusedSourceUpdate([
      `node --import ${JSON.stringify(path.join(repoRoot, "scripts/tsx.mjs"))} ${JSON.stringify(probe)}`,
    ]);
    expect(result.status, result.stdout + result.stderr).toBe(23);
    expect(calls()).toContain("artifact-fact:false");
    expect(calls()).toContain("stop-refused");
    expect({ bytes: fs.readFileSync(serving), ino: fs.statSync(serving).ino }).toEqual(before);
    expect({
      head: git(workdir, "rev-parse", "HEAD"),
      dependency: fs.readFileSync(dependency, "utf8"),
      installed: calls().includes("live-install"),
      restarted: calls().includes("unexpected-restart"),
    }).toEqual({
      head: original,
      dependency: "original dependency\n",
      installed: false,
      restarted: false,
    });
  });

  it("retains the published 9.6 three-argument first-hop contract", () => {
    const published = fs.readFileSync(
      path.join(repoRoot, "test/scripts/fixtures/update-gateway-2026.9.6.sh"),
    );
    expect(createHash("sha256").update(published).digest("hex")).toBe(
      "38bb92e899187cb2d86cf5ef043d2de2aa02a1b0bbcade505b104a036f3d7837",
    );
    const seed = path.join(scratch, "seed");
    fs.writeFileSync(path.join(seed, "scripts/update-gateway.sh"), published);
    git(seed, "add", "scripts/update-gateway.sh");
    commitFixture(seed, "published source driver");
    git(seed, "push", "-q", path.join(scratch, "origin.git"), "main");
    git(workdir, "pull", "--ff-only", "-q");
    // The old shell is already running when its target replaces this file.
    fs.copyFileSync(
      path.join(repoRoot, "scripts/update-gateway.sh"),
      path.join(seed, "scripts/update-gateway.sh"),
    );
    git(seed, "add", "scripts/update-gateway.sh");
    const { result, original, dependency } = runRefusedSourceUpdate();
    expect(result.status, result.stdout + result.stderr).toBe(23);
    expect(calls()).toContain("stop-refused");
    expect(git(workdir, "rev-parse", "HEAD")).not.toBe(original);
    expect(fs.readFileSync(dependency, "utf8")).toBe("changed\n");
    expect(calls()).not.toContain("unexpected-restart");
  });

  it.each([
    "reset-refused",
    "restart-failed",
    "tracked-runtime-deleted",
    "tracked-runtime-changed",
    "tracked-runtime-rollback",
    "tracked-runtime-partial",
    "restore-branch-drift",
  ] as const)(
    "publishes or restores complete source runtime through the reference entry (%s)",
    (mode) => {
      const trackedAsset = "dist/tracked-runtime.txt";
      const seed = path.join(scratch, "seed");
      const trackedRuntime = mode.startsWith("tracked-runtime-");
      const interceptRename = mode === "tracked-runtime-partial" || mode === "restore-branch-drift";
      if (interceptRename) {
        fs.writeFileSync(
          path.join(seed, "scripts/update-gateway-build.mts"),
          `
import fs from "node:fs/promises";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {runUpdateGatewayBuild} from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/update-gateway-build.mts")).href)};
const root = await fs.realpath(process.cwd());
const rename = fs.rename.bind(fs);
fs.rename = async (source, destination) => {
  if (${JSON.stringify(mode)} === "tracked-runtime-partial" && path.basename(String(source)) === "candidate" && destination === path.join(root, "dist")) {
    await fs.appendFile(process.env.UPDATE_TEST_LOG, "candidate-rename-refused\\n");
    throw new Error("candidate move refused");
  }
  await rename(source, destination);
  if (${JSON.stringify(mode)} === "restore-branch-drift" && path.basename(String(source)) === "previous" && destination === path.join(root, "dist")) {
    execFileSync("git", ["checkout", "-b", "operator-work"], {cwd:root, stdio:"pipe"});
  }
};
process.exitCode = await runUpdateGatewayBuild(...process.argv.slice(2));
`,
        );
        git(seed, "add", "scripts/update-gateway-build.mts");
      }
      if (trackedRuntime) {
        fs.mkdirSync(path.join(seed, "dist"));
        fs.writeFileSync(path.join(seed, trackedAsset), "original tracked runtime\n");
        git(seed, "add", "-f", trackedAsset);
      }
      if (trackedRuntime || interceptRename) {
        commitFixture(seed, "runtime recovery fixture");
        git(seed, "push", "-q", path.join(scratch, "origin.git"), "main");
        git(workdir, "pull", "-q", "--ff-only");
      }
      if (trackedRuntime) {
        if (mode === "tracked-runtime-deleted") {
          git(seed, "rm", trackedAsset);
        } else {
          fs.writeFileSync(path.join(seed, trackedAsset), "target tracked runtime\n");
          git(seed, "add", "-f", trackedAsset);
        }
      }
      const runtimeWriter = path.join(shimDir, "write-runtime.cjs");
      execFileSync(process.execPath, [runtimeWriter, "old"], { cwd: workdir });
      writeShim(
        "stop-ok",
        [
          'echo "stop:$(git rev-parse HEAD):$(cat node_modules/serving-marker)" >> "$UPDATE_TEST_LOG"',
          ...(mode === "tracked-runtime-deleted" ||
          mode === "tracked-runtime-rollback" ||
          mode === "restore-branch-drift"
            ? ['node "$UPDATE_TEST_BIN/corrupt-staged.cjs"']
            : []),
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(shimDir, "corrupt-staged.cjs"),
        `
const fs = require('node:fs');
const path = require('node:path');
const names = fs.readdirSync('.').filter(name => name.startsWith('dist.openclaw-update-'));
if (names.length !== 1) throw new Error('Expected exactly one owned staged dist');
fs.writeFileSync(path.join(names[0],'candidate','.buildstamp'), JSON.stringify({head:'invalid'}));
`,
      );
      writeShim(
        "restart-observe",
        'echo "restart:$(git rev-parse HEAD):$(cat node_modules/serving-marker)" >> "$UPDATE_TEST_LOG"\nexit "${UPDATE_TEST_RESTART_EXIT:-0}"',
      );
      if (mode === "reset-refused") {
        writeShim(
          "git",
          [
            'if [ "$1" = -C ] && [ "$2" = "$UPDATE_TEST_LIVE_ROOT" ] && [ "$3" = reset ] && [ "$4" = --keep ]; then echo reset-refused >> "$UPDATE_TEST_LOG"; exit 17; fi',
            'PATH="${PATH#*:}" exec git "$@"',
          ].join("\n"),
        );
      }
      const { result, original, dependency } = runRefusedSourceUpdate([], {
        OPENCLAW_UPDATE_STOP_CMD: "stop-ok",
        OPENCLAW_UPDATE_RESTART_CMD: "restart-observe",
        UPDATE_TEST_RESTART_EXIT: mode === "restart-failed" ? "29" : "0",
      });
      expect(result.status, result.stdout + result.stderr).toBe(
        mode === "tracked-runtime-changed" ? 0 : 1,
      );
      const published = mode === "restart-failed" || mode === "tracked-runtime-changed";
      const expectedHead = published
        ? git(path.join(scratch, "seed"), "rev-parse", "HEAD")
        : original;
      const expectedDependency = published ? "changed" : "original dependency";
      expect(calls()).toContain(`stop:${original}:original dependency`);
      if (mode === "restore-branch-drift") {
        expect(result.stderr).toContain("Published source runtime could not be verified");
        expect(result.stderr).toContain("Source checkout or branch changed during update");
        expect(git(workdir, "branch", "--show-current")).toBe("operator-work");
        expect(git(workdir, "rev-parse", "HEAD")).toBe(git(seed, "rev-parse", "HEAD"));
        expect(calls().some((call) => call.includes(`reset --keep ${original}`))).toBe(false);
        expect(calls().some((call) => call.startsWith("restart:"))).toBe(false);
        expect(fs.readFileSync(dependency, "utf8")).toBe("original dependency\n");
        expect(fs.readFileSync(path.join(workdir, "dist/marker"), "utf8")).toBe("old");
        expect(fs.readdirSync(workdir).some((name) => name.includes(".openclaw-update-"))).toBe(
          true,
        );
        return;
      }
      if (mode === "tracked-runtime-partial") {
        expect(calls()).toContain("candidate-rename-refused");
        expect(result.stderr).toContain("candidate move refused");
      }
      if (mode.startsWith("tracked-runtime-")) {
        if (mode === "tracked-runtime-deleted") {
          expect(result.stderr).toContain("Published source runtime could not be verified");
        }
        expect(
          fs.readFileSync(path.join(workdir, trackedAsset), "utf8"),
          result.stdout + result.stderr,
        ).toBe(published ? "target tracked runtime\n" : "original tracked runtime\n");
        expect(git(workdir, "diff", "--name-only", "HEAD")).toBe("");
      }
      expect(calls()).toContain(`restart:${expectedHead}:${expectedDependency}`);
      expect(git(workdir, "rev-parse", "HEAD")).toBe(expectedHead);
      expect(git(workdir, "branch", "--show-current")).toBe("main");
      expect(fs.readFileSync(dependency, "utf8")).toBe(`${expectedDependency}\n`);
      expect(fs.readFileSync(path.join(workdir, "dist/marker"), "utf8")).toBe(
        published ? "new" : "old",
      );
      const backups = fs.readdirSync(workdir).filter((name) => name.includes(".openclaw-update-"));
      expect(backups.length > 0).toBe(mode === "restart-failed");
      expect(calls()).not.toContain("live-install");
      if (mode === "restart-failed") {
        const retained = new Map(
          backups.map((name) => [name, fs.statSync(path.join(workdir, name)).ino]),
        );
        const retainedMarker = backups.find((name) => name.startsWith("dist.openclaw-update-"))!;
        const originalMarker = path.join(workdir, retainedMarker, "previous/marker");
        expect(fs.readFileSync(originalMarker, "utf8")).toBe("old");
        const observation = path.join(scratch, "retry-inputs");
        fs.appendFileSync(
          runtimeWriter,
          '\nfs.writeFileSync(process.env.UPDATE_TEST_RETRY_INPUTS, JSON.stringify(fs.readdirSync(".").filter(name => name.includes(".openclaw-update-"))));\n',
        );
        const retry = runUpdater({
          OPENCLAW_UPDATE_STOP_CMD: "refuse-stop",
          OPENCLAW_UPDATE_RESTART_CMD: "restart-proof",
          UPDATE_TEST_RETRY_INPUTS: observation,
        });
        expect(retry.status, retry.stdout + retry.stderr).toBe(23);
        expect(JSON.parse(fs.readFileSync(observation, "utf8"))).toEqual([]);
        expect(fs.readFileSync(originalMarker, "utf8")).toBe("old");
        expect(
          new Map(backups.map((name) => [name, fs.statSync(path.join(workdir, name)).ino])),
        ).toEqual(retained);
        expect(
          fs
            .readdirSync(workdir)
            .filter((name) => name.includes(".openclaw-update-"))
            .toSorted(),
        ).toEqual(backups.toSorted());
      }
    },
  );

  it.each(["head-read", "tracked-change"] as const)(
    "reports reset refusal together with failed reconciliation (%s)",
    (mode) => {
      execFileSync(process.execPath, [path.join(shimDir, "write-runtime.cjs"), "old"], {
        cwd: workdir,
      });
      writeShim("stop-ok", 'echo stop-ok >> "$UPDATE_TEST_LOG"');
      writeShim(
        "git",
        [
          'if [ "$1" = -C ] && [ "$2" = "$UPDATE_TEST_LIVE_ROOT" ]; then',
          '  if [ "$3" = reset ] && [ "$4" = --keep ]; then',
          '    echo reset-refused >> "$UPDATE_TEST_LOG"',
          ...(mode === "head-read"
            ? ['    touch "$UPDATE_TEST_BIN/reset-failed"']
            : ['    echo " " >> "$UPDATE_TEST_LIVE_ROOT/package.json"']),
          "    exit 17",
          "  fi",
          ...(mode === "head-read"
            ? [
                '  if [ "$3" = rev-parse ] && [ "$4" = HEAD ] && [ -f "$UPDATE_TEST_BIN/reset-failed" ]; then exit 19; fi',
              ]
            : []),
          "fi",
          'PATH="${PATH#*:}" exec git "$@"',
        ].join("\n"),
      );
      const { result, original, dependency } = runRefusedSourceUpdate([], {
        OPENCLAW_UPDATE_STOP_CMD: "stop-ok",
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(calls()).toContain("reset-refused");
      expect(result.stderr).toContain("Source update Git reset failed (exit 17)");
      expect(result.stderr).toContain(
        mode === "head-read"
          ? "Source update Git rev-parse failed (exit 19)"
          : "Source update Git diff failed (exit 1)",
      );
      expect(git(workdir, "rev-parse", "HEAD")).toBe(original);
      expect(fs.readFileSync(dependency, "utf8")).toBe("original dependency\n");
      expect(calls()).not.toContain("unexpected-restart");
      expect(fs.readdirSync(workdir).some((name) => name.includes(".openclaw-update-"))).toBe(true);
    },
  );

  it.each(["cleanup-refused", "pack-advisory"] as const)(
    "reports preparation cleanup after a refused stop (%s)",
    (mode) => {
      writeShim(
        "stop-with-cleanup-failure",
        [
          'echo stop-refused >> "$UPDATE_TEST_LOG"',
          ...(mode === "cleanup-refused"
            ? ['ln -s "$UPDATE_TEST_BIN" "$UPDATE_TEST_LIVE_ROOT/dist"']
            : []),
          "exit 23",
        ].join("\n"),
      );
      if (mode === "pack-advisory") {
        writeShim(
          "git",
          [
            'case "$*" in *objects/pack/pack-*.keep*) echo pack-cleanup-refused >> "$UPDATE_TEST_LOG"; exit 19;; esac',
            'PATH="${PATH#*:}" exec git "$@"',
          ].join("\n"),
        );
      }
      const { result, original, dependency } = runRefusedSourceUpdate([], {
        OPENCLAW_UPDATE_STOP_CMD: "stop-with-cleanup-failure",
      });
      expect(result.status, result.stdout + result.stderr).toBe(
        mode === "cleanup-refused" ? 1 : 23,
      );
      expect(calls()).toContain("stop-refused");
      if (mode === "cleanup-refused") {
        expect(result.stderr).toContain("Source update stop failed (exit 23)");
        expect(result.stderr).toContain("is a symbolic link; refusing to mutate it");
      } else {
        expect(calls()).toContain("pack-cleanup-refused");
        expect(result.stderr.match(/Git update pack could not be removed:/gu)).toHaveLength(1);
        expect(fs.readdirSync(workdir).some((name) => name.includes(".openclaw-update-"))).toBe(
          false,
        );
      }
      expect(git(workdir, "rev-parse", "HEAD")).toBe(original);
      expect(fs.readFileSync(dependency, "utf8")).toBe("original dependency\n");
      expect(calls()).not.toContain("unexpected-restart");
    },
  );

  it.each([
    "physical-alias",
    "external-file-changed",
    "candidate-directory-file-changed",
    "candidate-directory-file-rerouted",
    "candidate-directory-file-published",
  ] as const)("prepares accepted symlink build inputs (%s)", (kind) => {
    const seed = path.join(scratch, "seed");
    const input = path.join(workdir, "inputs", "operator-link");
    fs.mkdirSync(path.dirname(input));
    const payload = path.join(scratch, "external-input");
    let expected = "external input\n";
    let mutationTarget = payload;
    const published = kind.endsWith("-published");
    const rerouted = kind.endsWith("-rerouted");
    const changedInput = kind.endsWith("-changed") || rerouted;
    let originalExternalFile: string | undefined;
    const replacementExternalFile = path.join(scratch, "replacement-external-file");
    if (kind.startsWith("candidate-directory")) {
      fs.mkdirSync(payload);
      mutationTarget = path.join(payload, "payload.txt");
      fs.writeFileSync(mutationTarget, expected);
      fs.symlinkSync(payload, path.join(seed, "assets"), "dir");
      git(seed, "add", "assets");
      commitFixture(seed, "tracked external input alias");
      git(seed, "push", "-q", path.join(scratch, "origin.git"), "main");
      git(workdir, "pull", "-q", "--ff-only");
      fs.symlinkSync("../assets/payload.txt", input);
      const candidatePayload = path.join(scratch, "candidate-external-input");
      fs.mkdirSync(candidatePayload);
      expected = "candidate external input\n";
      mutationTarget = path.join(candidatePayload, "payload.txt");
      fs.writeFileSync(mutationTarget, expected);
      if (rerouted) {
        originalExternalFile = path.join(candidatePayload, "original.txt");
        fs.renameSync(mutationTarget, originalExternalFile);
        fs.symlinkSync(originalExternalFile, mutationTarget);
        fs.writeFileSync(replacementExternalFile, "changed\n");
      }
      fs.unlinkSync(path.join(seed, "assets"));
      fs.symlinkSync(candidatePayload, path.join(seed, "assets"), "dir");
      git(seed, "add", "assets");
    } else if (kind === "physical-alias") {
      fs.writeFileSync(path.join(seed, "target.txt"), "old tracked source\n");
      git(seed, "add", "target.txt");
      commitFixture(seed, "old source input");
      git(seed, "push", "-q", path.join(scratch, "origin.git"), "main");
      git(workdir, "pull", "-q", "--ff-only");
      const alias = path.join(scratch, "external-checkout-alias");
      fs.symlinkSync(workdir, alias, "dir");
      fs.symlinkSync(path.join(alias, "target.txt"), input);
      expected = "new tracked source\n";
    } else {
      fs.writeFileSync(payload, expected);
      fs.symlinkSync(payload, input);
    }
    if (published) {
      execFileSync(process.execPath, [path.join(shimDir, "write-runtime.cjs"), "original"], {
        cwd: workdir,
      });
      writeShim("allow-stop", 'echo selected-stop >> "$UPDATE_TEST_LOG"');
      writeShim("allow-restart", 'echo selected-restart >> "$UPDATE_TEST_LOG"');
    }
    const observation = path.join(scratch, "candidate-observation");
    const { result, original, dependency } = runRefusedSourceUpdate(
      [
        'cat inputs/operator-link > "$UPDATE_TEST_INPUT_OBSERVATION"',
        ...(rerouted
          ? [
              'rm "$UPDATE_TEST_EXTERNAL_INPUT"; ln -s "$UPDATE_TEST_EXTERNAL_OTHER" "$UPDATE_TEST_EXTERNAL_INPUT"',
            ]
          : changedInput
            ? ['echo changed > "$UPDATE_TEST_EXTERNAL_INPUT"']
            : []),
      ],
      {
        UPDATE_TEST_INPUT_OBSERVATION: observation,
        UPDATE_TEST_EXTERNAL_INPUT: mutationTarget,
        UPDATE_TEST_EXTERNAL_OTHER: replacementExternalFile,
        ...(published
          ? { OPENCLAW_UPDATE_STOP_CMD: "allow-stop", OPENCLAW_UPDATE_RESTART_CMD: "allow-restart" }
          : {}),
      },
    );
    expect(fs.readFileSync(observation, "utf8")).toBe(expected);
    if (originalExternalFile) {
      expect(fs.readFileSync(originalExternalFile, "utf8")).toBe(expected);
    }
    expect(result.status, result.stdout + result.stderr).toBe(
      changedInput ? 1 : published ? 0 : 23,
    );
    expect(calls().includes("stop-refused")).toBe(!changedInput && !published);
    if (changedInput) {
      expect(result.stderr).toContain("Local source build inputs changed");
      expect(fs.readFileSync(mutationTarget, "utf8")).toBe("changed\n");
    }
    expect(git(workdir, "rev-parse", "HEAD")).toBe(
      published ? git(seed, "rev-parse", "HEAD") : original,
    );
    expect(fs.readFileSync(dependency, "utf8")).toBe(
      published ? "changed\n" : "original dependency\n",
    );
    if (published) {
      expect(fs.readFileSync(input, "utf8")).toBe(expected);
      expect(calls()).toContain("selected-restart");
    }
    expect(calls()).not.toContain("live-install");
    expect(calls()).not.toContain("unexpected-restart");
  });
});
