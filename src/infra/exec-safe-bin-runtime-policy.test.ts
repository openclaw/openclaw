import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isInterpreterLikeSafeBin,
  listInterpreterLikeSafeBins,
  resolveExecSafeBinRuntimePolicy,
  resolveMergedSafeBinProfileFixtures,
} from "./exec-safe-bin-runtime-policy.js";

// Mirror the runtime FS probe so test expectations match actual behavior.
function isCaseInsensitiveFs(): boolean {
  try {
    const tmpDir = os.tmpdir();
    const original = fsSync.statSync(tmpDir);
    const flipped = (() => {
      try {
        return fsSync.statSync(tmpDir.toUpperCase());
      } catch {
        return null;
      }
    })();
    if (!flipped) {
      return false;
    }
    return original.ino === flipped.ino && original.dev === flipped.dev;
  } catch {
    return false;
  }
}

const resolveTrusted = (p: string) =>
  isCaseInsensitiveFs() ? path.resolve(p).toLowerCase() : path.resolve(p);

describe("exec safe-bin runtime policy", () => {
  const interpreterCases: Array<{ bin: string; expected: boolean }> = [
    { bin: "python3", expected: true },
    { bin: "python3.12", expected: true },
    { bin: " C:\\Tools\\Python3.EXE ", expected: true },
    { bin: "node", expected: true },
    { bin: "node20", expected: true },
    { bin: "/usr/local/bin/node20", expected: true },
    { bin: "awk", expected: true },
    { bin: "/opt/homebrew/bin/gawk", expected: true },
    { bin: "mawk", expected: true },
    { bin: "nawk", expected: true },
    { bin: "sed", expected: true },
    { bin: "gsed", expected: true },
    { bin: "ruby3.2", expected: true },
    { bin: "bash", expected: true },
    { bin: "busybox", expected: true },
    { bin: "toybox", expected: true },
    { bin: "myfilter", expected: false },
    { bin: "jq", expected: false },
  ];

  for (const testCase of interpreterCases) {
    it(`classifies interpreter-like safe bin '${testCase.bin}'`, () => {
      expect(isInterpreterLikeSafeBin(testCase.bin)).toBe(testCase.expected);
    });
  }

  it("lists interpreter-like bins from a mixed set", () => {
    expect(
      listInterpreterLikeSafeBins([
        "jq",
        " C:\\Tools\\Python3.EXE ",
        "myfilter",
        "/usr/bin/node",
        "/opt/homebrew/bin/gawk",
      ]),
    ).toEqual(["gawk", "node", "python3"]);
  });

  it("merges and normalizes safe-bin profile fixtures", () => {
    const merged = resolveMergedSafeBinProfileFixtures({
      global: {
        safeBinProfiles: {
          " MyFilter ": {
            deniedFlags: ["--file", " --file ", ""],
          },
        },
      },
      local: {
        safeBinProfiles: {
          myfilter: {
            maxPositional: 0,
          },
        },
      },
    });
    expect(merged).toEqual({
      myfilter: {
        maxPositional: 0,
      },
    });
  });

  it("computes unprofiled interpreter entries separately from custom profiled bins", () => {
    const policy = resolveExecSafeBinRuntimePolicy({
      local: {
        safeBins: ["python3", "myfilter"],
        safeBinProfiles: {
          myfilter: { maxPositional: 0 },
        },
      },
    });

    expect(policy.safeBins.has("python3")).toBe(true);
    expect(policy.safeBins.has("myfilter")).toBe(true);
    expect(policy.unprofiledSafeBins).toEqual(["python3"]);
    expect(policy.unprofiledInterpreterSafeBins).toEqual(["python3"]);
  });

  it("prefers local safe bins over global ones when both are configured", () => {
    const policy = resolveExecSafeBinRuntimePolicy({
      global: {
        safeBins: ["python3", "jq"],
      },
      local: {
        safeBins: ["sort"],
      },
    });

    expect([...policy.safeBins]).toEqual(["sort"]);
  });

  it("merges explicit safe-bin trusted dirs from global and local config", () => {
    const customDir = path.join(path.sep, "custom", "bin");
    const agentDir = path.join(path.sep, "agent", "bin");
    const policy = resolveExecSafeBinRuntimePolicy({
      global: {
        safeBinTrustedDirs: [` ${customDir} `, customDir],
      },
      local: {
        safeBinTrustedDirs: [agentDir],
      },
    });

    expect(policy.trustedSafeBinDirs.has(resolveTrusted(customDir))).toBe(true);
    expect(policy.trustedSafeBinDirs.has(resolveTrusted(agentDir))).toBe(true);
  });

  it("does not trust package-manager bin dirs unless explicitly configured", () => {
    const defaultPolicy = resolveExecSafeBinRuntimePolicy({});
    expect(defaultPolicy.trustedSafeBinDirs.has(resolveTrusted("/opt/homebrew/bin"))).toBe(false);
    expect(defaultPolicy.trustedSafeBinDirs.has(resolveTrusted("/usr/local/bin"))).toBe(false);

    const optedIn = resolveExecSafeBinRuntimePolicy({
      global: {
        safeBinTrustedDirs: ["/opt/homebrew/bin", "/usr/local/bin"],
      },
    });
    expect(optedIn.trustedSafeBinDirs.has(resolveTrusted("/opt/homebrew/bin"))).toBe(true);
    expect(optedIn.trustedSafeBinDirs.has(resolveTrusted("/usr/local/bin"))).toBe(true);
  });

  it("emits runtime warning when explicitly trusted dir is writable", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-safe-bin-runtime-"));
    try {
      await fs.chmod(dir, 0o777);
      const onWarning = vi.fn();
      const policy = resolveExecSafeBinRuntimePolicy({
        global: {
          safeBinTrustedDirs: [dir],
        },
        onWarning,
      });

      expect(policy.writableTrustedSafeBinDirs).toEqual([
        {
          dir: resolveTrusted(dir),
          groupWritable: true,
          worldWritable: true,
        },
      ]);
      expect(onWarning).toHaveBeenCalledWith(expect.stringContaining(resolveTrusted(dir)));
      expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("world-writable"));
    } finally {
      await fs.chmod(dir, 0o755).catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
