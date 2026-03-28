import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
  sanitizeHostExecEnv,
  sanitizeHostExecEnvWithDiagnostics,
  sanitizeSystemRunEnvOverrides,
} from "./host-env-security.js";
import { OPENCLAW_CLI_ENV_VALUE } from "./openclaw-exec-env.js";

function getSystemGitPath() {
  if (process.platform === "win32") {
    return null;
  }
  const gitPath = "/usr/bin/git";
  return fs.existsSync(gitPath) ? gitPath : null;
}

function clearMarker(marker: string) {
  try {
    fs.unlinkSync(marker);
  } catch {
    // no-op
  }
}

async function runGitLsRemote(gitPath: string, target: string, env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve) => {
    const child = spawn(gitPath, ["ls-remote", target], { env, stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

async function runGitCommand(
  gitPath: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
) {
  await new Promise<void>((resolve) => {
    const child = spawn(gitPath, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: "ignore",
    });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

async function runGitClone(
  gitPath: string,
  source: string,
  destination: string,
  env: NodeJS.ProcessEnv,
) {
  await runGitCommand(gitPath, ["clone", source, destination], { env });
}

describe("isDangerousHostEnvVarName", () => {
  it("matches dangerous keys and prefixes case-insensitively", () => {
    expect(isDangerousHostEnvVarName("BASH_ENV")).toBe(true);
    expect(isDangerousHostEnvVarName("bash_env")).toBe(true);
    expect(isDangerousHostEnvVarName("SHELL")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_EXTERNAL_DIFF")).toBe(true);
    expect(isDangerousHostEnvVarName("git_exec_path")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_TEMPLATE_DIR")).toBe(true);
    expect(isDangerousHostEnvVarName("git_template_dir")).toBe(true);
    expect(isDangerousHostEnvVarName("SHELLOPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("ps4")).toBe(true);
    expect(isDangerousHostEnvVarName("DYLD_INSERT_LIBRARIES")).toBe(true);
    expect(isDangerousHostEnvVarName("ld_preload")).toBe(true);
    expect(isDangerousHostEnvVarName("BASH_FUNC_echo%%")).toBe(true);
    expect(isDangerousHostEnvVarName("JAVA_TOOL_OPTIONS")).toBe(true);
    expect(isDangerousHostEnvVarName("java_tool_options")).toBe(true);
    expect(isDangerousHostEnvVarName("_JAVA_OPTIONS")).toBe(true);
    expect(isDangerousHostEnvVarName("_java_options")).toBe(true);
    expect(isDangerousHostEnvVarName("JDK_JAVA_OPTIONS")).toBe(true);
    expect(isDangerousHostEnvVarName("jdk_java_options")).toBe(true);
    expect(isDangerousHostEnvVarName("PYTHONBREAKPOINT")).toBe(true);
    expect(isDangerousHostEnvVarName("pythonbreakpoint")).toBe(true);
    expect(isDangerousHostEnvVarName("DOTNET_STARTUP_HOOKS")).toBe(true);
    expect(isDangerousHostEnvVarName("dotnet_startup_hooks")).toBe(true);
    expect(isDangerousHostEnvVarName("DOTNET_ADDITIONAL_DEPS")).toBe(true);
    expect(isDangerousHostEnvVarName("dotnet_additional_deps")).toBe(true);
    expect(isDangerousHostEnvVarName("GLIBC_TUNABLES")).toBe(true);
    expect(isDangerousHostEnvVarName("glibc_tunables")).toBe(true);
    expect(isDangerousHostEnvVarName("MAVEN_OPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("maven_opts")).toBe(true);
    expect(isDangerousHostEnvVarName("SBT_OPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("sbt_opts")).toBe(true);
    expect(isDangerousHostEnvVarName("GRADLE_OPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("gradle_opts")).toBe(true);
    expect(isDangerousHostEnvVarName("ANT_OPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("ant_opts")).toBe(true);
    expect(isDangerousHostEnvVarName("AWS_CONFIG_FILE")).toBe(false);
    expect(isDangerousHostEnvVarName("aws_config_file")).toBe(false);
    expect(isDangerousHostEnvVarName("PATH")).toBe(false);
    expect(isDangerousHostEnvVarName("FOO")).toBe(false);
    expect(isDangerousHostEnvVarName("GRADLE_USER_HOME")).toBe(false);
  });
});

describe("sanitizeHostExecEnv", () => {
  it("removes dangerous inherited keys while preserving PATH", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        BASH_ENV: "/tmp/pwn.sh",
        GIT_EXTERNAL_DIFF: "/tmp/pwn.sh",
        GIT_TEMPLATE_DIR: "/tmp/git-template",
        AWS_CONFIG_FILE: "/tmp/aws-config",
        LD_PRELOAD: "/tmp/pwn.so",
        OK: "1",
      },
    });

    expect(env).toEqual({
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
      PATH: "/usr/bin:/bin",
      AWS_CONFIG_FILE: "/tmp/aws-config",
      OK: "1",
    });
  });

  it("blocks PATH and dangerous override values", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        HOME: "/tmp/trusted-home",
        ZDOTDIR: "/tmp/trusted-zdotdir",
      },
      overrides: {
        PATH: "/tmp/evil",
        HOME: "/tmp/evil-home",
        ZDOTDIR: "/tmp/evil-zdotdir",
        BASH_ENV: "/tmp/pwn.sh",
        GIT_SSH_COMMAND: "touch /tmp/pwned",
        GIT_EXEC_PATH: "/tmp/git-exec-path",
        EDITOR: "/tmp/editor",
        NPM_CONFIG_USERCONFIG: "/tmp/npmrc",
        GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
        AWS_CONFIG_FILE: "/tmp/override-aws-config",
        SHELLOPTS: "xtrace",
        PS4: "$(touch /tmp/pwned)",
        CLASSPATH: "/tmp/evil-classpath",
        GOFLAGS: "-mod=mod",
        PHPRC: "/tmp/evil-php.ini",
        XDG_CONFIG_HOME: "/tmp/evil-config",
        SAFE: "ok",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.GIT_TEMPLATE_DIR).toBeUndefined();
    expect(env.AWS_CONFIG_FILE).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_EXEC_PATH).toBeUndefined();
    expect(env.EDITOR).toBeUndefined();
    expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env.SHELLOPTS).toBeUndefined();
    expect(env.PS4).toBeUndefined();
    expect(env.CLASSPATH).toBeUndefined();
    expect(env.GOFLAGS).toBeUndefined();
    expect(env.PHPRC).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.SAFE).toBe("ok");
    expect(env.HOME).toBe("/tmp/trusted-home");
    expect(env.ZDOTDIR).toBe("/tmp/trusted-zdotdir");
  });

  it("drops dangerous inherited shell trace keys", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        SHELLOPTS: "xtrace",
        PS4: "$(touch /tmp/pwned)",
        OK: "1",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(env.OK).toBe("1");
    expect(env.SHELLOPTS).toBeUndefined();
    expect(env.PS4).toBeUndefined();
  });

  it("drops non-portable env key names", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides: {
        " BAD KEY": "x",
        "NOT-PORTABLE": "x",
        GOOD_KEY: "ok",
      },
    });

    expect(env.GOOD_KEY).toBe("ok");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(env[" BAD KEY"]).toBeUndefined();
    expect(env["NOT-PORTABLE"]).toBeUndefined();
  });

  it("can allow PATH overrides when explicitly opted out of blocking", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides: {
        PATH: "/custom/bin",
      },
      blockPathOverrides: false,
    });

    expect(env.PATH).toBe("/custom/bin");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
  });

  it("drops non-string inherited values while preserving non-portable inherited keys", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        GOOD: "1",
        // oxlint-disable-next-line typescript/no-explicit-any
        BAD_NUMBER: 1 as any,
        "NOT-PORTABLE": "x",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
      },
    });

    expect(env).toEqual({
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
      PATH: "/usr/bin:/bin",
      GOOD: "1",
      "NOT-PORTABLE": "x",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
  });

  it("strips provider auth env vars from inherited host env case-insensitively", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        OPENAI_API_KEY: "openai-secret",
        anthropic_api_key: "anthropic-secret",
        SAFE: "1",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.anthropic_api_key).toBeUndefined();
    expect(env.SAFE).toBe("1");
  });
});

