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

function findSystemCommandPath(command: string) {
  if (process.platform === "win32") {
    return null;
  }
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getSystemGitPath() {
  return findSystemCommandPath("git");
}

function getSystemMakePath() {
  return findSystemCommandPath("make");
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

async function initGitRepoWithCommits(gitPath: string, repoDir: string, commitCount: number) {
  await runGitCommand(gitPath, ["init", repoDir]);
  for (let index = 1; index <= commitCount; index += 1) {
    fs.writeFileSync(path.join(repoDir, `commit-${index}.txt`), `commit ${index}\n`, "utf8");
    await runGitCommand(gitPath, ["-C", repoDir, "add", "."], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
    });
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
        "-m",
        `commit ${index}`,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      },
    );
  }
}

async function runMakeCommand(makePath: string, cwd: string, env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve) => {
    const child = spawn(makePath, ["all"], {
      cwd,
      env,
      stdio: "ignore",
    });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

describe("isDangerousHostEnvVarName", () => {
  it("matches dangerous keys and prefixes case-insensitively", () => {
    expect(isDangerousHostEnvVarName("BASH_ENV")).toBe(true);
    expect(isDangerousHostEnvVarName("bash_env")).toBe(true);
    expect(isDangerousHostEnvVarName("BROWSER")).toBe(true);
    expect(isDangerousHostEnvVarName("browser")).toBe(true);
    expect(isDangerousHostEnvVarName("SHELL")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_EDITOR")).toBe(true);
    expect(isDangerousHostEnvVarName("git_editor")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_EXTERNAL_DIFF")).toBe(true);
    expect(isDangerousHostEnvVarName("git_exec_path")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_SEQUENCE_EDITOR")).toBe(true);
    expect(isDangerousHostEnvVarName("git_sequence_editor")).toBe(true);
    expect(isDangerousHostEnvVarName("GIT_TEMPLATE_DIR")).toBe(true);
    expect(isDangerousHostEnvVarName("git_template_dir")).toBe(true);
    expect(isDangerousHostEnvVarName("CC")).toBe(true);
    expect(isDangerousHostEnvVarName("cxx")).toBe(true);
    expect(isDangerousHostEnvVarName("CARGO_BUILD_RUSTC")).toBe(true);
    expect(isDangerousHostEnvVarName("cargo_build_rustc")).toBe(true);
    expect(isDangerousHostEnvVarName("CARGO_BUILD_RUSTC_WRAPPER")).toBe(true);
    expect(isDangerousHostEnvVarName("cargo_build_rustc_wrapper")).toBe(true);
    expect(isDangerousHostEnvVarName("RUSTC_WRAPPER")).toBe(true);
    expect(isDangerousHostEnvVarName("rustc_wrapper")).toBe(true);
    expect(isDangerousHostEnvVarName("RUSTC_WORKSPACE_WRAPPER")).toBe(true);
    expect(isDangerousHostEnvVarName("rustc_workspace_wrapper")).toBe(true);
    expect(isDangerousHostEnvVarName("CMAKE_C_COMPILER")).toBe(true);
    expect(isDangerousHostEnvVarName("cmake_c_compiler")).toBe(true);
    expect(isDangerousHostEnvVarName("CMAKE_CXX_COMPILER")).toBe(true);
    expect(isDangerousHostEnvVarName("cmake_cxx_compiler")).toBe(true);
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
    expect(isDangerousHostEnvVarName("JAVA_OPTS")).toBe(true);
    expect(isDangerousHostEnvVarName("java_opts")).toBe(true);
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
    expect(isDangerousHostEnvVarName("HTTPS_PROXY")).toBe(false);
    expect(isDangerousHostEnvVarName("https_proxy")).toBe(false);
    expect(isDangerousHostEnvVarName("HTTP_PROXY")).toBe(false);
    expect(isDangerousHostEnvVarName("http_proxy")).toBe(false);
    expect(isDangerousHostEnvVarName("ALL_PROXY")).toBe(false);
    expect(isDangerousHostEnvVarName("no_proxy")).toBe(false);
    expect(isDangerousHostEnvVarName("NODE_TLS_REJECT_UNAUTHORIZED")).toBe(false);
    expect(isDangerousHostEnvVarName("node_extra_ca_certs")).toBe(false);
    expect(isDangerousHostEnvVarName("SSL_CERT_FILE")).toBe(false);
    expect(isDangerousHostEnvVarName("SSL_CERT_DIR")).toBe(false);
    expect(isDangerousHostEnvVarName("requests_ca_bundle")).toBe(false);
    expect(isDangerousHostEnvVarName("CURL_CA_BUNDLE")).toBe(false);
    expect(isDangerousHostEnvVarName("DOCKER_HOST")).toBe(false);
    expect(isDangerousHostEnvVarName("docker_cert_path")).toBe(false);
    expect(isDangerousHostEnvVarName("DOCKER_TLS_VERIFY")).toBe(false);
    expect(isDangerousHostEnvVarName("CARGO_REGISTRIES_CRATES_IO_INDEX")).toBe(false);
    expect(isDangerousHostEnvVarName("AWS_CONFIG_FILE")).toBe(false);
    expect(isDangerousHostEnvVarName("aws_config_file")).toBe(false);
    expect(isDangerousHostEnvVarName("yarn_rc_filename")).toBe(false);
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
        BROWSER: "/tmp/pwn-browser",
        GIT_EDITOR: "/tmp/pwn-editor",
        GIT_EXTERNAL_DIFF: "/tmp/pwn.sh",
        GIT_TEMPLATE_DIR: "/tmp/git-template",
        GIT_SEQUENCE_EDITOR: "/tmp/pwn-sequence-editor",
        RUSTC_WRAPPER: "/tmp/pwn-rustc-wrapper",
        JAVA_OPTS: "-javaagent:/tmp/pwn.jar",
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
        CARGO_REGISTRIES_CRATES_IO_INDEX: "https://trusted.example/crates.io-index",
        YARN_RC_FILENAME: ".trusted-yarnrc.yml",
      },
      overrides: {
        PATH: "/tmp/evil",
        HOME: "/tmp/evil-home",
        ZDOTDIR: "/tmp/evil-zdotdir",
        BASH_ENV: "/tmp/pwn.sh",
        BROWSER: "/tmp/browser",
        CC: "/tmp/evil-cc",
        CXX: "/tmp/evil-cxx",
        CARGO_BUILD_RUSTC: "/tmp/evil-rustc",
        CARGO_BUILD_RUSTC_WRAPPER: "/tmp/evil-rustc-wrapper",
        RUSTC_WRAPPER: "/tmp/evil-rustc-wrapper",
        RUSTC_WORKSPACE_WRAPPER: "/tmp/evil-rustc-workspace-wrapper",
        CMAKE_C_COMPILER: "/tmp/evil-c-compiler",
        CMAKE_CXX_COMPILER: "/tmp/evil-cxx-compiler",
        GIT_SSH_COMMAND: "touch /tmp/pwned",
        GIT_EDITOR: "/tmp/git-editor",
        GIT_EXEC_PATH: "/tmp/git-exec-path",
        GIT_SEQUENCE_EDITOR: "/tmp/git-sequence-editor",
        EDITOR: "/tmp/editor",
        NPM_CONFIG_USERCONFIG: "/tmp/npmrc",
        GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
        CARGO_REGISTRIES_CRATES_IO_INDEX: "https://example.invalid/crates.io-index",
        AWS_CONFIG_FILE: "/tmp/override-aws-config",
        YARN_RC_FILENAME: ".evil-yarnrc.yml",
        PIP_INDEX_URL: "https://example.invalid/simple",
        PIP_PYPI_URL: "https://example.invalid/simple",
        PIP_EXTRA_INDEX_URL: "https://example.invalid/simple",
        PIP_CONFIG_FILE: "/tmp/evil-pip.conf",
        PIP_REQUIREMENT: "/tmp/evil-requirements.txt",
        PIP_CONSTRAINT: "/tmp/evil-constraints.txt",
        PIP_FIND_LINKS: "https://example.invalid/wheels",
        PIP_TRUSTED_HOST: "example.invalid",
        UV_INDEX: "https://example.invalid/simple",
        UV_INDEX_URL: "https://example.invalid/simple",
        UV_DEFAULT_INDEX: "https://example.invalid/simple",
        UV_EXTRA_INDEX_URL: "https://example.invalid/simple",
        DOCKER_HOST: "tcp://example.invalid:2376",
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "/tmp/evil-docker-certs",
        DOCKER_CONTEXT: "evil-remote",
        LIBRARY_PATH: "/tmp/evil-lib",
        CPATH: "/tmp/evil-headers",
        C_INCLUDE_PATH: "/tmp/evil-c-headers",
        CPLUS_INCLUDE_PATH: "/tmp/evil-cpp-headers",
        OBJC_INCLUDE_PATH: "/tmp/evil-objc-headers",
        NODE_EXTRA_CA_CERTS: "/tmp/evil-ca.pem",
        SSL_CERT_FILE: "/tmp/evil-cert.pem",
        SSL_CERT_DIR: "/tmp/evil-cert-dir",
        REQUESTS_CA_BUNDLE: "/tmp/evil-requests-ca.pem",
        CURL_CA_BUNDLE: "/tmp/evil-curl-ca.pem",
        GIT_SSL_NO_VERIFY: "1",
        GIT_SSL_CAINFO: "/tmp/evil-git-ca.pem",
        GIT_SSL_CAPATH: "/tmp/evil-git-ca-dir",
        GOPROXY: "https://example.invalid/proxy",
        GONOSUMCHECK: "example.invalid/*",
        GONOSUMDB: "example.invalid/*",
        GOSUMDB: "off",
        GOINSECURE: "example.invalid/*",
        GONOPROXY: "example.invalid/*",
        GOPRIVATE: "example.invalid/*",
        GOENV: "/tmp/evil-goenv",
        GOPATH: "/tmp/evil-go",
        PYTHONUSERBASE: "/tmp/evil-python-userbase",
        VIRTUAL_ENV: "/tmp/evil-venv",
        SHELLOPTS: "xtrace",
        PS4: "$(touch /tmp/pwned)",
        CLASSPATH: "/tmp/evil-classpath",
        JAVA_OPTS: "-javaagent:/tmp/evil.jar",
        GOFLAGS: "-mod=mod",
        RUSTFLAGS: "-C link-arg=-Wl,-rpath,/tmp/evil",
        CARGO_ENCODED_RUSTFLAGS: "-Clink-arg=-Wl,-rpath,/tmp/evil",
        CARGO_HOME: "/tmp/evil-cargo-home",
        PHPRC: "/tmp/evil-php.ini",
        XDG_CONFIG_HOME: "/tmp/evil-config",
        SAFE: "ok",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.BROWSER).toBeUndefined();
    expect(env.GIT_EDITOR).toBeUndefined();
    expect(env.CC).toBeUndefined();
    expect(env.CXX).toBeUndefined();
    expect(env.CARGO_BUILD_RUSTC).toBeUndefined();
    expect(env.CARGO_BUILD_RUSTC_WRAPPER).toBeUndefined();
    expect(env.RUSTC_WRAPPER).toBeUndefined();
    expect(env.RUSTC_WORKSPACE_WRAPPER).toBeUndefined();
    expect(env.CMAKE_C_COMPILER).toBeUndefined();
    expect(env.CMAKE_CXX_COMPILER).toBeUndefined();
    expect(env.GIT_TEMPLATE_DIR).toBeUndefined();
    expect(env.GIT_SEQUENCE_EDITOR).toBeUndefined();
    expect(env.AWS_CONFIG_FILE).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_EXEC_PATH).toBeUndefined();
    expect(env.EDITOR).toBeUndefined();
    expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env.CARGO_REGISTRIES_CRATES_IO_INDEX).toBe("https://trusted.example/crates.io-index");
    expect(env.SHELLOPTS).toBeUndefined();
    expect(env.PS4).toBeUndefined();
    expect(env.CLASSPATH).toBeUndefined();
    expect(env.JAVA_OPTS).toBeUndefined();
    expect(env.GOFLAGS).toBeUndefined();
    expect(env.RUSTFLAGS).toBeUndefined();
    expect(env.CARGO_ENCODED_RUSTFLAGS).toBeUndefined();
    expect(env.CARGO_HOME).toBeUndefined();
    expect(env.PHPRC).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.YARN_RC_FILENAME).toBe(".trusted-yarnrc.yml");
    expect(env.PIP_INDEX_URL).toBeUndefined();
    expect(env.PIP_PYPI_URL).toBeUndefined();
    expect(env.PIP_EXTRA_INDEX_URL).toBeUndefined();
    expect(env.PIP_CONFIG_FILE).toBeUndefined();
    expect(env.PIP_CONSTRAINT).toBeUndefined();
    expect(env.PIP_FIND_LINKS).toBeUndefined();
    expect(env.PIP_TRUSTED_HOST).toBeUndefined();
    expect(env.PIP_REQUIREMENT).toBeUndefined();
    expect(env.UV_INDEX).toBeUndefined();
    expect(env.UV_INDEX_URL).toBeUndefined();
    expect(env.UV_DEFAULT_INDEX).toBeUndefined();
    expect(env.UV_EXTRA_INDEX_URL).toBeUndefined();
    expect(env.DOCKER_HOST).toBeUndefined();
    expect(env.DOCKER_TLS_VERIFY).toBeUndefined();
    expect(env.DOCKER_CERT_PATH).toBeUndefined();
    expect(env.DOCKER_CONTEXT).toBeUndefined();
    expect(env.LIBRARY_PATH).toBeUndefined();
    expect(env.CPATH).toBeUndefined();
    expect(env.C_INCLUDE_PATH).toBeUndefined();
    expect(env.CPLUS_INCLUDE_PATH).toBeUndefined();
    expect(env.OBJC_INCLUDE_PATH).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.SSL_CERT_DIR).toBeUndefined();
    expect(env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(env.CURL_CA_BUNDLE).toBeUndefined();
    expect(env.GOPROXY).toBeUndefined();
    expect(env.GONOSUMCHECK).toBeUndefined();
    expect(env.GONOSUMDB).toBeUndefined();
    expect(env.GOSUMDB).toBeUndefined();
    expect(env.GOINSECURE).toBeUndefined();
    expect(env.GONOPROXY).toBeUndefined();
    expect(env.GOPRIVATE).toBeUndefined();
    expect(env.GOENV).toBeUndefined();
    expect(env.GOPATH).toBeUndefined();
    expect(env.PYTHONUSERBASE).toBeUndefined();
    expect(env.VIRTUAL_ENV).toBeUndefined();
    expect(env.SAFE).toBe("ok");
    expect(env.HOME).toBe("/tmp/trusted-home");
    expect(env.ZDOTDIR).toBe("/tmp/trusted-zdotdir");
  });

  it("keeps trusted inherited proxy, TLS, and Docker env while blocking overrides", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        HTTP_PROXY: "http://trusted-proxy.example.test:8080",
        HTTPS_PROXY: "http://trusted-proxy.example.test:8443",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        SSL_CERT_DIR: "/etc/ssl/certs",
        CURL_CA_BUNDLE: "/etc/ssl/cert.pem",
        DOCKER_TLS_VERIFY: "1",
      },
      overrides: {
        HTTP_PROXY: "http://evil-proxy.example.test:8080",
        NODE_TLS_REJECT_UNAUTHORIZED: "1",
        DOCKER_TLS_VERIFY: "0",
      },
    });

    expect(env).toEqual({
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
      PATH: "/usr/bin:/bin",
      HTTP_PROXY: "http://trusted-proxy.example.test:8080",
      HTTPS_PROXY: "http://trusted-proxy.example.test:8443",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      SSL_CERT_DIR: "/etc/ssl/certs",
      CURL_CA_BUNDLE: "/etc/ssl/cert.pem",
      DOCKER_TLS_VERIFY: "1",
    });
  });

  it("blocks proxy, TLS, and Docker override values explicitly", () => {
    expect(isDangerousHostEnvOverrideVarName("HTTPS_PROXY")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("https_proxy")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("HTTP_PROXY")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("http_proxy")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("ALL_PROXY")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("no_proxy")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("NODE_TLS_REJECT_UNAUTHORIZED")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("node_extra_ca_certs")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("SSL_CERT_FILE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("SSL_CERT_DIR")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("requests_ca_bundle")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CURL_CA_BUNDLE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("DOCKER_HOST")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("docker_cert_path")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("DOCKER_TLS_VERIFY")).toBe(true);
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
});

describe("isDangerousHostEnvOverrideVarName", () => {
  it("matches override-only blocked keys case-insensitively", () => {
    expect(isDangerousHostEnvOverrideVarName("HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("zdotdir")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GIT_SSH_COMMAND")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("editor")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("NPM_CONFIG_USERCONFIG")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("git_config_global")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CARGO_REGISTRIES_CRATES_IO_INDEX")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("cargo_registries_internal_index")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GRADLE_USER_HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("gradle_user_home")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("PIP_INDEX_URL")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("pip_config_file")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("PIP_CONSTRAINT")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("PIP_FIND_LINKS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("pip_requirement")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("pip_trusted_host")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("pip_pypi_url")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("PIP_EXTRA_INDEX_URL")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("UV_INDEX")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("UV_INDEX_URL")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("uv_default_index")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("UV_EXTRA_INDEX_URL")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("DOCKER_HOST")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("docker_context")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("NODE_EXTRA_CA_CERTS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("ssl_cert_file")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("REQUESTS_CA_BUNDLE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("curl_ca_bundle")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("LIBRARY_PATH")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("c_include_path")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GOPROXY")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("gonosumdb")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("gosumdb")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("goinsecure")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GOPRIVATE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("goenv")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("PYTHONUSERBASE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("virtual_env")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CLASSPATH")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("classpath")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("GOFLAGS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("goflags")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("RUSTFLAGS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("rustflags")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CARGO_ENCODED_RUSTFLAGS")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("cargo_encoded_rustflags")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CARGO_HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("cargo_home")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("CORECLR_PROFILER_PATH")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("coreclr_profiler_path")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("XDG_CONFIG_HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("xdg_config_home")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("AWS_CONFIG_FILE")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("aws_config_file")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("yarn_rc_filename")).toBe(true);
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
        CXX: "/tmp/evil-cxx",
        CARGO_REGISTRIES_CRATES_IO_INDEX: "https://example.invalid/crates.io-index",
        CMAKE_C_COMPILER: "/tmp/evil-c-compiler",
        CARGO_BUILD_RUSTC_WRAPPER: "/tmp/evil-rustc-wrapper",
        RUSTC_WRAPPER: "/tmp/evil-rustc-wrapper",
        RUSTC_WORKSPACE_WRAPPER: "/tmp/evil-rustc-workspace-wrapper",
        CLASSPATH: "/tmp/evil-classpath",
        JAVA_OPTS: "-javaagent:/tmp/evil.jar",
        PIP_INDEX_URL: "https://example.invalid/simple",
        PIP_PYPI_URL: "https://example.invalid/simple",
        PIP_EXTRA_INDEX_URL: "https://example.invalid/simple",
        PIP_CONFIG_FILE: "/tmp/evil-pip.conf",
        PIP_CONSTRAINT: "/tmp/evil-constraints.txt",
        PIP_FIND_LINKS: "https://example.invalid/wheels",
        PIP_REQUIREMENT: "/tmp/evil-requirements.txt",
        PIP_TRUSTED_HOST: "example.invalid",
        UV_INDEX: "https://example.invalid/simple",
        UV_INDEX_URL: "https://example.invalid/simple",
        UV_DEFAULT_INDEX: "https://example.invalid/simple",
        UV_EXTRA_INDEX_URL: "https://example.invalid/simple",
        DOCKER_HOST: "tcp://example.invalid:2376",
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "/tmp/evil-docker-certs",
        DOCKER_CONTEXT: "evil-remote",
        LIBRARY_PATH: "/tmp/evil-lib",
        CPATH: "/tmp/evil-headers",
        C_INCLUDE_PATH: "/tmp/evil-c-headers",
        CPLUS_INCLUDE_PATH: "/tmp/evil-cpp-headers",
        OBJC_INCLUDE_PATH: "/tmp/evil-objc-headers",
        NODE_EXTRA_CA_CERTS: "/tmp/evil-ca.pem",
        SSL_CERT_FILE: "/tmp/evil-cert.pem",
        SSL_CERT_DIR: "/tmp/evil-cert-dir",
        REQUESTS_CA_BUNDLE: "/tmp/evil-requests-ca.pem",
        CURL_CA_BUNDLE: "/tmp/evil-curl-ca.pem",
        GOPROXY: "https://example.invalid/proxy",
        GONOSUMCHECK: "example.invalid/*",
        GONOSUMDB: "example.invalid/*",
        GOSUMDB: "off",
        GOINSECURE: "example.invalid/*",
        GONOPROXY: "example.invalid/*",
        GOPRIVATE: "example.invalid/*",
        GOENV: "/tmp/evil-goenv",
        GOPATH: "/tmp/evil-go",
        CARGO_HOME: "/tmp/evil-cargo-home",
        RUSTFLAGS: "-C link-arg=-Wl,-rpath,/tmp/evil",
        CARGO_ENCODED_RUSTFLAGS: "-Clink-arg=-Wl,-rpath,/tmp/evil",
        PYTHONUSERBASE: "/tmp/evil-python-userbase",
        VIRTUAL_ENV: "/tmp/evil-venv",
        YARN_RC_FILENAME: ".evil-yarnrc.yml",
        HTTPS_PROXY: "http://proxy.example.test:8080",
        GIT_SSL_NO_VERIFY: "1",
        GIT_SSL_CAINFO: "/tmp/evil-git-ca.pem",
        GIT_SSL_CAPATH: "/tmp/evil-git-capath",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        SAFE_KEY: "ok",
        "BAD-KEY": "bad",
      },
    });

    expect(result.rejectedOverrideBlockedKeys).toEqual([
      "C_INCLUDE_PATH",
      "CARGO_BUILD_RUSTC_WRAPPER",
      "CARGO_ENCODED_RUSTFLAGS",
      "CARGO_HOME",
      "CARGO_REGISTRIES_CRATES_IO_INDEX",
      "CLASSPATH",
      "CMAKE_C_COMPILER",
      "CPATH",
      "CPLUS_INCLUDE_PATH",
      "CURL_CA_BUNDLE",
      "CXX",
      "DOCKER_CERT_PATH",
      "DOCKER_CONTEXT",
      "DOCKER_HOST",
      "DOCKER_TLS_VERIFY",
      "GIT_SSL_CAINFO",
      "GIT_SSL_CAPATH",
      "GIT_SSL_NO_VERIFY",
      "GOENV",
      "GOINSECURE",
      "GONOPROXY",
      "GONOSUMCHECK",
      "GONOSUMDB",
      "GOPATH",
      "GOPRIVATE",
      "GOPROXY",
      "GOSUMDB",
      "HTTPS_PROXY",
      "JAVA_OPTS",
      "LIBRARY_PATH",
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "OBJC_INCLUDE_PATH",
      "PATH",
      "PIP_CONFIG_FILE",
      "PIP_CONSTRAINT",
      "PIP_EXTRA_INDEX_URL",
      "PIP_FIND_LINKS",
      "PIP_INDEX_URL",
      "PIP_PYPI_URL",
      "PIP_REQUIREMENT",
      "PIP_TRUSTED_HOST",
      "PYTHONUSERBASE",
      "REQUESTS_CA_BUNDLE",
      "RUSTC_WORKSPACE_WRAPPER",
      "RUSTC_WRAPPER",
      "RUSTFLAGS",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
      "UV_DEFAULT_INDEX",
      "UV_EXTRA_INDEX_URL",
      "UV_INDEX",
      "UV_INDEX_URL",
      "VIRTUAL_ENV",
      "YARN_RC_FILENAME",
    ]);
    expect(result.rejectedOverrideInvalidKeys).toEqual(["BAD-KEY"]);
    expect(result.env.SAFE_KEY).toBe("ok");
    expect(result.env.PATH).toBe("/usr/bin:/bin");
    expect(result.env.CLASSPATH).toBeUndefined();
    expect(result.env.CXX).toBeUndefined();
    expect(result.env.CMAKE_C_COMPILER).toBeUndefined();
    expect(result.env.CARGO_BUILD_RUSTC_WRAPPER).toBeUndefined();
    expect(result.env.RUSTC_WRAPPER).toBeUndefined();
    expect(result.env.RUSTC_WORKSPACE_WRAPPER).toBeUndefined();
    expect(result.env.JAVA_OPTS).toBeUndefined();
    expect(result.env.CARGO_REGISTRIES_CRATES_IO_INDEX).toBeUndefined();
    expect(result.env.PIP_INDEX_URL).toBeUndefined();
    expect(result.env.PIP_PYPI_URL).toBeUndefined();
    expect(result.env.PIP_EXTRA_INDEX_URL).toBeUndefined();
    expect(result.env.PIP_CONFIG_FILE).toBeUndefined();
    expect(result.env.PIP_CONSTRAINT).toBeUndefined();
    expect(result.env.PIP_FIND_LINKS).toBeUndefined();
    expect(result.env.PIP_REQUIREMENT).toBeUndefined();
    expect(result.env.PIP_TRUSTED_HOST).toBeUndefined();
    expect(result.env.UV_INDEX).toBeUndefined();
    expect(result.env.UV_INDEX_URL).toBeUndefined();
    expect(result.env.UV_DEFAULT_INDEX).toBeUndefined();
    expect(result.env.UV_EXTRA_INDEX_URL).toBeUndefined();
    expect(result.env.GIT_SSL_NO_VERIFY).toBeUndefined();
    expect(result.env.GIT_SSL_CAINFO).toBeUndefined();
    expect(result.env.GIT_SSL_CAPATH).toBeUndefined();
    expect(result.env.DOCKER_HOST).toBeUndefined();
    expect(result.env.DOCKER_TLS_VERIFY).toBeUndefined();
    expect(result.env.DOCKER_CERT_PATH).toBeUndefined();
    expect(result.env.DOCKER_CONTEXT).toBeUndefined();
    expect(result.env.LIBRARY_PATH).toBeUndefined();
    expect(result.env.CPATH).toBeUndefined();
    expect(result.env.C_INCLUDE_PATH).toBeUndefined();
    expect(result.env.CPLUS_INCLUDE_PATH).toBeUndefined();
    expect(result.env.OBJC_INCLUDE_PATH).toBeUndefined();
    expect(result.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(result.env.SSL_CERT_FILE).toBeUndefined();
    expect(result.env.SSL_CERT_DIR).toBeUndefined();
    expect(result.env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(result.env.CURL_CA_BUNDLE).toBeUndefined();
    expect(result.env.GOPROXY).toBeUndefined();
    expect(result.env.GONOSUMCHECK).toBeUndefined();
    expect(result.env.GONOSUMDB).toBeUndefined();
    expect(result.env.GOSUMDB).toBeUndefined();
    expect(result.env.GOINSECURE).toBeUndefined();
    expect(result.env.GONOPROXY).toBeUndefined();
    expect(result.env.GOPRIVATE).toBeUndefined();
    expect(result.env.GOENV).toBeUndefined();
    expect(result.env.GOPATH).toBeUndefined();
    expect(result.env.CARGO_HOME).toBeUndefined();
    expect(result.env.RUSTFLAGS).toBeUndefined();
    expect(result.env.CARGO_ENCODED_RUSTFLAGS).toBeUndefined();
    expect(result.env.HTTPS_PROXY).toBeUndefined();
    expect(result.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(result.env.PYTHONUSERBASE).toBeUndefined();
    expect(result.env.VIRTUAL_ENV).toBeUndefined();
    expect(result.env.YARN_RC_FILENAME).toBeUndefined();
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

  it("blocks advisory toolchain overrides from an empty base env", () => {
    const dangerous = {
      RUSTC_WRAPPER: "/tmp/evil_rustc",
      RUSTC_WORKSPACE_WRAPPER: "/tmp/evil_workspace_rustc",
      GOPROXY: "https://attacker.example.com/proxy",
      GOENV: "/tmp/evil-goenv",
      GOINSECURE: "attacker.example.com/*",
      GONOSUMCHECK: "attacker.example.com/*",
      GONOSUMDB: "attacker.example.com/*",
      GOSUMDB: "off",
      GOPRIVATE: "attacker.example.com/*",
      JAVA_OPTS: "-javaagent:/tmp/evil.jar",
      CARGO_HOME: "/tmp/evil_cargo",
      RUSTFLAGS: "-C link-args=-l/tmp/evil.so",
      CARGO_ENCODED_RUSTFLAGS: "-Clink-arg=-Wl,-rpath,/tmp/evil",
      PIP_CONFIG_FILE: "/tmp/evil_pip.cfg",
      PIP_CONSTRAINT: "/tmp/evil_constraints.txt",
      PIP_REQUIREMENT: "/tmp/evil_requirements.txt",
      LIBRARY_PATH: "/tmp/evil_lib",
    };

    const result = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: {},
      overrides: dangerous,
      blockPathOverrides: true,
    });

    expect(result.rejectedOverrideBlockedKeys).toEqual([
      "CARGO_ENCODED_RUSTFLAGS",
      "CARGO_HOME",
      "GOENV",
      "GOINSECURE",
      "GONOSUMCHECK",
      "GONOSUMDB",
      "GOPRIVATE",
      "GOPROXY",
      "GOSUMDB",
      "JAVA_OPTS",
      "LIBRARY_PATH",
      "PIP_CONFIG_FILE",
      "PIP_CONSTRAINT",
      "PIP_REQUIREMENT",
      "RUSTC_WORKSPACE_WRAPPER",
      "RUSTC_WRAPPER",
      "RUSTFLAGS",
    ]);
    expect(result.rejectedOverrideInvalidKeys).toEqual([]);
    for (const key of Object.keys(dangerous)) {
      expect(result.env[key]).toBeUndefined();
    }
    expect(result.env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
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
  it("blocks inherited GIT_SEQUENCE_EDITOR so git rebase -i cannot execute helper payloads", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-sequence-editor-${process.pid}-${Date.now()}-`),
    );
    const safeRepoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-sequence-editor-safe-${process.pid}-${Date.now()}-`),
    );
    const editorPath = path.join(repoDir, "sequence-editor.sh");
    const safeEditorPath = path.join(safeRepoDir, "sequence-editor.sh");
    const marker = path.join(
      os.tmpdir(),
      `openclaw-git-sequence-editor-marker-${process.pid}-${Date.now()}`,
    );

    try {
      await initGitRepoWithCommits(gitPath, repoDir, 2);
      await initGitRepoWithCommits(gitPath, safeRepoDir, 2);
      clearMarker(marker);
      fs.writeFileSync(editorPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, "utf8");
      fs.chmodSync(editorPath, 0o755);
      fs.writeFileSync(safeEditorPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, "utf8");
      fs.chmodSync(safeEditorPath, 0o755);

      const unsafeEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_SEQUENCE_EDITOR: editorPath,
        GIT_TERMINAL_PROMPT: "0",
      };

      await runGitCommand(gitPath, ["-C", repoDir, "rebase", "-i", "HEAD~1"], {
        env: unsafeEnv,
      });

      expect(fs.existsSync(marker)).toBe(true);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          GIT_SEQUENCE_EDITOR: safeEditorPath,
          GIT_TERMINAL_PROMPT: "0",
        },
      });

      await runGitCommand(gitPath, ["-C", safeRepoDir, "rebase", "-i", "HEAD~1"], {
        env: safeEnv,
      });

      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(safeRepoDir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  });

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

describe("compiler override exploit regression", () => {
  it("blocks CC overrides so make cannot execute a substituted compiler", async () => {
    const makePath = getSystemMakePath();
    if (!makePath) {
      return;
    }

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-compiler-override-${process.pid}-${Date.now()}-`),
    );
    const exploitPath = path.join(tempDir, "evil-cc");
    const marker = path.join(
      os.tmpdir(),
      `openclaw-compiler-override-marker-${process.pid}-${Date.now()}`,
    );

    try {
      // `CC` is a representative proof for the whole class because all compiler override keys
      // flow through the same host env sanitization boundary; unit tests cover the sibling keys.
      clearMarker(marker);
      fs.writeFileSync(
        path.join(tempDir, "Makefile"),
        "all:\n\t@$(CC) --version >/dev/null 2>&1 || true\n",
        "utf8",
      );
      fs.writeFileSync(exploitPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, "utf8");
      fs.chmodSync(exploitPath, 0o755);

      const baseEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      };

      await runMakeCommand(makePath, tempDir, {
        ...baseEnv,
        CC: exploitPath,
      });

      expect(fs.existsSync(marker)).toBe(true);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv,
        overrides: {
          CC: exploitPath,
        },
      });

      await runMakeCommand(makePath, tempDir, safeEnv);

      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  });
});
