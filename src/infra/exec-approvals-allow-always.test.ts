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

  function expectAllowAlwaysBypassBlocked(params: {
    dir: string;
    firstCommand: string;
    secondCommand: string;
    env: Record<string, string | undefined>;
    persistedPattern: string;
  }) {
    const safeBins = resolveSafeBins(undefined);
    const first = evaluateShellAllowlist({
      command: params.firstCommand,
      allowlist: [],
      safeBins,
      cwd: params.dir,
      env: params.env,
      platform: process.platform,
    });
    const persisted = resolveAllowAlwaysPatterns({
      segments: first.segments,
      cwd: params.dir,
      env: params.env,
      platform: process.platform,
    });
    expect(persisted).toEqual([params.persistedPattern]);

    const second = evaluateShellAllowlist({
      command: params.secondCommand,
      allowlist: [{ pattern: params.persistedPattern }],
      safeBins,
      cwd: params.dir,
      env: params.env,
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
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand: `${busybox} sh -c 'echo warmup-ok'`,
      secondCommand: `${busybox} sh -c 'id > marker'`,
      env,
      persistedPattern: echo,
    });
  });

  it("prevents allow-always bypass for dispatch-wrapper + shell-wrapper chains", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand: "/usr/bin/nice /bin/zsh -lc 'echo warmup-ok'",
      secondCommand: "/usr/bin/nice /bin/zsh -lc 'id > marker'",
      env,
      persistedPattern: echo,
    });
  });

  it("persists the script file path for shell+script invocations (bash scripts/foo.sh)", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    // Create a shell script file
    const scriptPath = path.join(dir, "scripts", "save_crystal.sh");
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(scriptPath, "#!/bin/bash\necho ok");
    fs.chmodSync(scriptPath, 0o755);

    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "bash scripts/save_crystal.sh",
          argv: ["bash", "scripts/save_crystal.sh"],
          resolution: {
            rawExecutable: "bash",
            resolvedPath: "/bin/bash",
            executableName: "bash",
          },
        },
      ],
      cwd: dir,
      env: process.env,
      platform: process.platform,
    });
    expect(patterns).toEqual([scriptPath]);
  });

  it("persists the script path when shell flags precede the script (sh -xe setup.sh)", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const scriptPath = path.join(dir, "setup.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho ok");
    fs.chmodSync(scriptPath, 0o755);

    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "sh -xe setup.sh",
          argv: ["sh", "-xe", "setup.sh"],
          resolution: {
            rawExecutable: "sh",
            resolvedPath: "/bin/sh",
            executableName: "sh",
          },
        },
      ],
      cwd: dir,
      env: process.env,
      platform: process.platform,
    });
    expect(patterns).toEqual([scriptPath]);
  });

  it("does NOT persist script path when shell uses -c inline command (not a script file)", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "echo");
    const env = makePathEnv(dir);
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "bash -c 'echo hello'",
          argv: ["bash", "-c", "echo hello"],
          resolution: {
            rawExecutable: "bash",
            resolvedPath: "/bin/bash",
            executableName: "bash",
          },
        },
      ],
      cwd: dir,
      env,
      platform: process.platform,
    });
    // Inline -c command: inner executable (echo) is persisted, not the script
    expect(patterns).not.toContain("/bin/bash");
  });
});

describe("evaluateShellAllowlist with shell+script allowlist entries", () => {
  it("satisfies allowlist when script path matches a stored entry (bash scripts/foo.sh)", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const scriptPath = path.join(dir, "scripts", "save_crystal.sh");
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(scriptPath, "#!/bin/bash\necho ok");
    fs.chmodSync(scriptPath, 0o755);

    const safeBins = resolveSafeBins(undefined);
    const result = evaluateShellAllowlist({
      command: "bash scripts/save_crystal.sh",
      allowlist: [{ id: "test-id", pattern: scriptPath }],
      safeBins,
      cwd: dir,
      env: process.env,
      platform: process.platform,
    });
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("round-trips allow-always for bash+script: persisted pattern satisfies the next run", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const scriptPath = path.join(dir, "scripts", "backup.sh");
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(scriptPath, "#!/bin/bash\necho ok");
    fs.chmodSync(scriptPath, 0o755);

    const safeBins = resolveSafeBins(undefined);
    const command = "bash scripts/backup.sh";

    // First run: no allowlist → not satisfied
    const first = evaluateShellAllowlist({
      command,
      allowlist: [],
      safeBins,
      cwd: dir,
      env: process.env,
      platform: process.platform,
    });
    expect(first.allowlistSatisfied).toBe(false);

    // Simulate "Always allow": persist the patterns
    const persisted = resolveAllowAlwaysPatterns({
      segments: first.segments,
      cwd: dir,
      env: process.env,
      platform: process.platform,
    });
    expect(persisted).toEqual([scriptPath]);

    // Second run: allowlist contains the script path → satisfied, no re-prompt
    const second = evaluateShellAllowlist({
      command,
      allowlist: persisted.map((p) => ({ id: "saved", pattern: p })),
      safeBins,
      cwd: dir,
      env: process.env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(true);
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: second.analysisOk,
        allowlistSatisfied: second.allowlistSatisfied,
      }),
    ).toBe(false);
  });
});
