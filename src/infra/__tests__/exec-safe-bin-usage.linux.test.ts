import { describe, expect, it } from "vitest";
import { isSafeBinUsage, normalizeSafeBins } from "../exec-approvals.js";
import { resolveSafeBinProfiles } from "../exec-safe-bin-policy.js";
import { resolveExecSafeBinRuntimePolicy } from "../exec-safe-bin-runtime-policy.js";

describe.runIf(process.platform !== "win32")("linux safe-bin usage contracts", () => {
  const trustedDir = "/trusted/bin";
  const profiledBin = "myfilter";
  const profiledPath = `${trustedDir}/${profiledBin}`;
  const safeBinProfiles = resolveSafeBinProfiles({
    [profiledBin]: { maxPositional: 1 },
  });

  it("requires a profiled safe bin from a trusted path with valid argv", () => {
    expect(
      isSafeBinUsage({
        argv: [profiledBin, "ok"],
        resolution: {
          rawExecutable: profiledBin,
          resolvedPath: profiledPath,
          executableName: profiledBin,
        },
        safeBins: normalizeSafeBins([profiledBin]),
        safeBinProfiles,
        trustedSafeBinDirs: new Set([trustedDir]),
      }),
    ).toBe(true);
  });

  it("fails when the resolved path is outside trusted safe-bin dirs", () => {
    expect(
      isSafeBinUsage({
        argv: [profiledBin, "ok"],
        resolution: {
          rawExecutable: profiledBin,
          resolvedPath: "/tmp/evil-bin/myfilter",
          executableName: profiledBin,
        },
        safeBins: normalizeSafeBins([profiledBin]),
        safeBinProfiles,
        trustedSafeBinDirs: new Set([trustedDir]),
      }),
    ).toBe(false);
  });

  it("fails when argv violates the real safe-bin profile", () => {
    expect(
      isSafeBinUsage({
        argv: [profiledBin, "ok", "extra"],
        resolution: {
          rawExecutable: profiledBin,
          resolvedPath: profiledPath,
          executableName: profiledBin,
        },
        safeBins: normalizeSafeBins([profiledBin]),
        safeBinProfiles,
        trustedSafeBinDirs: new Set([trustedDir]),
      }),
    ).toBe(false);
  });

  it("fails when a safeBins entry has no real profile", () => {
    expect(
      isSafeBinUsage({
        argv: ["python3", "-V"],
        resolution: {
          rawExecutable: "python3",
          resolvedPath: "/usr/bin/python3",
          executableName: "python3",
        },
        safeBins: normalizeSafeBins(["python3"]),
        trustedSafeBinDirs: new Set(["/usr/bin"]),
      }),
    ).toBe(false);
  });

  it("surfaces unprofiled safeBins in runtime policy", () => {
    const policy = resolveExecSafeBinRuntimePolicy({
      local: {
        safeBins: ["python3", profiledBin],
        safeBinProfiles: {
          [profiledBin]: { maxPositional: 1 },
        },
        safeBinTrustedDirs: [trustedDir],
      },
    });

    expect(policy.unprofiledSafeBins).toEqual(["python3"]);
    expect(policy.unprofiledInterpreterSafeBins).toEqual(["python3"]);
  });
});
