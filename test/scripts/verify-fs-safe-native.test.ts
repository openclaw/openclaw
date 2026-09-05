import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const verifierPath = path.resolve("scripts/docker/verify-fs-safe-native.mjs");

type FixtureOptions = {
  binding?: "bundled" | "escaped" | "platform";
  durability?: boolean;
  installPlatformPackage?: boolean;
  native?: boolean;
  platformPackage?: boolean;
  pnpmLayout?: boolean;
  version?: string | undefined;
};

function writeModule(pathname: string, contents: string): void {
  mkdirSync(path.dirname(pathname), { recursive: true });
  writeFileSync(pathname, contents);
}

function linkDirectory(target: string, link: string): void {
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(
    process.platform === "win32" ? target : path.relative(path.dirname(link), target),
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function createFixture(options: FixtureOptions = {}) {
  const root = tempDirs.make("openclaw-fs-safe-");
  const packageRoot = path.join(root, "app");
  const modulesRoot = path.join(packageRoot, "node_modules");
  const virtualStore = path.join(modulesRoot, ".pnpm");
  const fsSafeDependencyRoot = options.pnpmLayout
    ? path.join(virtualStore, "@openclaw+fs-safe@0.8.1", "node_modules")
    : modulesRoot;
  const fsSafeRoot = path.join(fsSafeDependencyRoot, "@openclaw", "fs-safe");
  const platformRoot = options.pnpmLayout
    ? path.join(
        virtualStore,
        "@openclaw+fs-safe-linux-x64-gnu@0.8.1",
        "node_modules",
        "@openclaw",
        "fs-safe-linux-x64-gnu",
      )
    : path.join(modulesRoot, "@openclaw", "fs-safe-linux-x64-gnu");
  const outsideRoot = path.join(root, "outside");
  const bindingPath =
    options.binding === "platform"
      ? path.join(platformRoot, "fs-safe-native.node")
      : options.binding === "escaped"
        ? path.join(outsideRoot, "fs-safe-native.node")
        : path.join(fsSafeRoot, "dist", "native", "linux-x64-gnu", "fs-safe-native.node");

  mkdirSync(fsSafeRoot, { recursive: true });
  if (options.pnpmLayout) {
    linkDirectory(fsSafeRoot, path.join(modulesRoot, "@openclaw", "fs-safe"));
  }
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    path.join(fsSafeRoot, "package.json"),
    JSON.stringify({
      name: "@openclaw/fs-safe",
      ...(options.version === undefined ? {} : { version: options.version }),
      type: "module",
      exports: {
        "./config": "./dist/config.js",
        ...(options.durability ? { "./durability": "./dist/durability.js" } : {}),
      },
      ...(options.platformPackage
        ? { optionalDependencies: { "@openclaw/fs-safe-linux-x64-gnu": "0.8.1" } }
        : {}),
    }),
  );
  writeModule(
    path.join(fsSafeRoot, "dist", "config.js"),
    options.native
      ? "export function configureFsSafeNative() {}\n"
      : "export function configureFsSafePython() {}\n",
  );
  if (options.durability) {
    writeModule(
      path.join(fsSafeRoot, "dist", "durability.js"),
      [
        'import { createRequire } from "node:module";',
        "const require = createRequire(import.meta.url);",
        options.binding ? `require.cache[${JSON.stringify(bindingPath)}] = { exports: {} };` : "",
        'export async function sha256File() { return { digest: "a".repeat(64) }; }',
        "",
      ].join("\n"),
    );
  }
  if (options.binding) {
    writeModule(bindingPath, "");
  }
  if (options.installPlatformPackage || options.binding === "platform") {
    writeModule(
      path.join(platformRoot, "package.json"),
      JSON.stringify({
        name: "@openclaw/fs-safe-linux-x64-gnu",
        version: "0.8.1",
        main: "fs-safe-native.node",
      }),
    );
    writeModule(path.join(platformRoot, "fs-safe-native.node"), "");
    if (options.pnpmLayout) {
      linkDirectory(
        platformRoot,
        path.join(fsSafeDependencyRoot, "@openclaw", "fs-safe-linux-x64-gnu"),
      );
    }
  }
  return { packageRoot };
}

function runVerifier(
  packageRoot: string,
  options: { allowPreNative?: boolean; mode?: "fallback" | "require" } = {},
) {
  return spawnSync(
    process.execPath,
    [
      verifierPath,
      "--package-root",
      packageRoot,
      "--mode",
      options.mode ?? "require",
      "--allow-pre-native-contract",
      options.allowPreNative ? "1" : "0",
    ],
    { encoding: "utf8" },
  );
}

describe("pre-native fs-safe packages", () => {
  it.each(["0.3.0", "0.4.1"])(
    "accepts explicitly authorized version %s without a native surface",
    (version) => {
      const fixture = createFixture({ version });

      const result = runVerifier(fixture.packageRoot, { allowPreNative: true });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("authorized package predates native bindings");
    },
  );

  it.each(["0.3.0", "0.4.1"])("rejects version %s without authorization", (version) => {
    const fixture = createFixture({ version });

    const result = runVerifier(fixture.packageRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires explicit frozen-target authorization");
  });

  it.each([
    ["versionless", undefined],
    ["malformed", "legacy"],
    ["post-threshold", "0.5.0"],
  ])("rejects %s packages without native configuration", (_name, version) => {
    const fixture = createFixture({ version });

    const result = runVerifier(fixture.packageRoot, { allowPreNative: true });

    expect(result.status).not.toBe(0);
  });

  it("rejects inconsistent pre-native metadata", () => {
    const fixture = createFixture({ durability: true, version: "0.4.1" });

    const result = runVerifier(fixture.packageRoot, { allowPreNative: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unexpectedly exports durability");
  });
});

describe("bundled-native fs-safe packages", () => {
  it("accepts a 0.5.x binding contained under dist/native/<target>", () => {
    const fixture = createFixture({
      binding: "bundled",
      durability: true,
      native: true,
      version: "0.5.6",
    });

    const result = runVerifier(fixture.packageRoot);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a bundled binding outside the installed fs-safe package", () => {
    const fixture = createFixture({
      binding: "escaped",
      durability: true,
      native: true,
      version: "0.5.6",
    });

    const result = runVerifier(fixture.packageRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("escaped dist/native/<target>");
  });
});

describe("split-package fs-safe packages", () => {
  it("accepts a required binding from a declared installed platform package", () => {
    const fixture = createFixture({
      binding: "platform",
      durability: true,
      native: true,
      installPlatformPackage: true,
      platformPackage: true,
      version: "0.8.1",
    });

    const result = runVerifier(fixture.packageRoot);

    expect(result.status, result.stderr).toBe(0);
  });

  it("resolves a platform package beside the canonical fs-safe pnpm location", () => {
    const fixture = createFixture({
      binding: "platform",
      durability: true,
      native: true,
      platformPackage: true,
      pnpmLayout: true,
      version: "0.8.1",
    });

    const result = runVerifier(fixture.packageRoot);

    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts fallback mode when optional platform packages are absent", () => {
    const fixture = createFixture({
      durability: true,
      native: true,
      platformPackage: true,
      version: "0.8.1",
    });

    const result = runVerifier(fixture.packageRoot, { mode: "fallback" });

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a required binding outside the declared platform package", () => {
    const fixture = createFixture({
      binding: "escaped",
      durability: true,
      installPlatformPackage: true,
      native: true,
      platformPackage: true,
      version: "0.8.1",
    });

    const result = runVerifier(fixture.packageRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not come from an installed platform package");
  });

  it("rejects fallback mode when a platform package is installed", () => {
    const fixture = createFixture({
      durability: true,
      installPlatformPackage: true,
      native: true,
      platformPackage: true,
      version: "0.8.1",
    });

    const result = runVerifier(fixture.packageRoot, { mode: "fallback" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fallback install contains a platform package");
  });
});
