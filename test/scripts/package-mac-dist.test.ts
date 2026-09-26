// Package Mac Dist tests cover package mac dist script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
const scriptPath = "scripts/package-mac-dist.sh";
const checkpointDirs = useAutoCleanupTempDirTracker(afterEach);

function makeCheckpointFixture() {
  const root = checkpointDirs.make("openclaw-dist-checkpoint-");
  const tools = path.join(root, "tools");
  mkdirSync(tools);
  mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  for (const file of [
    "package-mac-dist.sh",
    "lib/mac-notarization-recovery.py",
    "lib/swift-toolchain.sh",
    "lib/plistbuddy.sh",
    "lib/mac-signing-identity.sh",
  ]) {
    writeFileSync(
      path.join(root, "scripts", file),
      readFileSync(path.join("scripts", file), "utf8")
        .replaceAll("/usr/bin/codesign", path.join(tools, "codesign"))
        .replaceAll("/usr/bin/lipo", path.join(tools, "lipo"))
        .replaceAll("/usr/libexec/PlistBuddy", path.join(tools, "PlistBuddy")),
    );
  }
  const fake = path.join(tools, "fake");
  writeFileSync(
    fake,
    `#!/usr/bin/env python3
import json, os, pathlib, shutil, sys, zipfile
root = pathlib.Path(__file__).resolve().parents[1]
name, args = pathlib.Path(sys.argv[0]).name, sys.argv[1:]
with (root / "events").open("a") as log:
    log.write(name + " " + " ".join(args) + "\\n")
def archive(source, target):
    with zipfile.ZipFile(target, "w") as z:
        for p in source.rglob("*"):
            if p.is_file(): z.write(p, p.relative_to(source.parent))
if name == "security": print('1) ABCDEF "Developer ID Application: Fixture"')
elif name == "swift": print("Apple Swift version 6.3")
elif name == "xcrun": print("Xcode 26.4")
elif name == "node": print("2608000290")
elif name == "git": print("a" * 40)
elif name == "lipo": print("arm64")
elif name == "PlistBuddy":
    print(json.loads(pathlib.Path(args[2]).read_text())[args[1].split(":")[1]])
elif name == "package-mac-app.sh":
    app = root / "dist/OpenClaw.app/Contents"
    app.mkdir(parents=True, exist_ok=True)
    (app / "Info.plist").write_text(json.dumps(dict(CFBundleShortVersionString="2026.8.2", CFBundleVersion="2608000290", CFBundleIdentifier="ai.openclaw.mac", SUFeedURL="https://example.com/appcast.xml")))
    (app / "signature").write_text("adhoc" if os.environ.get("SIGN_IDENTITY") == "-" else "developer")
elif name == "codesign":
    target = pathlib.Path(args[-1])
    if "--sign" in args:
        if os.environ.get("SIGN_IDENTITY") == "unavailable": sys.exit("unexpected signing during resume")
        with target.open("ab") as out: out.write(b"signed")
    elif "--verify" in args:
        if target.is_file(): assert target.read_bytes().endswith((b"signed", b"stapled"))
        else: assert (target / "Contents/signature").exists()
        if any(a.startswith("-R=") for a in args) and os.environ.get("ALLOW_ADHOC_SIGNING") == "1":
            sys.exit("ad-hoc signatures have no Developer Team ID")
    else:
        print("Signature=" + (target / "Contents/signature").read_text(), file=sys.stderr)
elif name == "ditto":
    source, target = map(pathlib.Path, args[-2:])
    if "-x" in args:
        with zipfile.ZipFile(source) as z: z.extractall(target)
    else: archive(source, target)
elif name == "create-dmg.sh": pathlib.Path(args[1]).write_bytes(b"dmg")
elif name == "hdiutil":
    if args[0] == "attach":
        mount = pathlib.Path(args[args.index("-mountpoint") + 1])
        with zipfile.ZipFile(root / "dist/macos-notarization-recovery/app.zip") as z: z.extractall(mount)
    else: shutil.rmtree(pathlib.Path(args[1]) / "OpenClaw.app")
elif name == "audit-async-sleep-frames.py":
    if (root / "reject-audit").exists(): sys.exit("async frame allocation is undersized")
elif name == "notarize-mac-artifact.sh":
    artifact = pathlib.Path(args[-1])
    if artifact.suffix == ".dmg":
        with artifact.open("ab") as out: out.write(b"stapled")
    else: pathlib.Path(os.environ["STAPLE_APP_PATH"], "Contents/stapled").touch()
else: sys.exit("unexpected fake tool: " + name)
`,
    { mode: 0o755 },
  );
  for (const name of [
    "security",
    "swift",
    "xcrun",
    "node",
    "git",
    "lipo",
    "PlistBuddy",
    "codesign",
    "ditto",
    "hdiutil",
  ]) {
    symlinkSync(fake, path.join(tools, name));
  }
  for (const name of ["package-mac-app.sh", "create-dmg.sh", "notarize-mac-artifact.sh"]) {
    symlinkSync(fake, path.join(root, "scripts", name));
  }
  const audit = path.join(root, "apps/macos/scripts/audit-async-sleep-frames.py");
  mkdirSync(path.dirname(audit), { recursive: true });
  symlinkSync(fake, audit);
  const symbols = path.join(root, "apps/macos/.build/arm64/release/OpenClaw.dSYM");
  mkdirSync(symbols, { recursive: true });
  writeFileSync(path.join(symbols, "symbols"), "debug symbols");
  const checkpoint = path.join(root, "dist/macos-notarization-recovery");
  return {
    root,
    checkpoint,
    events: () => readFileSync(path.join(root, "events"), "utf8"),
    run: (mode: string, env: NodeJS.ProcessEnv = {}) =>
      spawnSync("/bin/bash", [path.join(root, scriptPath), mode], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tools}${path.delimiter}${process.env.PATH}`,
          APP_VERSION: "2026.8.2",
          APP_BUILD: "2608000290",
          BUILD_CONFIG: "release",
          BUILD_ARCHS: "arm64",
          SIGN_IDENTITY: "fixture",
          ALLOW_ADHOC_SIGNING: "0",
          SKIP_NOTARIZE: "0",
          SKIP_DMG: "0",
          SKIP_DSYM: "0",
          EXPECTED_DEVELOPER_TEAM_ID: "",
          ...env,
        },
      }),
  };
}

describe("macOS packaging checkpoint boundary", () => {
  it("retains a signed DMG before notarization and resumes without build or signing credentials", () => {
    const f = makeCheckpointFixture();
    const built = f.run("--checkpoint-only");
    expect(built.status, built.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(f.checkpoint, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      sourceSha: "a".repeat(40),
      version: "2026.8.2",
      build: "2608000290",
      completed: false,
    });
    expect(Object.keys(manifest.files).toSorted()).toEqual(["app.dmg", "app.zip", "symbols.zip"]);
    expect(readFileSync(path.join(f.checkpoint, "app.dmg"), "utf8")).toBe("dmgsigned");
    expect(f.events()).not.toContain("notarize-mac-artifact.sh");
    expect(f.events().indexOf("audit-async-sleep-frames.py")).toBeLessThan(
      f.events().indexOf("create-dmg.sh"),
    );
    rmSync(path.join(f.root, "apps/macos/.build"), { recursive: true });
    rmSync(path.join(f.root, "scripts/package-mac-app.sh"));
    rmSync(path.join(f.root, "scripts/create-dmg.sh"));
    const resumed = f.run("--resume-notarization", { SIGN_IDENTITY: "unavailable" });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(f.events().match(/notarize-mac-artifact.sh/g)).toHaveLength(2);
    expect(existsSync(path.join(f.root, "dist/OpenClaw.app/Contents/stapled"))).toBe(true);
    expect(readFileSync(path.join(f.root, "dist/OpenClaw-2026.8.2.dmg"), "utf8")).toBe(
      "dmgsignedstapled",
    );
    for (const suffix of ["zip", "dSYM.zip"]) {
      expect(existsSync(path.join(f.root, `dist/OpenClaw-2026.8.2.${suffix}`))).toBe(true);
    }
    expect(
      JSON.parse(readFileSync(path.join(f.checkpoint, "manifest.json"), "utf8")).completed,
    ).toBe(true);
  });

  it.each(["-", ""])(
    "allows ad-hoc smoke resume with identity %j on a signer-equipped host",
    (identity) => {
      const f = makeCheckpointFixture();
      const smoke = {
        ALLOW_ADHOC_SIGNING: "1",
        SIGN_IDENTITY: identity,
        SKIP_NOTARIZE: "1",
        EXPECTED_DEVELOPER_TEAM_ID: "FIXTURE",
      };
      expect(f.run("--checkpoint-only", smoke).status).toBe(0);
      const resumed = f.run("--resume-notarization", smoke);
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(f.events()).not.toContain("notarize-mac-artifact.sh");
      expect(existsSync(path.join(f.root, "dist/OpenClaw.app/Contents/stapled"))).toBe(false);
      expect(existsSync(path.join(f.root, "appcast.xml"))).toBe(false);
    },
  );

  it("uses the automatically selected app identity for the checkpoint DMG", () => {
    const f = makeCheckpointFixture();
    const built = f.run("--checkpoint-only", { SIGN_IDENTITY: "" });
    expect(built.status, built.stderr).toBe(0);
    expect(f.events()).toContain("--sign Developer ID Application: Fixture --timestamp");
  });

  it("preserves an explicit signed identity when smoke flags are present", () => {
    const f = makeCheckpointFixture();
    const built = f.run("--checkpoint-only", { ALLOW_ADHOC_SIGNING: "1", SKIP_NOTARIZE: "1" });
    expect(built.status).not.toBe(0);
    expect(built.stderr).toContain("requires an ad-hoc signed smoke app");
    expect(existsSync(f.checkpoint)).toBe(false);
  });

  it.each(["release", "release with smoke flag", "tampered app", "missing DMG", "audit"])(
    "refuses %s recovery before notarization",
    (failure) => {
      const f = makeCheckpointFixture();
      const built = f.run("--checkpoint-only");
      expect(built.status, built.stderr).toBe(0);
      if (failure === "tampered app") {
        writeFileSync(path.join(f.checkpoint, "app.zip"), "tampered");
      }
      if (failure === "missing DMG") {
        rmSync(path.join(f.checkpoint, "app.dmg"));
      }
      if (failure === "audit") {
        writeFileSync(path.join(f.root, "reject-audit"), "");
      }
      const resumed = f.run(
        "--resume-notarization",
        failure.startsWith("release")
          ? {
              SKIP_NOTARIZE: "1",
              ALLOW_ADHOC_SIGNING: failure === "release with smoke flag" ? "1" : "0",
            }
          : {},
      );
      expect(resumed.status).not.toBe(0);
      expect(resumed.stderr).toContain(
        failure.startsWith("release")
          ? "smoke"
          : failure === "audit"
            ? "undersized"
            : "SHA-256 mismatch",
      );
      expect(f.events()).not.toContain("notarize-mac-artifact.sh");
    },
  );

  it("fails the frame audit before creating a checkpoint", () => {
    const f = makeCheckpointFixture();
    writeFileSync(path.join(f.root, "reject-audit"), "");
    const result = f.run("--checkpoint-only");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("async frame allocation is undersized");
    expect(existsSync(f.checkpoint)).toBe(false);
    expect(f.events()).not.toContain("create-dmg.sh");
  });
});

function makeDistributionFixture(layout: "native" | "xcode", missingArch?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-dist-symbols-"));
  tempDirs.push(root);
  const scripts = path.join(root, "scripts");
  const tools = path.join(root, "tools");
  mkdirSync(path.join(scripts, "lib"), { recursive: true });
  mkdirSync(tools);
  for (const file of [
    "package-mac-dist.sh",
    "notarize-mac-artifact.sh",
    "lib/mac-notarization-recovery.py",
    "lib/plistbuddy.sh",
    "lib/mac-signing-identity.sh",
    "lib/swift-toolchain.sh",
  ]) {
    copyFileSync(path.join("scripts", file), path.join(scripts, file));
  }
  const executable = (file: string, body: string) => {
    writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  };
  executable(path.join(scripts, "package-mac-app.sh"), "exit 0");
  executable(path.join(tools, "swift"), "echo 'Apple Swift version 6.3'");
  executable(path.join(tools, "xcrun"), "echo 'Xcode 26.4'");
  executable(path.join(tools, "node"), "echo 2608000290");
  const contents = path.join(root, "dist", "OpenClaw.app", "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  const auditScript = path.join(root, "apps/macos/scripts/audit-async-sleep-frames.py");
  mkdirSync(path.dirname(auditScript), { recursive: true });
  writeFileSync(
    auditScript,
    `from pathlib import Path
import sys
binary = Path(sys.argv[1])
assert binary.is_file()
Path(__file__).resolve().parents[3].joinpath("async-frame-audit.log").write_text(str(binary))
`,
  );
  writeFileSync(
    path.join(contents, "Info.plist"),
    `<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>2026.8.2</string>
<key>CFBundleVersion</key><string>2608000290</string>
<key>CFBundleIdentifier</key><string>ai.openclaw.mac</string>
<key>CFBundleExecutable</key><string>OpenClaw</string>
<key>SUFeedURL</key><string>https://example.com/appcast.xml</string>
</dict></plist>`,
  );
  const source = path.join(root, "main.c");
  writeFileSync(source, "int main(void) { return 0; }\n");
  const expectedUUIDs: string[] = [];
  for (const arch of ["arm64", "x86_64"]) {
    const build = path.join(root, "apps", "macos", ".build", arch);
    const products = path.join(
      build,
      layout === "xcode" ? "out/Products/Release" : `${arch}-apple-macosx/release`,
    );
    mkdirSync(products, { recursive: true });
    symlinkSync(path.relative(build, products), path.join(build, "release"));
    if (arch === missingArch) {
      continue;
    }
    const binary = path.join(products, "OpenClaw");
    const symbols = `${binary}.dSYM`;
    for (const args of [
      ["clang", "-arch", arch, "-g", "-Wl,-adhoc_codesign", source, "-o", binary],
      ["dsymutil", binary, "-o", symbols],
    ]) {
      const result = spawnSync("xcrun", args, { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const uuid = spawnSync("xcrun", ["dwarfdump", "--uuid", binary], { encoding: "utf8" });
    expect(uuid.status, uuid.stderr).toBe(0);
    expectedUUIDs.push(uuid.stdout.trim().split(" ").slice(0, 3).join(" "));
    if (arch === "arm64") {
      copyFileSync(binary, path.join(contents, "MacOS/OpenClaw"));
    }
  }
  return {
    root,
    auditScript,
    expectedUUIDs,
    run: (options: { resume?: boolean; notarize?: boolean; dmg?: boolean; archs?: string } = {}) =>
      spawnSync(
        "bash",
        [
          path.join(scripts, "package-mac-dist.sh"),
          ...(options.resume ? ["--resume-notarization"] : []),
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${tools}:/usr/bin:/bin`,
            APP_VERSION: "2026.8.2",
            APP_BUILD: "2608000290",
            BUILD_CONFIG: "release",
            BUILD_ARCHS: options.archs ?? "all",
            SKIP_NOTARIZE: options.notarize ? "0" : "1",
            ALLOW_ADHOC_SIGNING: "1",
            SIGN_IDENTITY: "-",
            NOTARYTOOL_PROFILE: "test-profile",
            SKIP_DMG: options.dmg ? "0" : "1",
            SKIP_DSYM: "0",
          },
        },
      ),
  };
}

