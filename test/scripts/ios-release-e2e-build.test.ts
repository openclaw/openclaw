import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareIOSReleaseNativeBuild,
  type IOSReleaseNativeBuildIdentity,
} from "../../scripts/lib/ios-release-e2e-build.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const root = roots.make("ios-native-build-");
  const identity: IOSReleaseNativeBuildIdentity = {
    sourceSha: "a".repeat(40),
    checkoutPath: root,
    xcodeVersion: "Xcode 27.0\nBuild version 18A1",
    sdkVersion: "24A1",
    developerDir: path.join(root, "Xcode"),
    nodeVersion: process.version,
    platform: "darwin",
    arch: "arm64",
    buildArgs: ["-scheme", "OpenClawUITests", "build-for-testing"],
    generatorArgs: ["ios:gen"],
  };
  const write = (relative: string, text = "fixture bytes") => {
    const file = path.join(root, "build/DerivedData/Build/Products", relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const build = vi.fn(async () => {
    write("OpenClawUITests_iphonesimulator.xctestrun", "fixture test configuration");
    for (const bundle of [
      "OpenClaw.app",
      "OpenClawUITests-Runner.app",
      "OpenClawUITests-Runner.app/PlugIns/OpenClawUITests.xctest",
    ]) {
      write(`Debug-iphonesimulator/${bundle}/Info.plist`);
      const executable = path.basename(bundle).replace(/\.(app|xctest)$/u, "");
      fs.chmodSync(write(`Debug-iphonesimulator/${bundle}/${executable}`), 0o755);
    }
    const framework = "Debug-iphonesimulator/OpenClaw.app/Frameworks/Fixture.framework";
    const library = write(`${framework}/Versions/A/Fixture`);
    fs.symlinkSync("A", path.join(path.dirname(path.dirname(library)), "Current"));
  });
  const options = {
    buildDir: path.join(root, "build"),
    identity,
    assertCurrentSource: vi.fn(async () => {}),
    build,
  };
  return { root, options, write };
}

describe("retained iOS qualification native build", () => {
  it("reuses complete exact-candidate products without invoking the builder again", async () => {
    const { options } = fixture();
    const first = await prepareIOSReleaseNativeBuild(options);
    const second = await prepareIOSReleaseNativeBuild(options);
    expect(first.reused).toBe(false);
    expect(second).toEqual({ ...first, reused: true });
    expect(fs.existsSync(second.xctestrunPath)).toBe(true);
    expect(options.build).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["sourceSha", "b".repeat(40)],
    ["xcodeVersion", "Xcode 27.1\nBuild version 18B1"],
    ["sdkVersion", "24B1"],
    ["developerDir", "/different/Xcode"],
    ["nodeVersion", "v99.0.0"],
    ["platform", "linux"],
    ["arch", "x64"],
    ["buildArgs", ["-scheme", "AnotherTests", "build-for-testing"]],
    ["generatorArgs", ["other:gen"]],
  ] as const)("refuses a changed %s instead of rebuilding over the receipt", async (key, value) => {
    const { options } = fixture();
    await prepareIOSReleaseNativeBuild(options);
    const identity = { ...options.identity, [key]: typeof value === "string" ? value : [...value] };
    await expect(prepareIOSReleaseNativeBuild({ ...options, identity })).rejects.toThrow(
      "native-build-receipt-mismatch",
    );
    expect(options.build).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "changed", "extra", "mode", "link"] as const)(
    "refuses %s runnable artifacts without repair or replacement",
    async (change) => {
      const { options, write } = fixture();
      await prepareIOSReleaseNativeBuild(options);
      const executable = path.join(
        options.buildDir,
        "DerivedData/Build/Products/Debug-iphonesimulator/OpenClaw.app/OpenClaw",
      );
      if (change === "missing") {
        fs.rmSync(executable);
      } else if (change === "changed") {
        fs.writeFileSync(executable, "changed app");
      } else if (change === "extra") {
        write("Debug-iphonesimulator/OpenClaw.app/unrecorded.dylib");
      } else if (change === "mode") {
        fs.chmodSync(executable, 0o644);
      } else {
        fs.rmSync(executable);
        fs.symlinkSync("Info.plist", executable);
      }
      await expect(prepareIOSReleaseNativeBuild(options)).rejects.toThrow(/native-build-/u);
      expect(options.build).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["checkout", "build"] as const)("refuses a relocated physical %s", async (owner) => {
    const { root, options } = fixture();
    await prepareIOSReleaseNativeBuild(options);
    const moved = path.join(root, "moved");
    if (owner === "checkout") {
      fs.mkdirSync(moved);
      options.identity.checkoutPath = moved;
    } else {
      fs.renameSync(options.buildDir, moved);
      options.buildDir = moved;
    }
    await expect(prepareIOSReleaseNativeBuild(options)).rejects.toThrow(
      "native-build-receipt-mismatch",
    );
    expect(options.build).toHaveBeenCalledTimes(1);
  });

  it("does not admit a failed build or overwrite its incomplete directory", async () => {
    const { options, write } = fixture();
    options.build.mockImplementation(async () => {
      write("partial-output");
      throw new Error("build failed");
    });
    await expect(prepareIOSReleaseNativeBuild(options)).rejects.toThrow("build failed");
    await expect(prepareIOSReleaseNativeBuild(options)).rejects.toThrow(
      "native-build-incomplete-directory",
    );
    expect(options.build).toHaveBeenCalledTimes(1);
  });

  it("refuses a receipt when source admission changes during the build", async () => {
    const { options } = fixture();
    options.assertCurrentSource.mockResolvedValueOnce().mockRejectedValueOnce(new Error("dirty"));
    await expect(prepareIOSReleaseNativeBuild(options)).rejects.toThrow("dirty");
    expect(fs.existsSync(path.join(options.buildDir, "native-build.json"))).toBe(false);
  });
});
