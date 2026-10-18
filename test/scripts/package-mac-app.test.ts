import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { minimatch } from "minimatch";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMacScriptTest } from "./mac-script-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/package-mac-app.sh";
const swiftScriptPath = "scripts/lib/mac-swift-build.sh";

function writeExecutable(file: string, source: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function writeFiles(root: string, files: Record<string, string | Uint8Array>) {
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

function expectContains(text: string, fragments: string[]) {
  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
}

function read(...parts: string[]) {
  return readFileSync(path.join(...parts), "utf8");
}

function shellVars(values: Record<string, string>) {
  return Object.entries(values)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
}

function runShell(script: string, args: string[] = [], env?: NodeJS.ProcessEnv) {
  return spawnSync("/bin/bash", ["-c", script, "package-fixture", ...args], {
    encoding: "utf8",
    env,
  });
}

describe.skipIf(process.platform === "win32")("cloud-worker app packaging identity", () => {
  const script = readFileSync(scriptPath, "utf8");
  const initialization = script.slice(
    script.indexOf('CLOUD_WORKER_HOST="${OPENCLAW_MAC_CLOUD_WORKER_HOST:-0}"'),
    script.indexOf("PKG_VERSION="),
  );

  function resolveVariant(overrides: NodeJS.ProcessEnv) {
    return runShell(
      `set -euo pipefail\nROOT_DIR="$1"\n${initialization}\nprintf '%s\\n' "$APP_DESTINATION" "$BUNDLE_ID"`,
      [process.cwd()],
      { PATH: "/usr/bin:/bin", ...overrides },
    );
  }

  it.each([false, true])(
    "keeps the cloud variant %s separate from the ordinary output",
    (cloud) => {
      const result = resolveVariant({ OPENCLAW_MAC_CLOUD_WORKER_HOST: cloud ? "1" : "0" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        path.join(process.cwd(), "dist", cloud ? "OpenClawCloudWorker.app" : "OpenClaw.app"),
        cloud ? "ai.openclaw.cloud-worker" : "ai.openclaw.mac.debug",
      ]);
    },
  );

  it.each([
    { BUNDLE_ID: "ai.openclaw.mac" },
    { ALLOW_ADHOC_SIGNING: "1" },
    { DISABLE_LIBRARY_VALIDATION: "1" },
    { SKIP_TEAM_ID_CHECK: "1" },
    { OPENCLAW_PACKAGE_APP_ROOT: path.join(process.cwd(), "dist/OpenClaw.app") },
  ])(
    "rejects a cloud build that weakens its identity or replaces the ordinary app: %j",
    (override) => {
      const result = resolveVariant({ OPENCLAW_MAC_CLOUD_WORKER_HOST: "1", ...override });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ERROR:");
    },
  );

  it.runIf(process.platform === "darwin").each([false, true])(
    "stamps cloud capability only in its dedicated bundle: %s",
    (cloud) => {
      const app = tempDirs.make("openclaw-cloud-bundle-");
      writeFiles(app, {
        "Contents/Info.plist": readFileSync("apps/macos/Sources/OpenClaw/Resources/Info.plist"),
      });
      const stamp = script.slice(
        script.indexOf(
          'plist_set_string_required "$APP_ROOT/Contents/Info.plist" CFBundleIdentifier',
        ),
        script.indexOf(
          'plist_set_string_required "$APP_ROOT/Contents/Info.plist" CFBundleShortVersionString',
        ),
      );
      const result = runShell(
        `set -euo pipefail\nsource "$1"\nAPP_ROOT="$2"\nBUNDLE_ID="$3"\nCLOUD_WORKER_HOST="$4"\n${stamp}\n/usr/bin/plutil -convert json -o - "$APP_ROOT/Contents/Info.plist"`,
        [
          path.resolve("scripts/lib/plistbuddy.sh"),
          app,
          cloud ? "ai.openclaw.cloud-worker" : "ai.openclaw.mac.debug",
          cloud ? "1" : "0",
        ],
      );
      expect(result.status, result.stderr).toBe(0);
      const plist = JSON.parse(result.stdout);
      expect(plist.CFBundleIdentifier).toBe(
        cloud ? "ai.openclaw.cloud-worker" : "ai.openclaw.mac.debug",
      );
      expect(plist.CFBundleName).toBe(cloud ? "OpenClaw Cloud Worker" : "OpenClaw");
      expect(plist.OpenClawCloudWorkerHostVersion).toBe(cloud ? 1 : undefined);
      expect(plist.CFBundleURLTypes).toEqual(cloud ? undefined : expect.any(Array));
    },
  );
});

describe.skipIf(process.platform === "win32" || availableParallelism() < 2)(
  "parallel macOS Swift build ownership",
  () => {
    const test = createMacScriptTest();
    test.for(["success", "failure", "wrong-source", "cancel", "cleanup-failure"])(
      "joins architecture workers and preserves assembly safety: %s",
      { timeout: 15_000 },
      async (mode, { mac, onTestFinished, signal }) => {
        const root = mac.createTempDir("openclaw-swift-parallel-");
        const stage = path.join(root, "stage");
        const scripts = path.join(root, "scripts/lib");
        mkdirSync(scripts, { recursive: true });
        mkdirSync(stage);
        const mountParent = path.join(root, "Darwin private temp");
        mkdirSync(mountParent);
        const getconf = path.join(root, "getconf");
        writeExecutable(
          getconf,
          `#!/bin/bash
[[ "$*" == DARWIN_USER_TEMP_DIR ]] || exit 2
printf '%s\\n' '${mountParent.replaceAll("'", "'\\''")}'
`,
        );
        const commit = "b".repeat(40);
        writeFileSync(
          path.join(scripts, "mac-swift-build.sh"),
          `#!/bin/bash
set -euo pipefail
exec "${process.execPath}" "${path.join(root, "worker.mjs")}" "$@"
`,
        );
        writeFileSync(
          path.join(root, "worker.mjs"),
          `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [operation, root, arch, config, jobs, commit, skip, work, mount] = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const event = (value) => fs.appendFileSync(path.join(root, 'events'), value + '\\n');
if (!mount || path.dirname(path.dirname(mount)) !== fs.realpathSync(path.join(root, 'Darwin private temp'))) {
  throw new Error('snapshot mount must use the OS temp location, independently of work or TMPDIR');
}
if (operation === 'cleanup') {
  if (fs.readFileSync(path.join(root, 'mount-' + arch), 'utf8') !== mount) throw new Error('cleanup lost the build mount');
  event('cleanup:' + arch);
  if (mode === 'cleanup-failure') process.exit(55);
  fs.rmdirSync(mount);
  process.exit(0);
}
fs.mkdirSync(mount);
fs.writeFileSync(path.join(root, 'mount-' + arch), mount);
event('build:' + arch + ':' + jobs);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(root, 'pid-' + arch), String(child.pid));
const exited = new Promise(resolve => child.on('exit', resolve));
process.on('SIGTERM', async () => { child.kill(); await exited; event('stopped:' + arch); process.exit(143); });
const released = new Promise(resolve => process.once('SIGUSR2', resolve));
console.log('ready:' + arch + ':' + process.pid);
await released;
event('barrier:' + arch);
if (mode === 'cancel' || (mode === 'failure' && arch === 'arm64')) await new Promise(() => {});
child.kill(); await exited;
if (mode === 'failure') process.exit(42);
fs.writeFileSync(path.join(work, 'peekaboo-commit'), mode === 'wrong-source' ? 'wrong' : commit);
`,
        );
        const script = readFileSync(scriptPath, "utf8");
        const cleanup = script.slice(
          script.indexOf("cleanup_package_build() {"),
          script.indexOf("PNPM_CMD=()"),
        );
        const build = script.slice(
          script.indexOf('echo "🔨 Building $PRODUCT'),
          script.indexOf('BIN_PRIMARY="$(bin_for_arch'),
        );
        // Exercise the real parent wait/signal/cleanup flow; only the heavy graph is a fixture.
        const launcher = `set -euo pipefail
ROOT_DIR=${JSON.stringify(root)}
APP_STAGE_DIR=${JSON.stringify(stage)}
SWIFT_BUILD_RESULTS=""
SWIFT_BUILD_PID=""
PRODUCT=OpenClaw
BUILD_CONFIG=release
PEEKABOO_LOCKED_SOURCE_COMMIT=${commit}
SKIP_MLX_TTS=0
BUILD_ARCHS=(arm64 x86_64)
node() { exec "${process.execPath}" ${JSON.stringify(path.resolve("scripts/build-mac-swift.mts"))} "\${@:2}"; }
${cleanup}
${build}
touch "$ROOT_DIR/assembled"
`;
        const child = spawn("/bin/bash", ["-c", launcher], {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            TMPDIR: path.join(root, "unavailable"),
          },
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        const closed = mac.lifetime.track(
          new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          }),
        );
        const output = createInterface({ input: child.stdout });
        const workers = new Map<string, number>();
        const ready = createDeferred();
        output.on("line", (line) => {
          const match = /^ready:(arm64|x86_64):(\d+)$/.exec(line);
          if (match) {
            workers.set(match[1]!, Number(match[2]));
            if (workers.size === 2) {
              ready.resolve();
            }
          }
        });
        onTestFinished(async () => {
          try {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGTERM");
            }
            await closed;
          } finally {
            output.close();
          }
        });
        await withinTest(
          awaitGateBeforeSettlement(ready.promise, closed, "architecture barrier did not open"),
          signal,
        );
        // Each worker installs its release handler before publishing its PID.
        for (const pid of workers.values()) {
          process.kill(pid, "SIGUSR2");
        }
        if (mode === "cancel") {
          child.kill("SIGTERM");
        }
        const code = await withinTest(closed, signal);
        expect(code, stderr).toBe(
          mode === "success" ? 0 : mode === "cancel" ? 143 : mode === "cleanup-failure" ? 2 : 1,
        );
        expect(existsSync(path.join(root, "assembled"))).toBe(mode === "success");
        expect(existsSync(stage)).toBe(mode === "cleanup-failure");
        expect(readdirSync(mountParent)).toHaveLength(mode === "cleanup-failure" ? 1 : 0);
        const events = read(root, "events").trim().split("\n");
        expect(events.filter((event) => event.startsWith("cleanup:")).toSorted()).toEqual([
          "cleanup:arm64",
          "cleanup:x86_64",
        ]);
        for (const arch of ["arm64", "x86_64"]) {
          const mount = read(root, `mount-${arch}`);
          expect(existsSync(mount)).toBe(mode === "cleanup-failure");
          if (mode === "cleanup-failure") {
            expect(statSync(path.dirname(mount)).mode & 0o777).toBe(0o700);
          }
          const pid = Number(read(root, `pid-${arch}`));
          expect(() => process.kill(pid, 0)).toThrow();
          expect(
            existsSync(path.join(root, "apps/macos/.build", `.openclaw-package-${arch}.lock`)),
          ).toBe(mode === "cleanup-failure");
        }
      },
    );
  },
);

