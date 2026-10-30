import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const scriptPath = "scripts/package-mac-dist.sh";
const packageSource = readFileSync(scriptPath, "utf8");
const checkpointDirs = useAutoCleanupTempDirTracker(afterEach);

function packageBlock(start: string, end?: string) {
  const from = packageSource.indexOf(start);
  const to = end ? packageSource.indexOf(end) : packageSource.length;
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return packageSource.slice(from, to);
}

function writeExecutable(file: string, body: string) {
  writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
}

function checkedTool(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function expectSuccess(result: ReturnType<typeof runHelper>) {
  expect(result.status, result.stderr).toBe(0);
  return result;
}

function expectFailure(result: ReturnType<typeof runHelper>, error: string, status?: number) {
  expect(result.status, result.stderr).not.toBe(0);
  if (status !== undefined) {
    expect(result.status).toBe(status);
  }
  expect(result.stderr).toContain(error);
}

function fixtureFiles(root: string) {
  const file = (...parts: string[]) => path.join(root, ...parts);
  const write = (name: string, body: string) => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(file(name), body);
  };
  return {
    root,
    file,
    write,
    executable: (name: string, body: string) => writeExecutable(file(name), body),
    tool: (command: string, args: string[]) => checkedTool(command, args, root),
    read: (...parts: string[]) => readFileSync(file(...parts), "utf8"),
    json: (name: string) => JSON.parse(readFileSync(file(name), "utf8")),
    copy: (source: string, target: string) => copyFileSync(file(source), file(target)),
    remove: (...names: string[]) => {
      for (const name of names) {
        rmSync(file(name), { recursive: true });
      }
    },
    expectFiles: (present: boolean, ...names: string[]) => {
      for (const name of names) {
        expect(existsSync(file(name))).toBe(present);
      }
    },
    exists: (...parts: string[]) => existsSync(file(...parts)),
    package: (args: string[], env: NodeJS.ProcessEnv, shell = "bash") =>
      spawnSync(shell, [file(scriptPath), ...args], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          APP_VERSION: "2026.8.2",
          APP_BUILD: "2608000290",
          BUILD_CONFIG: "release",
          SKIP_DSYM: "0",
          ...env,
        },
      }),
  };
}

function packageFixture(fakeTools: boolean) {
  const files = fixtureFiles(checkpointDirs.make("openclaw-dist-"));
  const { root } = files;
  const tools = files.file("tools");
  const scripts = files.file("scripts");
  mkdirSync(tools);
  mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  for (const file of [
    "package-mac-dist.sh",
    "lib/mac-notarization-recovery.py",
    "lib/swift-toolchain.sh",
    "lib/plistbuddy.sh",
    "lib/mac-disk-image.sh",
    "lib/mac-signing-identity.sh",
    ...(fakeTools ? [] : ["notarize-mac-artifact.sh"]),
  ]) {
    const target = path.join(scripts, file);
    copyFileSync(path.join("scripts", file), target);
    if (fakeTools) {
      writeFileSync(
        target,
        readFileSync(target, "utf8")
          .replaceAll("/usr/bin/codesign", path.join(tools, "codesign"))
          .replaceAll("/usr/bin/lipo", path.join(tools, "lipo"))
          .replaceAll("/usr/libexec/PlistBuddy", path.join(tools, "PlistBuddy")),
      );
    }
  }
  return { ...files, tools, scripts };
}

