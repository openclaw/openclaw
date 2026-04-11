import { describe, expect, it } from "vitest";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "../exec-approvals-test-helpers.js";
import {
  evaluateExecAllowlist,
  normalizeSafeBins,
  type ExecutableResolution,
} from "../exec-approvals.js";

function buildSegment(params: {
  argv: string[];
  executable: ExecutableResolution;
  effectiveArgv?: string[];
}) {
  return {
    raw: params.argv.join(" "),
    argv: params.argv,
    resolution: makeMockCommandResolution({
      execution: params.executable,
      effectiveArgv: params.effectiveArgv,
    }),
  };
}

describe.runIf(process.platform !== "win32")("linux exec allowlist path contracts", () => {
  const resolvedPython = "/home/fancymatt/.nvm/versions/node/v22.22.1/bin/python3";

  it("does not let a bare-name allowlist pattern match a resolved executable path", () => {
    const segment = buildSegment({
      argv: ["python3", "-V"],
      executable: makeMockExecutableResolution({
        rawExecutable: "python3",
        resolvedPath: resolvedPython,
        executableName: "python3",
      }),
    });

    const result = evaluateExecAllowlist({
      analysis: { ok: true, segments: [segment] },
      allowlist: [{ pattern: "python3", source: "allow-always" }],
      safeBins: normalizeSafeBins([]),
      cwd: "/tmp",
      platform: "linux",
    });

    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentAllowlistEntries).toEqual([null]);
  });

  it("matches a resolved executable path against path/glob allowlist patterns", () => {
    const segment = buildSegment({
      argv: ["python3", "-V"],
      executable: makeMockExecutableResolution({
        rawExecutable: "python3",
        resolvedPath: resolvedPython,
        executableName: "python3",
      }),
    });

    const result = evaluateExecAllowlist({
      analysis: { ok: true, segments: [segment] },
      allowlist: [{ pattern: "/home/fancymatt/.nvm/**", source: "allow-always" }],
      safeBins: normalizeSafeBins([]),
      cwd: "/tmp",
      platform: "linux",
    });

    expect(result.allowlistSatisfied).toBe(true);
    expect(result.segmentAllowlistEntries[0]).toMatchObject({ pattern: "/home/fancymatt/.nvm/**" });
  });

  it("matches a direct absolute invocation against the same path rule", () => {
    const segment = buildSegment({
      argv: [resolvedPython, "-V"],
      executable: makeMockExecutableResolution({
        rawExecutable: resolvedPython,
        resolvedPath: resolvedPython,
        executableName: "python3",
      }),
    });

    const result = evaluateExecAllowlist({
      analysis: { ok: true, segments: [segment] },
      allowlist: [{ pattern: "/home/fancymatt/.nvm/**", source: "allow-always" }],
      safeBins: normalizeSafeBins([]),
      cwd: "/tmp",
      platform: "linux",
    });

    expect(result.allowlistSatisfied).toBe(true);
    expect(result.segmentAllowlistEntries[0]).toMatchObject({ pattern: "/home/fancymatt/.nvm/**" });
  });
});