describe("isDangerousHostEnvOverrideVarName", () => {
  it("matches override-only blocked keys case-insensitively", () => {
    expect(isDangerousHostEnvOverrideVarName("HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("zdotdir")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GIT_SSH_COMMAND")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("editor")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("NPM_CONFIG_USERCONFIG")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("git_config_global")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GRADLE_USER_HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("gradle_user_home")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CLASSPATH")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("classpath")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GOFLAGS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("goflags")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CORECLR_PROFILER_PATH")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("coreclr_profiler_path")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("XDG_CONFIG_HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("xdg_config_home")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("AWS_CONFIG_FILE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("aws_config_file")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("BASH_ENV")).toBe(false);
    expect(isDangerousHostEnvOverrideVarName("FOO")).toBe(false);
  });
});

describe("sanitizeHostExecEnvWithDiagnostics", () => {
  it("reports blocked and invalid requested overrides", () => {
    const result = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides: {
        PATH: "/tmp/evil",
        CLASSPATH: "/tmp/evil-classpath",
        SAFE_KEY: "ok",
        "BAD-KEY": "bad",
      },
    });

    expect(result.rejectedOverrideBlockedKeys).toEqual(["CLASSPATH", "PATH"]);
    expect(result.rejectedOverrideInvalidKeys).toEqual(["BAD-KEY"]);
    expect(result.env.SAFE_KEY).toBe("ok");
    expect(result.env.PATH).toBe("/usr/bin:/bin");
    expect(result.env.CLASSPATH).toBeUndefined();
  });

  it("allows Windows-style override names while still rejecting invalid keys", () => {
    const result = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
      },
      overrides: {
        "ProgramFiles(x86)": "D:\\SDKs",
        "BAD-KEY": "bad",
      },
    });

    expect(result.rejectedOverrideBlockedKeys).toEqual([]);
    expect(result.rejectedOverrideInvalidKeys).toEqual(["BAD-KEY"]);
    expect(result.env["ProgramFiles(x86)"]).toBe("D:\\SDKs");
  });
});

