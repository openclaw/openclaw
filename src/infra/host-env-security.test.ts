// Covers host environment sanitization and dangerous key detection.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { describe, expect, it } from "vitest";
import { loadHostEnvSecurityPolicy } from "./host-env-security-policy.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostInheritedEnvVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
  sanitizeHostExecEnv,
  sanitizeHostExecEnvWithDiagnostics,
  sanitizeSystemRunEnvOverrides,
} from "./host-env-security.js";

const OPENCLAW_CLI_ENV_VALUE = "1";

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

function clearMarker(marker: string) {
  try {
    fs.unlinkSync(marker);
  } catch {
    // no-op
  }
}

function listKeys(source: string): string[] {
  return source.trim().split(/\s+/u);
}

function envRecord(
  entries: ReadonlyArray<readonly [string, string]> | string,
): Record<string, string> {
  if (typeof entries !== "string") {
    return Object.fromEntries(entries);
  }
  return Object.fromEntries(
    entries
      .trim()
      .split(/\n|\s+\|\s+/u)
      .map((entry) => {
        const separator = entry.indexOf("=");
        if (separator < 1) {
          throw new Error(`invalid env fixture entry: ${entry}`);
        }
        return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
      }),
  );
}

function expectEnvKeysUndefined(env: Record<string, string | undefined>, source: string): void {
  for (const key of listKeys(source)) {
    expect(env[key]).toBeUndefined();
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

async function runGitCommandExitCode(
  gitPath: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const child = spawn(gitPath, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: "ignore",
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
}

describe("sanitizeHostExecEnv", () => {
  it("removes dangerous inherited keys while preserving PATH", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: envRecord(`PATH=/usr/bin:/bin | BASH_ENV=/tmp/pwn.sh | BROWSER=/tmp/pwn-browser
GIT_ALLOW_PROTOCOL=ext | GIT_EDITOR=/tmp/pwn-editor | GIT_EXTERNAL_DIFF=/tmp/pwn.sh
GIT_DIR=/tmp/evil-git-dir | GIT_WORK_TREE=/tmp/evil-work-tree
GIT_COMMON_DIR=/tmp/evil-common-dir | GIT_TEMPLATE_DIR=/tmp/git-template
GIT_INDEX_FILE=/tmp/evil-git-index | GIT_OBJECT_DIRECTORY=/tmp/evil-git-objects
GIT_ALTERNATE_OBJECT_DIRECTORIES=/tmp/evil-git-alt-objects | GIT_NAMESPACE=evil-namespace
GIT_PROTOCOL_FROM_USER=1 | GIT_SEQUENCE_EDITOR=/tmp/pwn-sequence-editor | HGRCPATH=/tmp/evil-hgrc
CARGO_BUILD_RUSTC_WRAPPER=/tmp/evil-rustc-wrapper | RUSTC_WRAPPER=/tmp/evil-rustc-wrapper
JAVA_OPTS=-javaagent:/tmp/evil.jar | MAKEFLAGS=--eval=$(shell touch /tmp/pwned)
MFLAGS=--eval=$(shell touch /tmp/pwned-too) | KUBECONFIG=/tmp/kubeconfig
GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp.json | AWS_SHARED_CREDENTIALS_FILE=/tmp/aws-credentials
AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/aws-web-token | AZURE_AUTH_LOCATION=/tmp/azure-auth.json
AWS_CONFIG_FILE=/tmp/aws-config | SSH_AUTH_SOCK=/tmp/trusted-ssh-agent.sock | CPP=/tmp/evil-cpp
CARGO_HOME=/tmp/cargo | RUSTUP_DIST_ROOT=https://mirror.example.test/deprecated-dist
RUSTUP_DIST_SERVER=https://mirror.example.test | RUSTUP_HOME=/tmp/rustup-home
RUSTUP_TOOLCHAIN=/tmp/rustup-toolchain | RUSTUP_UPDATE_ROOT=https://mirror.example.test/rustup
HELM_HOME=/tmp/helm | HTTP_PROXY=http://proxy.example.test:8080
HTTPS_PROXY=http://proxy.example.test:8443 | SSL_CERT_FILE=/tmp/evil-cert.pem
SSL_CERT_DIR=/tmp/evil-cert-dir | DOCKER_CONTEXT=trusted-remote
DOCKER_HOST=tcp://docker.example.test:2376 | LD_PRELOAD=/tmp/pwn.so | BASHOPTS=xtrace
FPATH=/tmp/evil-fpath | KSH_ENV=/tmp/evil-ksh-env | TCLLIBPATH=/tmp/evil-tcllibpath
NODE_REDIRECT_WARNINGS=/tmp/node-warnings.log | NODE_REPL_EXTERNAL_MODULE=/tmp/pwn.js
NODE_REPL_HISTORY=/tmp/node-repl-history | NODE_V8_COVERAGE=/tmp/coverage | OK=1`),
    });

    expect(env).toEqual(
      envRecord(`OPENCLAW_CLI=${OPENCLAW_CLI_ENV_VALUE} | PATH=/usr/bin:/bin
AWS_CONFIG_FILE=/tmp/aws-config | KUBECONFIG=/tmp/kubeconfig
GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp.json | AWS_SHARED_CREDENTIALS_FILE=/tmp/aws-credentials
AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/aws-web-token | AZURE_AUTH_LOCATION=/tmp/azure-auth.json
SSH_AUTH_SOCK=/tmp/trusted-ssh-agent.sock | HTTP_PROXY=http://proxy.example.test:8080
HTTPS_PROXY=http://proxy.example.test:8443 | SSL_CERT_FILE=/tmp/evil-cert.pem
SSL_CERT_DIR=/tmp/evil-cert-dir | DOCKER_CONTEXT=trusted-remote
DOCKER_HOST=tcp://docker.example.test:2376 | GIT_ALLOW_PROTOCOL= | GIT_PROTOCOL_FROM_USER=0
RUSTUP_DIST_ROOT=https://mirror.example.test/deprecated-dist
RUSTUP_DIST_SERVER=https://mirror.example.test | RUSTUP_HOME=/tmp/rustup-home
RUSTUP_TOOLCHAIN=/tmp/rustup-toolchain | RUSTUP_UPDATE_ROOT=https://mirror.example.test/rustup | OK=1`),
    );
  });

  it("drops non-string inherited values while preserving non-portable inherited keys", () => {
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        GOOD: "1",
        BAD_NUMBER: 1 as unknown as string,
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

describe("sanitizeHostExecEnvWithDiagnostics", () => {
  it("reports blocked and invalid requested overrides", () => {
    const overrides = envRecord(`PATH=/tmp/evil | CPP=/tmp/evil-cpp | CXX=/tmp/evil-cxx
CARGO_BUILD_RUSTC_WRAPPER=/tmp/evil-rustc-wrapper
CARGO_REGISTRIES_CRATES_IO_INDEX=https://example.invalid/crates.io-index
CMAKE_C_COMPILER=/tmp/evil-c-compiler | KUBECONFIG=/tmp/evil-kubeconfig
GOOGLE_APPLICATION_CREDENTIALS=/tmp/evil-gcp.json
AWS_SHARED_CREDENTIALS_FILE=/tmp/evil-aws-credentials
AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/evil-aws-web-token
AZURE_AUTH_LOCATION=/tmp/evil-azure-auth.json | CLASSPATH=/tmp/evil-classpath
PIP_INDEX_URL=https://example.invalid/simple | PIP_PYPI_URL=https://example.invalid/simple
PIP_EXTRA_INDEX_URL=https://example.invalid/simple | PIP_CONFIG_FILE=/tmp/evil-pip.conf
PIP_FIND_LINKS=https://example.invalid/wheels | PIP_TRUSTED_HOST=example.invalid
UV_INDEX=https://example.invalid/simple | UV_INDEX_URL=https://example.invalid/simple
UV_PYTHON=/tmp/evil-uv-python | UV_DEFAULT_INDEX=https://example.invalid/simple
UV_EXTRA_INDEX_URL=https://example.invalid/simple | DOCKER_HOST=tcp://example.invalid:2376
DOCKER_TLS_VERIFY=1 | DOCKER_CERT_PATH=/tmp/evil-docker-certs | DOCKER_CONTEXT=evil-remote
LIBRARY_PATH=/tmp/evil-lib | CPATH=/tmp/evil-headers | C_INCLUDE_PATH=/tmp/evil-c-headers
CPLUS_INCLUDE_PATH=/tmp/evil-cpp-headers | OBJC_INCLUDE_PATH=/tmp/evil-objc-headers
NODE_EXTRA_CA_CERTS=/tmp/evil-ca.pem | SSL_CERT_FILE=/tmp/evil-cert.pem
SSL_CERT_DIR=/tmp/evil-cert-dir | REQUESTS_CA_BUNDLE=/tmp/evil-requests-ca.pem
CURL_CA_BUNDLE=/tmp/evil-curl-ca.pem | GIT_ALLOW_PROTOCOL=ext | GIT_DIR=/tmp/evil-git-dir
GIT_WORK_TREE=/tmp/evil-work-tree | GIT_COMMON_DIR=/tmp/evil-common-dir
GIT_INDEX_FILE=/tmp/evil-git-index | GIT_OBJECT_DIRECTORY=/tmp/evil-git-objects
GIT_ALTERNATE_OBJECT_DIRECTORIES=/tmp/evil-git-alt-objects | GIT_NAMESPACE=evil-namespace
GIT_PROTOCOL_FROM_USER=1 | GOPROXY=https://example.invalid/proxy
GONOSUMCHECK=example.invalid/* | GONOSUMDB=example.invalid/* | GONOPROXY=example.invalid/*
GOPRIVATE=example.invalid/* | GOENV=/tmp/evil-goenv | GOPATH=/tmp/evil-go
CARGO_HOME=/tmp/evil-cargo | HGRCPATH=/tmp/evil-hgrc
MAKEFLAGS=--eval=$(shell touch /tmp/pwned) | MFLAGS=--eval=$(shell touch /tmp/pwned-too)
HELM_HOME=/tmp/evil-helm | NODE_REDIRECT_WARNINGS=/tmp/node-warnings.log
NODE_REPL_EXTERNAL_MODULE=/tmp/pwn.js | NODE_REPL_HISTORY=/tmp/node-repl-history
NODE_V8_COVERAGE=/tmp/coverage | PYTHONUSERBASE=/tmp/evil-python-userbase
RUSTC_WRAPPER=/tmp/evil-rustc-wrapper | RUSTFLAGS=-C link-args=-l/tmp/evil.so
RUSTUP_DIST_ROOT=https://evil.example.test/deprecated-dist
RUSTUP_DIST_SERVER=https://evil.example.test | RUSTUP_HOME=/tmp/evil-rustup-home
RUSTUP_TOOLCHAIN=/tmp/evil-toolchain | RUSTUP_UPDATE_ROOT=https://evil.example.test/rustup
VIRTUAL_ENV=/tmp/evil-venv | CONDA_DEFAULT_ENV=evil-conda | CONDA_PREFIX=/tmp/evil-conda
JAVA_OPTS=-javaagent:/tmp/evil.jar | YARN_RC_FILENAME=.evil-yarnrc.yml
HTTPS_PROXY=http://proxy.example.test:8080 | GIT_SSL_NO_VERIFY=1
GIT_SSL_CAINFO=/tmp/evil-git-ca.pem | GIT_SSL_CAPATH=/tmp/evil-git-capath
NODE_TLS_REJECT_UNAUTHORIZED=0 | SAFE_KEY=ok | BAD-KEY=bad`);
    const result = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: {
        PATH: "/usr/bin:/bin",
      },
      overrides,
    });

    expect(result.rejectedOverrideBlockedKeys).toEqual(
      listKeys(`AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE AZURE_AUTH_LOCATION
CARGO_BUILD_RUSTC_WRAPPER CARGO_HOME CARGO_REGISTRIES_CRATES_IO_INDEX CLASSPATH CMAKE_C_COMPILER
CONDA_DEFAULT_ENV CONDA_PREFIX CPATH CPLUS_INCLUDE_PATH CPP CURL_CA_BUNDLE CXX C_INCLUDE_PATH
DOCKER_CERT_PATH DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY GIT_ALLOW_PROTOCOL
GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_DIR GIT_INDEX_FILE GIT_NAMESPACE
GIT_OBJECT_DIRECTORY GIT_PROTOCOL_FROM_USER GIT_SSL_CAINFO GIT_SSL_CAPATH GIT_SSL_NO_VERIFY
GIT_WORK_TREE GOENV GONOPROXY GONOSUMCHECK GONOSUMDB GOOGLE_APPLICATION_CREDENTIALS GOPATH
GOPRIVATE GOPROXY HELM_HOME HGRCPATH HTTPS_PROXY JAVA_OPTS KUBECONFIG LIBRARY_PATH MAKEFLAGS
MFLAGS NODE_EXTRA_CA_CERTS NODE_REDIRECT_WARNINGS NODE_REPL_EXTERNAL_MODULE NODE_REPL_HISTORY
NODE_TLS_REJECT_UNAUTHORIZED NODE_V8_COVERAGE OBJC_INCLUDE_PATH PATH PIP_CONFIG_FILE
PIP_EXTRA_INDEX_URL PIP_FIND_LINKS PIP_INDEX_URL PIP_PYPI_URL PIP_TRUSTED_HOST PYTHONUSERBASE
REQUESTS_CA_BUNDLE RUSTC_WRAPPER RUSTFLAGS RUSTUP_DIST_ROOT RUSTUP_DIST_SERVER RUSTUP_HOME
RUSTUP_TOOLCHAIN RUSTUP_UPDATE_ROOT SSL_CERT_DIR SSL_CERT_FILE UV_DEFAULT_INDEX UV_EXTRA_INDEX_URL
UV_INDEX UV_INDEX_URL UV_PYTHON VIRTUAL_ENV YARN_RC_FILENAME`),
    );
    expect(result.rejectedOverrideInvalidKeys).toEqual(["BAD-KEY"]);
    expect(result.env.SAFE_KEY).toBe("ok");
    expect(result.env.PATH).toBe("/usr/bin:/bin");
    expectEnvKeysUndefined(
      result.env,
      `CLASSPATH CXX CMAKE_C_COMPILER CARGO_BUILD_RUSTC_WRAPPER CARGO_REGISTRIES_CRATES_IO_INDEX
PIP_INDEX_URL PIP_PYPI_URL PIP_EXTRA_INDEX_URL PIP_CONFIG_FILE PIP_FIND_LINKS PIP_TRUSTED_HOST
UV_INDEX UV_INDEX_URL UV_PYTHON UV_DEFAULT_INDEX UV_EXTRA_INDEX_URL KUBECONFIG
GOOGLE_APPLICATION_CREDENTIALS AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE
AZURE_AUTH_LOCATION GIT_SSL_NO_VERIFY GIT_SSL_CAINFO GIT_SSL_CAPATH DOCKER_HOST
DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONTEXT LIBRARY_PATH CPATH C_INCLUDE_PATH
CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR
REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE
GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_OBJECT_DIRECTORY GIT_NAMESPACE GIT_ALLOW_PROTOCOL
GIT_PROTOCOL_FROM_USER GOPROXY GONOSUMCHECK GONOSUMDB GONOPROXY GOPRIVATE GOENV GOPATH
CARGO_HOME HGRCPATH HELM_HOME NODE_REDIRECT_WARNINGS NODE_REPL_EXTERNAL_MODULE NODE_REPL_HISTORY
NODE_V8_COVERAGE HTTPS_PROXY JAVA_OPTS MAKEFLAGS MFLAGS NODE_TLS_REJECT_UNAUTHORIZED
PYTHONUSERBASE RUSTC_WRAPPER RUSTFLAGS RUSTUP_DIST_ROOT RUSTUP_DIST_SERVER RUSTUP_HOME
RUSTUP_TOOLCHAIN RUSTUP_UPDATE_ROOT VIRTUAL_ENV CONDA_DEFAULT_ENV CONDA_PREFIX YARN_RC_FILENAME`,
    );
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
        LC_TIME: "C",
      },
    });
    expect(overrides).toEqual({
      LANG: "C",
      LC_ALL: "C",
      LC_TIME: "C",
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
});

describe("git env exploit regression", () => {
  it("blocks inherited GIT_ALLOW_PROTOCOL so git cannot enable ext transport helpers", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const helperDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-allow-protocol-${process.pid}-${Date.now()}-`),
    );
    const helperPath = path.join(helperDir, "ext-helper.sh");
    const marker = path.join(
      os.tmpdir(),
      `openclaw-git-allow-protocol-marker-${process.pid}-${Date.now()}`,
    );

    try {
      clearMarker(marker);
      fs.writeFileSync(helperPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, "utf8");
      fs.chmodSync(helperPath, 0o755);

      const target = `ext::${helperPath}`;
      const unsafeEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_ALLOW_PROTOCOL: "ext",
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

  it("filters inherited GIT_ALLOW_PROTOCOL without widening file transport access", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-git-allow-protocol-source-${process.pid}-${Date.now()}-`),
    );
    const cloneDir = path.join(
      os.tmpdir(),
      `openclaw-git-allow-protocol-clone-${process.pid}-${Date.now()}`,
    );

    try {
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

      const inheritedEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_ALLOW_PROTOCOL: "https::ssh",
        GIT_TERMINAL_PROMPT: "0",
      };
      const unsafeExitCode = await runGitCommandExitCode(gitPath, ["clone", repoDir, cloneDir], {
        env: inheritedEnv,
      });

      expect(unsafeExitCode).not.toBe(0);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv: inheritedEnv,
      });

      expect(safeEnv.GIT_ALLOW_PROTOCOL).toBe("https:ssh");

      const safeExitCode = await runGitCommandExitCode(gitPath, ["clone", repoDir, cloneDir], {
        env: safeEnv,
      });

      expect(safeExitCode).not.toBe(0);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("forces inherited permissive GIT_PROTOCOL_FROM_USER to block file transport access", async () => {
    const gitPath = getSystemGitPath();
    if (!gitPath) {
      return;
    }

    const repoDir = fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        `openclaw-git-protocol-from-user-source-${process.pid}-${Date.now()}-`,
      ),
    );
    const unsafeCloneDir = path.join(
      os.tmpdir(),
      `openclaw-git-protocol-from-user-unsafe-${process.pid}-${Date.now()}`,
    );
    const safeCloneDir = path.join(
      os.tmpdir(),
      `openclaw-git-protocol-from-user-safe-${process.pid}-${Date.now()}`,
    );

    try {
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

      const inheritedEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_PROTOCOL_FROM_USER: "1",
        GIT_TERMINAL_PROMPT: "0",
      };
      const unsafeExitCode = await runGitCommandExitCode(
        gitPath,
        ["clone", repoDir, unsafeCloneDir],
        { env: inheritedEnv },
      );

      expect(unsafeExitCode).toBe(0);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv: inheritedEnv,
      });

      expect(safeEnv.GIT_PROTOCOL_FROM_USER).toBe("0");

      const safeExitCode = await runGitCommandExitCode(gitPath, ["clone", repoDir, safeCloneDir], {
        env: safeEnv,
      });

      expect(safeExitCode).not.toBe(0);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(unsafeCloneDir, { recursive: true, force: true });
      fs.rmSync(safeCloneDir, { recursive: true, force: true });
    }
  });
});

