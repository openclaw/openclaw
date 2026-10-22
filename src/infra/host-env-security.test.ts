import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { loadHostEnvSecurityPolicy } from "./host-env-security-policy.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostInheritedEnvVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
  sanitizeHostExecEnv,
  sanitizeHostExecEnvWithDiagnostics,
  sanitizeSystemRunEnvOverrides,
  setGatewayCredentialEnvKeys,
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

function listKeys(source: string): string[] {
  return source.trim().split(/\s+/u);
}

async function runGitCommandExitCode(
  gitPath: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const child = spawn(gitPath, args, {
      env,
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
    const env = sanitizeHostExecEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        LD_PRELOAD: "/tmp/pwn.so",
        OK: "1",
        GIT_ALLOW_PROTOCOL: "ext",
        GIT_PROTOCOL_FROM_USER: "1",
      },
    });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      OK: "1",
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
      GIT_ALLOW_PROTOCOL: "",
      GIT_PROTOCOL_FROM_USER: "0",
    });
  });

  it("withholds the env sources of Gateway credentials from inherited host exec env", () => {
    const baseEnv = {
      PATH: "/usr/bin:/bin",
      OPENCLAW_HOOK_TOKEN: "synthetic-hook-token",
      OK: "1",
    };
    try {
      setGatewayCredentialEnvKeys("test", ["openclaw_hook_token"]);
      expect(sanitizeHostExecEnv({ baseEnv })).toEqual({
        PATH: "/usr/bin:/bin",
        OK: "1",
        OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
      });
      // A command's own requested value is not the Gateway credential and still applies.
      expect(
        sanitizeHostExecEnv({ baseEnv, overrides: { OPENCLAW_HOOK_TOKEN: "requested" } })
          .OPENCLAW_HOOK_TOKEN,
      ).toBe("requested");
      // Owners publish independently; clearing one keeps the other withheld.
      setGatewayCredentialEnvKeys("other", ["OK"]);
      setGatewayCredentialEnvKeys("test", []);
      expect(sanitizeHostExecEnv({ baseEnv })).toEqual({
        PATH: "/usr/bin:/bin",
        OPENCLAW_HOOK_TOKEN: "synthetic-hook-token",
        OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
      });
    } finally {
      setGatewayCredentialEnvKeys("test", []);
      setGatewayCredentialEnvKeys("other", []);
    }
    expect(sanitizeHostExecEnv({ baseEnv }).OPENCLAW_HOOK_TOKEN).toBe("synthetic-hook-token");
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

it("reports blocked and invalid requested overrides", () => {
  const blockedKeys = ["CARGO_REGISTRIES_CRATES_IO_INDEX", "PATH"];
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
  expect(result.env).toMatchObject({ SAFE_KEY: "ok", PATH: "/usr/bin:/bin" });
  expect(result.env.CARGO_REGISTRIES_CRATES_IO_INDEX).toBeUndefined();
});

it("normalizes and validates keys", () => {
  expect(normalizeEnvVarKey(" OPENROUTER_API_KEY ")).toBe("OPENROUTER_API_KEY");
  expect(normalizeEnvVarKey("NOT-PORTABLE", { portable: true })).toBeNull();
  expect(normalizeEnvVarKey(" BASH_FUNC_echo%% ")).toBe("BASH_FUNC_echo%%");
  expect(normalizeEnvVarKey("   ")).toBeNull();
});

describe("sanitizeSystemRunEnvOverrides", () => {
  it.each([
    [false, { OPENCLAW_TEST: "1", TOKEN: "abc", LANG: "C", LC_ALL: "C", LC_TIME: "C" }],
    [true, { LANG: "C", LC_ALL: "C", LC_TIME: "C" }],
  ] as const)(
    "filters shell-wrapper overrides only when enabled (%s)",
    (shellWrapper, expected) => {
      expect(
        sanitizeSystemRunEnvOverrides({
          shellWrapper,
          overrides: { OPENCLAW_TEST: "1", TOKEN: "abc", LANG: "C", LC_ALL: "C", LC_TIME: "C" },
        }),
      ).toEqual(expected);
    },
  );

  it("returns undefined when no shell-wrapper overrides survive", () => {
    expect(
      sanitizeSystemRunEnvOverrides({ shellWrapper: true, overrides: { TOKEN: "abc" } }),
    ).toBeUndefined();
    expect(sanitizeSystemRunEnvOverrides({ shellWrapper: true })).toBeUndefined();
  });
});

const gitEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0" };
type GitFixture = {
  git: (args: string[], env?: NodeJS.ProcessEnv) => Promise<number | null>;
  root: string;
};

async function withGitWorkspace(run: (fixture: GitFixture) => Promise<void>) {
  const gitPath = findSystemCommandPath("git");
  if (!gitPath) {
    return;
  }
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    runGitCommandExitCode(gitPath, args, env);
  await withTestDir({ prefix: "openclaw-git-protocol-" }, (root) => run({ git, root }));
}

async function withGitRepo(run: (fixture: GitFixture & { repoDir: string }) => Promise<void>) {
  await withGitWorkspace(async ({ git, root }) => {
    const repoDir = path.join(root, "source");
    await git(["init", repoDir]);
    await git(
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
      { PATH: gitEnv.PATH },
    );
    await run({ git, repoDir, root });
  });
}

describe("git env exploit regression", () => {
  it("blocks inherited GIT_ALLOW_PROTOCOL so git cannot enable ext transport helpers", async () => {
    await withGitWorkspace(async ({ git, root }) => {
      const helperPath = path.join(root, "ext-helper.sh");
      const marker = path.join(root, "marker");
      fs.writeFileSync(helperPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, "utf8");
      fs.chmodSync(helperPath, 0o755);

      const target = `ext::${helperPath}`;
      const unsafeEnv = {
        ...gitEnv,
        GIT_ALLOW_PROTOCOL: "ext",
      };
      await git(["ls-remote", target], unsafeEnv);
      expect(fs.existsSync(marker)).toBe(true);
      fs.unlinkSync(marker);
      await git(["ls-remote", target], sanitizeHostExecEnv({ baseEnv: unsafeEnv }));
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  it("filters inherited GIT_ALLOW_PROTOCOL without widening file transport access", async () => {
    await withGitRepo(async ({ git, repoDir, root }) => {
      const cloneDir = path.join(root, "clone");
      const inheritedEnv = { ...gitEnv, GIT_ALLOW_PROTOCOL: "https::ssh" };
      expect(await git(["clone", repoDir, cloneDir], inheritedEnv)).not.toBe(0);
      const safeEnv = sanitizeHostExecEnv({ baseEnv: inheritedEnv });
      expect(safeEnv.GIT_ALLOW_PROTOCOL).toBe("https:ssh");
      expect(await git(["clone", repoDir, cloneDir], safeEnv)).not.toBe(0);
    });
  });

  it("forces inherited permissive GIT_PROTOCOL_FROM_USER to block file transport access", async () => {
    await withGitRepo(async ({ git, repoDir, root }) => {
      const inheritedEnv = { ...gitEnv, GIT_PROTOCOL_FROM_USER: "1" };
      expect(await git(["clone", repoDir, path.join(root, "unsafe")], inheritedEnv)).toBe(0);
      const safeEnv = sanitizeHostExecEnv({ baseEnv: inheritedEnv });
      expect(safeEnv.GIT_PROTOCOL_FROM_USER).toBe("0");
      expect(await git(["clone", repoDir, path.join(root, "safe")], safeEnv)).not.toBe(0);
    });
  });
});

type HostEnvReportedBaseline = {
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
  const inheritedInput: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", ...inputs("inherited") };
  const inheritedSanitized = sanitizeHostExecEnv({ baseEnv: inheritedInput });

  for (const key of baseline.reportedDangerousEverywhereKeys) {
    const expected =
      key === "GIT_ALLOW_PROTOCOL"
        ? ""
        : key === "GIT_PROTOCOL_FROM_USER"
          ? inheritedInput[key]
          : undefined;
    expect([
      isDangerousHostEnvVarName(key),
      isDangerousHostInheritedEnvVarName(key),
      inheritedSanitized[key],
    ]).toEqual([true, true, expected]);
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
    const allowed = inheritedAllowlist.has(key);
    expect([
      isDangerousHostEnvOverrideVarName(key),
      isDangerousHostInheritedEnvVarName(key),
      inheritedSanitized[key],
    ]).toEqual([true, !allowed, allowed ? inheritedInput[key] : undefined]);
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
