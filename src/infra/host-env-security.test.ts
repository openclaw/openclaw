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

function envRecord(entries: string): Record<string, string> {
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
  it("preserves Gateway identity for child commands that need their custom service", () => {
    const serviceEnv = {
      OPENCLAW_SERVICE_KIND: "gateway",
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.custom",
      OPENCLAW_SYSTEMD_UNIT: "custom-gateway.service",
      OPENCLAW_WINDOWS_TASK_NAME: "Custom Gateway",
      OPENCLAW_GATEWAY_SERVICE_PID: "12345",
    };
    expect(sanitizeHostExecEnv({ baseEnv: serviceEnv })).toEqual({
      ...serviceEnv,
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
    });
  });

  it("removes dangerous inherited keys while preserving PATH", () => {
    const baseEnv = envRecord(`PATH=/usr/bin:/bin | BASH_ENV=/tmp/pwn.sh | BROWSER=/tmp/pwn-browser
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
NODE_REPL_HISTORY=/tmp/node-repl-history | NODE_V8_COVERAGE=/tmp/coverage | OK=1`);
    const env = sanitizeHostExecEnv({ baseEnv });

    const allowedKeys = listKeys(
      `PATH AWS_CONFIG_FILE KUBECONFIG GOOGLE_APPLICATION_CREDENTIALS AWS_SHARED_CREDENTIALS_FILE
AWS_WEB_IDENTITY_TOKEN_FILE AZURE_AUTH_LOCATION SSH_AUTH_SOCK HTTP_PROXY HTTPS_PROXY SSL_CERT_FILE
SSL_CERT_DIR DOCKER_CONTEXT DOCKER_HOST RUSTUP_DIST_ROOT RUSTUP_DIST_SERVER RUSTUP_HOME
RUSTUP_TOOLCHAIN RUSTUP_UPDATE_ROOT OK`,
    );
    expect(env).toEqual({
      ...Object.fromEntries(allowedKeys.map((key) => [key, baseEnv[key]])),
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
      GIT_ALLOW_PROTOCOL: "",
      GIT_PROTOCOL_FROM_USER: "0",
    });
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
    const blockedKeys =
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
UV_INDEX UV_INDEX_URL UV_PYTHON VIRTUAL_ENV YARN_RC_FILENAME`);
    const result = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: { PATH: "/usr/bin:/bin" },
      overrides: {
        ...Object.fromEntries(blockedKeys.map((key) => [key, "untrusted"])),
        SAFE_KEY: "ok",
        "BAD-KEY": "bad",
      },
    });
    expect(result.rejectedOverrideBlockedKeys).toEqual(blockedKeys);

    expect(result.rejectedOverrideInvalidKeys).toEqual(["BAD-KEY"]);
    expect(result.env.SAFE_KEY).toBe("ok");
    expect(result.env.PATH).toBe("/usr/bin:/bin");
    expectEnvKeysUndefined(result.env, blockedKeys.filter((key) => key !== "PATH").join(" "));
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
      overrides: { OPENCLAW_TEST: "1", TOKEN: "abc" },
    });
    expect(overrides).toEqual({ OPENCLAW_TEST: "1", TOKEN: "abc" });
  });

  it("drops non-allowlisted overrides for shell wrappers", () => {
    const overrides = sanitizeSystemRunEnvOverrides({
      shellWrapper: true,
      overrides: { OPENCLAW_TEST: "1", TOKEN: "abc", LANG: "C", LC_ALL: "C", LC_TIME: "C" },
    });
    expect(overrides).toEqual({ LANG: "C", LC_ALL: "C", LC_TIME: "C" });
  });

  it("returns undefined when no shell-wrapper overrides survive", () => {
    expect(
      sanitizeSystemRunEnvOverrides({
        shellWrapper: true,
        overrides: { TOKEN: "abc" },
      }),
    ).toBeUndefined();
    expect(sanitizeSystemRunEnvOverrides({ shellWrapper: true })).toBeUndefined();
  });
});

const gitEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0" };

async function withGitRepo(
  run: (fixture: { gitPath: string; repoDir: string; root: string }) => Promise<void>,
) {
  const gitPath = getSystemGitPath();
  if (!gitPath) {
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-git-protocol-"));
  const repoDir = path.join(root, "source");
  try {
    await runGitCommandExitCode(gitPath, ["init", repoDir]);
    await runGitCommandExitCode(
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
      { env: { PATH: gitEnv.PATH } },
    );
    await run({ gitPath, repoDir, root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

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

      await runGitCommandExitCode(gitPath, ["ls-remote", target], { env: unsafeEnv });

      expect(fs.existsSync(marker)).toBe(true);
      clearMarker(marker);

      const safeEnv = sanitizeHostExecEnv({
        baseEnv: unsafeEnv,
      });

      await runGitCommandExitCode(gitPath, ["ls-remote", target], { env: safeEnv });

      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(helperDir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  });

  it("filters inherited GIT_ALLOW_PROTOCOL without widening file transport access", async () => {
    await withGitRepo(async ({ gitPath, repoDir, root }) => {
      const cloneDir = path.join(root, "clone");
      const inheritedEnv = { ...gitEnv, GIT_ALLOW_PROTOCOL: "https::ssh" };
      expect(
        await runGitCommandExitCode(gitPath, ["clone", repoDir, cloneDir], {
          env: inheritedEnv,
        }),
      ).not.toBe(0);
      const safeEnv = sanitizeHostExecEnv({ baseEnv: inheritedEnv });
      expect(safeEnv.GIT_ALLOW_PROTOCOL).toBe("https:ssh");
      expect(
        await runGitCommandExitCode(gitPath, ["clone", repoDir, cloneDir], {
          env: safeEnv,
        }),
      ).not.toBe(0);
    });
  });

  it("forces inherited permissive GIT_PROTOCOL_FROM_USER to block file transport access", async () => {
    await withGitRepo(async ({ gitPath, repoDir, root }) => {
      const inheritedEnv = { ...gitEnv, GIT_PROTOCOL_FROM_USER: "1" };
      expect(
        await runGitCommandExitCode(gitPath, ["clone", repoDir, path.join(root, "unsafe")], {
          env: inheritedEnv,
        }),
      ).toBe(0);
      const safeEnv = sanitizeHostExecEnv({ baseEnv: inheritedEnv });
      expect(safeEnv.GIT_PROTOCOL_FROM_USER).toBe("0");
      expect(
        await runGitCommandExitCode(gitPath, ["clone", repoDir, path.join(root, "safe")], {
          env: safeEnv,
        }),
      ).not.toBe(0);
    });
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

    const reportedKeys = [
      ...baseline.reportedDangerousEverywhereKeys,
      ...baseline.reportedDangerousOverrideOnlyKeys,
    ];
    const inputs = (source: string) =>
      Object.fromEntries(reportedKeys.map((key) => [key, `${key.toLowerCase()}-from-${source}`]));
    const inheritedInput = { PATH: "/usr/bin:/bin", ...inputs("inherited") };
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
    expect(allowedInheritedOverrideOnlyKeys.toSorted()).toEqual(
      listKeys(
        `ALL_PROXY AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE AZURE_AUTH_LOCATION
CURL_CA_BUNDLE DOCKER_CERT_PATH DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY GIT_PAGER
GOOGLE_APPLICATION_CREDENTIALS GRADLE_USER_HOME HISTFILE HOME HTTPS_PROXY HTTP_PROXY KUBECONFIG
MANPAGER NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED NO_PROXY PAGER REQUESTS_CA_BUNDLE
RUSTUP_DIST_ROOT RUSTUP_DIST_SERVER RUSTUP_HOME RUSTUP_TOOLCHAIN RUSTUP_UPDATE_ROOT SSH_AUTH_SOCK
SSL_CERT_DIR SSL_CERT_FILE SYSTEMROOT WINDIR XDG_CACHE_HOME XDG_CONFIG_DIRS XDG_CONFIG_HOME
XDG_DATA_DIRS XDG_DATA_HOME XDG_RUNTIME_DIR XDG_STATE_HOME ZDOTDIR`,
      ),
    );

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

    const overrideResult = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: { PATH: "/usr/bin:/bin" },
      overrides: inputs("override"),
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

    const fields = [
      "blockedInheritedKeys",
      "blockedInheritedPrefixes",
      "blockedKeys",
      "blockedOverrideKeys",
      "blockedOverridePrefixes",
      "blockedPrefixes",
    ] as const;
    for (const field of fields) {
      expect(parseSwiftStringArray(generatedSource, `static let ${field}`)).toEqual(policy[field]);
    }

    // The sanitizer may consume the generated policy directly or through local aliases.
    const consumedPolicyFields = Array.from(
      sanitizerSource.matchAll(/\bHostEnvSecurityPolicy\s*\.\s*(\w+)/g),
      (match) => expectDefined(match[1], "Swift policy field"),
    );
    expect(new Set(consumedPolicyFields)).toEqual(new Set(fields));
  });
});