describe("packaged worker freshness", () => {
  it.skipIf(process.platform === "win32")(
    "keeps private app staging out of package contents and removes it after use",
    async () => {
      const root = tempDirs.make("openclaw-package-stage-");
      const dist = path.join(root, "dist");
      const output = tempDirs.make("openclaw-package-stage-output-");
      const previousApp = path.join(dist, "OpenClaw.app/Contents/MacOS/OpenClaw");
      const { files, packageManager, version } = JSON.parse(
        readFileSync("package.json", "utf8"),
      ) as {
        files: string[];
        packageManager: string;
        version: string;
      };
      writeFiles(root, {
        "dist/OpenClaw.app/Contents/MacOS/OpenClaw": "previous signed app\n",
        "dist/entry.js": "export {};\n",
        "package.json": JSON.stringify({ name: "openclaw", version, packageManager, files }),
      });
      const allocated = runShell(
        `set -euo pipefail
ROOT_DIR="$1"
APP_DESTINATION="$ROOT_DIR/dist/OpenClaw.app"
APP_BUNDLE_NAME=OpenClaw.app
${scriptBlock("# pnpm build owns the Control UI", 'echo "🔨 Building $PRODUCT')}
printf '%s' "$APP_STAGE_DIR"
`,
        [root],
        { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: path.join(root, "unavailable") },
      );
      expect(allocated.status, allocated.stderr).toBe(0);
      const stage = allocated.stdout;
      const swiftResults = path.join(stage, "swift-builds");
      writeFiles(swiftResults, {
        "arm64/peekaboo-commit": "private stage canary\n",
        "cleanup-complete": "verified\n",
      });
      writeFiles(stage, { "OpenClaw.app/Contents/MacOS/OpenClaw": "candidate app\n" });
      try {
        expect(statSync(stage).dev).toBe(statSync(dist).dev);
        expect(statSync(stage).mode & 0o777).toBe(0o700);
        const packed = spawnSync(
          "npm",
          ["pack", "--silent", "--ignore-scripts", "--offline", "--pack-destination", output],
          { cwd: root, encoding: "utf8", env: { HOME: root, PATH: process.env.PATH } },
        );
        expect(packed.status, packed.stderr).toBe(0);
        const entries: string[] = [];
        await tar.t({
          file: path.join(output, `openclaw-${version}.tgz`),
          onentry: (entry) => {
            if (entry.type !== "Directory") {
              entries.push(entry.path);
            }
          },
        });
        expect(entries.toSorted()).toEqual(["package/dist/entry.js", "package/package.json"]);
      } finally {
        const cleaned = runShell(
          `set -euo pipefail
APP_STAGE_DIR="$1"
SWIFT_BUILD_RESULTS="$APP_STAGE_DIR/swift-builds"
SWIFT_BUILD_PID=""
${scriptBlock("cleanup_package_build() {", "PNPM_CMD=()")}
`,
          [stage],
          { HOME: root, PATH: "/usr/bin:/bin" },
        );
        expect(cleaned.status, cleaned.stderr).toBe(0);
        expect(existsSync(stage)).toBe(false);
        expect(readFileSync(previousApp, "utf8")).toBe("previous signed app\n");
      }
    },
  );

  it("bounds expanded package exclusions to the app root", () => {
    const app = "dist/OpenClaw-proof.app";
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };
    const exclusions = manifest.files
      .filter((entry) => entry.startsWith("!"))
      .map((entry) => entry.slice(1));
    const entries = [app, `${app}/Contents`, `${app}/Contents/MacOS/OpenClaw`, "dist/entry.js"];
    // npm 12 expands files globs into individual ignore rules. Exclude the app
    // directory, which also excludes its contents, not every payload file separately.
    const matches = entries.filter((entry) =>
      exclusions.some((pattern) => minimatch(entry, pattern, { dot: true })),
    );
    expect(matches).toEqual([app]);
  });

  it("rebuilds dirty JavaScript even when the old SKIP_TSC shortcut is requested", () => {
    const root = tempDirs.make("openclaw-package-worker-freshness-");
    const result = spawnSync(
      process.platform === "win32" ? "bash" : "/bin/bash",
      [
        "-c",
        `
      set -euo pipefail
      run_pnpm() { printf '%s\\n' 'fresh dirty worker' > "$HOME/worker.js"; }
      ${scriptBlock('if [[ "${SKIP_TSC:-0}"', 'node - "$ROOT_DIR/dist/build-info.json"')}
    `,
      ],
      { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin", SKIP_TSC: "1" } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(root, "worker.js"))).toBe(true);
  });
});

function makePlist(): string {
  const dir = tempDirs.make("openclaw-plistbuddy-");
  const plist = path.join(dir, "Info.plist");
  writeFileSync(
    plist,
    plistDocument("<dict><key>CFBundleIdentifier</key><string>old.bundle</string></dict>"),
    "utf8",
  );
  return plist;
}

function plistDocument(value: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">${value}</plist>`;
}

function runHelper(script: string, shell = process.platform === "win32" ? "bash" : "/bin/bash") {
  // Login/logout hooks can replace the helper's exit status on headless hosts.
  return spawnSync(shell, ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function scriptBlock(startMarker: string, endMarker: string, file = scriptPath): string {
  const script = readFileSync(file, "utf8");
  const start = script.indexOf(startMarker);
  const end = script.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

function runBlock(start: string, end: string, before: string, after = "", file = scriptPath) {
  return runHelper(`set -euo pipefail\n${before}\n${scriptBlock(start, end, file)}\n${after}`);
}

function runSwiftToolchainHarness(options: {
  swiftVersion: string;
  selectedDeveloperDir: "command-line-tools" | "xcode";
  xcodebuildFailure?: string;
}) {
  const root = tempDirs.make("openclaw-package-swift-root-");
  const toolsDir = path.join(root, "tools");
  const commandLineToolsDir = path.join(root, "Library", "Developer", "CommandLineTools");
  const xcodeDeveloperDir = path.join(root, "Applications", "Xcode.app", "Contents", "Developer");
  const selectedDeveloperDir =
    options.selectedDeveloperDir === "xcode" ? xcodeDeveloperDir : commandLineToolsDir;

  mkdirSync(commandLineToolsDir, { recursive: true });
  const xcodebuild = path.join(xcodeDeveloperDir, "usr", "bin", "xcodebuild");
  writeExecutable(
    xcodebuild,
    `#!/bin/bash
[[ "$*" == "-version" ]] || exit 2
${
  options.xcodebuildFailure
    ? `printf '%s\\n' ${JSON.stringify(options.xcodebuildFailure)} >&2; exit 1`
    : "echo 'Xcode 26.4'"
}
`,
  );
  writeExecutable(
    path.join(toolsDir, "xcrun"),
    `#!/bin/bash
[[ "\${1:-}" == "xcodebuild" && "\${2:-}" == "-version" ]] || exit 2
developer_dir="\${DEVELOPER_DIR:-$MOCK_SELECTED_DEVELOPER_DIR}"
xcodebuild="$developer_dir/usr/bin/xcodebuild"
if [[ ! -x "$xcodebuild" ]]; then
  echo "xcrun: error: unable to find utility xcodebuild" >&2
  exit 1
fi
exec "$xcodebuild" "\${@:2}"
`,
  );
  writeExecutable(
    path.join(toolsDir, "swift"),
    `#!/bin/bash\necho 'swift-driver version: 1.120.0 Apple Swift version ${options.swiftVersion} (swiftlang-${options.swiftVersion} clang-1700.0.13.5)'\n`,
  );

  return runHelper(`
    set -euo pipefail
    PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
    export MOCK_SELECTED_DEVELOPER_DIR=${JSON.stringify(selectedDeveloperDir)}
    unset DEVELOPER_DIR
    ${readFileSync("scripts/lib/swift-toolchain.sh", "utf8")}
    require_swift_toolchain
  `);
}

function runPeekabooSourceCommitHarness(packageResolved: string, expectedRevision?: string) {
  const root = tempDirs.make("openclaw-package-peekaboo-source-");
  writeFiles(root, { "apps/macos/Package.resolved": packageResolved });

  return runBlock(
    "resolve_peekaboo_source_commit() {",
    "sparkle_canonical_build_from_version()",
    `${shellVars({ ROOT_DIR: root })}\n${expectedRevision ? shellVars({ OPENCLAW_EXPECTED_PEEKABOO_SOURCE_COMMIT: expectedRevision }) : "unset OPENCLAW_EXPECTED_PEEKABOO_SOURCE_COMMIT"}`,
    "resolve_peekaboo_source_commit",
  );
}

function runSourceProvenanceStampHarness(corruptKey?: string) {
  const openClawCommit = "a".repeat(40);
  const peekabooCommit = "b".repeat(40);
  const corruptCommit = "c".repeat(40);
  const result = runHelper(`
    set -euo pipefail
    stamped_openclaw=
    stamped_peekaboo=
    plist_set_string_required() {
      case "$2" in
        OpenClawGitCommit) stamped_openclaw="$3" ;;
        PeekabooSourceCommit) stamped_peekaboo="$3" ;;
      esac
    }
    plist_print_required() {
      local value
      case "$2" in
        OpenClawGitCommit) value="$stamped_openclaw" ;;
        PeekabooSourceCommit) value="$stamped_peekaboo" ;;
        *) return 1 ;;
      esac
      if [[ "$2" == ${JSON.stringify(corruptKey ?? "")} ]]; then
        value=${JSON.stringify(corruptCommit)}
      fi
      printf '%s' "$value"
    }
    APP_ROOT=/tmp/OpenClaw.app
    ROOT_DIR=/unused
    node() { echo fixture-build-id; }
    plist_set_or_add_string() { :; }
    BUILD_TS=2026-08-13T00:00:00.000Z
    BUILD_GIT_COMMIT=${JSON.stringify(openClawCommit)}
    PEEKABOO_SOURCE_COMMIT=${JSON.stringify(peekabooCommit)}
    BUILD_CONFIG=release
    ${scriptBlock('plist_set_string_required "$APP_ROOT/Contents/Info.plist" OpenClawBuildTimestamp', 'plist_set_or_add_string "$APP_ROOT/Contents/Info.plist" SUFeedURL')}
    printf '%s\n%s\n' "$stamped_openclaw" "$stamped_peekaboo"
  `);

  return { result, openClawCommit, peekabooCommit };
}

function getSwiftPackageResolutionBlock(): string {
  const block = scriptBlock(
    "run_with_locked_swift_packages()",
    "build_swift_architecture() {",
    swiftScriptPath,
  );
  // The inlined block skips the worker's own source of the shared disk image helpers.
  const diskImage = `source ${JSON.stringify(path.resolve("scripts/lib/mac-disk-image.sh"))}`;
  // The shared EXIT cleanup also needs the packager preamble's unallocated app stage.
  return `${diskImage}\n${block}\nBUILD_PATH="$ROOT_DIR/build"\nSWIFT_WORK_ROOT="$ROOT_DIR/work"\nmkdir -p "$SWIFT_WORK_ROOT"\n`;
}

function runSnapshotCreation(
  fixture: {
    root: string;
    buildPath: string;
    mount: string;
    operations: string;
    expectedCommit: string;
  },
  before = "",
  env: Record<string, string> = {},
) {
  const { root, buildPath, mount, operations, expectedCommit } = fixture;
  return runHelper(
    `
    set -euo pipefail
    ${shellVars({ ROOT_DIR: root, fixture_root: root, operations, fixture_mount: mount, PATH: `${root}:/usr/bin:/bin`, ...env })}
    ${getSwiftPackageResolutionBlock()}
    PEEKABOO_SNAPSHOT_MOUNT="$fixture_mount"
    BUILD_PATH=${JSON.stringify(buildPath)}
    trap cleanup_swift_architecture EXIT
    compiled_peekaboo_commit() {
      printf 'verify:%s:%s\\n' "$1" "$2" >> "$operations"
      printf '%s' "$2"
    }
    ${before}
    create_verified_peekaboo_snapshot ${JSON.stringify(buildPath)} ${JSON.stringify(expectedCommit)}
    printf 'snapshot-ready\\n' >> "$operations"
  `,
    "/bin/bash",
  );
}

function snapshotImageInfoPlist(imagePath?: string): string {
  const image = imagePath
    ? `<dict>
  <key>image-path</key>
  <string>${imagePath.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string>
  <key>system-entities</key>
  <array>
    ${["/dev/disk8", "/dev/disk8s1", "/dev/disk11", "/dev/disk11s1"]
      .map((device) => `<dict><key>dev-entry</key><string>${device}</string></dict>`)
      .join("\n    ")}
  </array>
</dict>`
    : "";
  return plistDocument(`<dict><key>images</key><array>${image}</array></dict>`);
}

function fixtureGit(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function initializeRepository(cwd: string) {
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Fixture"],
    ["config", "user.email", "fixture@example.invalid"],
    ["add", "."],
    ["commit", "-qm", "fixture"],
  ]) {
    fixtureGit(cwd, ...args);
  }
  return fixtureGit(cwd, "rev-parse", "HEAD");
}

function runRealCompiledPeekabooHarness(
  mutation:
    | "assume-unchanged"
    | "corrupt-object"
    | "dirty-gitlink"
    | "export-subst"
    | "gitlink-sibling"
    | "ignored"
    | "nested-gitlink"
    | "none"
    | "replacement-ref",
  expectedOverride?: string,
) {
  const root = tempDirs.make(`openclaw-compiled-peekaboo-real-${mutation}-`);
  const buildPath = path.join(root, "build");
  const checkout = path.join(buildPath, "checkouts", "Peekaboo");
  const sourcePath = path.join(checkout, "Core", "Sources", "Fixture.swift");
  writeFiles(checkout, {
    "Package.swift": "// swift-tools-version: 6.2\n",
    "Core/Sources/Fixture.swift": 'let fixture = "$Format:%H$"\n',
    ".gitattributes": "Core/Sources/Fixture.swift export-subst\n",
  });
  let head = initializeRepository(checkout);

  if (
    mutation === "dirty-gitlink" ||
    mutation === "gitlink-sibling" ||
    mutation === "nested-gitlink"
  ) {
    const gitlinkPath = mutation === "gitlink-sibling" ? "Vendor" : "Dependencies/Vendor";
    const gitlinkCheckout = path.join(checkout, gitlinkPath);
    writeFiles(gitlinkCheckout, { "README.md": "initialized submodule\n" });
    const gitlinkHead = initializeRepository(gitlinkCheckout);
    writeFiles(checkout, {
      ".gitmodules": `[submodule "fixture"]\n\tpath = ${gitlinkPath}\n\turl = https://example.invalid/vendor.git\n`,
    });
    fixtureGit(checkout, "add", ".gitmodules");
    fixtureGit(
      checkout,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${gitlinkHead},${gitlinkPath}`,
    );
    fixtureGit(checkout, "commit", "-qm", "gitlink");
    head = fixtureGit(checkout, "rev-parse", "HEAD");
  }

  if (mutation === "assume-unchanged") {
    fixtureGit(checkout, "update-index", "--assume-unchanged", path.relative(checkout, sourcePath));
    writeFileSync(sourcePath, "let fixture = 2\n", "utf8");
  } else if (mutation === "corrupt-object") {
    const treeId = fixtureGit(checkout, "rev-parse", "HEAD^{tree}");
    const objectPath = path.join(checkout, ".git", "objects", treeId.slice(0, 2), treeId.slice(2));
    chmodSync(objectPath, 0o644);
    writeFileSync(objectPath, "corrupt object\n");
  } else if (mutation === "dirty-gitlink") {
    writeFileSync(path.join(checkout, "Dependencies", "Vendor", "README.md"), "dirty submodule\n");
  } else if (mutation === "export-subst") {
    writeFileSync(sourcePath, `let fixture = "${head}"\n`, "utf8");
  } else if (mutation === "gitlink-sibling") {
    writeFiles(checkout, { "Core/Vendor/Injected.swift": "let injected = true\n" });
  } else if (mutation === "ignored") {
    writeFiles(checkout, {
      ".git/info/exclude": "Hidden.swift\n",
      "Hidden.swift": "let hidden = true\n",
    });
  } else if (mutation === "replacement-ref") {
    const approvedHead = head;
    writeFileSync(sourcePath, 'let fixture = "replacement"\n', "utf8");
    fixtureGit(checkout, "commit", "-qam", "replacement");
    const replacementHead = fixtureGit(checkout, "rev-parse", "HEAD");
    fixtureGit(checkout, "replace", approvedHead, replacementHead);
    fixtureGit(checkout, "checkout", "-q", "--detach", approvedHead);
    writeFileSync(sourcePath, 'let fixture = "replacement"\n', "utf8");
    head = approvedHead;
  }

  return runBlock(
    "compiled_peekaboo_commit() {",
    "swiftpm_resource_sources()",
    "",
    `compiled_peekaboo_commit ${JSON.stringify(buildPath)} ${JSON.stringify(expectedOverride ?? head)}`,
    swiftScriptPath,
  );
}

const swiftPMResourceBundles = [
  "GRDB_GRDB.bundle",
  "OpenClaw_OpenClaw.bundle",
  "OpenClawKit_OpenClawKit.bundle",
  "OpenClawKit_OpenClawChatUI.bundle",
  "KeyboardShortcuts_KeyboardShortcuts.bundle",
  "SwiftMath_SwiftMath.bundle",
] as const;

const mlxTTSResourceFiles = [
  "mlx-swift_Cmlx.bundle/Contents/Info.plist",
  "mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib",
  "swift-crypto_Crypto.bundle/Contents/Info.plist",
  "swift-crypto_Crypto.bundle/Contents/Resources/PrivacyInfo.xcprivacy",
  "swift-transformers_Hub.bundle/Contents/Info.plist",
  "swift-transformers_Hub.bundle/Contents/Resources/gpt2_tokenizer_config.json",
  "swift-transformers_Hub.bundle/Contents/Resources/t5_tokenizer_config.json",
] as const;

function runSwiftPMResourceBundleHarness(options: { missingBundle?: string } = {}) {
  const root = tempDirs.make("openclaw-package-resources-root-");
  const buildRoot = path.join(root, "build");
  const helperBuildRoot = path.join(root, "helper build");
  const appRoot = path.join(root, "OpenClaw.app");
  const buildProducts = path.join(buildRoot, "arm64", "debug");
  const helperBuildProducts = path.join(helperBuildRoot, "arm64", "out", "Products", "Debug");

  mkdirSync(path.join(appRoot, "Contents", "Resources"), { recursive: true });
  for (const bundle of swiftPMResourceBundles) {
    if (bundle === options.missingBundle) {
      continue;
    }
    writeFiles(buildProducts, { [`${bundle}/marker`]: bundle });
  }
  for (const file of mlxTTSResourceFiles) {
    writeFiles(helperBuildProducts, { [file]: file });
  }

  const result = runHelper(`
    set -euo pipefail
    BUILD_ROOT=${JSON.stringify(buildRoot)}
    MLX_TTS_HELPER_BUILD_ROOT=${JSON.stringify(helperBuildRoot)}
    APP_ROOT=${JSON.stringify(appRoot)}
    PRIMARY_ARCH=arm64
    BUILD_CONFIG=debug
    SKIP_MLX_TTS=0
    build_path_for_arch() {
      echo "$BUILD_ROOT/$1"
    }
    helper_build_path_for_arch() {
      echo "$MLX_TTS_HELPER_BUILD_ROOT/$1"
    }
    helper_products_for_arch() {
      [[ "$#" -eq 1 && "$1" == "$PRIMARY_ARCH" ]] || return 1
      printf '%s\\n' ${JSON.stringify(helperBuildProducts)}
    }
    ${scriptBlock('echo "📦 Copying SwiftPM resource bundles"', "running_packaged_app_pids()")}
  `);

  return { appRoot, result };
}

function runSwiftPMResourcePatchHarness(failRestore = false) {
  const root = tempDirs.make("openclaw-package-resource-patch-");
  const workRoot = tempDirs.make("openclaw-resource-backups-");
  const backupRoot = path.join(workRoot, "resource-backups");
  const buildPath = path.join(root, "build");
  const checkoutRoot = path.join(buildPath, "checkouts");
  const keyboardShortcuts = path.join(
    checkoutRoot,
    "KeyboardShortcuts/Sources/KeyboardShortcuts/Utilities.swift",
  );
  const swiftMathFont = path.join(
    checkoutRoot,
    "SwiftMath/Sources/SwiftMath/MathBundle/MathFont.swift",
  );
  const swiftMathLegacyFont = path.join(
    checkoutRoot,
    "SwiftMath/Sources/SwiftMath/MathRender/MTFont.swift",
  );
  const fixtures = new Map([
    [
      keyboardShortcuts,
      `import Foundation
extension String {
  var localized: String {
    NSLocalizedString(self, bundle: .module, comment: self)
  }
}

extension Data {
}
`,
    ],
    [
      swiftMathFont,
      `import Foundation
#if os(macOS)
import AppKit
#endif

/// Now available for everyone to use
let first = Bundle.module.url(forResource: "mathFonts", withExtension: "bundle")
let second = Bundle.module.url(forResource: "mathFonts", withExtension: "bundle")
`,
    ],
    [
      swiftMathLegacyFont,
      'let font = Bundle.module.url(forResource: "mathFonts", withExtension: "bundle")\n',
    ],
  ]);

  writeFiles(
    root,
    Object.fromEntries(
      [...fixtures].map(([file, contents]) => [path.relative(root, file), contents]),
    ),
  );

  const result = runHelper(`
    set -euo pipefail
    SWIFT_WORK_ROOT=${JSON.stringify(workRoot)}
    BUILD_PATH=${JSON.stringify(buildPath)}
    ${scriptBlock("swiftpm_resource_sources()", "cleanup_swift_architecture() {", swiftScriptPath)}
    patch_swiftpm_resource_lookups ${JSON.stringify(buildPath)}
    grep -q keyboardShortcutsPackagedResources ${JSON.stringify(keyboardShortcuts)}
    test "$(grep -c swiftMathPackagedResources ${JSON.stringify(swiftMathFont)})" -eq 3
    grep -q swiftMathPackagedResources ${JSON.stringify(swiftMathLegacyFont)}
    ${failRestore ? "mv() { printf 'restore failed\\n' >&2; return 13; }" : ""}
    cleanup_status=0
    restore_swiftpm_resource_sources || cleanup_status=$?
    exit "$cleanup_status"
  `);

  return { backupRoot, fixtures, result };
}

function runStopPackagedAppHarness() {
  const root = tempDirs.make("openclaw-package-stop-root-");
  const toolsDir = tempDirs.make("openclaw-package-stop-tools-");

  const appRoot = path.join(root, "dist", "OpenClaw.app");
  const appBinary = path.join(appRoot, "Contents", "MacOS", "OpenClaw");
  const lsofPath = path.join(toolsDir, "lsof");
  const pgrepPath = path.join(toolsDir, "pgrep");
  const sleepPath = path.join(toolsDir, "sleep");

  writeExecutable(lsofPath, `#!/bin/bash\nprintf 'n%s\\n' ${JSON.stringify(appBinary)}`);
  writeExecutable(pgrepPath, "#!/bin/bash\nprintf '123\\n'\n");
  writeExecutable(sleepPath, "#!/bin/bash\nexit 0\n");

  return runBlock(
    "running_packaged_app_pids()",
    'if [[ -n "${SIGN_IDENTITY:-}" ]]',
    `${shellVars({ APP_DESTINATION: appRoot, PRODUCT: "OpenClaw", PATH: `${toolsDir}:/usr/bin:/bin` })}\nkill() { return 0; }`,
    "stop_packaged_app_if_running",
  );
}

function runSwiftCompatibilityHarness() {
  const root = tempDirs.make("openclaw-package-swift-root-");
  const toolsDir = tempDirs.make("openclaw-package-swift-tools-");
  const developerDir = path.join(root, "Xcode.app", "Contents", "Developer");
  const appRoot = path.join(root, "OpenClaw.app");
  const xcodeSelectPath = path.join(toolsDir, "xcode-select");

  writeExecutable(xcodeSelectPath, `#!/bin/bash\nprintf '%s\\n' ${JSON.stringify(developerDir)}`);

  return runBlock(
    'echo "📦 Copying Swift 6.2 compatibility libraries"',
    'echo "🖼  Compiling app icon"',
    `${shellVars({ APP_ROOT: appRoot, BUILD_CONFIG: "release", PATH: `${toolsDir}:/usr/bin:/bin` })}\nmkdir -p "$APP_ROOT/Contents/Frameworks"`,
  );
}

function runSwiftPackageResolutionHarness() {
  const root = tempDirs.make("openclaw-swift-resolve-root-");
  const toolsDir = tempDirs.make("openclaw-swift-resolve-tools-");

  const resolvedFile = path.join(root, "apps", "macos", "Package.resolved");
  const swiftPath = path.join(toolsDir, "swift");

  mkdirSync(path.dirname(resolvedFile), { recursive: true });
  writeFileSync(resolvedFile, "locked\n", { encoding: "utf8", flag: "wx" });
  writeExecutable(swiftPath, `#!/bin/bash\nprintf 'changed\\n' > ${JSON.stringify(resolvedFile)}`);

  const result = runHelper(`
    set -euo pipefail
    ROOT_DIR=${JSON.stringify(root)}
    PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
    ${getSwiftPackageResolutionBlock()}
    run_with_locked_swift_packages swift package --scratch-path "$ROOT_DIR/apps/macos/.build/arm64" resolve
  `);

  return { result, resolvedFile };
}

describe("package-mac-app plist stamping", () => {
  it("gates only release packaging on clean matching source and verifies the embedded commit", () => {
    const script = readFileSync(scriptPath, "utf8");
    const sourceCheck = script.indexOf(
      '/bin/bash "$ROOT_DIR/scripts/apple-release-source-check.sh"',
    );
    const build = script.indexOf('node "$ROOT_DIR/scripts/build-mac-swift.mts"');
    const embeddedRead = script.indexOf(
      'plist_print_required "$APP_ROOT/Contents/Info.plist" OpenClawGitCommit',
    );
    const bridgeSourceRead = script.indexOf(
      'plist_print_required "$APP_ROOT/Contents/Info.plist" PeekabooSourceCommit',
    );
    const signing = script.indexOf('"$ROOT_DIR/scripts/codesign-mac-app.sh"');
    const releaseBranch = script.lastIndexOf(
      'if [[ "$BUILD_CONFIG" == "release" ]]; then',
      sourceCheck,
    );
    const releaseBranchEnd = script.indexOf("\nfi", sourceCheck);

    expectContains(script, [
      'BUILD_CONFIG="${BUILD_CONFIG:-debug}"',
      '--expected-commit "$BUILD_GIT_COMMIT"',
      'plist_set_string_required "$APP_ROOT/Contents/Info.plist" PeekabooSourceCommit "$PEEKABOO_SOURCE_COMMIT"',
    ]);
    expect(sourceCheck).toBeGreaterThan(releaseBranch);
    expect(sourceCheck).toBeLessThan(releaseBranchEnd);
    expect(sourceCheck).toBeLessThan(build);
    expect(embeddedRead).toBeGreaterThan(sourceCheck);
    expect(embeddedRead).toBeLessThan(signing);
    expect(bridgeSourceRead).toBeGreaterThan(sourceCheck);
    expect(bridgeSourceRead).toBeLessThan(signing);
    expect(script).not.toContain(
      'plist_set_string_required "$APP_ROOT/Contents/Info.plist" PeekabooSourceCommit "$BUILD_GIT_COMMIT"',
    );
  });

  it.each([
    { key: undefined, diagnostic: "" },
    { key: "OpenClawGitCommit", diagnostic: "Release app OpenClaw source mismatch" },
    { key: "PeekabooSourceCommit", diagnostic: "Release app Peekaboo source mismatch" },
  ])("validates independent source stamps (corrupt key: $key)", ({ key, diagnostic }) => {
    const { result, openClawCommit, peekabooCommit } = runSourceProvenanceStampHarness(key);
    expect(result.status, result.stderr).toBe(key ? 1 : 0);
    if (key) {
      expect(result.stderr).toContain(diagnostic);
    } else {
      expect(result.stdout).toBe(`${openClawCommit}\n${peekabooCommit}\n`);
      expect(result.stderr).toBe("");
    }
  });

  it("requires the locked Peekaboo pin to match the requested elevation release source", () => {
    const requestedRevision = "b".repeat(40);
    const packageResolved = readFileSync("apps/macos/Package.resolved", "utf8");
    const parsed = JSON.parse(packageResolved) as {
      pins: Array<{ identity: string; state: { revision?: string } }>;
    };
    const pinnedRevision = parsed.pins.find((pin) => pin.identity === "peekaboo")?.state.revision;
    expect(pinnedRevision).toMatch(/^[0-9a-f]{40}$/);

    const matching = runPeekabooSourceCommitHarness(packageResolved, pinnedRevision!);
    expect(matching.status, matching.stderr).toBe(0);
    expect(matching.stdout).toBe(pinnedRevision);

    const mismatched = runPeekabooSourceCommitHarness(packageResolved, requestedRevision);
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain("does not match requested release source");
  });

  it.each([
    {
      title: "is missing",
      packageResolved: '{"pins":[]}',
      diagnostic: "exactly one 'peekaboo' pin",
    },
    {
      title: "has a malformed revision",
      packageResolved:
        '{"pins":[{"identity":"peekaboo","state":{"revision":"A2FB16764A7D1C53BF696127C287BA32703F614F"}}]}',
      diagnostic: "40-character lowercase hexadecimal revision",
    },
    {
      title: "is invalid JSON",
      packageResolved: "not-json",
      diagnostic: "Could not parse Peekaboo source revision",
    },
  ])("fails closed when the Peekaboo package pin $title", ({ packageResolved, diagnostic }) => {
    const result = runPeekabooSourceCommitHarness(packageResolved);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it("keeps dependency installation lockfile-safe", () => {
    const installBlock = scriptBlock(
      'if [[ "${SKIP_PNPM_INSTALL:-0}" != "1" ]]',
      'if [[ -z "${APP_BUILD:-}" ]]',
    );
    expectContains(installBlock, [
      "run_pnpm install --frozen-lockfile",
      "--config.node-linker=hoisted",
    ]);
    expect(installBlock).not.toContain("--no-frozen-lockfile");
  });

  it.each(["primary", "secondary"])(
    "merges framework architectures when %s file output exceeds the pipe buffer",
    (verboseFramework) => {
      const root = tempDirs.make("openclaw-package-framework-pipe-");
      const primary = path.join(root, "primary.framework");
      const secondary = path.join(root, "secondary.framework");
      const destination = path.join(root, "destination.framework");
      for (const framework of [primary, secondary, destination]) {
        writeFiles(framework, {
          Fixture: framework === secondary ? "arm64 x86_64\n" : "arm64\n",
          "Info.plist": "resource\n",
        });
      }
      const description = path.join(root, "file-output");
      // A matching first line followed by more than a pipe can buffer makes an
      // early-exiting grep kill the producer, without depending on scheduling.
      writeFileSync(
        description,
        "Mach-O universal binary with 2 architectures\n" + "architecture detail\n".repeat(65536),
      );
      const helper = scriptBlock(
        "merge_framework_machos()",
        'PEEKABOO_SOURCE_COMMIT="$(resolve_peekaboo_source_commit)"',
      )
        .replaceAll("/usr/bin/file", "fixture_file")
        .replaceAll("/usr/bin/lipo", "fixture_lipo");
      const result = runHelper(`
        set -euo pipefail
        fixture_file() {
          if [[ "$1" == */Info.plist ]]; then
            printf 'XML document\\n'
          elif [[ "$1" == */${verboseFramework}.framework/Fixture ]]; then
            cat ${JSON.stringify(description)}
          else
            printf 'Mach-O 64-bit executable\\n'
          fi
        }
        fixture_lipo() {
          case "$1" in
            -info) printf 'Architectures in the fat file: %s are: %s\\n' "$2" "$(cat "$2")" ;;
            -thin)
              [[ "$2" == x86_64 && "$4" == -output ]] || return 2
              printf '%s\\n' "$2" > "$5" ;;
            -create)
              [[ "$4" == -output ]] || return 2
              cat "$2" "$3" > "$5" ;;
            *) return 2 ;;
          esac
        }
        ${helper}
        merge_framework_machos ${JSON.stringify(primary)} ${JSON.stringify(destination)} ${JSON.stringify(secondary)}
      `);

      expect(result.status, result.stderr).toBe(0);
      expect(read(destination, "Fixture")).toBe("arm64\nx86_64\n");
      expect(read(destination, "Info.plist")).toBe("resource\n");
    },
  );

  it.runIf(process.platform === "darwin")(
    "merges framework Mach-O binaries with arm64e slices and glob metacharacters in the checkout path",
    () => {
      const secondaryArchitecture = "arm64e";
      const root = tempDirs.make("openclaw-package-framework-[fixture]-");
      const primary = path.join(root, "Primary.framework");
      const secondary = path.join(root, "Secondary.framework");
      const destination = path.join(root, "Destination.framework");
      const relativeBinary = path.join("Versions", "A", "OpenClawFixture");

      for (const framework of [primary, secondary, destination]) {
        mkdirSync(path.dirname(path.join(framework, relativeBinary)), { recursive: true });
      }

      // Inert mach_header_64 dylibs (mach-o/loader.h and mach/machine.h).
      // Own the CPU/subtype bytes so host executables and compiler SDKs cannot
      // change this fixture's slice set; real file/lipo still classify and merge it.
      const thinMachO = (cpu: number, subtype: number) => {
        const bytes = Buffer.alloc(32);
        [0xfeedfacf, cpu, subtype, 6, 0, 0, 0, 0].forEach((value, index) =>
          bytes.writeUInt32LE(value, index * 4),
        );
        return bytes;
      };
      const intel = thinMachO(0x01000007, 3);
      const arm = thinMachO(0x0100000c, 2);
      const primaryBinary = path.join(primary, relativeBinary);
      const secondaryBinary = path.join(secondary, relativeBinary);
      const destinationBinary = path.join(destination, relativeBinary);
      const armBinary = path.join(root, "arm-slice");
      writeFileSync(primaryBinary, intel);
      writeFileSync(armBinary, arm);
      const universal = spawnSync(
        "/usr/bin/lipo",
        ["-create", primaryBinary, armBinary, "-output", secondaryBinary],
        { encoding: "utf8" },
      );
      expect(universal.status, universal.stderr).toBe(0);
      writeFileSync(destinationBinary, intel);

      const result = runHelper(`
        set -euo pipefail
        ${scriptBlock("merge_framework_machos()", 'PEEKABOO_SOURCE_COMMIT="$(resolve_peekaboo_source_commit)"')}
        merge_framework_machos ${JSON.stringify(primary)} ${JSON.stringify(destination)} ${JSON.stringify(secondary)}
        /usr/bin/lipo -archs ${JSON.stringify(destinationBinary)}
      `);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split(/\s+/u).toSorted()).toEqual(
        ["x86_64", secondaryArchitecture].toSorted(),
      );
      for (const [arch, bytes] of [
        ["x86_64", intel],
        [secondaryArchitecture, arm],
      ] as const) {
        const extracted = path.join(root, `merged-${arch}`);
        const slice = spawnSync(
          "/usr/bin/lipo",
          ["-thin", arch, destinationBinary, "-output", extracted],
          { encoding: "utf8" },
        );
        expect(slice.status, slice.stderr).toBe(0);
        expect(readFileSync(extracted)).toEqual(bytes);
      }
    },
  );

  it("builds and locates the MLX helper with SwiftBuild without a legacy output alias", () => {
    const arch = "arm64";
    const tempRoot = tempDirs.make("openclaw-package-mlx-metal-");
    const metalPath = path.join(tempRoot, "metal");
    const invocationPath = path.join(tempRoot, "swift-args");
    const helperBuildRoot = path.join(tempRoot, "build");
    const helperBuildProducts = path.join(helperBuildRoot, arch, "out", "Products", "Release");
    writeFiles(helperBuildProducts, { "openclaw-mlx-tts": arch });
    writeExecutable(metalPath, "#!/bin/sh\nexit 1\n");

    const result = runHelper(`
      set -euo pipefail
      PATH=/usr/bin:/bin
      xcrun() {
        case "$*" in
          "--find swift") printf '%s\\n' ${JSON.stringify(path.join(tempRoot, "swift"))} ;;
          "metal --version") return 0 ;;
          *) return 1 ;;
        esac
      }
      swift() {
        printf '%s\\n' "$@" >> ${JSON.stringify(invocationPath)}
        printf '\\n' >> ${JSON.stringify(invocationPath)}
        for argument in "$@"; do
          if [[ "$argument" == "--show-bin-path" ]]; then
            printf '%s\\n' ${JSON.stringify(helperBuildProducts)}
          fi
        done
      }
      MLX_TTS_HELPER_ROOT=${JSON.stringify(path.join(tempRoot, "helper"))}
      MLX_TTS_HELPER_BUILD_ROOT=${JSON.stringify(helperBuildRoot)}
      MLX_TTS_HELPER_PRODUCT=openclaw-mlx-tts
      BUILD_CONFIG=release
      SWIFT_BUILD_JOBS=2
      SWIFT_BUILD_RESULTS=${JSON.stringify(tempRoot)}
      mkdir -p "$SWIFT_BUILD_RESULTS/${arch}"
      ${scriptBlock("helper_build_path_for_arch() {", "sparkle_framework_for_arch()", swiftScriptPath)}
      build_mlx_tts_helper ${arch}
      build_mlx_tts_helper ${arch} --show-bin-path > "$SWIFT_BUILD_RESULTS/${arch}/helper-products"
      swift() { echo unexpected-build >&2; return 99; }
      cat "$(helper_bin_for_arch ${arch})"
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(arch);
    const buildArgs = [
      "build",
      "--build-system",
      "swiftbuild",
      "--package-path",
      path.join(tempRoot, "helper"),
      "-c",
      "release",
      "--product",
      "openclaw-mlx-tts",
      "--build-path",
      path.join(helperBuildRoot, arch),
      "--arch",
      arch,
      "--jobs",
      "2",
    ];
    const invocations = readFileSync(invocationPath, "utf8")
      .trim()
      .split("\n\n")
      .map((call) => call.split("\n"));
    expect(invocations).toEqual([buildArgs, [...buildArgs, "--show-bin-path"]]);
  });

  it("refuses OPENCLAW_SKIP_MLX_TTS for release builds but allows it for dev builds", () => {
    const guard = scriptBlock('SKIP_MLX_TTS="${OPENCLAW_SKIP_MLX_TTS:-0}"', "BUILD_TS=");

    const released = runHelper(
      `set -euo pipefail\nexport OPENCLAW_SKIP_MLX_TTS=1\nBUILD_CONFIG=release\n${guard}\necho reached-build`,
    );
    expect(released.status).toBe(1);
    expect(released.stderr).toContain("not allowed for release builds");
    expect(released.stdout).not.toContain("reached-build");

    const dev = runHelper(
      `set -euo pipefail\nexport OPENCLAW_SKIP_MLX_TTS=1\nBUILD_CONFIG=debug\n${guard}\necho reached-build`,
    );
    expect(dev.status, dev.stderr).toBe(0);
    expect(dev.stdout).toContain("reached-build");
  });

  it("prefers repo Corepack pnpm over a global pnpm shim", () => {
    const helperBlock = scriptBlock("PNPM_CMD=()", "merge_framework_machos()");
    const tempRoot = tempDirs.make("openclaw-package-pnpm-root-");
    const outerRoot = tempDirs.make("openclaw-package-pnpm-outer-");
    const toolsDir = tempDirs.make("openclaw-package-pnpm-tools-");
    const logPath = path.join(tempRoot, "pnpm.log");
    symlinkSync("/bin/bash", path.join(toolsDir, "bash"));
    symlinkSync("/usr/bin/grep", path.join(toolsDir, "grep"));

    writeFiles(tempRoot, {
      "package.json": '{\n  "packageManager": "pnpm@11.2.2+sha512.test"\n}\n',
    });
    writeFiles(outerRoot, {
      "package.json": '{\n  "packageManager": "pnpm@11.8.0+sha512.test"\n}\n',
    });
    writeExecutable(
      path.join(toolsDir, "pnpm"),
      `#!/bin/bash
set -euo pipefail
printf "global|%s|%s\\n" "$PWD" "$*" >> "$OPENCLAW_TEST_LOG"
if [[ "\${1:-}" == "--version" ]]; then echo "11.8.0"; fi
`,
    );
    writeExecutable(
      path.join(toolsDir, "corepack"),
      `#!/bin/bash
set -euo pipefail
printf "corepack|%s|%s\\n" "$PWD" "$*" >> "$OPENCLAW_TEST_LOG"
if [[ "\${1:-}" == "pnpm" && "\${2:-}" == "--version" ]]; then
  if grep -q "pnpm@11.2.2" package.json 2>/dev/null; then echo "11.2.2"; else echo "11.8.0"; fi
fi
`,
    );

    const result = runHelper(`
      set -euo pipefail
      ROOT_DIR=${JSON.stringify(tempRoot)}
      OPENCLAW_TEST_LOG=${JSON.stringify(logPath)}
      export OPENCLAW_TEST_LOG
      PATH=${JSON.stringify(toolsDir)}
      cd ${JSON.stringify(outerRoot)}
      ${helperBlock}
      run_pnpm --version
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("11.2.2\n");
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
      `corepack|${tempRoot}|pnpm --version`,
      `corepack|${tempRoot}|pnpm --version`,
    ]);
  });

  it("checks the selected Swift toolchain before dependency install work", () => {
    const script = readFileSync(scriptPath, "utf8");
    const installIndex = script.indexOf('if [[ "${SKIP_PNPM_INSTALL:-0}" != "1" ]]');
    const preInstallBlock = script.slice(0, installIndex);

    expect(script).toContain('source "$ROOT_DIR/scripts/lib/swift-toolchain.sh"');
    expect(preInstallBlock).toContain("\nrequire_swift_toolchain\n");
  });

  it.each([
    { selectedDeveloperDir: "command-line-tools", xcodebuildFailure: undefined },
    {
      selectedDeveloperDir: "xcode",
      xcodebuildFailure: "xcodebuild: error: SDK metadata is unavailable",
    },
  ] as const)("rejects unusable Xcode: $selectedDeveloperDir", (options) => {
    const result = runSwiftToolchainHarness({
      swiftVersion: "6.3.1",
      ...options,
    });
    expect(result.status).toBe(1);
    expectContains(result.stderr, [
      "requires a full Xcode developer directory",
      "Command Line Tools do not include the required SwiftUI macro plugins",
      "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
      "DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer",
    ]);
    if (options.xcodebuildFailure) {
      const diagnosticIndex = result.stderr.indexOf(options.xcodebuildFailure);
      const guidanceIndex = result.stderr.indexOf(
        "ERROR: OpenClaw macOS app packaging requires a full Xcode developer directory",
      );
      expect(diagnosticIndex).toBeGreaterThanOrEqual(0);
      expect(guidanceIndex).toBeGreaterThan(diagnosticIndex);
    }
  });

  it("runs Sparkle build metadata derivation from the repository root", () => {
    const helperBlock = scriptBlock(
      "sparkle_canonical_build_from_version()",
      'source "$ROOT_DIR/scripts/lib/mac-swift-build.sh"',
    );
    const tempRoot = tempDirs.make("openclaw-package-sparkle-root-");
    const toolsDir = tempDirs.make("openclaw-package-sparkle-tools-");

    const nodePath = path.join(toolsDir, "node");
    writeExecutable(
      nodePath,
      `#!/bin/bash
set -euo pipefail
if [[ "$PWD" != "$OPENCLAW_ROOT" ]]; then
  echo "node ran outside repo root: $PWD" >&2
  exit 1
fi
echo 2026060290
`,
    );

    const result = runHelper(`
      set -euo pipefail
      ROOT_DIR=${JSON.stringify(tempRoot)}
      OPENCLAW_ROOT=${JSON.stringify(tempRoot)}
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      export OPENCLAW_ROOT PATH
      cd /tmp
      ${helperBlock}
      sparkle_canonical_build_from_version 2026.6.2
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("2026060290\n");
    expect(result.stderr).toBe("");
  });

  it("does not kill unrelated OpenClaw processes during packaging", () => {
    expect(readFileSync(scriptPath, "utf8")).not.toContain("killall -q OpenClaw");
    expectContains(scriptBlock("running_packaged_app_pids()", 'echo "🔏 Signing bundle'), [
      'local app_binary="$APP_DESTINATION/Contents/MacOS/OpenClaw"',
      'pgrep -x "$PRODUCT"',
      'grep -Fx "$app_binary"',
      '[[ "$command_line" == "$app_binary" || "$command_line" == "$app_binary "* ]]',
    ]);
  });

  it.runIf(process.platform === "darwin").each(["configured", "unset"] as const)(
    "passes an explicit signing identity and honors %s TMPDIR during runtime verification",
    (tempMode) => {
      const script = readFileSync(scriptPath, "utf8");
      const start = script.indexOf('if [[ -n "${SIGN_IDENTITY:-}" ]]');
      expect(start).toBeGreaterThanOrEqual(0);
      const signingBlock = script.slice(start);
      const tempRoot = tempDirs.make("openclaw-package-signing-identity-");
      const scriptsDir = path.join(tempRoot, "scripts");
      const signerPath = path.join(scriptsDir, "codesign-mac-app.sh");
      const appStage = path.join(tempRoot, "stage");
      const appRoot = path.join(appStage, "OpenClaw.app");
      const callerHome = path.join(tempRoot, "caller-home");
      const callerTemp = path.join(tempRoot, "caller temp [*]");
      const eventsPath = path.join(tempRoot, "events");
      const observationsPath = path.join(tempRoot, "worker-scratch.jsonl");
      const identity = "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)";
      for (const directory of [callerHome, callerTemp]) {
        mkdirSync(directory, { recursive: true });
      }
      writeFiles(appRoot, { candidate: "verified replacement" });
      writeExecutable(
        signerPath,
        '#!/bin/bash\nset -euo pipefail\n[[ -d "$1" ]]\nprintf "identity=%s\\n" "${SIGN_IDENTITY-<unset>}"\nprintf "sign\\n" >> "${0%/*}/../events"\n',
      );
      {
        const node = path.join(appRoot, "Contents/Resources/runtime/bin/bun");
        writeExecutable(
          node,
          `#!/bin/bash\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
        );
      }
      writeFileSync(
        path.join(scriptsDir, "verify-mac-runtime.mjs"),
        `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-proof-')));
try {
  fs.writeFileSync(path.join(scratch, 'created-by-worker'), 'scratch');
  fs.appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({ home: process.env.HOME, scratch, callerCanary: process.env.OPENCLAW_TEST_CALLER_CANARY ?? null }) + '\\n');
  fs.appendFileSync(${JSON.stringify(eventsPath)}, 'worker:' + path.basename(process.argv[2]) + '\\n');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
`,
      );

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          `
      set -euo pipefail
      ROOT_DIR="$1"
      APP_STAGE_DIR="$ROOT_DIR/stage"
      APP_ROOT="$APP_STAGE_DIR/OpenClaw.app"
      APP_DESTINATION="$ROOT_DIR/OpenClaw.app"
      BUILD_ARCHS=(${process.arch === "arm64" ? "arm64" : "x86_64"})
      source "$3"
      stop_packaged_app_if_running() { printf 'stop\\n' >> "$ROOT_DIR/events"; }
      codesign() {
        [[ "$1" == --verify && "$2" == --deep && "$3" == --strict && -d "$4" ]]
        printf 'verify\\n' >> "$ROOT_DIR/events"
      }
      SIGN_IDENTITY="$2"
      export SIGN_IDENTITY
      ${signingBlock}
      printf 'published\\n' >> "$ROOT_DIR/events"
    `,
          "package-signing",
          tempRoot,
          identity,
          path.resolve("scripts/lib/mac-app-bundle.sh"),
        ],
        {
          encoding: "utf8",
          env: {
            HOME: callerHome,
            PATH: "/usr/bin:/bin",
            OPENCLAW_TEST_CALLER_CANARY: "must-not-reach-worker",
            ...(tempMode === "configured" ? { TMPDIR: callerTemp } : {}),
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Signing bundle with explicit SIGN_IDENTITY");
      expect(result.stdout).toContain(`identity=${identity}`);
      expect(result.stderr).toBe("");
      expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
        "sign",
        "verify",
        "worker:runtime",
        "verify",
        "stop",
        "published",
      ]);
      expect(read(tempRoot, "OpenClaw.app/candidate")).toBe("verified replacement");
      const observations = readFileSync(observationsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { home: string; scratch: string; callerCanary: null });
      expect(observations).toHaveLength(1);
      for (const observation of observations) {
        expect(observation.home).toBe(appStage);
        expect(observation.callerCanary).toBeNull();
        expect(path.dirname(observation.scratch)).toBe(
          realpathSync(tempMode === "configured" ? callerTemp : "/tmp"),
        );
        expect(existsSync(observation.scratch)).toBe(false);
      }
    },
  );

  it("fails when the packaged app survives forced shutdown", () => {
    const result = runStopPackagedAppHarness();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERROR: Packaged OpenClaw bundle did not exit: 123");
  });

  it("fails release packaging when the Swift compatibility library is missing", () => {
    const result = runSwiftCompatibilityHarness();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERROR: Swift compatibility library not found");
  });

  it("keeps mac packaging script checks in the macOS CI lane", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const macosCi = [1, 2, 3].map((part) => pkg.scripts?.[`test:macos:ci:${part}`] ?? "").join(" ");

    expectContains(macosCi, [
      "src/gateway/worker-environments/workspace-rsync-path.test.ts",
      "test/scripts/package-mac-app.test.ts",
      "test/scripts/package-mac-dist.test.ts",
      "test/scripts/create-dmg.test.ts",
      "test/scripts/codesign-mac-app.test.ts",
      "test/scripts/notarize-mac-artifact.test.ts",
      "test/scripts/mac-elevation-host.test.ts",
      "test/scripts/mac-elevation-artifact.test.ts",
    ]);
  });

  it.each([undefined, "OpenClawKit_OpenClawKit.bundle"])(
    "requires complete main and MLX resource bundles (missing: %s)",
    (missingBundle) => {
      const { appRoot, result } = runSwiftPMResourceBundleHarness({ missingBundle });
      if (missingBundle) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("ERROR: Required SwiftPM resource bundle not found at");
        expect(result.stderr).toContain(missingBundle);
        return;
      }

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      for (const bundle of swiftPMResourceBundles) {
        expect(read(appRoot, "Contents", "Resources", bundle, "marker")).toBe(bundle);
        expect(existsSync(path.join(appRoot, bundle))).toBe(false);
      }
      for (const file of mlxTTSResourceFiles) {
        expect(read(appRoot, "Contents", "Resources", file)).toBe(file);
        expect(existsSync(path.join(appRoot, file))).toBe(false);
      }
    },
  );

  it.each([false, true])(
    "restores resource sources or retains failed backups (%s)",
    (failRestore) => {
      const { backupRoot, fixtures, result } = runSwiftPMResourcePatchHarness(failRestore);
      expect(result.status).toBe(failRestore ? 1 : 0);
      expect(result.stderr).toBe(failRestore ? "restore failed\n" : "");
      if (failRestore) {
        const backups = readdirSync(backupRoot).map((file) => read(backupRoot, file));
        expect(backups).toHaveLength(fixtures.size);
        expect(backups).toEqual(expect.arrayContaining([...fixtures.values()]));
      } else {
        for (const [file, contents] of fixtures) {
          expect(readFileSync(file, "utf8")).toBe(contents);
        }
        expect(readdirSync(backupRoot)).toEqual([]);
      }
    },
  );

  it("compiles app localizations into signed resources", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain(
      'node --import tsx "$ROOT_DIR/scripts/apple-app-i18n.ts" compile-macos',
    );
    expect(script).toContain('--output "$APP_ROOT/Contents/Resources"');
  });

  it("preserves locked Swift resolution and verifies source around each native build", () => {
    const worker = readFileSync(swiftScriptPath, "utf8");
    const build = worker.indexOf('swift build -c "$BUILD_CONFIG" --jobs');
    expectContains(worker, [
      'chmod 0400 "$SWIFT_PACKAGE_LOCK_BASELINE"',
      'cmp -s "$resolved_snapshot" "$resolved_file"',
      'cp "$resolved_snapshot" "$resolved_file"',
      "identity in result",
      'cp "$ROOT_DIR/apps/macos-mlx-tts/Package.resolved" "$MLX_TTS_HELPER_ROOT/Package.resolved"',
    ]);
    expect(worker.lastIndexOf("verify_snapshot_swift_lock", build)).toBeGreaterThan(
      worker.indexOf("build_swift_architecture()"),
    );
    expect(worker.indexOf("verify_snapshot_swift_lock", build)).toBeGreaterThan(build);
  });

  it("runs no SwiftPM operation before the locked lock-file resolve", () => {
    // Any earlier resolve on a reused scratch path can float pins before the lock guard snapshots.
    const root = tempDirs.make("openclaw-swift-first-resolve-");
    for (const app of ["macos", "macos-mlx-tts"]) {
      writeFiles(path.join(root, "apps", app), {
        "Package.swift": "// fixture\n",
        "Package.resolved": "locked\n",
      });
    }
    const invocations = path.join(root, "swift-invocations");
    const result = runHelper(`
      set -euo pipefail
      source ${JSON.stringify(swiftScriptPath)}
      ROOT_DIR=${JSON.stringify(root)}
      BUILD_ROOT="$ROOT_DIR/apps/macos/.build"
      SWIFT_WORK_ROOT="$ROOT_DIR/work"
      PEEKABOO_LOCKED_SOURCE_COMMIT=${JSON.stringify("b".repeat(40))}
      swift() { printf '%s\\n' "$*" >> ${JSON.stringify(invocations)}; }
      create_verified_peekaboo_snapshot() { exit 0; }
      build_swift_architecture arm64
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(invocations, "utf8")).toBe(
      `package --scratch-path ${root}/apps/macos/.build/arm64 resolve --force-resolved-versions\n`,
    );
  });

  it("names every pin the edited Peekaboo resolution moved away from the committed lock", () => {
    const root = tempDirs.make("openclaw-snapshot-swift-lock-");
    const packageRoot = path.join(root, "package");
    const baseline = path.join(root, "Package.resolved.committed");
    mkdirSync(packageRoot);
    const pin = (identity: string, version: string, revision: string) => ({
      identity,
      kind: "remoteSourceControl",
      location: `https://github.com/example/${identity}.git`,
      state: { revision, version },
    });
    const cmark = pin("swift-cmark", "0.8.0", "c".repeat(40));
    const markdown = pin("swift-markdown", "0.8.0", "d".repeat(40));
    writeFileSync(
      baseline,
      JSON.stringify({
        version: 3,
        pins: [pin("peekaboo", "4.6.0", "b".repeat(40)), cmark, markdown],
      }),
    );
    const verify = (pins: unknown[]) => {
      writeFileSync(
        path.join(packageRoot, "Package.resolved"),
        JSON.stringify({ version: 3, pins }),
      );
      return runHelper(`
        set -euo pipefail
        SWIFT_PACKAGE_LOCK_BASELINE=${JSON.stringify(baseline)}
        SWIFT_PACKAGE_ROOT=${JSON.stringify(packageRoot)}
        ${scriptBlock("verify_snapshot_swift_lock() {", "create_verified_peekaboo_snapshot() {", swiftScriptPath)}
        verify_snapshot_swift_lock
      `);
    };

    const unchanged = verify([cmark, markdown]);
    expect(unchanged.status, unchanged.stderr).toBe(0);

    const drifted = verify([pin("swift-cmark", "0.9.0", "e".repeat(40)), markdown]);
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toBe(
      `ERROR: Peekaboo snapshot resolution does not match the committed Package.resolved: swift-cmark: 0.8.0 ${"c".repeat(40)} from https://github.com/example/swift-cmark.git -> 0.9.0 ${"e".repeat(40)} from https://github.com/example/swift-cmark.git\n`,
    );
  });

  it.each([
    { operation: "create", exitCode: 1, reason: "No such file or directory", mounts: "empty" },
    { operation: "attach", exitCode: 73, reason: "Permission denied", mounts: "mounted" },
    { operation: "attach", exitCode: 73, reason: "Permission denied", mounts: "failed" },
  ])(
    "preserves Peekaboo snapshot diagnostics and cleanup: $operation / $mounts",
    ({ operation, exitCode, reason, mounts }) => {
      const root = tempDirs.make("openclaw-peekaboo-snapshot-fixture-");
      const buildPath = path.join(root, "build with spaces");
      const checkout = path.join(buildPath, "checkouts", "Peekaboo");
      const scratch = path.join(root, "temporary snapshots");
      const mount = path.join(scratch, "mounted source");
      const unrelated = path.join(scratch, "unrelated-snapshot", "marker");
      const operationsPath = path.join(root, "operations");
      const expectedCommit = "b".repeat(40);
      writeFiles(checkout, { source: "source preserved\n" });
      writeFiles(path.dirname(unrelated), { marker: "unrelated snapshot preserved\n" });
      writeFiles(root, { "empty.plist": snapshotImageInfoPlist() });
      const hdiutil = path.join(root, "hdiutil");
      writeExecutable(
        hdiutil,
        `#!/bin/bash
        set -euo pipefail
        printf '%s\\n' "$1" >> "$operations"
        printf '%s\\0' "$@" > "$fixture_root/$1.args"
        if [[ "$1" == info && "$2" == -plist ]]; then
          cat "$fixture_root/empty.plist"
          exit 0
        fi
        if [[ "$1" == create ]]; then
          image="\${@: -1}"
          printf '%s' "\${image%/*}" > "$fixture_root/snapshot-root"
          : > "$image"
        fi
        for arg in "$@"; do
          if [[ "$arg" == -quiet ]]; then
            exec 1>&- 2>&-
          fi
        done
        if [[ "$1" == ${JSON.stringify(operation)} ]]; then
          printf 'hdiutil: %s failed - %s\\n' "$1" ${JSON.stringify(reason)} >&2 || true
          exit ${exitCode}
        fi
        if [[ "$1" == detach ]]; then
          exit 1
        fi
        printf 'hdiutil: %s completed\\n' "$1" || true
        exit 0
        `,
      );
      const mountCommand = path.join(root, "mount");
      writeExecutable(
        mountCommand,
        `#!/bin/bash
printf 'mount\\n' >> "$operations"
${mounts === "failed" ? "exit 1" : mounts === "mounted" ? `printf '/dev/disk9 on %s (apfs, read-only)\\n' "$fixture_mount"` : "exit 0"}
`,
      );

      const result = runSnapshotCreation(
        { root, buildPath, mount, operations: operationsPath, expectedCommit },
        `rm() {
        printf 'remove:%s\\n' "$*" >> "$operations"
        command rm "$@"
      }`,
        { TMPDIR: scratch },
      );

      const snapshotRoot = read(root, "snapshot-root");
      const image = path.join(snapshotRoot, "Peekaboo.dmg");
      const expectedOperations = [`verify:${checkout}:${expectedCommit}`, "create"];
      if (operation !== "create") {
        expectedOperations.push("attach");
      }
      expectedOperations.push("detach", "mount", "info");
      const retained = mounts !== "empty";
      if (!retained) {
        expectedOperations.push(
          `remove:-rf ${snapshotRoot} ${mount}  ${path.join(root, "work/resource-backups")}`,
        );
      }
      expect(result.status).toBe(retained ? 1 : exitCode);
      expect(readFileSync(operationsPath, "utf8").trim().split("\n")).toEqual(expectedOperations);
      expect(existsSync(snapshotRoot)).toBe(retained);
      expect(existsSync(mount)).toBe(retained);
      expect(read(checkout, "source")).toBe("source preserved\n");
      expect(readFileSync(unrelated, "utf8")).toBe("unrelated snapshot preserved\n");
      const readArgs = (command: string) =>
        read(root, `${command}.args`)
          .split("\0")
          .slice(0, -1)
          .filter((arg) => arg !== "-quiet");
      expect(readArgs("create")).toEqual([
        "create",
        "-fs",
        "APFS",
        "-format",
        "UDRO",
        "-srcfolder",
        checkout,
        "-volname",
        "OpenClawPeekabooSnapshot",
        image,
      ]);
      if (operation !== "create") {
        expect(readArgs("attach")).toEqual([
          "attach",
          "-readonly",
          "-nobrowse",
          "-mountpoint",
          mount,
          image,
        ]);
      }
      expect(readArgs("detach")).toEqual(["detach", mount]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`hdiutil: ${operation} failed - ${reason}\n`);
    },
  );

  it("retries a transient Peekaboo snapshot attach after detaching its unmounted devices", () => {
    const root = tempDirs.make("openclaw-peekaboo-attach-retry-");
    const buildPath = path.join(root, "build");
    const checkout = path.join(buildPath, "checkouts/Peekaboo");
    const mount = path.join(root, "mounted source");
    const image = path.join(root, "work/snapshot/Peekaboo.dmg");
    const operations = path.join(root, "operations");
    const expectedCommit = "b".repeat(40);
    mkdirSync(checkout, { recursive: true });
    writeFiles(root, {
      "attached.plist": snapshotImageInfoPlist(image),
      "empty.plist": snapshotImageInfoPlist(),
    });
    const hdiutil = path.join(root, "hdiutil");
    writeExecutable(
      hdiutil,
      `#!/bin/bash
set -euo pipefail
case "$1" in
  create)
    printf 'create\\n' >> "$operations"
    : > "\${@: -1}"
    ;;
  attach)
    printf 'attach\\n' >> "$operations"
    : > "$fixture_root/attached"
    if [[ ! -e "$fixture_root/attempted" ]]; then
      : > "$fixture_root/attempted"
      printf 'hdiutil: attach failed - Resource temporarily unavailable\\n' >&2
      exit 35
    fi
    ;;
  info)
    [[ "$2" == -plist ]] || exit 2
    printf 'info\\n' >> "$operations"
    if [[ -e "$fixture_root/attached" ]]; then
      cat "$fixture_root/attached.plist"
    else
      cat "$fixture_root/empty.plist"
    fi
    ;;
  detach)
    [[ "$2" == -quiet ]] || exit 2
    printf 'detach %s\\n' "$3" >> "$operations"
    rm "$fixture_root/attached"
    ;;
  *) exit 2 ;;
esac
`,
    );
    const sleep = path.join(root, "sleep");
    writeExecutable(sleep, '#!/bin/bash\nprintf "sleep %s\\n" "$*" >> "$operations"\n');

    const result = runSnapshotCreation({ root, buildPath, mount, operations, expectedCommit });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("hdiutil: attach failed - Resource temporarily unavailable\n");
    expect(readFileSync(operations, "utf8").trim().split("\n")).toEqual([
      `verify:${checkout}:${expectedCommit}`,
      "create",
      "attach",
      "info",
      "detach /dev/disk8",
      "info",
      "sleep 2",
      "attach",
      `verify:${mount}:${expectedCommit}`,
      "snapshot-ready",
      `detach ${mount}`,
    ]);
    expect(existsSync(image)).toBe(false);
    expect(existsSync(mount)).toBe(false);
  });

  it.each([false, true])(
    "cleans up an unmounted Peekaboo image through the standalone entry point (detach fails: %s)",
    (detachFails) => {
      const root = tempDirs.make("openclaw-peekaboo-device-cleanup-");
      const work = path.join(root, "work");
      const snapshot = path.join(work, "snapshot");
      const image = path.join(snapshot, "Peekaboo.dmg");
      const mount = path.join(root, "mounted source");
      const alias = path.join(root, "work alias");
      const operations = path.join(root, "operations");
      const attached = path.join(root, "attached");
      mkdirSync(mount);
      writeFiles(root, {
        "work/snapshot/Peekaboo.dmg": "snapshot",
        attached: "",
        "attached.plist": snapshotImageInfoPlist(path.join(alias, "snapshot/Peekaboo.dmg")),
        "empty.plist": snapshotImageInfoPlist(),
      });
      symlinkSync(work, alias, "dir");
      const hdiutil = path.join(root, "hdiutil");
      writeExecutable(
        hdiutil,
        `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$operations"
if [[ "$1" == info && "$2" == -plist ]]; then
  if [[ -e "$attached" ]]; then
    cat "$fixture_root/attached.plist"
  else
    cat "$fixture_root/empty.plist"
  fi
elif [[ "$1" == detach && "$2" == -quiet ]]; then
  [[ "$3" == /dev/disk8 ]] || exit 1
  ${detachFails ? "exit 1" : 'rm "$attached"'}
else
  printf 'unexpected: %s\\n' "$*" >> "$operations"
  exit 2
fi
`,
      );
      const mountCommand = path.join(root, "mount");
      writeExecutable(
        mountCommand,
        `#!/bin/bash
printf 'mount\\n' >> "$operations"
printf '/dev/disk99 on /unrelated (apfs, read-only)\\n'
`,
      );

      const result = spawnSync(
        "/bin/bash",
        [
          swiftScriptPath,
          "cleanup",
          root,
          "arm64",
          "release",
          "1",
          "b".repeat(40),
          "0",
          work,
          mount,
        ],
        {
          encoding: "utf8",
          env: {
            PATH: `${root}:/usr/bin:/bin`,
            fixture_root: root,
            operations,
            attached,
          },
        },
      );

      expect(result.status, result.stderr).toBe(detachFails ? 1 : 0);
      const loggedOperations = readFileSync(operations, "utf8");
      expect(loggedOperations.trim().split("\n")).toEqual([
        `detach -quiet ${mount}`,
        "mount",
        "info -plist",
        "detach -quiet /dev/disk8",
        "info -plist",
      ]);
      expect(loggedOperations).not.toContain("-force");
      expect(existsSync(snapshot)).toBe(detachFails);
      expect(existsSync(image)).toBe(detachFails);
      expect(existsSync(mount)).toBe(detachFails);
      if (detachFails) {
        expect(result.stderr).toBe(
          `ERROR: disk image ${image} is still attached; detach it with: hdiutil detach /dev/disk8\n`,
        );
      } else {
        expect(result.stderr).toBe("");
      }
    },
  );

  it("stamps only the clean Peekaboo source that SwiftPM actually compiled", () => {
    const verifier = scriptBlock(
      "compiled_peekaboo_commit() {",
      "swiftpm_resource_sources()",
      swiftScriptPath,
    );
    expectContains(verifier, [
      '"core.commitGraph=false"',
      '"--no-replace-objects"',
      '"fsck", "--full", "--strict"',
      '"cat-file", object_type',
    ]);
    expect(readFileSync(swiftScriptPath, "utf8")).toContain(
      'swift package --scratch-path "$build_path" edit Peekaboo --path "$PEEKABOO_SNAPSHOT_MOUNT"',
    );
    const mismatched = runRealCompiledPeekabooHarness("none", "e".repeat(40));
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain("does not match locked source");
  });

  // Each real Git fixture owns a separate checkout and deadline; do not aggregate
  // independent verification scenarios into one long synchronous test.
  it.each([
    "nested-gitlink",
    "assume-unchanged",
    "corrupt-object",
    "dirty-gitlink",
    "export-subst",
    "gitlink-sibling",
    "ignored",
    "replacement-ref",
  ] as const)("verifies compiled Peekaboo source (%s)", (mutation) => {
    const result = runRealCompiledPeekabooHarness(mutation);
    expect(result.status, result.stderr).toBe(mutation === "nested-gitlink" ? 0 : 1);
    if (mutation !== "nested-gitlink") {
      expect(result.stderr).toContain(
        "Compiled Peekaboo checkout does not exactly match its committed source",
      );
    }
  });

  it("restores and rejects a Swift package resolution that changes the lockfile", () => {
    const { result, resolvedFile } = runSwiftPackageResolutionHarness();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERROR: Swift package resolution changed Package.resolved");
    expect(readFileSync(resolvedFile, "utf8")).toBe("locked\n");
  });

  it("omits the CUA driver only from elevation-host packages", () => {
    const variantBlock = scriptBlock(
      'SIGNING_VARIANT="${OPENCLAW_MAC_SIGNING_VARIANT:-standard}"',
      "# OPENCLAW_SKIP_MLX_TTS",
    );
    const cuaBlock = scriptBlock(
      'if [[ "$SIGNING_VARIANT" == "elevation-host" ]]',
      'echo "📦 Copying CLI installer"',
    );
    expectContains(variantBlock, [
      "standard | elevation-host",
      "Unknown OPENCLAW_MAC_SIGNING_VARIANT value",
    ]);
    expectContains(cuaBlock, [
      "Omitting embedded CUA driver from elevation-host package",
      "else",
      "Staging embedded CUA driver",
      '"$ROOT_DIR/scripts/stage-cua-driver-macos.sh" "$CUA_DRIVER"',
    ]);
  });

  it("does not mask required Info.plist stamp failures", () => {
    const stampBlock = scriptBlock("plist_set_string_required", 'echo "🚚 Copying binary"');
    expect(stampBlock).toContain("plist_set_string_required");
    expect(stampBlock).not.toContain("|| true");
  });

  it.runIf(process.platform === "darwin")(
    "sets required strings and fails when the plist cannot be stamped",
    () => {
      const plist = makePlist();
      const result = runHelper(`
        set -euo pipefail
        source scripts/lib/plistbuddy.sh
        plist_set_string_required ${JSON.stringify(plist)} CFBundleIdentifier 'ai.openclaw.test'
        /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' ${JSON.stringify(plist)}
        broken="$(mktemp -d)"
        plist_set_string_required "$broken" CFBundleIdentifier broken
      `);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("ai.openclaw.test");
      expect(result.stderr).toContain("Error Reading File");
    },
  );
});
