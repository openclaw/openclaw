import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32")("packaged Swift build isolation", () => {
  it.each([
    { arch: "arm64", minimum: "15.0" },
    { arch: "x86_64", minimum: "16.0" },
  ])("owns SwiftPM caches and uses the app minimum for $arch dependencies", ({ arch, minimum }) => {
    const root = tempDirs.make("openclaw-swift-destination-");
    const resources = path.join(root, "apps/macos/Sources/OpenClaw/Resources");
    mkdirSync(resources, { recursive: true });
    mkdirSync(path.join(root, "package"));
    mkdirSync(path.join(root, "work", arch), { recursive: true });
    mkdirSync(path.join(root, "helper"));
    writeFileSync(path.join(root, "committed"), "{}\n");
    writeFileSync(path.join(root, "package/Package.resolved"), "{}\n");
    writeFileSync(path.join(root, "helper/Package.resolved"), "{}\n");
    writeFileSync(
      path.join(resources, "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>LSMinimumSystemVersion</key><string>${minimum}</string></dict></plist>`,
    );
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        String.raw`set -euo pipefail
source "$1"
ROOT_DIR="$2"
SWIFT_WORK_ROOT="$2/work/$3"
SWIFT_PACKAGE_CONTAINER="$2/package"
SWIFT_PACKAGE_ROOT="$2/package"
SWIFT_PACKAGE_LOCK_BASELINE="$2/committed"
BUILD_ROOT="$2/build"
MLX_TTS_HELPER_ROOT="$2/helper"
MLX_TTS_HELPER_BUILD_ROOT="$2/helper-build"
PEEKABOO_LOCKED_SOURCE_COMMIT=fixture
PEEKABOO_SNAPSHOT_MOUNT="$2/snapshot"
PEEKABOO_SNAPSHOT_ROOT="$2/snapshot-container"
PRODUCT=OpenClaw
MLX_TTS_HELPER_PRODUCT=openclaw-mlx-tts
BUILD_CONFIG=release
SWIFT_BUILD_JOBS=2
SKIP_MLX_TTS=0
prepare_swift_package_root() { :; }
create_verified_peekaboo_snapshot() { :; }
verify_snapshot_swift_lock() { :; }
patch_swiftpm_resource_lookups() { :; }
restore_swiftpm_resource_sources() { :; }
compiled_peekaboo_commit() { printf fixture; }
swift() {
  /usr/bin/python3 - "$ROOT_DIR/calls.jsonl" "$@" <<'PY'
import json, sys
from pathlib import Path
args = sys.argv[2:]
toolset = None
if "--toolset" in args:
    toolset = json.loads(Path(args[args.index("--toolset") + 1]).read_text())
with open(sys.argv[1], "a") as output:
    output.write(json.dumps({"args": args, "toolset": toolset}) + "\n")
PY
}
build_swift_architecture "$3"
cleanup_swift_architecture`,
        "swift-destination",
        path.resolve("scripts/lib/mac-swift-build.sh"),
        root,
        arch,
      ],
      { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
    );
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(path.join(root, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; toolset: unknown });
    // Every package/build operation, including edit cleanup and MLX, must stay
    // inside a namespace owned by this architecture, never the process-global HOME cache.
    const ownedRoots = ["build", "helper-build", "work"].map((name) => path.join(root, name, arch));
    for (const { args } of calls) {
      const cacheIndex = args.indexOf("--cache-path");
      expect(cacheIndex, args.join(" ")).toBeGreaterThan(-1);
      const cache = path.resolve(args[cacheIndex + 1]!);
      expect(
        ownedRoots.some((owned) => cache.startsWith(owned + path.sep)),
        cache,
      ).toBe(true);
    }
    const packageCalls = calls.filter(({ args }) => args[0] === "package");
    expect(packageCalls.some(({ args }) => args.includes("resolve"))).toBe(true);
    expect(packageCalls.some(({ args }) => args.includes("edit"))).toBe(true);
    expect(packageCalls.filter(({ args }) => args.includes("unedit"))).toHaveLength(2);
    const buildCalls = calls.filter(({ args }) => args[0] === "build");
    expect(buildCalls.map(({ args }) => args[args.indexOf("--product") + 1])).toEqual([
      "OpenClaw",
      "openclaw-mac",
      "openclaw-mlx-tts",
      "openclaw-mlx-tts",
    ]);
    for (const { args, toolset } of buildCalls) {
      expect(args[args.indexOf("--arch") + 1]).toBe(arch);
      // Global compiler overrides also retarget host macros during an Intel cross-build.
      expect(args.some((arg, index) => arg === "-Xswiftc" && args[index + 1] === "-target")).toBe(
        false,
      );
      if (args[args.indexOf("--product") + 1] === "openclaw-mlx-tts") {
        expect(args[args.indexOf("--build-system") + 1]).toBe("swiftbuild");
        continue;
      }
      expect(toolset).toEqual({
        schemaVersion: "1.0",
        swiftCompiler: { extraCLIOptions: ["-target", `${arch}-apple-macosx${minimum}`] },
      });
    }
  });
});
