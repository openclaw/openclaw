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
    [
      ["--compile-aot"],
      "aot",
      ["--aot", "--aot-allow-code-from-disk"],
      { aotCompileOptions: { allowCodeFromDisk: true } },
    ],
    [
      ["--aot-source"],
      "aot",
      ["--aot", "--aot-allow-code-from-disk"],
      { source: true, aotCompileOptions: { allowCodeFromDisk: true } },
    ],
    [
      ["--plugins", "codex, slack,codex", "--bytecode"],
      "bytecode",
      ["--bytecode"],
      { pluginIds: ["codex", "slack"] },
    ],
    [
      ["--compile-aot", "--support-output", "support"],
      "aot",
      ["--aot", "--aot-allow-code-from-disk"],
      { supportOutputDirectory: "support", aotCompileOptions: { allowCodeFromDisk: true } },
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
    [["--aot-source", "--support-output", "support"], "requires --compile-aot"],
    [["--support-output", "support", "--aot-source"], "requires --compile-aot"],
    [["--compile-aot", "--support-output", "one", "--support-output", "two"], "once"],
    [["--target=bun-linux-x64"], "AOT cannot cross-compile"],
  ])("rejects invalid standalone options %j", (flags, error) => {
    expect(() => parse(...flags)).toThrow(error);
  });

  it("requires an output directory", () => {
    expect(() => parseStandaloneArguments([])).toThrow("Usage:");
  });
  it("defaults to JIT and selects exactly one explicit compilation mode", () => {
    expect(parseStandaloneArguments(["out"])).toEqual({
      outputDirectory: "out",
      mode: "jit",
      compileFlags: [],
    });
    for (const [flag, mode] of Object.entries({
      "--bytecode": "bytecode",
      "--compile-aot": "aot",
    })) {
      const parsed = parseStandaloneArguments(["out", flag]);
      if (parsed.help) {
        throw new Error("A build mode must not request help");
      }
      expect(parsed.mode).toBe(mode);
    }
    expect(() => parseStandaloneArguments(["out", "--bytecode", "--compile-aot"])).toThrow(
      "at most one",
    );
    expect(() => parseStandaloneArguments(["out", "--unknown"])).toThrow("at most one");
    expect(() => parseStandaloneArguments([])).toThrow("Usage:");
  });

  it("limits type-mismatch logging to AOT and accepts either option order", () => {
    for (const flags of [
      ["--compile-aot", "--aot-log-type-mismatches"],
      ["--aot-log-type-mismatches", "--compile-aot"],
    ]) {
      expect(parseStandaloneArguments(["out", ...flags])).toEqual({
        outputDirectory: "out",
        mode: "aot",
        compileFlags: ["--aot", "--aot-log-type-mismatches", "--aot-allow-code-from-disk"],
        aotCompileOptions: { aotLogTypeMismatches: true, allowCodeFromDisk: true },
      });
    }
    expect(() => parseStandaloneArguments(["out", "--aot-log-type-mismatches"])).toThrow(
      "requires --compile-aot",
    );
    expect(() =>
      parseStandaloneArguments(["out", "--bytecode", "--aot-log-type-mismatches"]),
    ).toThrow("requires --compile-aot");
    expect(() =>
      parseStandaloneArguments(["out", "--compile-aot", "--aot-type-errors=log"]),
    ).toThrow("Unknown option");
  });

  it("selects original TypeScript without changing the emitted-JavaScript AOT mode", () => {
    expect(parseStandaloneArguments(["out", "--aot-source", "--aot-log-type-mismatches"])).toEqual({
      outputDirectory: "out",
      mode: "aot",
      source: true,
      compileFlags: ["--aot", "--aot-log-type-mismatches", "--aot-allow-code-from-disk"],
      aotCompileOptions: { aotLogTypeMismatches: true, allowCodeFromDisk: true },
    });
    expect(() => parseStandaloneArguments(["out", "--compile-aot", "--aot-source"])).toThrow(
      "at most one",
    );
  });

  it.each(["--compile-aot", "--aot-source"])(
    "maps trim, reports, and hardening to both compiler interfaces with %s",
    (mode) => {
      const parsed = parseStandaloneArguments([
        "out",
        "--trim-locales",
        "en,de",
        "--explain",
        "--explain=statistics",
        "--explain=trim",
        "--trim",
        "--no-compile-function-source",
        "--disallow-code-generation-from-strings=strict",
        mode,
      ]);
      expect(parsed).toMatchObject({
        mode: "aot",
        compileFlags: [
          "--aot",
          "--trim-locales=en,de",
          "--explain",
          "--explain=statistics",
          "--explain=trim",
          "--trim",
          "--no-compile-function-source",
          "--disallow-code-generation-from-strings=strict",
          "--aot-allow-code-from-disk",
        ],
        aotCompileOptions: {
          trim: { locales: ["en", "de"] },
          aotExplain: ["text", "statistics", "trim"],
          functionSource: false,
          disallowCodeGenerationFromStrings: "strict",
        },
      });
      expect("source" in parsed).toBe(mode === "--aot-source");
    },
  );

  it("preserves the non-strict string-code policy and plain trimming", () => {
    expect(
      parseStandaloneArguments([
        "out",
        "--compile-aot",
        "--trim",
        "--disallow-code-generation-from-strings",
      ]),
    ).toMatchObject({
      aotCompileOptions: { trim: true, disallowCodeGenerationFromStrings: true },
    });
  });

  it.each(["--compile-aot", "--aot-source"])(
    "forwards compiler analysis opt-outs with %s",
    (mode) => {
      expect(
        parse("--aot-disable", "flow-results", mode, "--aot-disable=pass:PlaceTypeTests"),
      ).toMatchObject({
        mode: "aot",
        compileFlags: [
          "--aot",
          "--aot-disable=flow-results",
          "--aot-disable=pass:PlaceTypeTests",
          "--aot-allow-code-from-disk",
        ],
        aotCompileOptions: { aotDisable: ["flow-results", "pass:PlaceTypeTests"] },
      });
    },
  );

  it.each(["--compile-aot", "--aot-source"])(
    "normalizes retained trim features with %s",
    (mode) => {
      for (const flags of [
        ["--trim-allow", "run,jit,run", "--trim-locales=en,de"],
        ["--trim-locales=en,de", "--trim-allow=jit,run"],
        ["--trim", "--trim-allow=run", "--trim-allow=jit", "--trim-locales=en,de"],
      ]) {
        const parsed = parseStandaloneArguments(["out", mode, ...flags]);
        expect(parsed).toMatchObject({
          aotCompileOptions: { trim: { allow: ["run", "jit"], locales: ["en", "de"] } },
        });
        if (!parsed.help) {
          expect(parsed.compileFlags.filter((flag) => flag.startsWith("--trim-allow="))).toEqual([
            "--trim-allow=run,jit",
          ]);
        }
      }
      expect(parseStandaloneArguments(["out", mode, "--trim-allow=run"])).toMatchObject({
        aotCompileOptions: { trim: { allow: ["run"] } },
      });
    },
  );

  it.each([
    ["--trim"],
    ["--explain"],
    ["--no-compile-function-source"],
    ["--disallow-code-generation-from-strings=strict"],
    ["--bytecode", "--trim"],
    ["--trim-allow=run"],
    ["--bytecode", "--trim-allow=run,jit"],
    ["--aot-disable=flow-results"],
    ["--bytecode", "--aot-disable=flow-results"],
  ])("requires AOT for compiler options %j", (...flags) => {
    expect(() => parseStandaloneArguments(["out", ...flags])).toThrow("requires --compile-aot");
  });

  it.each([
    ["--trim", "--trim"],
    ["--no-compile-function-source", "--no-compile-function-source"],
    ["--aot-log-type-mismatches", "--aot-log-type-mismatches"],
    ["--disallow-code-generation-from-strings", "--disallow-code-generation-from-strings=strict"],
    ["--disallow-code-generation-from-strings=invalid"],
    ["--trim-locales"],
    ["--trim-locales=en,"],
    ["--trim-locales=en"],
    ["--trim-allow"],
    ["--trim-allow="],
    ["--trim-allow=run,"],
    ["--trim-allow=ffi"],
    ["--explain="],
    ["--aot-disable"],
    ["--aot-disable="],
    ["--aot-disable=flow-results,"],
    ["--aot-disable", "--trim"],
  ])("rejects incomplete or repeated AOT options %j", (...flags) => {
    expect(() => parseStandaloneArguments(["out", "--compile-aot", ...flags])).toThrow();
  });

  it("accepts one plugin list independently of the compilation mode", () => {
    for (const flags of [
      ["--plugins", "codex, slack,codex", "--bytecode"],
      ["--bytecode", "--plugins", "codex,slack"],
    ]) {
      expect(parseStandaloneArguments(["out", ...flags])).toEqual({
        outputDirectory: "out",
        mode: "bytecode",
        compileFlags: ["--bytecode"],
        pluginIds: ["codex", "slack"],
      });
    }
    for (const flags of [
      ["--plugins"],
      ["--plugins", ""],
      ["--plugins", "codex,"],
      ["--plugins", "--bytecode"],
      ["--plugins", "codex", "--plugins", "slack"],
    ]) {
      expect(() => parseStandaloneArguments(["out", ...flags])).toThrow("--plugins");
    }
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
      bun: { version: "1.4.4", revision: "1.4.4+fixture", executableSha256: "a".repeat(64) },
      openclaw: { version: "2026.10.3", commit: "b".repeat(40) },
      embedded: { modules: 4, plugins: 1, workers: 2, inlineWorkers: 0 },
      plugins: { embedded: ["slack", "codex"], omitted: ["signal", "matrix"] },
      pluginContract: {
        schemaVersion: 1,
        sdk: {
          "openclaw/plugin-sdk/core": { source: "dist/plugin-sdk/core.js", entry: "/image/core" },
        },
        plugins: {},
      },
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
      plugins: {
        embedded: ["codex", "slack"],
        omitted: ["matrix", "signal"],
        contract: {
          schemaVersion: 1,
          sdk: {
            "openclaw/plugin-sdk/core": { source: "dist/plugin-sdk/core.js", entry: "/image/core" },
          },
          plugins: {},
        },
      },
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