type HostEnvReportedBaseline = {
  source: string;
  generatedAt: string;
  reportedDangerousEverywhereKeys: string[];
  reportedDangerousOverrideOnlyKeys: string[];
  expectedTotalReportedEntries: number;
};

function readBaselineAndPolicy(): {
  baseline: HostEnvReportedBaseline;
  allowedInheritedOverrideOnlyKeys: string[];
} {
  const repoRoot = process.cwd();
  const baselinePath = path.join(repoRoot, "src/infra/host-env-security.reported-baseline.json");
  const policyPath = path.join(repoRoot, "src/infra/host-env-security-policy.json");
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as HostEnvReportedBaseline;
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as {
    allowedInheritedOverrideOnlyKeys?: string[];
  };
  return {
    baseline,
    allowedInheritedOverrideOnlyKeys: (policy.allowedInheritedOverrideOnlyKeys ?? []).map((key) =>
      key.toUpperCase(),
    ),
  };
}

function sortUniqueUpper(values: string[]): string[] {
  return sortUniqueStrings(values.map((value) => value.toUpperCase()));
}

describe("host env reported baseline coverage", () => {
  it("keeps the fixed reported dangerous env baseline fully covered by inherited + override sanitization", () => {
    const { baseline, allowedInheritedOverrideOnlyKeys } = readBaselineAndPolicy();

    expect(
      baseline.reportedDangerousEverywhereKeys.length +
        baseline.reportedDangerousOverrideOnlyKeys.length,
    ).toBe(baseline.expectedTotalReportedEntries);
    expect(baseline.expectedTotalReportedEntries).toBe(266);
    expect(sortUniqueUpper(baseline.reportedDangerousEverywhereKeys)).toEqual(
      baseline.reportedDangerousEverywhereKeys,
    );
    expect(sortUniqueUpper(baseline.reportedDangerousOverrideOnlyKeys)).toEqual(
      baseline.reportedDangerousOverrideOnlyKeys,
    );

    const inheritedInput: Record<string, string> = {
      PATH: "/usr/bin:/bin",
    };
    for (const key of baseline.reportedDangerousEverywhereKeys) {
      inheritedInput[key] = `${key.toLowerCase()}-from-inherited`;
    }
    for (const key of baseline.reportedDangerousOverrideOnlyKeys) {
      inheritedInput[key] = `${key.toLowerCase()}-from-inherited`;
    }
    const inheritedSanitized = sanitizeHostExecEnv({ baseEnv: inheritedInput });

    for (const key of baseline.reportedDangerousEverywhereKeys) {
      expect(isDangerousHostEnvVarName(key)).toBe(true);
      expect(isDangerousHostInheritedEnvVarName(key)).toBe(true);
      if (key === "GIT_ALLOW_PROTOCOL") {
        expect(inheritedSanitized[key]).toBe("");
        continue;
      }
      if (key === "GIT_PROTOCOL_FROM_USER") {
        expect(inheritedSanitized[key]).toBe(`${key.toLowerCase()}-from-inherited`);
        continue;
      }
      expect(inheritedSanitized[key]).toBeUndefined();
    }

    // Pin the reviewed exception set independently of the production policy.
    expect(allowedInheritedOverrideOnlyKeys.toSorted()).toEqual([
      "ALL_PROXY",
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AZURE_AUTH_LOCATION",
      "CURL_CA_BUNDLE",
      "DOCKER_CERT_PATH",
      "DOCKER_CONTEXT",
      "DOCKER_HOST",
      "DOCKER_TLS_VERIFY",
      "GIT_PAGER",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GRADLE_USER_HOME",
      "HISTFILE",
      "HOME",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "KUBECONFIG",
      "MANPAGER",
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "NO_PROXY",
      "PAGER",
      "REQUESTS_CA_BUNDLE",
      "RUSTUP_DIST_ROOT",
      "RUSTUP_DIST_SERVER",
      "RUSTUP_HOME",
      "RUSTUP_TOOLCHAIN",
      "RUSTUP_UPDATE_ROOT",
      "SSH_AUTH_SOCK",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
      "SYSTEMROOT",
      "WINDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_DIRS",
      "XDG_CONFIG_HOME",
      "XDG_DATA_DIRS",
      "XDG_DATA_HOME",
      "XDG_RUNTIME_DIR",
      "XDG_STATE_HOME",
      "ZDOTDIR",
    ]);

    const inheritedAllowlist = new Set(allowedInheritedOverrideOnlyKeys);
    for (const key of baseline.reportedDangerousOverrideOnlyKeys) {
      expect(isDangerousHostEnvOverrideVarName(key)).toBe(true);
      if (inheritedAllowlist.has(key)) {
        expect(isDangerousHostInheritedEnvVarName(key)).toBe(false);
        expect(inheritedSanitized[key]).toBe(`${key.toLowerCase()}-from-inherited`);
      } else {
        expect(isDangerousHostInheritedEnvVarName(key)).toBe(true);
        expect(inheritedSanitized[key]).toBeUndefined();
      }
    }

    const overrideInput: Record<string, string> = {};
    for (const key of baseline.reportedDangerousEverywhereKeys) {
      overrideInput[key] = `${key.toLowerCase()}-from-override`;
    }
    for (const key of baseline.reportedDangerousOverrideOnlyKeys) {
      overrideInput[key] = `${key.toLowerCase()}-from-override`;
    }

    const overrideResult = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: { PATH: "/usr/bin:/bin" },
      overrides: overrideInput,
    });
    const expectedRejectedOverrideKeys = sortUniqueUpper([
      ...baseline.reportedDangerousEverywhereKeys,
      ...baseline.reportedDangerousOverrideOnlyKeys,
    ]);
    expect(overrideResult.rejectedOverrideBlockedKeys).toEqual(expectedRejectedOverrideKeys);
    expect(overrideResult.rejectedOverrideInvalidKeys).toStrictEqual([]);

    for (const key of expectedRejectedOverrideKeys) {
      expect(overrideResult.env[key]).toBeUndefined();
    }
  });
});

