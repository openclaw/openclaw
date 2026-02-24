import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  evaluateShellAllowlist,
  requiresExecApproval,
  resolveAllowAlwaysPatterns,
  resolveSafeBins,
} from "./exec-approvals.js";

describe("resolveAllowAlwaysPatterns", () => {
  function makeExecutable(dir: string, name: string): string {
    const fileName = process.platform === "win32" ? `${name}.exe` : name;
    const exe = path.join(dir, fileName);
    fs.writeFileSync(exe, "");
    fs.chmodSync(exe, 0o755);
    return exe;
  }

  it("returns direct executable paths for non-shell segments", () => {
    const exe = path.join("/tmp", "openclaw-tool");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: exe,
          argv: [exe],
          resolution: { rawExecutable: exe, resolvedPath: exe, executableName: "openclaw-tool" },
        },
      ],
    });
    expect(patterns).toEqual([exe]);
  });

  it("unwraps shell wrappers and persists the inner executable instead", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "/bin/zsh -lc 'whoami'",
          argv: ["/bin/zsh", "-lc", "whoami"],
          resolution: {
            rawExecutable: "/bin/zsh",
            resolvedPath: "/bin/zsh",
            executableName: "zsh",
          },
        },
      ],
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
    });
    expect(patterns).toEqual([whoami]);
    expect(patterns).not.toContain("/bin/zsh");
  });

  it("extracts all inner binaries from shell chains and deduplicates", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const ls = makeExecutable(dir, "ls");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "/bin/zsh -lc 'whoami && ls && whoami'",
          argv: ["/bin/zsh", "-lc", "whoami && ls && whoami"],
          resolution: {
            rawExecutable: "/bin/zsh",
            resolvedPath: "/bin/zsh",
            executableName: "zsh",
          },
        },
      ],
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
    });
    expect(new Set(patterns)).toEqual(new Set([whoami, ls]));
  });

  it("does not persist broad shell binaries when no inner command can be derived", () => {
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "/bin/zsh -s",
          argv: ["/bin/zsh", "-s"],
          resolution: {
            rawExecutable: "/bin/zsh",
            resolvedPath: "/bin/zsh",
            executableName: "zsh",
          },
        },
      ],
      platform: process.platform,
    });
    expect(patterns).toEqual([]);
  });

  it("detects shell wrappers even when unresolved executableName is a full path", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "/usr/local/bin/zsh -lc whoami",
          argv: ["/usr/local/bin/zsh", "-lc", "whoami"],
          resolution: {
            rawExecutable: "/usr/local/bin/zsh",
            resolvedPath: undefined,
            executableName: "/usr/local/bin/zsh",
          },
        },
      ],
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
    });
    expect(patterns).toEqual([whoami]);
  });

  it("unwraps known dispatch wrappers before shell wrappers", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "/usr/bin/nice /bin/zsh -lc whoami",
          argv: ["/usr/bin/nice", "/bin/zsh", "-lc", "whoami"],
          resolution: {
            rawExecutable: "/usr/bin/nice",
            resolvedPath: "/usr/bin/nice",
            executableName: "nice",
          },
        },
      ],
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
    });
    expect(patterns).toEqual([whoami]);
    expect(patterns).not.toContain("/usr/bin/nice");
  });

  it("unwraps busybox/toybox shell applets and persists inner executables", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = makeExecutable(dir, "busybox");
    makeExecutable(dir, "toybox");
    const whoami = makeExecutable(dir, "whoami");
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: `${busybox} sh -lc whoami`,
          argv: [busybox, "sh", "-lc", "whoami"],
          resolution: {
            rawExecutable: busybox,
            resolvedPath: busybox,
            executableName: "busybox",
          },
        },
      ],
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(patterns).toEqual([whoami]);
    expect(patterns).not.toContain(busybox);
  });

  it("fails closed for unsupported busybox/toybox applets", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = makeExecutable(dir, "busybox");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: `${busybox} sed -n 1p`,
          argv: [busybox, "sed", "-n", "1p"],
          resolution: {
            rawExecutable: busybox,
            resolvedPath: busybox,
            executableName: "busybox",
          },
        },
      ],
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
    });
    expect(patterns).toEqual([]);
  });

  it("fails closed for unresolved dispatch wrappers", () => {
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "sudo /bin/zsh -lc whoami",
          argv: ["sudo", "/bin/zsh", "-lc", "whoami"],
          resolution: {
            rawExecutable: "sudo",
            resolvedPath: "/usr/bin/sudo",
            executableName: "sudo",
          },
        },
      ],
      platform: process.platform,
    });
    expect(patterns).toEqual([]);
  });

  it("prevents allow-always bypass for busybox shell applets", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = makeExecutable(dir, "busybox");
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const safeBins = resolveSafeBins(undefined);
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };

    const first = evaluateShellAllowlist({
      command: `${busybox} sh -c 'echo warmup-ok'`,
      allowlist: [],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    const persisted = resolveAllowAlwaysPatterns({
      segments: first.segments,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(persisted).toEqual([echo]);

    const second = evaluateShellAllowlist({
      command: `${busybox} sh -c 'id > marker'`,
      allowlist: [{ pattern: echo }],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(false);
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: second.analysisOk,
        allowlistSatisfied: second.allowlistSatisfied,
      }),
    ).toBe(true);
  });

  it("prevents allow-always bypass for dispatch-wrapper + shell-wrapper chains", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const safeBins = resolveSafeBins(undefined);
    const env = makePathEnv(dir);

    const first = evaluateShellAllowlist({
      command: "/usr/bin/nice /bin/zsh -lc 'echo warmup-ok'",
      allowlist: [],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    const persisted = resolveAllowAlwaysPatterns({
      segments: first.segments,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(persisted).toEqual([echo]);

    const second = evaluateShellAllowlist({
      command: "/usr/bin/nice /bin/zsh -lc 'id > marker'",
      allowlist: [{ pattern: echo }],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(false);
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: second.analysisOk,
        allowlistSatisfied: second.allowlistSatisfied,
      }),
    ).toBe(true);
  });
});
