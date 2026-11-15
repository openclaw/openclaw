import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = path.resolve("scripts/swift-build-cache-metadata.py");
const originalTime = 1_700_000_000_123_456_789n;
const checkoutTime = originalTime + 10_000_000_123n;
const sourcePath = "apps/macos/Sources/Feature.swift";
const metadataPath = "apps/macos/.build/ci-input-metadata.json";
const sourceDigest = createHash("sha256").update("source\n").digest("hex");
const invalidEntry = (entry: { sha256?: string; mtime_ns?: boolean }) =>
  JSON.stringify({
    version: 1,
    files: { [sourcePath]: { sha256: sourceDigest, mode: 0o644, mtime_ns: 1, ...entry } },
  });

function writeInput(root: string, relative: string, content = "source\n") {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function expectTimes(time: bigint, ...files: string[]) {
  for (const file of files) {
    expect(fs.statSync(file, { bigint: true }).mtimeNs, file).toBe(time);
  }
}

function python(args: string[], cwd?: string) {
  const result = spawnSync("python3", ["-I", "-S", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}
function setTime(time: bigint, ...files: string[]) {
  python([
    "-c",
    "import os,sys\nfor file in sys.argv[2:]: os.utime(file, ns=(int(sys.argv[1]),)*2)",
    String(time),
    ...files,
  ]);
}

function fixture(profile: "macos" | "ios" = "macos") {
  const root = tempDirs.make("openclaw-swift-cache-metadata-");
  const at = (relative: string) => path.join(root, relative);
  const input = (relative: string, content?: string) => writeInput(root, relative, content);
  const metadata = at(profile === "ios" ? "apps/ios/build/ci-input-metadata.json" : metadataPath);
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  const source = input(`apps/${profile}/Sources/Feature.swift`);
  fs.chmodSync(source, 0o644);
  setTime(originalTime, source);
  const run = (mode: "record" | "restore") =>
    python([script, mode, ...(profile === "ios" ? [profile] : [])], root);
  return { root, at, input, source, metadata, run };
}

describe.skipIf(process.platform === "win32")("Swift build-cache input metadata", () => {
  it("reuses unchanged iOS and shared inputs while invalidating changed source and generated version settings", () => {
    const { input, run } = fixture("ios");
    const unchanged = [
      "apps/ios/Sources/Feature.swift",
      "apps/shared/OpenClawKit/Plugins/GenerateGatewayProtocol/plugin.swift",
      "apps/macos/Tests/OpenClawIPCTests/AsyncTestGate.swift",
    ].map((relative) => input(relative));
    const changed = input("apps/ios/Sources/Changed.swift", "before\n");
    const version = input("apps/ios/build/Version.xcconfig", "CURRENT_PROJECT_VERSION = 1\n");
    setTime(originalTime, ...unchanged, changed, version);
    expect(run("record")).toContain("4 verified input timestamps");
    fs.writeFileSync(changed, "after!\n");
    fs.writeFileSync(version, "CURRENT_PROJECT_VERSION = 2\n");
    setTime(checkoutTime, ...unchanged, changed, version);
    expect(run("restore")).toContain("3 verified input timestamps");
    expectTimes(originalTime, ...unchanged);
    expectTimes(checkoutTime, changed, version);
    expect(fs.readFileSync(version, "utf8")).toContain("= 2");
  });

  it("restores original nanoseconds only for byte-identical current inputs", () => {
    const { at, input, source, run } = fixture();
    const sharedFixture =
      "apps/shared/OpenClawKit/Tests/OpenClawKitTests/GatewayTLSStoreFixture.swift";
    const unchanged = [
      sourcePath,
      sharedFixture,
      "apps/macos/.build/checkouts/dependency/Sources/Library.swift",
    ];
    setTime(originalTime, ...unchanged.slice(1).map((relative) => input(relative)));
    const sharedFixtureLink = at("apps/macos/Tests/OpenClawIPCTests/GatewayTLSStoreFixture.swift");
    fs.mkdirSync(path.dirname(sharedFixtureLink), { recursive: true });
    fs.symlinkSync(
      path.relative(path.dirname(sharedFixtureLink), at(sharedFixture)),
      sharedFixtureLink,
    );
    const changed = input("apps/macos/Sources/Changed.swift", "before\n");
    const modeChanged = input("apps/macos/Sources/ModeChanged.swift");
    fs.chmodSync(modeChanged, 0o644);
    const removed = input("apps/macos/Sources/Removed.swift");
    run("record");
    const inode = fs.statSync(source, { bigint: true }).ino;
    for (const relative of unchanged) {
      const file = at(relative);
      const mode = fs.statSync(file).mode & 0o7777;
      fs.writeFileSync(`${file}.replacement`, fs.readFileSync(file), { mode });
      // File creation applies umask even when mode is explicit.
      fs.chmodSync(`${file}.replacement`, mode);
      fs.renameSync(`${file}.replacement`, file);
    }
    expect(fs.statSync(source, { bigint: true }).ino).not.toBe(inode);
    fs.writeFileSync(changed, "after!\n");
    fs.chmodSync(modeChanged, 0o600);
    fs.rmSync(removed);
    const added = input("apps/macos/Sources/Added.swift");
    setTime(checkoutTime, ...unchanged.map(at), changed, modeChanged, added);

    expect(run("restore")).toContain("3 verified input timestamps");
    expectTimes(originalTime, ...unchanged.map(at));
    expect(fs.lstatSync(sharedFixtureLink).isSymbolicLink()).toBe(true);
    expectTimes(originalTime, sharedFixtureLink);
    expectTimes(checkoutTime, changed, modeChanged, added);
    expect(fs.readFileSync(changed, "utf8")).toBe("after!\n");
    expect(() => fs.statSync(removed)).toThrow();
  });

  it.each([
    "{",
    "null",
    '{"version":2,"files":{}}',
    '{"version":1,"files":[]}',
    invalidEntry({ sha256: "not-a-digest" }),
    invalidEntry({ mtime_ns: true }),
  ])("leaves checkout metadata unchanged for unusable cache metadata: %s", (artifact) => {
    const { source, metadata, run } = fixture();
    fs.writeFileSync(metadata, artifact);
    run("restore");
    expectTimes(originalTime, source);
  });

  it("cannot replay arbitrary paths, source links, hardlinks, or a linked cache artifact", () => {
    const { at, input, source, metadata, run } = fixture();
    run("record");
    const artifact = JSON.parse(fs.readFileSync(metadata, "utf8"));
    const outside = tempDirs.make("openclaw-swift-cache-outside-");
    const external = writeInput(outside, "Feature.swift");
    for (const relative of [
      external,
      `../${path.basename(outside)}/Feature.swift`,
      "other.swift",
    ]) {
      artifact.files[relative] = artifact.files[sourcePath];
    }
    setTime(checkoutTime, external, input("other.swift"));
    fs.rmSync(source);
    fs.symlinkSync(external, source);
    fs.symlinkSync(outside, at("apps/macos/Sources/linked-directory"), "dir");
    fs.linkSync(external, at("apps/macos/Sources/Hardlink.swift"));
    artifact.files["apps/macos/Sources/linked-directory/Feature.swift"] =
      artifact.files[sourcePath];
    artifact.files["apps/macos/Sources/Hardlink.swift"] = artifact.files[sourcePath];
    fs.writeFileSync(metadata, JSON.stringify(artifact));
    run("restore");
    expectTimes(checkoutTime, external, at("other.swift"));

    fs.rmSync(source);
    input(sourcePath);
    setTime(checkoutTime, source);
    const linkedMetadata = writeInput(outside, "metadata.json", JSON.stringify(artifact));
    fs.rmSync(metadata);
    fs.symlinkSync(linkedMetadata, metadata);
    run("restore");
    expectTimes(checkoutTime, source);
    run("record");
    expect(fs.readFileSync(linkedMetadata, "utf8")).toBe(JSON.stringify(artifact));
    expect(JSON.parse(fs.readFileSync(metadata, "utf8")).files).toHaveProperty([sourcePath]);
    fs.rmSync(path.dirname(source), { recursive: true });
    fs.symlinkSync(outside, path.dirname(source), "dir");
    run("restore");
    expectTimes(checkoutTime, external);
  });

  it("lets absent metadata or a reset build directory invalidate normally", () => {
    const { source, metadata, run } = fixture();
    run("restore");
    fs.rmSync(path.dirname(metadata), { recursive: true });
    run("restore");
    expectTimes(originalTime, source);
  });
});