function parseSwiftStringArray(source: string, marker: string): string[] {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escapedMarker}[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\]`, "m");
  const match = source.match(re);
  if (!match) {
    throw new Error(`Failed to parse Swift array for marker: ${marker}`);
  }
  const arrayBody = expectDefined(match[1], `Swift array body for ${marker}`);
  return Array.from(arrayBody.matchAll(/"([^"]+)"/g), (entry) =>
    expectDefined(entry[1], `Swift array entry for ${marker}`),
  );
}

function readRepoFile(repoRoot: string, relativePath: string): string {
  try {
    return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  // Sparse worktrees may omit app sources, but the tracked blob is still the parity source.
  return execFileSync("git", ["show", `HEAD:${relativePath}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("host env security policy parity", () => {
  it("keeps generated macOS host env policy in sync with shared JSON policy", () => {
    const repoRoot = process.cwd();
    const policyPath = path.join(repoRoot, "src/infra/host-env-security-policy.json");

    const rawPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    const policy = loadHostEnvSecurityPolicy(rawPolicy);
    const generatedSource = readRepoFile(
      repoRoot,
      "apps/macos/Sources/OpenClaw/HostEnvSecurityPolicy.generated.swift",
    );
    const sanitizerSource = readRepoFile(
      repoRoot,
      "apps/macos/Sources/OpenClaw/HostEnvSanitizer.swift",
    );

    const swiftBlockedKeys = parseSwiftStringArray(generatedSource, "static let blockedKeys");
    const swiftBlockedInheritedKeys = parseSwiftStringArray(
      generatedSource,
      "static let blockedInheritedKeys",
    );
    const swiftBlockedInheritedPrefixes = parseSwiftStringArray(
      generatedSource,
      "static let blockedInheritedPrefixes",
    );
    const swiftBlockedOverrideKeys = parseSwiftStringArray(
      generatedSource,
      "static let blockedOverrideKeys",
    );
    const swiftBlockedOverridePrefixes = parseSwiftStringArray(
      generatedSource,
      "static let blockedOverridePrefixes",
    );
    const swiftBlockedPrefixes = parseSwiftStringArray(
      generatedSource,
      "static let blockedPrefixes",
    );

    expect(swiftBlockedInheritedKeys).toEqual(policy.blockedInheritedKeys);
    expect(swiftBlockedInheritedPrefixes).toEqual(policy.blockedInheritedPrefixes ?? []);
    expect(swiftBlockedKeys).toEqual(policy.blockedKeys);
    expect(swiftBlockedOverrideKeys).toEqual(policy.blockedOverrideKeys ?? []);
    expect(swiftBlockedOverridePrefixes).toEqual(policy.blockedOverridePrefixes ?? []);
    expect(swiftBlockedPrefixes).toEqual(policy.blockedPrefixes);

    // The sanitizer may consume the generated policy directly or through local aliases.
    const consumedPolicyFields = Array.from(
      sanitizerSource.matchAll(/\bHostEnvSecurityPolicy\s*\.\s*(\w+)/g),
      (match) => expectDefined(match[1], "Swift policy field"),
    );
    expect(new Set(consumedPolicyFields)).toEqual(
      new Set([
        "blockedInheritedKeys",
        "blockedInheritedPrefixes",
        "blockedKeys",
        "blockedOverrideKeys",
        "blockedOverridePrefixes",
        "blockedPrefixes",
      ]),
    );
  });
});