describe("normalizeEnvVarKey", () => {
  it("normalizes and validates keys", () => {
    expect(normalizeEnvVarKey(" OPENROUTER_API_KEY ")).toBe("OPENROUTER_API_KEY");
    expect(normalizeEnvVarKey("NOT-PORTABLE", { portable: true })).toBeNull();
    expect(normalizeEnvVarKey(" BASH_FUNC_echo%% ")).toBe("BASH_FUNC_echo%%");
    expect(normalizeEnvVarKey("   ")).toBeNull();
  });
});

describe("sanitizeSystemRunEnvOverrides", () => {
  it("keeps overrides for non-shell commands", () => {
    const overrides = sanitizeSystemRunEnvOverrides({
      shellWrapper: false,
      overrides: {
        OPENCLAW_TEST: "1",
        TOKEN: "abc",
      },
    });
    expect(overrides).toEqual({
      OPENCLAW_TEST: "1",
      TOKEN: "abc",
    });
  });

  it("drops non-allowlisted overrides for shell wrappers", () => {
    const overrides = sanitizeSystemRunEnvOverrides({
      shellWrapper: true,
      overrides: {
        OPENCLAW_TEST: "1",
        TOKEN: "abc",
        LANG: "C",
        LC_ALL: "C",
      },
    });
    expect(overrides).toEqual({
      LANG: "C",
      LC_ALL: "C",
    });
  });

  it("returns undefined when no shell-wrapper overrides survive", () => {
    expect(
      sanitizeSystemRunEnvOverrides({
        shellWrapper: true,
        overrides: {
          TOKEN: "abc",
        },
      }),
    ).toBeUndefined();
    expect(sanitizeSystemRunEnvOverrides({ shellWrapper: true })).toBeUndefined();
  });

  it("keeps allowlisted shell-wrapper overrides case-insensitively", () => {
    expect(
      sanitizeSystemRunEnvOverrides({
        shellWrapper: true,
        overrides: {
          lang: "C",
          ColorTerm: "truecolor",
        },
      }),
    ).toEqual({
      lang: "C",
      ColorTerm: "truecolor",
    });
  });
});

