import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "tsdown";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "../../scripts/lib/tsdown-config-groups.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import buildConfigs from "../../tsdown.config.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyFsSafePackageFixture } from "./fs-safe-package.test-support.js";

const builds = useAutoCleanupTempDirTracker(afterAll);
const fixtures = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve("scripts/verify-mac-runtime-fs.mjs");
const testNodeExecPath = resolveTestNodeExecPath();
// Native package containment runs on the test runtime; the packager repeats
// this proof on the bundled Bun for each shipped architecture.
describe.skipIf(process.platform !== "darwin")("Mac runtime bundled filesystem proof", () => {
  let compiled: string;
  beforeAll(async () => {
    compiled = builds.make("openclaw-runtime-fs-build-");
    const selected = buildConfigs.find((config) => config.name === TSDOWN_UNIFIED_CONFIG_GROUP);
    expect(selected).toBeDefined();
    const { bundles } = await build({
      ...selected,
      config: false,
      entry: {
        "plugin-sdk/memory-core-host-engine-fs": "src/plugin-sdk/memory-core-host-engine-fs.ts",
        // A second real entry keeps the shared loader at the package's dist root,
        // as in the production unified graph. No replacement SDK facade.
        "fs-safe": "src/infra/fs-safe.ts",
      },
      outDir: path.join(compiled, "dist"),
      dts: false,
      logLevel: "silent",
    });
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
    expect(fs.existsSync(path.join(compiled, "dist/native"))).toBe(false);
    fs.writeFileSync(path.join(compiled, "package.json"), '{"type":"module"}');
  });

  function fixture() {
    const directory = fixtures.make("openclaw-runtime-fs-proof-");
    const runtime = path.join(directory, "runtime");
    const packageRoot = path.join(runtime, "lib/node_modules/openclaw");
    fs.cpSync(compiled, packageRoot, { recursive: true });
    const home = path.join(directory, "home");
    fs.mkdirSync(home);
    const { dependencyRoot, nativePackages } = copyFsSafePackageFixture(packageRoot);
    const nativePackage = nativePackages.find(
      ({ name }) => name === `@openclaw/fs-safe-${process.platform}-${process.arch}`,
    )!;
    expect(nativePackage).toBeDefined();
    const native = createRequire(path.join(dependencyRoot, "package.json")).resolve(
      nativePackage.name,
    );
    return { packageRoot, home, native, nativePackage };
  }

  function probe(packageRoot: string, home: string) {
    const result = spawnSync(testNodeExecPath, [helper, packageRoot, home], {
      cwd: home,
      env: { HOME: home, TMPDIR: home, FS_SAFE_NATIVE_MODE: "require" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  it("rejects an omitted native package through the bundled filesystem verifier", () => {
    const { packageRoot, home, nativePackage } = fixture();
    fs.rmSync(nativePackage.root, { recursive: true });
    const result = probe(packageRoot, home);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("helper-unavailable");
    expect(result.stderr).toContain("MODULE_NOT_FOUND");
    expect(result.stderr).toContain(nativePackage.name);
  });

  it("accepts SDK write/create bytes from the installed platform package", () => {
    const { packageRoot, home, native } = fixture();
    const result = probe(packageRoot, home);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(home, "native-write-proof"), "utf8")).toBe(
      "bundled runtime write proof\n",
    );
    expect(fs.readFileSync(path.join(home, "native-create-proof"), "utf8")).toBe(
      "bundled runtime create proof\n",
    );
    expect(JSON.parse(result.stdout)).toEqual({
      architecture: process.arch,
      nativeModule: native,
      writeBytes: 28,
      createBytes: 29,
    });
  });

  it("rejects a loaded native package outside the runtime payload", () => {
    const { packageRoot, home, native } = fixture();
    const outside = path.join(home, "fs-safe-native.node");
    fs.renameSync(native, outside);
    fs.symlinkSync(outside, native);
    const result = probe(packageRoot, home);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("fs-safe native package is outside the runtime payload");
    // The SDK operation succeeded; the package provenance check rejects its source.
    expect(fs.readFileSync(path.join(home, "native-write-proof"), "utf8")).toBe(
      "bundled runtime write proof\n",
    );
    expect(fs.readFileSync(path.join(home, "native-create-proof"), "utf8")).toBe(
      "bundled runtime create proof\n",
    );
  });

  it("does not recover an omitted platform package from a stale dist native tree", () => {
    const { packageRoot, home, native, nativePackage } = fixture();
    const staleNative = path.join(
      packageRoot,
      "dist/native",
      `${process.platform}-${process.arch}`,
      "fs-safe-native.node",
    );
    fs.mkdirSync(path.dirname(staleNative), { recursive: true });
    fs.copyFileSync(native, staleNative);
    fs.rmSync(nativePackage.root, { recursive: true });
    const result = probe(packageRoot, home);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("helper-unavailable");
    expect(result.stderr).toContain(nativePackage.name);
    expect(fs.readFileSync(path.join(home, "native-write-proof"), "utf8")).toBe(
      "before replacement\n",
    );
    expect(fs.existsSync(path.join(home, "native-create-proof"))).toBe(false);
  });
});