function makeCheckpointFixture() {
  const f = packageFixture(true);
  const { root, tools } = f;
  const fake = path.join(tools, "fake");
  writeFileSync(
    fake,
    `#!/usr/bin/env python3
import json, os, pathlib, plistlib, shutil, sys, zipfile
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
    attached = root / "attached-image"
    if args[0] == "attach" and (root / "attach-eagain").exists():
        # Busy hosts can fail with EAGAIN after creating the image devices.
        attached.write_text((root / "attach-eagain").read_text())
        sys.exit("hdiutil: attach failed - Resource temporarily unavailable")
    elif args[0] == "attach":
        mount = pathlib.Path(args[args.index("-mountpoint") + 1])
        with zipfile.ZipFile(root / "dist/macos-notarization-recovery/app.zip") as z: z.extractall(mount)
    elif args[0] == "info":
        devices = ["/dev/disk8", "/dev/disk8s1", "/dev/disk11", "/dev/disk11s1"]
        images = [{"image-path": attached.read_text(), "system-entities": [{"dev-entry": d} for d in devices]}] if attached.exists() else []
        sys.stdout.buffer.write(plistlib.dumps({"images": images}))
    elif args[:2] == ["detach", "-quiet"]:
        if (root / "detach-fails").exists(): sys.exit(1)
        attached.unlink()
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
  const audit = f.file("apps/macos/scripts/audit-async-sleep-frames.py");
  mkdirSync(path.dirname(audit), { recursive: true });
  symlinkSync(fake, audit);
  f.write("apps/macos/.build/arm64/release/OpenClaw.dSYM/symbols", "debug symbols");
  const checkpoint = f.file("dist/macos-notarization-recovery");
  return {
    ...f,
    checkpoint,
    events: () => f.read("events"),
    run: (mode: string, env: NodeJS.ProcessEnv = {}) =>
      f.package(
        [mode],
        {
          PATH: `${tools}${path.delimiter}${process.env.PATH}`,
          BUILD_ARCHS: "arm64",
          SIGN_IDENTITY: "fixture",
          ALLOW_ADHOC_SIGNING: "0",
          SKIP_NOTARIZE: "0",
          SKIP_DMG: "0",
          EXPECTED_DEVELOPER_TEAM_ID: "",
          ...env,
        },
        "/bin/bash",
      ),
  };
}

it("resumes a signed DMG without build or signing credentials", () => {
  const f = makeCheckpointFixture();
  expectSuccess(f.run("--checkpoint-only", { SIGN_IDENTITY: "" }));
  expect(f.events()).toContain("--sign Developer ID Application: Fixture --timestamp");
  expect(f.read("dist/macos-notarization-recovery/app.dmg")).toBe("dmgsigned");
  expect(f.events()).not.toContain("notarize-mac-artifact.sh");
  expect(f.events().indexOf("audit-async-sleep-frames.py")).toBeLessThan(
    f.events().indexOf("create-dmg.sh"),
  );
  f.remove("apps/macos/.build", "scripts/package-mac-app.sh", "scripts/create-dmg.sh");
  expectSuccess(f.run("--resume-notarization", { SIGN_IDENTITY: "unavailable" }));
  expect(f.events().match(/notarize-mac-artifact.sh/g)).toHaveLength(2);
  expect(f.exists("dist/OpenClaw.app/Contents/stapled")).toBe(true);
  expect(f.read("dist/OpenClaw-2026.8.2.dmg")).toBe("dmgsignedstapled");
  f.expectFiles(true, "dist/OpenClaw-2026.8.2.zip", "dist/OpenClaw-2026.8.2.dSYM.zip");
  expect(f.json("dist/macos-notarization-recovery/manifest.json").completed).toBe(true);
});

it.each(["-", ""])("resumes ad-hoc identity %j on a signer-equipped host", (identity) => {
  const f = makeCheckpointFixture();
  const smoke = {
    ALLOW_ADHOC_SIGNING: "1",
    SIGN_IDENTITY: identity,
    SKIP_NOTARIZE: "1",
    EXPECTED_DEVELOPER_TEAM_ID: "FIXTURE",
  };
  expectSuccess(f.run("--checkpoint-only", smoke));
  expectSuccess(f.run("--resume-notarization", smoke));
  expect(f.events()).not.toContain("notarize-mac-artifact.sh");
  f.expectFiles(false, "dist/OpenClaw.app/Contents/stapled", "appcast.xml");
});

it("preserves an explicit signed identity when smoke flags are present", () => {
  const f = makeCheckpointFixture();
  expectFailure(
    f.run("--checkpoint-only", { ALLOW_ADHOC_SIGNING: "1", SKIP_NOTARIZE: "1" }),
    "requires an ad-hoc signed smoke app",
  );
  expect(existsSync(f.checkpoint)).toBe(false);
});

it.each(["release", "release with smoke flag", "tampered app"])(
  "refuses %s recovery before notarization",
  (failure) => {
    const f = makeCheckpointFixture();
    expectSuccess(f.run("--checkpoint-only"));
    if (failure === "tampered app") {
      writeFileSync(path.join(f.checkpoint, "app.zip"), "tampered");
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
    expectFailure(resumed, failure.startsWith("release") ? "smoke" : "SHA-256 mismatch");
    expect(f.events()).not.toContain("notarize-mac-artifact.sh");
  },
);

it.each([false, true])("cleans failed audit mounts (detach fails: %s)", (detachFails) => {
  const f = makeCheckpointFixture();
  expectSuccess(f.run("--checkpoint-only"));
  const dmg = path.join(f.checkpoint, "app.dmg");
  const alias = f.file("recovery alias");
  symlinkSync(f.checkpoint, alias, "dir");
  // The fake reports another spelling of the image path; cleanup matches real paths.
  writeFileSync(f.file("attach-eagain"), path.join(alias, "app.dmg"));
  if (detachFails) {
    writeFileSync(f.file("detach-fails"), "");
  }

  const resumed = f.run("--resume-notarization");

  expect(resumed.status).toBe(1);
  const [attach, ...cleanup] = f
    .events()
    .split("\n")
    .filter((line) => line.startsWith("hdiutil "));
  expect(attach).toMatch(/^hdiutil attach -readonly -nobrowse -mountpoint \S+\/\.notary-dmg\.\w+ /);
  expect(attach?.endsWith(` ${dmg}`)).toBe(true);
  expect(cleanup).toEqual([
    "hdiutil info -plist",
    "hdiutil detach -quiet /dev/disk8",
    "hdiutil info -plist",
  ]);
  expect(f.events()).not.toContain("notarize-mac-artifact.sh");
  expect(f.exists("attached-image")).toBe(detachFails);
  expect(existsSync(dmg)).toBe(true);
  expect(readdirSync(f.file("dist")).filter((name) => name.startsWith(".notary-dmg."))).toEqual([]);
  expect(resumed.stderr).toContain("hdiutil: attach failed - Resource temporarily unavailable");
  if (detachFails) {
    expect(resumed.stderr).toContain(
      `ERROR: disk image ${dmg} is still attached; detach it with: hdiutil detach /dev/disk8\n`,
    );
  } else {
    expect(resumed.stderr).not.toContain("still attached");
  }
});

function makeDistributionFixture(layout: "native" | "xcode", missingArch?: string) {
  const f = packageFixture(false);
  const { tools } = f;
  f.executable("scripts/package-mac-app.sh", "exit 0");
  f.executable("tools/swift", "echo 'Apple Swift version 6.3'");
  f.executable("tools/xcrun", "echo 'Xcode 26.4'");
  f.executable("tools/node", "echo 2608000290");
  const contents = "dist/OpenClaw.app/Contents";
  mkdirSync(f.file(contents, "MacOS"), { recursive: true });
  const auditPath = "apps/macos/scripts/audit-async-sleep-frames.py";
  f.write(
    auditPath,
    `from pathlib import Path
import sys
binary = Path(sys.argv[1])
assert binary.is_file()
Path(__file__).resolve().parents[3].joinpath("async-frame-audit.log").write_text(str(binary))
`,
  );
  f.write(
    `${contents}/Info.plist`,
    `<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>2026.8.2</string>
<key>CFBundleVersion</key><string>2608000290</string>
<key>CFBundleIdentifier</key><string>ai.openclaw.mac</string>
<key>CFBundleExecutable</key><string>OpenClaw</string>
<key>SUFeedURL</key><string>https://example.com/appcast.xml</string>
</dict></plist>`,
  );
  const source = f.file("main.c");
  writeFileSync(source, "int main(void) { return 0; }\n");
  const expectedUUIDs: string[] = [];
  for (const arch of ["arm64", "x86_64"]) {
    const build = f.file("apps/macos/.build", arch);
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
      checkedTool("xcrun", args);
    }
    const uuid = checkedTool("xcrun", ["dwarfdump", "--uuid", binary]);
    expectedUUIDs.push(uuid.trim().split(" ").slice(0, 3).join(" "));
    if (arch === "arm64") {
      copyFileSync(binary, f.file(contents, "MacOS/OpenClaw"));
    }
  }
  return {
    ...f,
    auditScript: f.file(auditPath),
    expectedUUIDs,
    run: (options: { resume?: boolean; notarize?: boolean; dmg?: boolean; archs?: string } = {}) =>
      f.package(options.resume ? ["--resume-notarization"] : [], {
        PATH: `${tools}:/usr/bin:/bin`,
        BUILD_ARCHS: options.archs ?? "all",
        SKIP_NOTARIZE: options.notarize ? "0" : "1",
        ALLOW_ADHOC_SIGNING: "1",
        SIGN_IDENTITY: "-",
        NOTARYTOOL_PROFILE: "test-profile",
        SKIP_DMG: options.dmg ? "0" : "1",
      }),
  };
}

function runHelper(script: string) {
  return spawnSync("bash", ["-lc", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function runSparkleBootstrap(nodeAfterInstall: string, pnpmBody: string) {
  const helpers = packageBlock("DIST_PNPM_CMD=()", "correction_build_from_exact_tag()");
  const dir = checkpointDirs.make("openclaw-dist-sparkle-");
  const tools = path.join(dir, "tools");
  const marker = path.join(dir, "installed");
  mkdirSync(tools);
  writeExecutable(
    path.join(tools, "node"),
    `if [[ "$PWD" != "$OPENCLAW_ROOT" ]]; then
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
  );
  writeExecutable(path.join(tools, "pnpm"), pnpmBody);
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

it("reads the exact required plist keys into their release fields", () => {
  expect(packageBlock("VERSION=", 'ZIP="$ROOT_DIR/dist/OpenClaw-$VERSION.zip"').trim()).toBe(
    [
      'VERSION="$(plist_print_required "$APP/Contents/Info.plist" CFBundleShortVersionString)"',
      'BUNDLE_VERSION="$(plist_print_required "$APP/Contents/Info.plist" CFBundleVersion)"',
      'ACTUAL_BUNDLE_ID="$(plist_print_required "$APP/Contents/Info.plist" CFBundleIdentifier)"',
      'ACTUAL_FEED_URL="$(plist_print_required "$APP/Contents/Info.plist" SUFeedURL)"',
    ].join("\n"),
  );
});

it.each([
  [
    "release bundle identity",
    () => packageBlock('if [[ "$BUILD_CONFIG" == "release" ]]', 'if [[ "$NOTARIZE" == "1" ]]'),
    /if \[\[ "\$ACTUAL_BUNDLE_ID" != "\$BUNDLE_ID" \]\]/,
  ],
  [
    "official Control UI before packaging",
    () =>
      packageBlock(
        "export OPENCLAW_CONTROL_UI_RELEASE_BUILD=1",
        '"$ROOT_DIR/scripts/package-mac-app.sh"',
      ),
    /^export OPENCLAW_CONTROL_UI_RELEASE_BUILD=1/,
  ],
  [
    "missing dSYM failure",
    () => packageBlock('if [[ "$SKIP_DSYM" != "1" ]]'),
    /if \[\[ ! -f "\$DWARF_INPUT" \]\]; then\s+echo [^\n]+\s+cleanup_tmp_dsym\s+exit 1/,
  ],
] as const)("guards %s", (_contract, source, invariant) => {
  expect(source().trim()).toMatch(invariant);
});

it("fails on old Swift before reading package metadata", () => {
  const toolsDir = checkpointDirs.make("openclaw-dist-swift-tools-");
  writeExecutable(
    path.join(toolsDir, "swift"),
    "echo 'swift-driver version: 1.115.1 Apple Swift version 6.0.3 (swiftlang-6.0.3.1.10 clang-1600.0.30.1)'",
  );
  writeExecutable(
    path.join(toolsDir, "xcrun"),
    '[[ "${1:-}" == "xcodebuild" && "${2:-}" == "-version" ]] || exit 2\necho \'Xcode 26.4\'',
  );
  writeExecutable(
    path.join(toolsDir, "node"),
    "echo 'node should not run before Swift preflight' >&2\nexit 42",
  );

  const result = runHelper(`
      set -euo pipefail
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      BUILD_CONFIG=release bash ${scriptPath}
    `);

  expectFailure(result, "OpenClaw macOS app packaging requires Swift tools 6.3+", 1);
  expect(result.stderr).toContain("Current Swift is 6.0");
  expect(result.stderr).not.toContain("node should not run before Swift preflight");
});

it("prefers repo Corepack pnpm over a global pnpm shim", () => {
  const helperBlock = packageBlock("DIST_PNPM_CMD=()", "ensure_sparkle_build_deps()");
  const tempRoot = checkpointDirs.make("openclaw-dist-pnpm-root-");
  const outerRoot = checkpointDirs.make("openclaw-dist-pnpm-outer-");
  const toolsDir = checkpointDirs.make("openclaw-dist-pnpm-tools-");
  const logPath = path.join(tempRoot, "pnpm.log");

  writeFileSync(
    path.join(tempRoot, "package.json"),
    '{\n  "packageManager": "pnpm@11.2.2+sha512.test"\n}\n',
  );
  writeFileSync(
    path.join(outerRoot, "package.json"),
    '{\n  "packageManager": "pnpm@11.8.0+sha512.test"\n}\n',
  );
  writeExecutable(
    path.join(toolsDir, "pnpm"),
    `printf "global|%s|%s\\n" "$PWD" "$*" >> "$OPENCLAW_TEST_LOG"
if [[ "\${1:-}" == "--version" ]]; then echo "11.8.0"; fi`,
  );
  writeExecutable(
    path.join(toolsDir, "corepack"),
    `printf "corepack|%s|%s\\n" "$PWD" "$*" >> "$OPENCLAW_TEST_LOG"
if [[ "\${1:-}" == "pnpm" && "\${2:-}" == "--version" ]]; then
  if grep -q "pnpm@11.2.2" package.json 2>/dev/null; then echo "11.2.2"; else echo "11.8.0"; fi
fi`,
  );

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

  expectSuccess(result);
  expect(result.stdout).toBe("11.2.2\n");
  expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
    `corepack|${tempRoot}|pnpm --version`,
    `corepack|${tempRoot}|pnpm --version`,
  ]);
});