describe("shell wrapper exploit regression", () => {
  it("blocks SHELLOPTS/PS4 chain after sanitization", async () => {
    const bashPath = "/bin/bash";
    if (process.platform === "win32" || !fs.existsSync(bashPath)) {
      return;
    }
    const marker = path.join(os.tmpdir(), `openclaw-ps4-marker-${process.pid}-${Date.now()}`);
    try {
      fs.unlinkSync(marker);
    } catch {
      // no-op
    }

    const filteredOverrides = sanitizeSystemRunEnvOverrides({
      shellWrapper: true,
      overrides: {
        SHELLOPTS: "xtrace",
        PS4: `$(touch ${marker})`,
      },
    });
    const env = sanitizeHostExecEnv({
      overrides: filteredOverrides,
      baseEnv: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
    });

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bashPath, ["-lc", "echo SAFE"], { env, stdio: "ignore" });
      child.once("error", reject);
      child.once("close", () => resolve());
    });

    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("git env exploit regression", () => {
  it("blocks inherited GIT_EXEC_PATH so git cannot execute helper payloads", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const helperDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-exec-path-${process.pid}-${Date.now()}-`),
    );
    const helperPath = path.join(helperDir, "git-remote-https");
    const marker = path.join(
      os.tmpdir(),
      `openclaw-git-exec-path-marker-${process.pid}-${Date.now()}`,
    );
    try {
      clearMarker(marker);
      fs.writeFileSync(helperPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, "utf8");
      fs.chmodSync(helperPath, 0o755);

      const target = "https://127.0.0.1:1/does-not-matter";
      const unsafeEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_EXEC_PATH: helperDir,
        GIT_TERMINAL_PROMPT: "0",
      };

      await runGitLsRemote(gitPath, target, unsafeEnv);

      expect(fs.existsSync(marker)).toBe(true);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv: unsafeEnv,
      });

      await runGitLsRemote(gitPath, target, safeEnv);

      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(helperDir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  });

  it("blocks inherited GIT_TEMPLATE_DIR so git clone cannot install hook payloads", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-template-source-${process.pid}-${Date.now()}-`),
    );
    const cloneDir = path.join(
      os.tmpdir(),
      `openclaw-git-template-clone-${process.pid}-${Date.now()}`,
    );
    const safeCloneDir = path.join(
      os.tmpdir(),
      `openclaw-git-template-safe-clone-${process.pid}-${Date.now()}`,
    );
    const templateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-template-dir-${process.pid}-${Date.now()}-`),
    );
    const hooksDir = path.join(templateDir, "hooks");
    const marker = path.join(
      os.tmpdir(),
      `openclaw-git-template-marker-${process.pid}-${Date.now()}`,
    );

    try {
      fs.mkdirSync(hooksDir, { recursive: true });
      clearMarker(marker);
      fs.writeFileSync(
        path.join(hooksDir, "post-checkout"),
        `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`,
        "utf8",
      );
      fs.chmodSync(path.join(hooksDir, "post-checkout"), 0o755);

      await runGitCommand(gitPath, ["init", repoDir]);
      await runGitCommand(
        gitPath,
        [
          "-C",
          repoDir,
          "-c",
          "user.name=OpenClaw Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "init",
        ],
        {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
          },
        },
      );

      const unsafeEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_TEMPLATE_DIR: templateDir,
        GIT_TERMINAL_PROMPT: "0",
      };

      await runGitClone(gitPath, repoDir, cloneDir, unsafeEnv);

      expect(fs.existsSync(marker)).toBe(true);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv: unsafeEnv,
      });

      await runGitClone(gitPath, repoDir, safeCloneDir, safeEnv);

      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(cloneDir, { recursive: true, force: true });
      fs.rmSync(safeCloneDir, { recursive: true, force: true });
      fs.rmSync(templateDir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  });

  it("blocks GIT_SSH_COMMAND override so git cannot execute helper payloads", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const marker = path.join(os.tmpdir(), `openclaw-git-ssh-command-${process.pid}-${Date.now()}`);
    clearMarker(marker);

    const target = "ssh://127.0.0.1:1/does-not-matter";
    const exploitValue = `touch ${JSON.stringify(marker)}; false`;
    const baseEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_TERMINAL_PROMPT: "0",
    };

    const unsafeEnv = {
      ...baseEnv,
      GIT_SSH_COMMAND: exploitValue,
    };

    await runGitLsRemote(gitPath, target, unsafeEnv);

    expect(fs.existsSync(marker)).toBe(true);
    clearMarker(marker);

    const safeEnv = sanitizeHostExecEnv({
      baseEnv,
      overrides: {
        GIT_SSH_COMMAND: exploitValue,
      },
    });

    await runGitLsRemote(gitPath, target, safeEnv);

    expect(fs.existsSync(marker)).toBe(false);
  });
});