function makePlist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-dist-plist-"));
  tempDirs.push(dir);
  const plist = path.join(dir, "Info.plist");
  writeFileSync(
    plist,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "<key>CFBundleShortVersionString</key>",
      "<string>1.2.3</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
    "utf8",
  );
  return plist;
}

function runHelper(script: string) {
  return spawnSync("bash", ["-lc", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function getPackageManagerHelperBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf("DIST_PNPM_CMD=()");
  const end = script.indexOf("ensure_sparkle_build_deps()");

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

function runSparkleBootstrap(nodeAfterInstall: string, pnpmBody: string) {
  const script = readFileSync(scriptPath, "utf8");
  const helpers = script.slice(
    script.indexOf("DIST_PNPM_CMD=()"),
    script.indexOf("correction_build_from_exact_tag()"),
  );
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-dist-sparkle-"));
  tempDirs.push(dir);
  const tools = path.join(dir, "tools");
  const marker = path.join(dir, "installed");
  mkdirSync(tools);
  writeFileSync(
    path.join(tools, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$PWD" != "$OPENCLAW_ROOT" ]]; then
  echo "node ran outside repo root: $PWD" >&2
  exit 1
fi
if [[ ! -f "$OPENCLAW_MARKER" ]]; then
  echo "Cannot find package tsx" >&2
  exit 1
fi
${nodeAfterInstall}
echo 2026060200
`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(tools, "pnpm"), `#!/usr/bin/env bash\nset -euo pipefail\n${pnpmBody}\n`, {
    mode: 0o755,
  });
  return runHelper(`
    set -euo pipefail
    ROOT_DIR=${JSON.stringify(process.cwd())}
    OPENCLAW_ROOT=${JSON.stringify(process.cwd())}
    OPENCLAW_MARKER=${JSON.stringify(marker)}
    PATH=${JSON.stringify(tools)}:/usr/bin:/bin
    export OPENCLAW_MARKER OPENCLAW_ROOT PATH
    ${helpers}
    require_canonical_sparkle_build 2026.6.2
  `);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("package-mac-dist plist validation", () => {
  it("fails closed for required Info.plist reads", () => {
    const script = readFileSync(scriptPath, "utf8");
    const readBlock = script.slice(
      script.indexOf("VERSION="),
      script.indexOf('ZIP="$ROOT_DIR/dist/OpenClaw-$VERSION.zip"'),
    );

    expect(script).toContain('source "$ROOT_DIR/scripts/lib/plistbuddy.sh"');
    expect(readBlock).toContain(
      'VERSION="$(plist_print_required "$APP/Contents/Info.plist" CFBundleShortVersionString)"',
    );
    expect(readBlock).toContain(
      'BUNDLE_VERSION="$(plist_print_required "$APP/Contents/Info.plist" CFBundleVersion)"',
    );
    expect(readBlock).toContain(
      'ACTUAL_BUNDLE_ID="$(plist_print_required "$APP/Contents/Info.plist" CFBundleIdentifier)"',
    );
    expect(readBlock).toContain(
      'ACTUAL_FEED_URL="$(plist_print_required "$APP/Contents/Info.plist" SUFeedURL)"',
    );
    expect(readBlock).not.toContain("PlistBuddy");
    expect(readBlock).not.toContain("|| echo");
  });

  it("requires the release bundle id to match the configured bundle id", () => {
    const script = readFileSync(scriptPath, "utf8");
    const releaseBlock = script.slice(
      script.indexOf('if [[ "$BUILD_CONFIG" == "release" ]]'),
      script.indexOf('if [[ "$NOTARIZE" == "1" ]]'),
    );

    expect(releaseBlock).toContain('if [[ "$ACTUAL_BUNDLE_ID" != "$BUNDLE_ID" ]]');
    expect(releaseBlock).toContain("expected '$BUNDLE_ID'");
    expect(releaseBlock).not.toContain("*.debug");
  });

  it("marks the distributed Control UI as an official release artifact", () => {
    const script = readFileSync(scriptPath, "utf8");
    const releaseMarkerIndex = script.indexOf("export OPENCLAW_CONTROL_UI_RELEASE_BUILD=1");
    const packageAppIndex = script.indexOf('"$ROOT_DIR/scripts/package-mac-app.sh"');

    expect(releaseMarkerIndex).toBeGreaterThanOrEqual(0);
    expect(packageAppIndex).toBeGreaterThan(releaseMarkerIndex);
  });

  it("does not mask canonical Sparkle build failures for release packaging", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain("ensure_sparkle_build_deps()");
    expect(script).toContain(
      "run_dist_pnpm install --frozen-lockfile --config.node-linker=hoisted >&2",
    );
    expect(script).toContain(
      '(cd "$ROOT_DIR" && node --import tsx "$ROOT_DIR/scripts/sparkle-build.ts" canonical-build "$1")',
    );
    expect(script).toContain('if [[ "$SPARKLE_BUILD_DEPS_RETRIED" == "1" ]]');
    expect(script).toContain("require_canonical_sparkle_build()");
    expect(script).toContain(
      'CANONICAL_APP_BUILD="$(require_canonical_sparkle_build "$APP_VERSION_INPUT")"',
    );
    expect(script).toContain('CANONICAL_APP_BUILD="$(require_canonical_sparkle_build "$VERSION")"');
    expect(script).not.toContain(
      'canonical_sparkle_build "$APP_VERSION_INPUT" 2>/dev/null || true',
    );
    expect(script).not.toContain('canonical_sparkle_build "$VERSION" 2>/dev/null || true');
  });

  it("fails on old Swift before reading package metadata", () => {
    const toolsDir = mkdtempSync(path.join(tmpdir(), "openclaw-dist-swift-tools-"));
    tempDirs.push(toolsDir);

    writeFileSync(
      path.join(toolsDir, "swift"),
      [
        "#!/usr/bin/env bash",
        "echo 'swift-driver version: 1.115.1 Apple Swift version 6.0.3 (swiftlang-6.0.3.1.10 clang-1600.0.30.1)'",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path.join(toolsDir, "swift"), 0o755);
    writeFileSync(
      path.join(toolsDir, "xcrun"),
      [
        "#!/usr/bin/env bash",
        '[[ "${1:-}" == "xcodebuild" && "${2:-}" == "-version" ]] || exit 2',
        "echo 'Xcode 26.4'",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path.join(toolsDir, "xcrun"), 0o755);
    writeFileSync(
      path.join(toolsDir, "node"),
      [
        "#!/usr/bin/env bash",
        "echo 'node should not run before Swift preflight' >&2",
        "exit 42",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path.join(toolsDir, "node"), 0o755);

    const result = runHelper(`
      set -euo pipefail
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      BUILD_CONFIG=release bash ${scriptPath}
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OpenClaw macOS app packaging requires Swift tools 6.3+");
    expect(result.stderr).toContain("Current Swift is 6.0");
    expect(result.stderr).not.toContain("node should not run before Swift preflight");
  });

  it("prefers repo Corepack pnpm over a global pnpm shim", () => {
    const helperBlock = getPackageManagerHelperBlock();
    const tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-dist-pnpm-root-"));
    const outerRoot = mkdtempSync(path.join(tmpdir(), "openclaw-dist-pnpm-outer-"));
    const toolsDir = mkdtempSync(path.join(tmpdir(), "openclaw-dist-pnpm-tools-"));
    const logPath = path.join(tempRoot, "pnpm.log");
    tempDirs.push(tempRoot, outerRoot, toolsDir);

    writeFileSync(
      path.join(tempRoot, "package.json"),
      '{\n  "packageManager": "pnpm@11.2.2+sha512.test"\n}\n',
    );
    writeFileSync(
      path.join(outerRoot, "package.json"),
      '{\n  "packageManager": "pnpm@11.8.0+sha512.test"\n}\n',
    );
    writeFileSync(
      path.join(toolsDir, "pnpm"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "global|%s|%s\\n" "$PWD" "$*" >> "$OPENCLAW_TEST_LOG"',
        'if [[ "${1:-}" == "--version" ]]; then echo "11.8.0"; fi',
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(toolsDir, "corepack"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "corepack|%s|%s\\n" "$PWD" "$*" >> "$OPENCLAW_TEST_LOG"',
        'if [[ "${1:-}" == "pnpm" && "${2:-}" == "--version" ]]; then',
        '  if grep -q "pnpm@11.2.2" package.json 2>/dev/null; then echo "11.2.2"; else echo "11.8.0"; fi',
        "fi",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path.join(toolsDir, "pnpm"), 0o755);
    chmodSync(path.join(toolsDir, "corepack"), 0o755);

    const result = runHelper(`
      set -euo pipefail
      ROOT_DIR=${JSON.stringify(tempRoot)}
      OPENCLAW_TEST_LOG=${JSON.stringify(logPath)}
      export OPENCLAW_TEST_LOG
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      cd ${JSON.stringify(outerRoot)}
      ${helperBlock}
      run_dist_pnpm --version
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("11.2.2\n");
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
      `corepack|${tempRoot}|pnpm --version`,
      `corepack|${tempRoot}|pnpm --version`,
    ]);
  });

  it("keeps dependency bootstrap output out of captured Sparkle build values", () => {
    const result = runSparkleBootstrap(
      'echo "ExperimentalWarning: tsx loader changed" >&2',
      'echo "Already up to date"\ntouch "$OPENCLAW_MARKER"',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("2026060200\n");
    expect(result.stderr).toContain("Ensuring deps for Sparkle build metadata");
    expect(result.stderr).toContain("Already up to date");
    expect(result.stderr).toContain("ExperimentalWarning: tsx loader changed");
  });

  it("stops when dependency bootstrap fails during Sparkle build retry", () => {
    const result = runSparkleBootstrap(
      'echo "node reran after failed install" >&2',
      'touch "$OPENCLAW_MARKER"\necho "pnpm failed" >&2\nexit 42',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("pnpm failed");
    expect(result.stderr).not.toContain("node reran after failed install");
  });

  it.runIf(process.platform === "darwin").each(["app", "dmg"] as const)(
    "re-audits the retained %s before resuming without build products",
    (artifact) => {
      const fixture = makeDistributionFixture("native");
      const app = path.join(fixture.root, "dist/OpenClaw.app");
      const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", app], {
        encoding: "utf8",
      });
      expect(signed.status, signed.stderr).toBe(0);
      for (const args of [
        ["init", "--quiet"],
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-m",
          "fixture",
        ],
      ]) {
        const result = spawnSync("git", args, { cwd: fixture.root, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
      }
      const tools = path.join(fixture.root, "tools");
      const jq = spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8" });
      expect(jq.status).toBe(0);
      symlinkSync(jq.stdout.trim(), path.join(tools, "jq"));
      writeFileSync(
        path.join(tools, "xcrun"),
        `#!/bin/bash
set -eu
root="$(dirname "$0")/.."
if [[ "$1" == stapler && "$2" == staple && ! -f "$root/staple-failed" && $(wc -l < "$root/submissions") -eq ${artifact === "app" ? 1 : 2} ]]; then
  touch "$root/staple-failed"
  echo 'stapling interrupted' >&2
  exit 7
fi
if [[ "$1" != notarytool ]]; then echo 'Xcode 26.4'; exit 0; fi
if [[ "$2" == submit ]]; then
  echo submit >> "$root/submissions"
  echo '{"id":"11111111-2222-3333-4444-555555555555"}'
else
  echo '{"id":"11111111-2222-3333-4444-555555555555","status":"Accepted"}'
fi
`,
        { mode: 0o755 },
      );
      writeFileSync(
        path.join(fixture.root, "scripts/create-dmg.sh"),
        `#!/bin/bash
set -eu
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
ditto "$1" "$stage/OpenClaw.app"
rm -f "$2"
hdiutil create -fs HFS+ -format UDZO -srcfolder "$stage" "$2" >/dev/null
/usr/bin/codesign --force --sign - "$2"
`,
        { mode: 0o755 },
      );
      const options = { notarize: true, dmg: artifact === "dmg" };
      const failed = fixture.run(options);
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain("stapling interrupted");
      const checkpoint = path.join(fixture.root, "dist/macos-notarization-recovery");
      expect(existsSync(path.join(checkpoint, "app.zip"))).toBe(true);
      expect(existsSync(path.join(checkpoint, "symbols.zip"))).toBe(true);
      renameSync(
        path.join(fixture.root, "apps/macos/.build"),
        path.join(fixture.root, "saved-build-products"),
      );
      writeFileSync(
        path.join(fixture.root, "scripts/package-mac-app.sh"),
        "#!/bin/bash\necho 'unexpected rebuild' >&2\nexit 97\n",
      );
      const submissions = readFileSync(path.join(fixture.root, "submissions"), "utf8");
      const auditor = readFileSync(fixture.auditScript, "utf8");
      writeFileSync(
        fixture.auditScript,
        `${auditor}\nif ".notary-${artifact === "app" ? "resume" : "dmg"}." in str(binary):\n    sys.exit("async frame allocation is undersized")\n`,
      );
      const rejected = fixture.run({ ...options, resume: true });
      expect(rejected.status, rejected.stdout).not.toBe(0);
      expect(rejected.stderr).toContain("async frame allocation is undersized");
      expect(readFileSync(path.join(fixture.root, "submissions"), "utf8")).toBe(submissions);
      expect(
        JSON.parse(readFileSync(path.join(checkpoint, "manifest.json"), "utf8")),
      ).toMatchObject({
        completed: false,
      });
      if (artifact === "app") {
        rmSync(fixture.auditScript);
        const missing = fixture.run({ ...options, resume: true });
        expect(missing.status).not.toBe(0);
        expect(missing.stderr).toContain("audit-async-sleep-frames.py");
        expect(existsSync(path.join(fixture.root, "dist/OpenClaw-2026.8.2.zip"))).toBe(false);
      }
      writeFileSync(fixture.auditScript, auditor);
      const resumed = fixture.run({ ...options, resume: true });
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(readFileSync(path.join(fixture.root, "async-frame-audit.log"), "utf8")).toContain(
        `.notary-${artifact === "app" ? "resume" : "dmg"}.`,
      );
      expect(readFileSync(path.join(fixture.root, "submissions"), "utf8")).toBe(submissions);
      expect(existsSync(path.join(fixture.root, "dist/OpenClaw-2026.8.2.zip"))).toBe(true);
      expect(existsSync(path.join(fixture.root, "dist/OpenClaw-2026.8.2.dSYM.zip"))).toBe(true);
      renameSync(
        path.join(fixture.root, "saved-build-products"),
        path.join(fixture.root, "apps/macos/.build"),
      );
      writeFileSync(
        path.join(fixture.root, "scripts/package-mac-app.sh"),
        "#!/bin/bash\ntouch fresh-build-started\n",
      );
      const fresh = fixture.run(options);
      expect(fresh.status, fresh.stderr).toBe(0);
      expect(existsSync(path.join(fixture.root, "fresh-build-started"))).toBe(true);
      expect(readFileSync(path.join(fixture.root, "submissions"), "utf8")).toBe(
        submissions.repeat(2),
      );
    },
  );

  it("fails closed when required dSYM outputs are missing", () => {
    const script = readFileSync(scriptPath, "utf8");
    const dsymBlock = script.slice(script.indexOf('if [[ "$SKIP_DSYM" != "1" ]]'));

    expect(dsymBlock).toContain('for arch in "${DSYM_ARCHS[@]}"');
    expect(dsymBlock).toContain('MISSING_DSYM_ARCHS+=("$arch")');
    expect(dsymBlock).toContain("Error: dSYM not found for architecture(s):");
    expect(dsymBlock).not.toContain('find "$BUILD_ROOT/arm64"');
    expect(dsymBlock).not.toContain('find "$BUILD_ROOT/x86_64"');
    expect(dsymBlock).toContain("Error: missing DWARF binaries for dSYM merge");
    expect(dsymBlock).toContain("Error: dSYM not found");
    expect(dsymBlock).toContain("exit 1");
    expect(script).toContain('if ! cp -R "$1" "$TMP_DSYM"; then');
    expect(dsymBlock).toContain("cleanup_tmp_dsym");
    expect(dsymBlock).toContain('copy_dsym_to_tmp "${DSYM_PATHS[0]}"');
    expect(dsymBlock).not.toContain('cp -R "${DSYM_PATHS[0]}" "$TMP_DSYM"');
    expect(dsymBlock).toContain(
      'if ! /usr/bin/lipo -create "${DWARF_INPUTS[@]}" -output "$DWARF_OUT"; then',
    );
    expect(dsymBlock).toContain('if ! ditto -c -k --keepParent "$TMP_DSYM" "$DSYM_ZIP"; then');
    expect(dsymBlock).toContain('rm -rf "$TMP_DSYM"');
    expect(dsymBlock).not.toContain("WARN:");
    expect(dsymBlock).not.toContain("continuing");
  });

  it.runIf(process.platform === "darwin")(
    "prints required plist keys and fails when a key is missing",
    () => {
      const plist = makePlist();
      const result = runHelper(`
        set -euo pipefail
        source scripts/lib/plistbuddy.sh
        plist_print_required ${JSON.stringify(plist)} CFBundleShortVersionString
        plist_print_required ${JSON.stringify(plist)} CFBundleVersion
      `);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("1.2.3");
      expect(result.stderr).toContain("Does Not Exist");
    },
  );
});

describe.runIf(process.platform === "darwin")("package-mac-dist symbol archives", () => {
  it.each(["native", "xcode"] as const)(
    "archives matching universal symbols from the %s build output",
    (layout) => {
      const fixture = makeDistributionFixture(layout);
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(path.join(fixture.root, "async-frame-audit.log"), "utf8")).toBe(
        path.join(fixture.root, "dist/OpenClaw.app/Contents/MacOS/OpenClaw"),
      );
      const archive = path.join(fixture.root, "dist", "OpenClaw-2026.8.2.dSYM.zip");
      const extracted = path.join(fixture.root, "extracted");
      const unpack = spawnSync("ditto", ["-x", "-k", archive, extracted], { encoding: "utf8" });
      expect(unpack.status, unpack.stderr).toBe(0);
      const uuid = spawnSync(
        "xcrun",
        ["dwarfdump", "--uuid", path.join(extracted, "OpenClaw.dSYM")],
        { encoding: "utf8" },
      );
      expect(uuid.status, uuid.stderr).toBe(0);
      expect(
        uuid.stdout
          .trim()
          .split("\n")
          .map((line) => line.split(" ").slice(0, 3).join(" "))
          .toSorted(),
      ).toEqual(fixture.expectedUUIDs.toSorted());
      expect(existsSync(path.join(fixture.root, "dist", "OpenClaw.dSYM"))).toBe(false);
    },
  );

  it.each(["undersized frame", "missing ARM64 slice"])("rejects %s before archiving", (failure) => {
    const fixture = makeDistributionFixture("native");
    const missingArm64 = failure === "missing ARM64 slice";
    if (missingArm64) {
      copyFileSync(
        path.join(fixture.root, "apps/macos/.build/x86_64/release/OpenClaw"),
        path.join(fixture.root, "dist/OpenClaw.app/Contents/MacOS/OpenClaw"),
      );
      rmSync(fixture.auditScript);
    } else {
      writeFileSync(
        fixture.auditScript,
        'import sys\nsys.stderr.write("async frame allocation is undersized\\n")\nsys.exit(1)\n',
      );
    }

    const result = fixture.run({ notarize: !missingArm64 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      missingArm64
        ? "release executable has no arm64 slice; audit cannot run"
        : "async frame allocation is undersized",
    );
    for (const artifact of [
      "OpenClaw-2026.8.2.zip",
      "OpenClaw-2026.8.2.dSYM.zip",
      "macos-notarization-recovery",
    ]) {
      expect(existsSync(path.join(fixture.root, "dist", artifact))).toBe(false);
    }
  });

  it("packages an x86_64-only build without the arm64 audit", () => {
    const fixture = makeDistributionFixture("native");
    copyFileSync(
      path.join(fixture.root, "apps/macos/.build/x86_64/release/OpenClaw"),
      path.join(fixture.root, "dist/OpenClaw.app/Contents/MacOS/OpenClaw"),
    );
    rmSync(fixture.auditScript);

    const result = fixture.run({ archs: "x86_64" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Async frame audit not applicable: x86_64-only build");
  });

  it("refuses a universal archive when one architecture has no symbols", () => {
    const fixture = makeDistributionFixture("xcode", "x86_64");
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dSYM not found for architecture(s): x86_64");
    expect(existsSync(path.join(fixture.root, "dist", "OpenClaw-2026.8.2.dSYM.zip"))).toBe(false);
  });
});
