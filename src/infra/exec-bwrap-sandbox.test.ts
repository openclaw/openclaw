import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BuildBwrapArgsParams,
  buildBwrapArgs,
  normalizeBwrapExtraBinds,
  normalizeBwrapSandboxMode,
  resetBwrapCache,
} from "./exec-bwrap-sandbox.js";

afterEach(() => {
  resetBwrapCache();
});

describe("normalizeBwrapSandboxMode", () => {
  it("returns 'bwrap' for valid input", () => {
    expect(normalizeBwrapSandboxMode("bwrap")).toBe("bwrap");
    expect(normalizeBwrapSandboxMode("BWRAP")).toBe("bwrap");
    expect(normalizeBwrapSandboxMode(" bwrap ")).toBe("bwrap");
  });

  it("returns 'none' for invalid or missing input", () => {
    expect(normalizeBwrapSandboxMode("none")).toBe("none");
    expect(normalizeBwrapSandboxMode(undefined)).toBe("none");
    expect(normalizeBwrapSandboxMode(null)).toBe("none");
    expect(normalizeBwrapSandboxMode("")).toBe("none");
    expect(normalizeBwrapSandboxMode("docker")).toBe("none");
    expect(normalizeBwrapSandboxMode("chroot")).toBe("none");
  });
});

describe("normalizeBwrapExtraBinds", () => {
  it("normalizes valid entries", () => {
    const result = normalizeBwrapExtraBinds([
      { src: "/data", dest: "/mnt/data", writable: true },
      { src: "/opt/tools" },
    ]);
    expect(result).toEqual([
      { src: "/data", dest: "/mnt/data", writable: true },
      { src: "/opt/tools", dest: undefined, writable: false },
    ]);
  });

  it("skips invalid entries", () => {
    const result = normalizeBwrapExtraBinds([
      { src: "" },
      { src: 123 } as unknown as Record<string, unknown>,
      null as unknown as Record<string, unknown>,
      { src: "/valid" },
    ]);
    expect(result).toEqual([{ src: "/valid", dest: undefined, writable: false }]);
  });

  it("returns empty for null/undefined", () => {
    expect(normalizeBwrapExtraBinds(undefined)).toEqual([]);
    expect(normalizeBwrapExtraBinds(null)).toEqual([]);
  });
});

describe("buildBwrapArgs", () => {
  const defaultParams: BuildBwrapArgsParams = {
    safeBins: new Set(["curl", "jq"]),
    trustedSafeBinDirs: new Set(["/usr/bin"]),
    workdir: "/home/test/workspace",
  };

  it("starts with bwrap binary", () => {
    const args = buildBwrapArgs(defaultParams);
    expect(args[0]).toMatch(/bwrap$/);
  });

  it("includes shell binary mounts", () => {
    const args = buildBwrapArgs(defaultParams);
    const joined = args.join(" ");
    expect(joined).toContain("--ro-bind");
  });

  it("mounts safeBins binaries from trusted dirs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-"));
    const curlPath = path.join(tmpDir, "curl");
    const jqPath = path.join(tmpDir, "jq");
    fs.writeFileSync(curlPath, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(jqPath, "#!/bin/sh\n", { mode: 0o755 });

    try {
      const args = buildBwrapArgs({
        safeBins: new Set(["curl", "jq"]),
        trustedSafeBinDirs: new Set([tmpDir]),
        workdir: "/tmp/test",
      });

      const joined = args.join(" ");
      expect(joined).toContain(`--ro-bind ${curlPath} ${curlPath}`);
      expect(joined).toContain(`--ro-bind ${jqPath} ${jqPath}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("does not mount binaries not in safeBins", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-"));
    const curlPath = path.join(tmpDir, "curl");
    const rmPath = path.join(tmpDir, "rm");
    fs.writeFileSync(curlPath, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(rmPath, "#!/bin/sh\n", { mode: 0o755 });

    try {
      const args = buildBwrapArgs({
        safeBins: new Set(["curl"]),
        trustedSafeBinDirs: new Set([tmpDir]),
        workdir: "/tmp/test",
      });

      const joined = args.join(" ");
      expect(joined).toContain(`--ro-bind ${curlPath} ${curlPath}`);
      expect(joined).not.toContain(`--ro-bind ${rmPath} ${rmPath}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("mounts system library paths read-only", () => {
    const args = buildBwrapArgs(defaultParams);
    const joined = args.join(" ");
    if (fs.existsSync("/usr/lib")) {
      expect(joined).toContain("--ro-bind /usr/lib /usr/lib");
    }
  });

  it("mounts working directory read-write", () => {
    const args = buildBwrapArgs(defaultParams);
    const joined = args.join(" ");
    expect(joined).toContain("--bind /home/test/workspace /home/test/workspace");
  });

  it("includes namespace isolation flags", () => {
    const args = buildBwrapArgs(defaultParams);
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--share-net");
    expect(args).toContain("--die-with-parent");
  });

  it("includes pseudo-filesystems", () => {
    const args = buildBwrapArgs(defaultParams);
    const joined = args.join(" ");
    expect(joined).toContain("--proc /proc");
    expect(joined).toContain("--dev /dev");
    expect(joined).toContain("--tmpfs /tmp");
  });

  it("adds extra read-only bind mounts", () => {
    const args = buildBwrapArgs({
      ...defaultParams,
      extraBinds: [{ src: "/opt/data", writable: false }],
    });
    const joined = args.join(" ");
    expect(joined).toContain("--ro-bind /opt/data /opt/data");
  });

  it("adds extra writable bind mounts", () => {
    const args = buildBwrapArgs({
      ...defaultParams,
      extraBinds: [{ src: "/opt/output", writable: true }],
    });
    const joined = args.join(" ");
    expect(joined).toContain("--bind /opt/output /opt/output");
  });

  it("supports dest override in extra binds", () => {
    const args = buildBwrapArgs({
      ...defaultParams,
      extraBinds: [{ src: "/host/data", dest: "/sandbox/data" }],
    });
    const joined = args.join(" ");
    expect(joined).toContain("--ro-bind /host/data /sandbox/data");
  });

  it("resolves relative workdir to absolute", () => {
    const args = buildBwrapArgs({
      ...defaultParams,
      workdir: "relative/path",
    });
    const joined = args.join(" ");
    const resolved = path.resolve("relative/path");
    expect(joined).toContain(`--bind ${resolved} ${resolved}`);
  });

  it("does not duplicate shell binary mounts", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-test-"));
    const shPath = path.join(tmpDir, "sh");
    fs.writeFileSync(shPath, "#!/bin/sh\n", { mode: 0o755 });

    try {
      const args = buildBwrapArgs({
        safeBins: new Set(["sh"]),
        trustedSafeBinDirs: new Set([tmpDir]),
        workdir: "/tmp/test",
      });

      // Count occurrences: sh should appear exactly once as --ro-bind source
      const bindPairs: string[] = [];
      for (let i = 0; i < args.length - 2; i++) {
        if (args[i] === "--ro-bind" && args[i + 1] === shPath) {
          bindPairs.push(args[i + 2]);
        }
      }
      expect(bindPairs.length).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
