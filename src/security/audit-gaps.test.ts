import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditOptions, SecurityAuditReport } from "./audit.js";
import { runSecurityAudit } from "./audit.js";

async function audit(
  cfg: OpenClawConfig,
  extra?: Omit<SecurityAuditOptions, "config">,
): Promise<SecurityAuditReport> {
  return runSecurityAudit({
    config: cfg,
    includeFilesystem: false,
    includeChannelSecurity: false,
    ...extra,
  });
}

function hasFinding(res: SecurityAuditReport, checkId: string, severity?: string): boolean {
  return res.findings.some(
    (f) => f.checkId === checkId && (severity == null || f.severity === severity),
  );
}

function expectFinding(res: SecurityAuditReport, checkId: string, severity?: string): void {
  expect(hasFinding(res, checkId, severity)).toBe(true);
}

function expectNoFinding(res: SecurityAuditReport, checkId: string): void {
  expect(hasFinding(res, checkId)).toBe(false);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PR 1: Token Expiry Check (T-PERSIST-004)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("gateway.token_no_expiry", () => {
  it("warns when token is set but no expiry or rotation configured", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { token: "a-long-enough-secret-token-1234" },
      },
    };
    const res = await audit(cfg, { env: {} });
    expectFinding(res, "gateway.token_no_expiry", "warn");
  });

  it("does not warn when tokenExpiry is configured", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "a-long-enough-secret-token-1234",
          tokenExpiry: "30d",
        },
      },
    };
    const res = await audit(cfg, { env: {} });
    expectNoFinding(res, "gateway.token_no_expiry");
  });

  it("does not warn when tokenRotation is configured", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "a-long-enough-secret-token-1234",
          tokenRotation: { enabled: true, intervalDays: 30 },
        },
      },
    };
    const res = await audit(cfg, { env: {} });
    expectNoFinding(res, "gateway.token_no_expiry");
  });

  it("does not warn when no token is configured", async () => {
    const cfg: OpenClawConfig = {
      gateway: { auth: {} },
    };
    const res = await audit(cfg, { env: {} });
    expectNoFinding(res, "gateway.token_no_expiry");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PR 2: Config-in-Git-Repo Check (T-ACCESS-003)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("fs.config.inside_git_repo", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audit-git-test-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("warns when config is inside a git repo", async () => {
    // Create a fake git repo
    const repoDir = path.join(fixtureRoot, "my-repo");
    const configDir = path.join(repoDir, ".openclaw");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(configDir, "openclaw.json");
    await fs.writeFile(configPath, "{}\n", "utf-8");
    await fs.chmod(configPath, 0o600);

    const cfg: OpenClawConfig = {};
    const res = await audit(cfg, {
      includeFilesystem: true,
      stateDir: configDir,
      configPath,
      env: {},
    });

    expectFinding(res, "fs.config.inside_git_repo", "warn");

    // check the remediation includes .gitignore advice
    const finding = res.findings.find((f) => f.checkId === "fs.config.inside_git_repo");
    expect(finding?.remediation).toContain(".gitignore");
  });

  it("does not warn when config is not inside a git repo", async () => {
    const noGitDir = path.join(fixtureRoot, "no-git-dir");
    await fs.mkdir(noGitDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(noGitDir, "openclaw.json");
    await fs.writeFile(configPath, "{}\n", "utf-8");
    await fs.chmod(configPath, 0o600);

    const cfg: OpenClawConfig = {};
    const res = await audit(cfg, {
      includeFilesystem: true,
      stateDir: noGitDir,
      configPath,
      env: {},
    });

    expectNoFinding(res, "fs.config.inside_git_repo");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PR 3: Dangerous Env Var Check (T-DISC-004)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("env.dangerous_vars_set", () => {
  it("warns when dangerous env vars are set", async () => {
    const cfg: OpenClawConfig = {};
    const res = await audit(cfg, {
      env: {
        NODE_OPTIONS: "--max-old-space-size=4096",
        GLIBC_TUNABLES: "glibc.tune.hwcaps=-AVX512F",
      },
    });
    expectFinding(res, "env.dangerous_vars_set", "warn");

    const finding = res.findings.find((f) => f.checkId === "env.dangerous_vars_set");
    expect(finding?.detail).toContain("NODE_OPTIONS");
    expect(finding?.detail).toContain("GLIBC_TUNABLES");
  });

  it("does not warn when no dangerous env vars are set", async () => {
    const cfg: OpenClawConfig = {};
    const res = await audit(cfg, {
      env: { HOME: "/home/user", PATH: "/usr/bin" },
    });
    expectNoFinding(res, "env.dangerous_vars_set");
  });

  it("ignores empty-string dangerous vars", async () => {
    const cfg: OpenClawConfig = {};
    const res = await audit(cfg, {
      env: { NODE_OPTIONS: "", LD_PRELOAD: "   " },
    });
    expectNoFinding(res, "env.dangerous_vars_set");
  });

  it("emits info when only language-tooling env vars are set", async () => {
    const cfg: OpenClawConfig = {};
    const res = await audit(cfg, {
      env: {
        PYTHONPATH: "/usr/lib/python3/dist-packages",
        JAVA_TOOL_OPTIONS: "-Xmx512m",
      },
    });
    expectNoFinding(res, "env.dangerous_vars_set");
    expectFinding(res, "env.lang_tooling_vars_set", "info");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PR 4: Web Fetch Allowlist Check (T-EXFIL-001)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("tools.web_fetch.no_url_allowlist", () => {
  it("warns when gateway is exposed and no web_fetch allowlist", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: { token: "a-long-enough-secret-token-1234" },
      },
    };
    const res = await audit(cfg, { env: {} });
    expectFinding(res, "tools.web_fetch.no_url_allowlist", "warn");
  });

  it("emits info when loopback and no web_fetch allowlist", async () => {
    const cfg: OpenClawConfig = {
      gateway: { bind: "loopback" },
    };
    const res = await audit(cfg, { env: {} });
    expectFinding(res, "tools.web_fetch.no_url_allowlist", "info");
  });

  it("does not warn when web_fetch is disabled", async () => {
    const cfg: OpenClawConfig = {
      gateway: { bind: "lan", auth: { token: "secret-token-long-enough" } },
      tools: { webFetch: false },
    };
    const res = await audit(cfg, { env: {} });
    expectNoFinding(res, "tools.web_fetch.no_url_allowlist");
  });

  it("does not warn when allowedUrls is configured", async () => {
    const cfg: OpenClawConfig = {
      gateway: { bind: "lan", auth: { token: "secret-token-long-enough" } },
      tools: { webFetch: { allowedUrls: ["https://api.example.com"] } },
    };
    const res = await audit(cfg, { env: {} });
    expectNoFinding(res, "tools.web_fetch.no_url_allowlist");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PR 5: Message Rate Limit Check (T-IMPACT-002)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("gateway.no_message_rate_limit", () => {
  it("warns when gateway is exposed with no message rate limit", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: { token: "a-long-enough-secret-token-1234" },
      },
    };
    const res = await audit(cfg, { env: {} });
    expectFinding(res, "gateway.no_message_rate_limit", "warn");
  });

  it("does not warn when loopback", async () => {
    const cfg: OpenClawConfig = {
      gateway: { bind: "loopback" },
    };
    const res = await audit(cfg, { env: {} });
    expectNoFinding(res, "gateway.no_message_rate_limit");
  });

  it("does not warn when rateLimit.enabled is true", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: { token: "a-long-enough-secret-token-1234" },
        rateLimit: { enabled: true },
      },
    };
    const res = await audit(cfg, { env: {} });
    expectNoFinding(res, "gateway.no_message_rate_limit");
  });

  it("does not warn when messageRateLimit is configured", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: { token: "a-long-enough-secret-token-1234" },
        messageRateLimit: { maxPerMinute: 60 },
      },
    };
    const res = await audit(cfg, { env: {} });
    expectNoFinding(res, "gateway.no_message_rate_limit");
  });
});
