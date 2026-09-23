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
      expect(isConfigPathTruthyWithDefaults({ value }, "value", {})).toBe(expected);
    }
  });

  it("resolves nested config paths and missing branches safely", () => {
    const config = {
      browser: {
        enabled: true,
        nested: {
          count: 1,
        },
      },
    };

    expect(isConfigPathTruthyWithDefaults(config, "browser.enabled", {})).toBe(true);
    expect(isConfigPathTruthyWithDefaults(config, ".browser..nested.count.", {})).toBe(true);
    expect(isConfigPathTruthyWithDefaults(config, "browser.missing.value", {})).toBe(false);
    expect(isConfigPathTruthyWithDefaults("not-an-object", "browser.enabled", {})).toBe(false);
  });

  it("blocks prototype keys while resolving config paths", () => {
    const config = {
      safe: {
        enabled: true,
      },
    };

    expect(isConfigPathTruthyWithDefaults(config, "safe.enabled", {})).toBe(true);
    expect(isConfigPathTruthyWithDefaults(config, "__proto__", {})).toBe(false);
    expect(isConfigPathTruthyWithDefaults(config, "constructor.name", {})).toBe(false);
    expect(isConfigPathTruthyWithDefaults(config, "prototype.polluted", {})).toBe(false);
  });

  it("uses defaults only when config paths are unresolved", () => {
    const config = {
      browser: {
        enabled: false,
      },
    };

    expect(
      isConfigPathTruthyWithDefaults(config, "browser.enabled", { "browser.enabled": true }),
    ).toBe(false);
    expect(
      isConfigPathTruthyWithDefaults(config, "browser.missing", { "browser.missing": true }),
    ).toBe(true);
    expect(isConfigPathTruthyWithDefaults(config, "browser.other", {})).toBe(false);
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
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(executable, 0o755);
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
    fs.writeFileSync(cmdCandidate, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(cmdCandidate, 0o755);

    expect(hasBinary("tool")).toBe(true);

    vi.stubEnv("PATHEXT", ".EXE");
    expect(hasBinary("tool")).toBe(false);
    vi.stubEnv("PATHEXT", ".CMD");
    expect(hasBinary("tool")).toBe(true);
  });

  it.each([
    { platform: "linux", suffix: "" },
    { platform: "darwin", suffix: "" },
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
      fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(executable, 0o755);

      expect(process.env.PATH).toBe(binDir);
      expect(process.env.PATHEXT).toBe(".EXE;.CMD");
      expect(hasBinary("fixture-tool")).toBe(true);
    },
  );
});

describe("prepared binary availability", () => {
  it("sees an installation on the next operation while preserving successful cache reuse", async () => {
    const binDir = tempDirs.make("openclaw-prepared-binary-");
    vi.stubEnv("PATH", binDir);
    const executable = path.join(binDir, "fixture-tool");
    expect((await prepareBinaryAvailability(["fixture-tool"])).hasBinary("fixture-tool")).toBe(
      false,
    );
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(executable, 0o755);
    expect((await prepareBinaryAvailability(["fixture-tool"])).hasBinary("fixture-tool")).toBe(
      true,
    );
    fs.unlinkSync(executable);
    expect(hasBinary("fixture-tool")).toBe(true);
    vi.stubEnv("PATH", path.join(binDir, "other"));
    expect(hasBinary("fixture-tool")).toBe(false);
  });

  it("does not publish an awaited hit into a different PATH cache", async () => {
    const binDir = tempDirs.make("openclaw-prepared-path-");
    const executable = path.join(binDir, "fixture-tool");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(executable, 0o755);
    vi.stubEnv("PATH", binDir);
    const pending = prepareBinaryAvailability(["fixture-tool"]);
    vi.stubEnv("PATH", path.join(binDir, "other"));
    expect(hasBinary("fixture-tool")).toBe(false);
    expect((await pending).isCurrent()).toBe(false);
    expect(hasBinary("fixture-tool")).toBe(false);
  });

  it("invalidates prepared PATHEXT candidates without changing synchronous successful-hit semantics", async () => {
    mockProcessPlatform("win32");
    const binDir = tempDirs.make("openclaw-prepared-pathext-");
    const executable = path.join(binDir, "fixture-tool.CMD");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(executable, 0o755);
    vi.stubEnv("PATH", binDir);
    vi.stubEnv("PATHEXT", undefined);
    const pending = prepareBinaryAvailability(["fixture-tool"]);
    vi.stubEnv("PATHEXT", "");
    expect((await pending).isCurrent()).toBe(false);
    expect(hasBinary("fixture-tool")).toBe(false);
    vi.stubEnv("PATHEXT", ".CMD");
    expect((await prepareBinaryAvailability(["fixture-tool"])).hasBinary("fixture-tool")).toBe(
      true,
    );
  });

  it("keeps filesystem lookup semantics for nested binary names", async () => {
    const binDir = tempDirs.make("openclaw-prepared-nested-");
    fs.mkdirSync(path.join(binDir, "nested"));
    const executable = path.join(binDir, "nested", "fixture-tool");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(executable, 0o755);
    vi.stubEnv("PATH", binDir);
    const bin = path.join("nested", "fixture-tool");
    expect((await prepareBinaryAvailability([bin])).hasBinary(bin)).toBe(true);
    expect(hasBinary(bin)).toBe(true);
  });
});

describe("runtime requirements through eligibility", () => {
  it("accepts remote bins and remote any-bin matches", () => {
    const result = evaluateRuntimeEligibility({
      requires: {
        bins: ["node"],
        anyBins: ["bun", "deno"],
        env: ["OPENAI_API_KEY"],
        config: ["browser.enabled"],
      },
      hasBin: () => false,
      hasRemoteBin: (bin) => bin === "node",
      hasAnyRemoteBin: (bins) => bins.includes("deno"),
      hasEnv: (name) => name === "OPENAI_API_KEY",
      isConfigPathTruthy: (pathValue) => pathValue === "browser.enabled",
    });

    expect(result).toBe(true);
  });

  it("rejects when any required runtime check is still unsatisfied", () => {
    expect(
      evaluateRuntimeEligibility({
        requires: { bins: ["node"] },
        hasBin: () => false,
        hasEnv: () => true,
        isConfigPathTruthy: () => true,
      }),
    ).toBe(false);

    expect(
      evaluateRuntimeEligibility({
        requires: { anyBins: ["bun", "node"] },
        hasBin: () => false,
        hasAnyRemoteBin: () => false,
        hasEnv: () => true,
        isConfigPathTruthy: () => true,
      }),
    ).toBe(false);
  });
});

describe("evaluateRuntimeEligibility", () => {
  it("rejects entries when required OS does not match local or remote", () => {
    const result = evaluateRuntimeEligibility({
      os: ["definitely-not-a-runtime-platform"],
      remotePlatforms: [],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(false);
  });

  it("accepts entries when remote platform satisfies OS requirements", () => {
    mockProcessPlatform("darwin");
    const result = evaluateRuntimeEligibility({
      os: ["linux"],
      remotePlatforms: ["linux"],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
  });

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
