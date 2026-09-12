import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDirSync } from "../test-helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  evaluateRuntimeEligibility,
  hasBinary,
  isConfigPathTruthyWithDefaults,
} from "./config-eval.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it("caches binary lookups until PATH changes", () => {
    withTempDirSync({ prefix: "openclaw-binary-cache-" }, (root) => {
      mockProcessPlatform("linux");
      const missingDir = path.join(root, "missing");
      const foundDir = path.join(root, "found");
      const otherDir = path.join(root, "other");
      for (const dir of [missingDir, foundDir, otherDir]) {
        fs.mkdirSync(dir);
      }
      const executable = path.join(foundDir, "tool");
      fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(executable, 0o755);
      vi.stubEnv("PATH", [missingDir, foundDir].join(path.delimiter));

      expect(hasBinary("tool")).toBe(true);

      // The cached positive survives the binary disappearing under an unchanged PATH.
      fs.rmSync(executable);
      expect(hasBinary("tool")).toBe(true);

      vi.stubEnv("PATH", otherDir);
      expect(hasBinary("tool")).toBe(false);
    });
  });

  it("checks PATHEXT candidates and invalidates cached hits when PATHEXT changes", () => {
    withTempDirSync({ prefix: "openclaw-binary-pathext-" }, (toolsDir) => {
      mockProcessPlatform("win32");
      vi.stubEnv("PATH", toolsDir);
      vi.stubEnv("PATHEXT", ".EXE;.CMD");
      const cmdCandidate = path.join(toolsDir, "tool.CMD");
      fs.writeFileSync(cmdCandidate, "@exit 0\r\n");
      fs.chmodSync(cmdCandidate, 0o755);
      const accessSpy = vi.spyOn(fs, "accessSync");

      expect(hasBinary("tool")).toBe(true);
      // Candidates that are not regular files never reach the permission probe.
      expect(accessSpy.mock.calls.map(([candidate]) => String(candidate))).toEqual([cmdCandidate]);

      vi.stubEnv("PATHEXT", ".EXE");
      expect(hasBinary("tool")).toBe(false);
      vi.stubEnv("PATHEXT", ".CMD");
      expect(hasBinary("tool")).toBe(true);
    });
  });

  it.each([
    { platform: "linux", suffix: "" },
    { platform: "darwin", suffix: "" },
    { platform: "win32", suffix: ".CMD" },
  ] as const)(
    "finds a newly installed binary on unchanged $platform PATH",
    ({ platform, suffix }) => {
      withTempDirSync({ prefix: "openclaw-binary-probe-" }, (binDir) => {
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
      });
    },
  );

  it.each([
    { platform: "linux", suffix: "" },
    { platform: "darwin", suffix: "" },
    { platform: "win32", suffix: ".CMD" },
  ] as const)(
    "reports a $platform PATH directory named like the binary as missing",
    ({ platform, suffix }) => {
      withTempDirSync({ prefix: "openclaw-binary-dir-" }, (binDir) => {
        mockProcessPlatform(platform);
        vi.stubEnv("PATH", binDir);
        vi.stubEnv("PATHEXT", ".EXE;.CMD");
        const candidate = path.join(binDir, `fixture-tool${suffix}`);
        fs.mkdirSync(candidate);
        // A searchable directory passes X_OK, which is what used to make it look installed.
        expect(fs.accessSync(candidate, fs.constants.X_OK)).toBeUndefined();

        expect(hasBinary("fixture-tool")).toBe(false);
      });
    },
  );

  it("accepts a PATH symlink pointing at an executable file", () => {
    withTempDirSync({ prefix: "openclaw-binary-symlink-" }, (root) => {
      mockProcessPlatform("linux");
      const binDir = path.join(root, "bin");
      const targetDir = path.join(root, "target");
      fs.mkdirSync(binDir);
      fs.mkdirSync(targetDir);
      const target = path.join(targetDir, "fixture-tool");
      fs.writeFileSync(target, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(target, 0o755);
      fs.symlinkSync(target, path.join(binDir, "fixture-tool"));
      vi.stubEnv("PATH", binDir);

      expect(hasBinary("fixture-tool")).toBe(true);
    });
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
