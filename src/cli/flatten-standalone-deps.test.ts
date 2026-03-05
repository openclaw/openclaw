import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flattenPnpmStandaloneDeps } from "./flatten-standalone-deps.js";
import { installManagedWebRuntime } from "./web-runtime.js";

// ---------------------------------------------------------------------------
// Helpers to build synthetic pnpm standalone structures
// ---------------------------------------------------------------------------

let tmpRoot: string;

function tmp(...segments: string[]): string {
  return path.join(tmpRoot, ...segments);
}

function writeFile(relativePath: string, content = ""): void {
  const full = tmp(relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

/** Create a real package directory in the pnpm virtual store. */
function addPnpmPackage(
  storeEntryName: string,
  packageName: string,
  files: Record<string, string> = { "index.js": `module.exports = "${packageName}";` },
): string {
  const pkgDir = tmp("standalone", "node_modules", ".pnpm", storeEntryName, "node_modules", packageName);
  mkdirSync(pkgDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(pkgDir, name);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf-8");
  }
  return pkgDir;
}

/** Create a symlink inside a pnpm store entry pointing to another store entry. */
function addPnpmSymlink(
  fromStoreEntry: string,
  linkName: string,
  toStoreEntry: string,
  toPackageName: string,
): void {
  const linkDir = tmp("standalone", "node_modules", ".pnpm", fromStoreEntry, "node_modules");
  const linkPath = path.join(linkDir, linkName);
  const target = path.join("..", "..", toStoreEntry, "node_modules", toPackageName);
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
}

/** Create a scoped symlink (e.g. @next/env → real @next/env in another store entry). */
function addScopedPnpmSymlink(
  fromStoreEntry: string,
  scope: string,
  name: string,
  toStoreEntry: string,
): void {
  const scopeDir = tmp("standalone", "node_modules", ".pnpm", fromStoreEntry, "node_modules", scope);
  mkdirSync(scopeDir, { recursive: true });
  const linkPath = path.join(scopeDir, name);
  const target = path.join("..", "..", "..", toStoreEntry, "node_modules", scope, name);
  symlinkSync(target, linkPath);
}

/** Create a scoped package in the pnpm virtual store. */
function addScopedPnpmPackage(
  storeEntryName: string,
  scope: string,
  name: string,
  files: Record<string, string> = { "index.js": `module.exports = "${scope}/${name}";` },
): string {
  return addPnpmPackage(storeEntryName, `${scope}/${name}`, files);
}

function standaloneDir(): string {
  return tmp("standalone");
}

function targetNodeModules(): string {
  return tmp("standalone", "apps", "web", "node_modules");
}

beforeEach(() => {
  tmpRoot = path.join(os.tmpdir(), `flatten-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(tmp("standalone", "apps", "web"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// flattenPnpmStandaloneDeps
// ---------------------------------------------------------------------------

describe("flattenPnpmStandaloneDeps", () => {
  it("copies non-scoped packages to flat node_modules (basic correctness)", () => {
    addPnpmPackage("react@19.0.0", "react", {
      "index.js": "module.exports = 'react';",
      "package.json": '{"name":"react"}',
    });

    const result = flattenPnpmStandaloneDeps(standaloneDir());

    expect(result.skipped).toBe(false);
    expect(result.copied).toBeGreaterThanOrEqual(1);

    const reactIndex = path.join(targetNodeModules(), "react", "index.js");
    expect(existsSync(reactIndex)).toBe(true);
    expect(readFileSync(reactIndex, "utf-8")).toBe("module.exports = 'react';");
  });

  it("places scoped packages at @scope/name path (prevents broken scoped imports)", () => {
    addScopedPnpmPackage("@swc+helpers@0.5.15", "@swc", "helpers", {
      "index.js": "module.exports = 'swc-helpers';",
    });

    flattenPnpmStandaloneDeps(standaloneDir());

    const helperIndex = path.join(targetNodeModules(), "@swc", "helpers", "index.js");
    expect(existsSync(helperIndex)).toBe(true);
    expect(readFileSync(helperIndex, "utf-8")).toBe("module.exports = 'swc-helpers';");
  });

  it("dereferences non-scoped symlinks into real files (prevents 'fetch failed' on user machines)", () => {
    addPnpmPackage("zzz-real-source@1.0.0", "my-dep", {
      "index.js": "real-content",
    });

    addPnpmPackage("aaa-consumer@1.0.0", "aaa-consumer");
    addPnpmSymlink("aaa-consumer@1.0.0", "my-dep", "zzz-real-source@1.0.0", "my-dep");

    flattenPnpmStandaloneDeps(standaloneDir());

    const flatDep = path.join(targetNodeModules(), "my-dep");
    expect(existsSync(flatDep)).toBe(true);
    expect(lstatSync(flatDep).isSymbolicLink()).toBe(false);
    expect(lstatSync(flatDep).isDirectory()).toBe(true);
    expect(readFileSync(path.join(flatDep, "index.js"), "utf-8")).toBe("real-content");
  });

  it("dereferences scoped symlinks into real directories (prevents broken @scope imports)", () => {
    addScopedPnpmPackage("zzz-real-scope@1.0.0", "@next", "env", {
      "index.js": "env-real",
    });

    addPnpmPackage("aaa-consumer@1.0.0", "aaa-consumer");
    addScopedPnpmSymlink("aaa-consumer@1.0.0", "@next", "env", "zzz-real-scope@1.0.0");

    flattenPnpmStandaloneDeps(standaloneDir());

    const flatEnv = path.join(targetNodeModules(), "@next", "env");
    expect(existsSync(flatEnv)).toBe(true);
    expect(lstatSync(flatEnv).isSymbolicLink()).toBe(false);
    expect(lstatSync(flatEnv).isDirectory()).toBe(true);
    expect(readFileSync(path.join(flatEnv, "index.js"), "utf-8")).toBe("env-real");
  });

  it("first-write-wins deduplication keeps earliest copy (stable output across store entries)", () => {
    addPnpmPackage("alpha@1.0.0", "shared-dep", { "index.js": "FIRST" });
    addPnpmPackage("beta@2.0.0", "shared-dep", { "index.js": "SECOND" });

    flattenPnpmStandaloneDeps(standaloneDir());

    const content = readFileSync(
      path.join(targetNodeModules(), "shared-dep", "index.js"),
      "utf-8",
    );
    expect(["FIRST", "SECOND"]).toContain(content);

    const entries = readdirSync(targetNodeModules()).filter((e) => e === "shared-dep");
    expect(entries).toHaveLength(1);
  });

  it("removes root node_modules after flattening (prevents stale pnpm symlinks in npm tarball)", () => {
    addPnpmPackage("react@19.0.0", "react");

    const rootNm = tmp("standalone", "node_modules");
    expect(existsSync(rootNm)).toBe(true);

    flattenPnpmStandaloneDeps(standaloneDir());

    expect(existsSync(rootNm)).toBe(false);
  });

  it("skips gracefully when no pnpm store exists (non-pnpm setups)", () => {
    mkdirSync(tmp("standalone", "node_modules"), { recursive: true });

    const result = flattenPnpmStandaloneDeps(standaloneDir());

    expect(result.skipped).toBe(true);
    expect(result.copied).toBe(0);
  });

  it("skips gracefully when standalone node_modules is entirely absent", () => {
    const result = flattenPnpmStandaloneDeps(standaloneDir());

    expect(result.skipped).toBe(true);
    expect(result.copied).toBe(0);
  });

  it("skips store entries that have no node_modules subdirectory (malformed entries)", () => {
    const malformedEntry = tmp("standalone", "node_modules", ".pnpm", "broken@1.0.0");
    mkdirSync(malformedEntry, { recursive: true });
    writeFileSync(path.join(malformedEntry, "package.json"), "{}", "utf-8");

    addPnpmPackage("react@19.0.0", "react");

    const result = flattenPnpmStandaloneDeps(standaloneDir());
    expect(result.copied).toBe(1);
    expect(existsSync(path.join(targetNodeModules(), "react"))).toBe(true);
  });

  it("clears pre-existing app node_modules before flattening (prevents stale leftover packages)", () => {
    const staleDir = path.join(targetNodeModules(), "stale-pkg");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(path.join(staleDir, "index.js"), "STALE", "utf-8");

    addPnpmPackage("react@19.0.0", "react");

    flattenPnpmStandaloneDeps(standaloneDir());

    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(path.join(targetNodeModules(), "react"))).toBe(true);
  });

  it("handles mixed scoped and non-scoped packages in a single store entry (next's deps)", () => {
    addPnpmPackage("next@15.0.0", "next");
    addScopedPnpmPackage("next@15.0.0", "@next", "env");
    addScopedPnpmPackage("next@15.0.0", "@swc", "helpers");

    flattenPnpmStandaloneDeps(standaloneDir());

    expect(existsSync(path.join(targetNodeModules(), "next", "index.js"))).toBe(true);
    expect(existsSync(path.join(targetNodeModules(), "@next", "env", "index.js"))).toBe(true);
    expect(existsSync(path.join(targetNodeModules(), "@swc", "helpers", "index.js"))).toBe(true);
  });

  it("merges multiple scoped packages under same scope from different store entries (prevents @scope dedup loss)", () => {
    addScopedPnpmPackage("@next+env@15.0.0", "@next", "env", {
      "index.js": "env",
    });
    addScopedPnpmPackage("@next+swc-helpers@15.0.0", "@next", "swc-helpers", {
      "index.js": "swc-helpers",
    });

    flattenPnpmStandaloneDeps(standaloneDir());

    expect(existsSync(path.join(targetNodeModules(), "@next", "env", "index.js"))).toBe(true);
    expect(existsSync(path.join(targetNodeModules(), "@next", "swc-helpers", "index.js"))).toBe(
      true,
    );
    expect(readFileSync(path.join(targetNodeModules(), "@next", "env", "index.js"), "utf-8")).toBe(
      "env",
    );
    expect(
      readFileSync(path.join(targetNodeModules(), "@next", "swc-helpers", "index.js"), "utf-8"),
    ).toBe("swc-helpers");
  });

  it("preserves nested file structure within packages (multi-file packages survive)", () => {
    addPnpmPackage("next@15.0.0", "next", {
      "package.json": '{"name":"next"}',
      "index.js": "entry",
      "dist/server/lib/start-server.js": "startServer()",
      "dist/server/lib/utils.js": "utils()",
    });

    flattenPnpmStandaloneDeps(standaloneDir());

    const nextDir = path.join(targetNodeModules(), "next");
    expect(readFileSync(path.join(nextDir, "package.json"), "utf-8")).toBe('{"name":"next"}');
    expect(readFileSync(path.join(nextDir, "dist/server/lib/start-server.js"), "utf-8")).toBe(
      "startServer()",
    );
  });
});

// ---------------------------------------------------------------------------
// installManagedWebRuntime — end-to-end with flattened source
// ---------------------------------------------------------------------------

describe("installManagedWebRuntime after flatten", () => {
  it("copies flattened node_modules as real directories to runtime dir (end-to-end fix for user installs)", () => {
    const packageRoot = tmp("package");
    const standaloneDir = path.join(packageRoot, "apps/web/.next/standalone");
    const standaloneAppDir = path.join(standaloneDir, "apps/web");

    mkdirSync(path.join(standaloneAppDir, "node_modules"), { recursive: true });
    writeFileSync(path.join(standaloneAppDir, "server.js"), "// server", "utf-8");

    addPnpmPackage("next@15.0.0", "next", { "index.js": "module.exports = 'next';" });

    const pnpmStore = tmp("standalone", "node_modules", ".pnpm");
    const targetPnpmStore = path.join(standaloneDir, "node_modules", ".pnpm");
    mkdirSync(path.dirname(targetPnpmStore), { recursive: true });
    cpSync(pnpmStore, targetPnpmStore, { recursive: true });

    flattenPnpmStandaloneDeps(standaloneDir);

    const stateDir = tmp("state");
    mkdirSync(stateDir, { recursive: true });

    const result = installManagedWebRuntime({
      stateDir,
      packageRoot,
      denchVersion: "2.0.0-test",
    });

    expect(result.installed).toBe(true);

    const copiedNext = path.join(result.runtimeAppDir, "node_modules", "next");
    expect(existsSync(copiedNext)).toBe(true);
    expect(lstatSync(copiedNext).isSymbolicLink()).toBe(false);
    expect(lstatSync(copiedNext).isDirectory()).toBe(true);
    expect(readFileSync(path.join(copiedNext, "index.js"), "utf-8")).toBe(
      "module.exports = 'next';",
    );
  });

  it("pnpm symlinks inside source survive cpSync even with dereference (documents Node.js limitation)", () => {
    const packageRoot = tmp("package");
    const standaloneAppDir = path.join(packageRoot, "apps/web/.next/standalone/apps/web");
    mkdirSync(path.join(standaloneAppDir, "node_modules"), { recursive: true });
    writeFileSync(path.join(standaloneAppDir, "server.js"), "// server", "utf-8");

    const realPkgDir = tmp("real-next-pkg");
    mkdirSync(realPkgDir, { recursive: true });
    writeFileSync(path.join(realPkgDir, "index.js"), "module.exports = 'next';", "utf-8");

    symlinkSync(realPkgDir, path.join(standaloneAppDir, "node_modules", "next"));

    const stateDir = tmp("state");
    mkdirSync(stateDir, { recursive: true });

    const result = installManagedWebRuntime({
      stateDir,
      packageRoot,
      denchVersion: "2.0.0-test",
    });

    expect(result.installed).toBe(true);
    const copiedNext = path.join(result.runtimeAppDir, "node_modules", "next");
    expect(lstatSync(copiedNext).isSymbolicLink()).toBe(true);
  });
});
