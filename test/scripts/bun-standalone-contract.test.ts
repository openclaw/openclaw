import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertStandaloneCompiler,
  assertStandalonePlatform,
  createStandaloneManifest,
  describeStandaloneRuntime,
  parseStandaloneArguments,
  relativeStandaloneEntry,
  resolveStandaloneBuildIdentity,
} from "../../scripts/lib/bun-standalone-contract.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.10.3";
const parse = (...flags: string[]) => parseStandaloneArguments(["out", ...flags]);
const identity = (info: Parameters<typeof resolveStandaloneBuildIdentity>[0]) =>
  resolveStandaloneBuildIdentity(info, version);
function fixture() {
  const root = tempDirs.make("openclaw-standalone-contract-");
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(runtime);
  return { root, runtime };
}

describe("standalone build interface", () => {
  it.each<[string[], string, string[], Record<string, unknown>]>([
    [[], "jit", [], {}],
    [["--bytecode"], "bytecode", ["--bytecode"], {}],
    [["--compile-aot"], "aot", ["--aot"], {}],
    [
      ["--plugins", "codex, slack,codex", "--bytecode"],
      "bytecode",
      ["--bytecode"],
      { pluginIds: ["codex", "slack"] },
    ],
    [
      ["--compile-aot", "--support-output", "support"],
      "aot",
      ["--aot"],
      { supportOutputDirectory: "support" },
    ],
  ])("parses standalone options %j", (flags, mode, compileFlags, extra) => {
    expect(parse(...flags)).toEqual({ outputDirectory: "out", mode, compileFlags, ...extra });
  });

  it.each<[string[], string]>([
    [["--bytecode", "--compile-aot"], "at most one"],
    [["--plugins"], "--plugins"],
    [["--plugins", "codex,"], "--plugins"],
    [["--plugins", "codex", "--plugins", "slack"], "--plugins"],
    [["--support-output", "support"], "requires --compile-aot"],
    [["--compile-aot", "--support-output", "one", "--support-output", "two"], "once"],
    [["--target=bun-linux-x64"], "AOT cannot cross-compile"],
  ])("rejects invalid standalone options %j", (flags, error) => {
    expect(() => parse(...flags)).toThrow(error);
  });

  it("requires an output directory", () => {
    expect(() => parseStandaloneArguments([])).toThrow("Usage:");
  });

  it("refuses experimental AOT on a compiler without that capability", () => {
    expect(() =>
      assertStandaloneCompiler("aot", "--compile  Build an executable\n--bytecode  Cache bytecode"),
    ).toThrow("Use the default JIT mode or --bytecode");
    expect(() => assertStandaloneCompiler("aot", "  --aot  Compile native code")).not.toThrow();
  });

  it("limits standalone artifacts to supported build hosts", () => {
    expect(() => assertStandalonePlatform("darwin")).not.toThrow();
    expect(() => assertStandalonePlatform("linux")).not.toThrow();
    expect(() => assertStandalonePlatform("linux", "riscv64")).toThrow("arm64 or x64");
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
      identity({ version, commit: "A".repeat(40), builtAt: "2026-10-14T00:00:00.000Z" }),
    ).toEqual({ version, commit: "a".repeat(40) });
  });

  it.each([
    undefined,
    { version: "", commit: "a".repeat(40) },
    { version, commit: null },
    { version, commit: "abc123" },
    { version: "2026.10.2", commit: "a".repeat(40) },
  ])("refuses missing, invalid, or mixed runtime provenance (%s)", (buildInfo) => {
    expect(() => identity(buildInfo)).toThrow("Run pnpm build");
  });

  it("describes the executable and deterministic sidecar without following links", async () => {
    const { root, runtime } = fixture();
    fs.writeFileSync(path.join(root, "openclaw"), "standalone\n");
    fs.writeFileSync(path.join(runtime, "a.js"), "export const value = 7;\n");
    fs.symlinkSync("a.js", path.join(runtime, "link"));
    const manifest = await createStandaloneManifest({
      outputRoot: root,
      mode: "jit",
      bun: { version: "1.4.3", revision: "1.4.3+fixture", executableSha256: "a".repeat(64) },
      openclaw: { version: "2026.10.3", commit: "b".repeat(40) },
      embedded: { modules: 4, plugins: 1, workers: 2, inlineWorkers: 0 },
      plugins: { embedded: ["slack", "codex"], omitted: ["signal", "matrix"] },
      sqlite: { version: "3.53.4" },
      pruning: { categories: {}, sidecarPlugins: [] },
    });
    expect(manifest).toMatchObject({
      executable: { path: "openclaw", sizeBytes: 11 },
      runtime: {
        path: "runtime",
        sizeBytes: 24,
        fileCount: 1,
        symlinkCount: 1,
      },
      plugins: { embedded: ["codex", "slack"], omitted: ["matrix", "signal"] },
    });
    expect(manifest.runtime.sha256).toBe(
      "c1763658d97365c3501098c7326f9a049ec6107223baaea9f96cdb19e7c6cf9a",
    );
    fs.writeFileSync(path.join(runtime, "a.js"), "changed\n");
    expect((await describeStandaloneRuntime(runtime)).sha256).not.toBe(manifest.runtime.sha256);
  });

  it.each(["dangling", "outside", "indirect-outside", "cycle", "absolute-inside"])(
    "rejects a %s runtime symlink before describing the sidecar",
    async (kind) => {
      const { root, runtime } = fixture();
      const outside = path.join(root, "outside");
      fs.writeFileSync(outside, "outside\n");
      const link = path.join(runtime, "link");
      const asset = path.join(runtime, "asset");
      fs.writeFileSync(asset, "asset\n");
      const target =
        kind === "dangling"
          ? "missing"
          : kind === "cycle"
            ? "link"
            : kind === "absolute-inside"
              ? asset
              : "../outside";
      if (kind === "indirect-outside") {
        const bridge = path.join(runtime, "bridge");
        fs.symlinkSync("../outside", bridge);
        fs.symlinkSync("bridge", link);
      } else {
        fs.symlinkSync(target, link);
      }
      await expect(describeStandaloneRuntime(runtime)).rejects.toThrow(
        "Invalid standalone runtime symlink",
      );
    },
  );

  it("allows contained directory links without counting their contents twice", async () => {
    const { runtime } = fixture();
    fs.mkdirSync(path.join(runtime, "assets"));
    fs.writeFileSync(path.join(runtime, "assets", "data"), "data");
    fs.symlinkSync("assets", path.join(runtime, "asset-link"));
    expect(await describeStandaloneRuntime(runtime)).toMatchObject({
      fileCount: 1,
      symlinkCount: 1,
      sizeBytes: 4,
    });
  });
});
