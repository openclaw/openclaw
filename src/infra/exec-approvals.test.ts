import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  matchAllowlist,
  maxAsk,
  minSecurity,
  resolveCommandResolution,
  resolveExecApprovals,
  type ExecAllowlistEntry,
} from "./exec-approvals.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-exec-approvals-"));
}

describe("exec approvals allowlist matching", () => {
  it("matches by executable name (case-insensitive)", () => {
    const resolution = {
      rawExecutable: "rg",
      resolvedPath: "/opt/homebrew/bin/rg",
      executableName: "rg",
    };
    const entries: ExecAllowlistEntry[] = [{ pattern: "RG" }];
    const match = matchAllowlist(entries, resolution);
    expect(match?.pattern).toBe("RG");
  });

  it("matches by resolved path with **", () => {
    const resolution = {
      rawExecutable: "rg",
      resolvedPath: "/opt/homebrew/bin/rg",
      executableName: "rg",
    };
    const entries: ExecAllowlistEntry[] = [{ pattern: "/opt/**/rg" }];
    const match = matchAllowlist(entries, resolution);
    expect(match?.pattern).toBe("/opt/**/rg");
  });

  it("does not let * cross path separators", () => {
    const resolution = {
      rawExecutable: "rg",
      resolvedPath: "/opt/homebrew/bin/rg",
      executableName: "rg",
    };
    const entries: ExecAllowlistEntry[] = [{ pattern: "/opt/*/rg" }];
    const match = matchAllowlist(entries, resolution);
    expect(match).toBeNull();
  });

  it("falls back to raw executable when no resolved path", () => {
    const resolution = {
      rawExecutable: "bin/rg",
      resolvedPath: undefined,
      executableName: "rg",
    };
    const entries: ExecAllowlistEntry[] = [{ pattern: "bin/rg" }];
    const match = matchAllowlist(entries, resolution);
    expect(match?.pattern).toBe("bin/rg");
  });
});

describe("exec approvals command resolution", () => {
  it("resolves PATH executables", () => {
    const dir = makeTempDir();
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const exe = path.join(binDir, "rg");
    fs.writeFileSync(exe, "");
    const res = resolveCommandResolution("rg -n foo", undefined, { PATH: binDir });
    expect(res?.resolvedPath).toBe(exe);
    expect(res?.executableName).toBe("rg");
  });

  it("resolves relative paths against cwd", () => {
    const dir = makeTempDir();
    const cwd = path.join(dir, "project");
    const script = path.join(cwd, "scripts", "run.sh");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "");
    const res = resolveCommandResolution("./scripts/run.sh --flag", cwd, undefined);
    expect(res?.resolvedPath).toBe(script);
  });

  it("parses quoted executables", () => {
    const dir = makeTempDir();
    const cwd = path.join(dir, "project");
    const script = path.join(cwd, "bin", "tool");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "");
    const res = resolveCommandResolution('"./bin/tool" --version', cwd, undefined);
    expect(res?.resolvedPath).toBe(script);
  });
});

describe("exec approvals policy helpers", () => {
  it("minSecurity returns the more restrictive value", () => {
    expect(minSecurity("deny", "full")).toBe("deny");
    expect(minSecurity("allowlist", "full")).toBe("allowlist");
  });

  it("maxAsk returns the more aggressive ask mode", () => {
    expect(maxAsk("off", "always")).toBe("always");
    expect(maxAsk("on-miss", "off")).toBe("on-miss");
  });
});

describe("exec approvals wildcard agent", () => {
  it("merges wildcard allowlist entries with agent entries", () => {
    const dir = makeTempDir();
    const oldHome = process.env.HOME;
    process.env.HOME = dir;

    const approvalsPath = path.join(dir, ".clawdbot", "exec-approvals.json");
    fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
    fs.writeFileSync(
      approvalsPath,
      JSON.stringify(
        {
          version: 1,
          agents: {
            "*": { allowlist: [{ pattern: "/bin/hostname" }] },
            main: { allowlist: [{ pattern: "/usr/bin/uname" }] },
          },
        },
        null,
        2,
      ),
    );

    const resolved = resolveExecApprovals("main");
    expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual([
      "/bin/hostname",
      "/usr/bin/uname",
    ]);

    process.env.HOME = oldHome;
  });
});
