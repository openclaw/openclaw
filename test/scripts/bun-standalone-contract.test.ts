import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertStandaloneCompiler,
  assertStandalonePlatform,
  createStandaloneManifest,
  describeStandaloneRuntime,
  parseStandaloneArguments,
  pruneStandaloneRuntime,
  relativeStandaloneEntry,
  resolveStandaloneBuildIdentity,
} from "../../scripts/lib/bun-standalone-contract.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-standalone-contract-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "runtime"));
  return root;
}

describe("standalone build interface", () => {
  it("defaults to JIT and selects exactly one explicit compilation mode", () => {
    expect(parseStandaloneArguments(["out"])).toEqual({
      outputDirectory: "out",
      mode: "jit",
      compileFlags: [],
    });
    expect(parseStandaloneArguments(["out", "--bytecode"]).mode).toBe("bytecode");
    expect(parseStandaloneArguments(["out", "--compile-aot"]).mode).toBe("aot");
    expect(() => parseStandaloneArguments(["out", "--bytecode", "--compile-aot"])).toThrow(
      "at most one",
    );
    expect(() => parseStandaloneArguments(["out", "--unknown"])).toThrow("at most one");
    expect(() => parseStandaloneArguments([])).toThrow("Usage:");
  });

  it("refuses experimental AOT on a compiler without that capability", () => {
    expect(() =>
      assertStandaloneCompiler("aot", "--compile  Build an executable\n--bytecode  Cache bytecode"),
    ).toThrow("Use the default JIT mode or --bytecode");
    expect(() =>
      assertStandaloneCompiler("aot", "  --compile-aot  Compile native code"),
    ).not.toThrow();
  });

  it("limits standalone artifacts to supported build hosts", () => {
    expect(() => assertStandalonePlatform("darwin")).not.toThrow();
    expect(() => assertStandalonePlatform("linux")).not.toThrow();
    expect(() => assertStandalonePlatform("win32")).toThrow(
      "Build on macOS or Linux; Windows standalone artifacts are not supported yet.",
    );
  });

  it.each([
    ["/build/runtime", "/build/runtime/dist/worker.js", "dist/worker.js"],
    ["/build/runtime", "/build/runtime/dist/../worker.js", "worker.js"],
    ["/build/runtime", "/build/runtime-other/dist/worker.js", undefined],
    ["/build/runtime", "/build/runtime/../worker.js", undefined],
    ["/build/runtime", "/build/runtime", undefined],
    ["/build/runtime", "dist/worker.js", undefined],
  ])("maps contained runtime paths to POSIX entry keys (%s, %s)", (root, filename, expected) => {
    expect(relativeStandaloneEntry(root, filename)).toBe(expected);
  });

  it("normalizes canonical runtime provenance", () => {
    expect(
      resolveStandaloneBuildIdentity(
        { version: "2026.10.3", commit: "A".repeat(40), builtAt: "2026-10-14T00:00:00.000Z" },
        "2026.10.3",
      ),
    ).toEqual({ version: "2026.10.3", commit: "a".repeat(40) });
  });

  it.each([
    [undefined, "2026.10.3"],
    [{ version: "", commit: "a".repeat(40) }, "2026.10.3"],
    [{ version: "2026.10.3", commit: null }, "2026.10.3"],
    [{ version: "2026.10.3", commit: "abc123" }, "2026.10.3"],
    [{ version: "2026.10.2", commit: "a".repeat(40) }, "2026.10.3"],
  ])("refuses missing, invalid, or mixed runtime provenance (%s)", (buildInfo, packageVersion) => {
    expect(() => resolveStandaloneBuildIdentity(buildInfo, packageVersion)).toThrow(
      "Run pnpm build",
    );
  });

  it("prunes declarations and maps while preserving runtime assets and links", () => {
    const root = fixture();
    const runtime = path.join(root, "runtime");
    for (const name of [
      "a.js",
      "a.js.map",
      "a.d.ts",
      "a.d.mts",
      "a.d.cts",
      "addon.node",
      "package.json",
    ]) {
      fs.writeFileSync(path.join(runtime, name), "123");
    }
    fs.symlinkSync("a.js", path.join(runtime, "linked.js.map"));
    expect(pruneStandaloneRuntime(runtime)).toEqual({
      patterns: ["**/*.map", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts"],
      removedFiles: 4,
      removedBytes: 12,
    });
    expect(
      fs.readdirSync(runtime).toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    ).toEqual(["a.js", "addon.node", "linked.js.map", "package.json"]);
  });

  it("describes the executable and deterministic sidecar without following links", async () => {
    const root = fixture();
    const runtime = path.join(root, "runtime");
    fs.writeFileSync(path.join(root, "openclaw"), "standalone\n");
    fs.writeFileSync(path.join(runtime, "a.js"), "export const value = 7;\n");
    fs.symlinkSync("a.js", path.join(runtime, "link"));
    const manifest = await createStandaloneManifest({
      outputRoot: root,
      mode: "jit",
      bun: { version: "1.4.3", revision: "1.4.3+fixture", executableSha256: "a".repeat(64) },
      openclaw: { version: "2026.10.3", commit: "b".repeat(40) },
      embedded: { modules: 4, plugins: 1, workers: 2, inlineWorkers: 0 },
      pruning: { patterns: [], removedFiles: 0, removedBytes: 0 },
    });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      mode: "jit",
      executable: { path: "openclaw", sizeBytes: 11 },
      runtime: { path: "runtime", sizeBytes: 24, fileCount: 1, symlinkCount: 1 },
      embedded: { modules: 4, plugins: 1, workers: 2, inlineWorkers: 0 },
    });
    expect(manifest.runtime.sha256).toBe(
      "c1763658d97365c3501098c7326f9a049ec6107223baaea9f96cdb19e7c6cf9a",
    );
    fs.writeFileSync(path.join(runtime, "a.js"), "changed\n");
    expect((await describeStandaloneRuntime(runtime)).sha256).not.toBe(manifest.runtime.sha256);
  });
});