it.each(["successful", "failed"] as const)(
  "keeps %s Sparkle bootstrap diagnostics separate from build values",
  (outcome) => {
    const failed = outcome === "failed";
    const result = runSparkleBootstrap(
      failed
        ? 'echo "node reran after failed install" >&2'
        : 'echo "ExperimentalWarning: tsx loader changed" >&2',
      failed
        ? 'touch "$OPENCLAW_MARKER"\necho "pnpm failed" >&2\nexit 42'
        : 'echo "Already up to date"\ntouch "$OPENCLAW_MARKER"',
    );
    expect(result.status).toBe(failed ? 1 : 0);
    expect(result.stdout).toBe(failed ? "" : "2026060200\n");
    if (failed) {
      expect(result.stderr).toContain("pnpm failed");
      expect(result.stderr).not.toContain("node reran after failed install");
    } else {
      expect(result.stderr).toContain("Ensuring deps for Sparkle build metadata");
      expect(result.stderr).toContain("Already up to date");
      expect(result.stderr).toContain("ExperimentalWarning: tsx loader changed");
    }
  },
);

it.runIf(process.platform === "darwin").each(["app", "dmg"] as const)(
  "re-audits the retained %s before resuming without build products",
  (artifact) => {
    const f = makeDistributionFixture("native");
    const app = f.file("dist/OpenClaw.app");
    f.tool("/usr/bin/codesign", ["--force", "--sign", "-", app]);
    f.tool("git", ["init", "--quiet"]);
    f.tool("git", [
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
    ]);
    const tools = f.file("tools");
    symlinkSync(checkedTool("sh", ["-c", "command -v jq"]).trim(), path.join(tools, "jq"));
    f.executable(
      "tools/xcrun",
      `root="$(dirname "$0")/.."
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
    );
    f.executable(
      "scripts/create-dmg.sh",
      `stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
ditto "$1" "$stage/OpenClaw.app"
rm -f "$2"
hdiutil create -fs HFS+ -format UDZO -srcfolder "$stage" "$2" >/dev/null
/usr/bin/codesign --force --sign - "$2"
`,
    );
    const options = { notarize: true, dmg: artifact === "dmg" };
    expectFailure(f.run(options), "stapling interrupted");
    f.expectFiles(
      true,
      "dist/macos-notarization-recovery/app.zip",
      "dist/macos-notarization-recovery/symbols.zip",
    );
    renameSync(f.file("apps/macos/.build"), f.file("saved-build-products"));
    f.executable("scripts/package-mac-app.sh", "echo 'unexpected rebuild' >&2\nexit 97");
    const submissions = f.read("submissions");
    const auditor = readFileSync(f.auditScript, "utf8");
    writeFileSync(
      f.auditScript,
      `${auditor}\nif ".notary-${artifact === "app" ? "resume" : "dmg"}." in str(binary):\n    sys.exit("async frame allocation is undersized")\n`,
    );
    expectFailure(f.run({ ...options, resume: true }), "async frame allocation is undersized");
    expect(f.read("submissions")).toBe(submissions);
    expect(f.json("dist/macos-notarization-recovery/manifest.json")).toMatchObject({
      completed: false,
    });
    if (artifact === "app") {
      rmSync(f.auditScript);
      expectFailure(f.run({ ...options, resume: true }), "audit-async-sleep-frames.py");
      expect(f.exists("dist/OpenClaw-2026.8.2.zip")).toBe(false);
    }
    writeFileSync(f.auditScript, auditor);
    expectSuccess(f.run({ ...options, resume: true }));
    expect(f.read("async-frame-audit.log")).toContain(
      `.notary-${artifact === "app" ? "resume" : "dmg"}.`,
    );
    expect(f.read("submissions")).toBe(submissions);
    f.expectFiles(true, "dist/OpenClaw-2026.8.2.zip", "dist/OpenClaw-2026.8.2.dSYM.zip");
    renameSync(f.file("saved-build-products"), f.file("apps/macos/.build"));
    f.executable("scripts/package-mac-app.sh", "touch fresh-build-started");
    expectSuccess(f.run(options));
    expect(f.exists("fresh-build-started")).toBe(true);
    expect(f.read("submissions")).toBe(submissions.repeat(2));
  },
);

it.runIf(process.platform === "darwin")(
  "prints required plist keys and fails when a key is missing",
  () => {
    const plist = path.join(checkpointDirs.make("openclaw-dist-plist-"), "Info.plist");
    writeFileSync(
      plist,
      '<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>',
    );
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
describe.runIf(process.platform === "darwin")("package-mac-dist symbol archives", () => {
  it.each(["native", "xcode"] as const)(
    "archives matching universal symbols from the %s build output",
    (layout) => {
      const f = makeDistributionFixture(layout);
      expectSuccess(f.run());
      expect(f.read("async-frame-audit.log")).toBe(
        f.file("dist/OpenClaw.app/Contents/MacOS/OpenClaw"),
      );
      const archive = f.file("dist", "OpenClaw-2026.8.2.dSYM.zip");
      const extracted = f.file("extracted");
      f.tool("ditto", ["-x", "-k", archive, extracted]);
      const uuid = f.tool("xcrun", ["dwarfdump", "--uuid", path.join(extracted, "OpenClaw.dSYM")]);
      expect(
        uuid
          .trim()
          .split("\n")
          .map((line) => line.split(" ").slice(0, 3).join(" "))
          .toSorted(),
      ).toEqual(f.expectedUUIDs.toSorted());
      expect(f.exists("dist", "OpenClaw.dSYM")).toBe(false);
    },
  );

  it.each(["undersized frame", "missing ARM64 slice"])("rejects %s before archiving", (failure) => {
    const f = makeDistributionFixture("native");
    const missingArm64 = failure === "missing ARM64 slice";
    if (missingArm64) {
      f.copy(
        "apps/macos/.build/x86_64/release/OpenClaw",
        "dist/OpenClaw.app/Contents/MacOS/OpenClaw",
      );
      rmSync(f.auditScript);
    } else {
      writeFileSync(
        f.auditScript,
        'import sys\nsys.stderr.write("async frame allocation is undersized\\n")\nsys.exit(1)\n',
      );
    }

    const result = f.run({ notarize: !missingArm64, dmg: !missingArm64 });

    expectFailure(
      result,
      missingArm64
        ? "release executable has no arm64 slice; audit cannot run"
        : "async frame allocation is undersized",
      1,
    );
    f.expectFiles(
      false,
      "dist/OpenClaw-2026.8.2.zip",
      "dist/OpenClaw-2026.8.2.dSYM.zip",
      "dist/OpenClaw-2026.8.2.dmg",
      "dist/macos-notarization-recovery",
    );
  });

  it("packages an x86_64-only build without the arm64 audit", () => {
    const f = makeDistributionFixture("native");
    f.copy(
      "apps/macos/.build/x86_64/release/OpenClaw",
      "dist/OpenClaw.app/Contents/MacOS/OpenClaw",
    );
    rmSync(f.auditScript);

    const result = expectSuccess(f.run({ archs: "x86_64" }));
    expect(result.stderr).toContain("Async frame audit not applicable: x86_64-only build");
  });

  it("refuses a universal archive when one architecture has no symbols", () => {
    const f = makeDistributionFixture("xcode", "x86_64");
    expectFailure(f.run(), "dSYM not found for architecture(s): x86_64");
    expect(f.exists("dist", "OpenClaw-2026.8.2.dSYM.zip")).toBe(false);
  });
});
