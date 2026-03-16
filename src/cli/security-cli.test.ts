import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const loadConfig = vi.fn();
const runSecurityAudit = vi.fn();
const fixSecurityFootguns = vi.fn();
const resolveCommandSecretRefsViaGateway = vi.fn();
const getSecurityAuditCommandSecretTargetIds = vi.fn(
  () => new Set(["gateway.auth.token", "gateway.auth.password"]),
);

const { defaultRuntime, runtimeLogs, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfig(),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../security/audit.js", () => ({
  runSecurityAudit: (opts: unknown) => runSecurityAudit(opts),
}));

vi.mock("../security/fix.js", () => ({
  fixSecurityFootguns: () => fixSecurityFootguns(),
}));

vi.mock("./command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: (opts: unknown) => resolveCommandSecretRefsViaGateway(opts),
}));

vi.mock("./command-secret-targets.js", () => ({
  getSecurityAuditCommandSecretTargetIds: () => getSecurityAuditCommandSecretTargetIds(),
}));

const { registerSecurityCli } = await import("./security-cli.js");

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerSecurityCli(program);
  return program;
}

describe("security CLI", () => {
  beforeEach(() => {
    resetRuntimeCapture();
    loadConfig.mockReset();
    runSecurityAudit.mockReset();
    fixSecurityFootguns.mockReset();
    resolveCommandSecretRefsViaGateway.mockReset();
    getSecurityAuditCommandSecretTargetIds.mockClear();
    fixSecurityFootguns.mockResolvedValue({
      changes: [],
      actions: [],
      errors: [],
    });
  });

  it("runs audit with read-only SecretRef resolution and prints JSON diagnostics", async () => {
    const sourceConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    const resolvedConfig = {
      ...sourceConfig,
      gateway: {
        ...sourceConfig.gateway,
        auth: {
          ...sourceConfig.gateway.auth,
          token: "resolved-token",
        },
      },
    };
    loadConfig.mockReturnValue(sourceConfig);
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig,
      diagnostics: [
        "security audit: gateway secrets.resolve unavailable (gateway closed); resolved command secrets locally.",
      ],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    });
    runSecurityAudit.mockResolvedValue({
      ts: 0,
      summary: { critical: 0, warn: 1, info: 0 },
      findings: [
        {
          checkId: "gateway.probe_failed",
          severity: "warn",
          title: "Gateway probe failed (deep)",
          detail: "connect failed: connect ECONNREFUSED 127.0.0.1:18789",
        },
      ],
    });

    await createProgram().parseAsync(["security", "audit", "--json"], { from: "user" });

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        config: sourceConfig,
        commandName: "security audit",
        mode: "read_only_status",
        targetIds: expect.any(Set),
      }),
    );
    expect(runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
        sourceConfig,
        deep: false,
        includeFilesystem: true,
        includeChannelSecurity: true,
      }),
    );
    const payload = JSON.parse(String(runtimeLogs.at(-1)));
    expect(payload.secretDiagnostics).toEqual([
      "security audit: gateway secrets.resolve unavailable (gateway closed); resolved command secrets locally.",
    ]);
  });

  it("forwards --token to deep probe auth without altering command-level resolver mode", async () => {
    const sourceConfig = { gateway: { mode: "local" } };
    loadConfig.mockReturnValue(sourceConfig);
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: sourceConfig,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    });
    runSecurityAudit.mockResolvedValue({
      ts: 0,
      summary: { critical: 0, warn: 0, info: 0 },
      findings: [],
    });

    await createProgram().parseAsync(
      ["security", "audit", "--deep", "--token", "explicit-token", "--json"],
      {
        from: "user",
      },
    );

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "read_only_status",
      }),
    );
    expect(runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        deep: true,
        deepProbeAuth: { token: "explicit-token" },
      }),
    );
  });

  it("forwards --password to deep probe auth without altering command-level resolver mode", async () => {
    const sourceConfig = { gateway: { mode: "local" } };
    loadConfig.mockReturnValue(sourceConfig);
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: sourceConfig,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    });
    runSecurityAudit.mockResolvedValue({
      ts: 0,
      summary: { critical: 0, warn: 0, info: 0 },
      findings: [],
    });

    await createProgram().parseAsync(
      ["security", "audit", "--deep", "--password", "explicit-password", "--json"],
      {
        from: "user",
      },
    );

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "read_only_status",
      }),
    );
    expect(runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        deep: true,
        deepProbeAuth: { password: "explicit-password" },
      }),
    );
  });

  it("forwards both --token and --password to deep probe auth", async () => {
    const sourceConfig = { gateway: { mode: "local" } };
    loadConfig.mockReturnValue(sourceConfig);
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: sourceConfig,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    });
    runSecurityAudit.mockResolvedValue({
      ts: 0,
      summary: { critical: 0, warn: 0, info: 0 },
      findings: [],
    });

    await createProgram().parseAsync(
      [
        "security",
        "audit",
        "--deep",
        "--token",
        "explicit-token",
        "--password",
        "explicit-password",
        "--json",
      ],
      {
        from: "user",
      },
    );

    expect(runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        deep: true,
        deepProbeAuth: {
          token: "explicit-token",
          password: "explicit-password",
        },
      }),
    );
  });
});
