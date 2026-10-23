import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  evaluateRuntimeEligibility,
  hasBinary,
  isConfigPathTruthyWithDefaults,
  prepareBinaryAvailability,
} from "./config-eval.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const truthy = (config: unknown, key: string) => isConfigPathTruthyWithDefaults(config, key, {});
const prepared = async (bin = "fixture-tool") =>
  (await prepareBinaryAvailability([bin])).hasBinary(bin);
function install(executable: string) {
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(executable, 0o755);
}

describe.each([
  { name: "synchronous", probe: hasBinary },
  {
    name: "prepared",
    probe: async (bin: string) => (await prepareBinaryAvailability([bin])).hasBinary(bin),
  },
])("$name binary file requirements", ({ probe }) => {
  it("rejects directories and continues to an executable in a later PATH entry", async () => {
    const root = tempDirs.make("openclaw-binary-file-");
    const directoryBin = path.join(root, "first");
    const executableBin = path.join(root, "second");
    fs.mkdirSync(path.join(directoryBin, "fixture-tool"), { recursive: true });
    fs.mkdirSync(executableBin);
    vi.stubEnv("PATH", [directoryBin, executableBin].join(path.delimiter));
    vi.stubEnv("PATHEXT", ".CMD");

    expect(await probe("fixture-tool")).toBe(false);

    const suffix = process.platform === "win32" ? ".CMD" : "";
    const executable = path.join(executableBin, `fixture-tool${suffix}`);
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(await probe("fixture-tool")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("accepts symlinks to executable files", async () => {
    const root = tempDirs.make("openclaw-binary-symlink-");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    const executable = path.join(root, "installed-tool");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.symlinkSync(executable, path.join(binDir, "fixture-tool"));
    vi.stubEnv("PATH", binDir);

    expect(await probe("fixture-tool")).toBe(true);
  });
});

describe("config-eval helpers", () => {
  it("normalizes truthy values across primitive types", () => {
    for (const [value, expected] of [
      [undefined, false],
      [null, false],
      [false, false],
      [true, true],
      [0, false],
      [1, true],
      ["   ", false],
      [" ok ", true],
      [{}, true],
    ] as const) {
      expect(truthy({ value }, "value")).toBe(expected);
    }
  });

  it("resolves nested config paths and missing branches safely", () => {
    const config = { browser: { enabled: true, nested: { count: 1 } } };
    expect(truthy(config, "browser.enabled")).toBe(true);
    expect(truthy(config, ".browser..nested.count.")).toBe(true);
    expect(truthy(config, "browser.missing.value")).toBe(false);
    expect(truthy("not-an-object", "browser.enabled")).toBe(false);
  });

  it("blocks prototype keys while resolving config paths", () => {
    const config = { safe: { enabled: true } };
    expect(truthy(config, "safe.enabled")).toBe(true);
    expect(truthy(config, "__proto__")).toBe(false);
    expect(truthy(config, "constructor.name")).toBe(false);
    expect(truthy(config, "prototype.polluted")).toBe(false);
  });

  it("does not use inherited defaults for blocked config paths", () => {
    expect(isConfigPathTruthyWithDefaults({}, "constructor", {})).toBe(false);
    expect(isConfigPathTruthyWithDefaults({}, "__proto__.enabled", {})).toBe(false);
    expect(isConfigPathTruthyWithDefaults({}, "prototype.enabled", {})).toBe(false);
  });

  it("returns the active runtime platform", () => {
    mockProcessPlatform("darwin");
    expect(
      evaluateRuntimeEligibility({
        os: ["darwin"],
        hasBin: () => true,
        hasEnv: () => true,
        isConfigPathTruthy: () => true,
      }),
    ).toBe(true);
  });

  it("caches successful binary lookups until PATH changes", () => {
    mockProcessPlatform("linux");
    const binDir = tempDirs.make("openclaw-binary-cache-");
    const missingDir = path.join(binDir, "missing");
    const executable = path.join(binDir, "tool");
    install(executable);
    vi.stubEnv("PATH", [missingDir, binDir].join(path.delimiter));

    expect(hasBinary("tool")).toBe(true);
    fs.unlinkSync(executable);
    expect(hasBinary("tool")).toBe(true);

    vi.stubEnv("PATH", missingDir);
    expect(hasBinary("tool")).toBe(false);
  });

  it("checks PATHEXT candidates and invalidates cached hits when PATHEXT changes", () => {
    mockProcessPlatform("win32");
    const toolsDir = tempDirs.make("openclaw-binary-pathext-");
    vi.stubEnv("PATH", toolsDir);
    vi.stubEnv("PATHEXT", ".EXE;.CMD");
    const cmdCandidate = path.join(toolsDir, "tool.CMD");
    install(cmdCandidate);

    expect(hasBinary("tool")).toBe(true);

    vi.stubEnv("PATHEXT", ".EXE");
    expect(hasBinary("tool")).toBe(false);
    vi.stubEnv("PATHEXT", ".CMD");
    expect(hasBinary("tool")).toBe(true);
  });

  it.each([
    { platform: "linux", suffix: "" },
    { platform: "win32", suffix: ".CMD" },
  ] as const)(
    "finds a newly installed binary on unchanged $platform PATH",
    ({ platform, suffix }) => {
      const binDir = tempDirs.make("openclaw-binary-probe-");
      mockProcessPlatform(platform);
      vi.stubEnv("PATH", binDir);
      vi.stubEnv("PATHEXT", ".EXE;.CMD");
      expect(hasBinary("fixture-tool")).toBe(false);

      const executable = path.join(binDir, `fixture-tool${suffix}`);
      install(executable);

      expect(hasBinary("fixture-tool")).toBe(true);
    },
  );
});

describe("prepared binary availability", () => {
  it("sees installations and removals even after a synchronous lookup cached the binary", async () => {
    const binDir = tempDirs.make("openclaw-prepared-binary-");
    vi.stubEnv("PATH", binDir);
    const executable = path.join(binDir, "fixture-tool");
    expect(await prepared()).toBe(false);
    install(executable);
    expect(hasBinary("fixture-tool")).toBe(true);
    expect(await prepared()).toBe(true);
    fs.unlinkSync(executable);
    expect(await prepared()).toBe(false);
    expect(hasBinary("fixture-tool")).toBe(true);
    vi.stubEnv("PATH", path.join(binDir, "other"));
    expect(hasBinary("fixture-tool")).toBe(false);
  });

  it("keeps filesystem lookup semantics for nested binary names", async () => {
    const binDir = tempDirs.make("openclaw-prepared-nested-");
    fs.mkdirSync(path.join(binDir, "nested"));
    const executable = path.join(binDir, "nested", "fixture-tool");
    install(executable);
    vi.stubEnv("PATH", binDir);
    const bin = path.join("nested", "fixture-tool");
    expect(await prepared(bin)).toBe(true);
    expect(hasBinary(bin)).toBe(true);
  });

  it("bounds environment reads when missing binaries expand across PATH and PATHEXT", async () => {
    mockProcessPlatform("win32");
    const root = tempDirs.make("openclaw-prepared-freshness-");
    const pathEntries = Array.from({ length: 30 }, (_, index) =>
      path.join(root, `missing-${index}`),
    );
    vi.stubEnv("PATH", pathEntries.join(path.delimiter));
    vi.stubEnv("PATHEXT", ".EXE;.CMD;.BAT;.COM");
    const cwdSpy = vi.spyOn(process, "cwd");
    const facts = await prepareBinaryAvailability(["missing-tool-a", "missing-tool-b"]);
    expect(facts.hasBinary("missing-tool-a")).toBe(false);
    expect(facts.hasBinary("missing-tool-b")).toBe(false);
    expect(cwdSpy.mock.calls.length).toBeLessThan(20);
  });
});

describe("evaluateRuntimeEligibility", () => {
  it("bypasses runtime requirements when always=true", () => {
    const result = evaluateRuntimeEligibility({
      always: true,
      requires: { env: ["OPENAI_API_KEY"] },
      hasBin: () => false,
      hasEnv: () => false,
      isConfigPathTruthy: () => false,
    });
    expect(result).toBe(true);
  });

  it("evaluates runtime requirements when always is false", () => {
    const result = evaluateRuntimeEligibility({
      requires: {
        bins: ["node"],
        anyBins: ["bun", "node"],
        env: ["OPENAI_API_KEY"],
        config: ["browser.enabled"],
      },
      hasBin: (bin) => bin === "node",
      hasAnyRemoteBin: () => false,
      hasEnv: (name) => name === "OPENAI_API_KEY",
      isConfigPathTruthy: (pathLocal) => pathLocal === "browser.enabled",
    });
    expect(result).toBe(true);
  });
});
