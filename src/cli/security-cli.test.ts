import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as terminalTheme from "../../packages/terminal-core/src/theme.js";
import { registerSecurityCli } from "./security-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  const runtime = createCliRuntimeMock(vi);
  return {
    loadConfig: vi.fn(),
    runSecurityAuditCore: vi.fn(),
    fixSecurityFootguns: vi.fn(),
    resolveCommandSecretRefsViaGateway: vi.fn(),
    getSecurityAuditCommandSecretTargetIds: vi.fn(
      () => new Set(["gateway.auth.token", "gateway.auth.password"]),
    ),
    ...runtime,
  };
});

const {
  loadConfig,
  runSecurityAuditCore,
  fixSecurityFootguns,
  resolveCommandSecretRefsViaGateway,
  getSecurityAuditCommandSecretTargetIds,
  runtimeLogs,
} = mocks;

// mock-isolation: Security command dispatch uses synthetic audit config, never host config.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.loadConfig(),
  loadConfig: () => mocks.loadConfig(),
  captureRuntimeConfigAsyncReader: () => async () => mocks.loadConfig(),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../security/audit.js", () => ({
  runSecurityAuditCore: (opts: unknown) => mocks.runSecurityAuditCore(opts),
}));

vi.mock("../security/fix.js", () => ({
  fixSecurityFootguns: () => mocks.fixSecurityFootguns(),
}));

// mock-isolation: Audit fixtures resolve secrets locally without connecting to a live Gateway.
vi.mock("./command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("./command-secret-targets.js", () => ({
  getSecurityAuditCommandSecretTargetIds: () => mocks.getSecurityAuditCommandSecretTargetIds(),
}));

function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerSecurityCli(program);
  return program.parseAsync(["security", "audit", ...args], { from: "user" });
}

function lastSecretResolverOptions(): Record<string, unknown> | undefined {
  return resolveCommandSecretRefsViaGateway.mock.lastCall?.[0];
}

function lastSecurityAuditOptions(): Record<string, unknown> | undefined {
  return runSecurityAuditCore.mock.lastCall?.[0];
}

describe("security CLI", () => {
  beforeEach(() => {
    runtimeLogs.length = 0;
    loadConfig.mockReset();
    runSecurityAuditCore.mockReset();
    fixSecurityFootguns.mockReset();
    resolveCommandSecretRefsViaGateway.mockReset();
    getSecurityAuditCommandSecretTargetIds.mockClear();
    fixSecurityFootguns.mockResolvedValue({ changes: [], actions: [], errors: [] });
    const config = { gateway: { mode: "local" } };
    loadConfig.mockReturnValue(config);
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    });
    runSecurityAuditCore.mockResolvedValue({
      ts: 0,
      summary: { critical: 0, warn: 0, info: 0 },
      findings: [],
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
    };
    const resolvedConfig = {
      ...sourceConfig,
      gateway: { auth: { ...sourceConfig.gateway.auth, token: "resolved-token" } },
    };
    const diagnostic =
      "security audit: gateway secrets.resolve unavailable (gateway closed); resolved command secrets locally.";
    loadConfig.mockReturnValue(sourceConfig);
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig,
      diagnostics: [diagnostic],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    });

    await run("--json");

    const resolverOptions = lastSecretResolverOptions();
    expect(resolverOptions?.config).toBe(sourceConfig);
    expect(resolverOptions).toMatchObject({
      commandName: "security audit",
      mode: "read_only_status",
      targetIds: expect.any(Set),
    });
    const auditOptions = lastSecurityAuditOptions();
    expect(auditOptions?.config).toBe(resolvedConfig);
    expect(auditOptions?.sourceConfig).toBe(sourceConfig);
    expect(auditOptions).toMatchObject({
      deep: false,
      includeFilesystem: true,
    });
    const payload = JSON.parse(String(runtimeLogs.at(-1)));
    expect(payload.secretDiagnostics).toEqual([diagnostic]);
  });

  it("prints the audit counts in the human summary", async () => {
    runSecurityAuditCore.mockResolvedValueOnce({
      ts: 0,
      summary: { critical: 2, warn: 3, info: 5 },
      findings: [],
    });
    const richSpy = vi.spyOn(terminalTheme, "isRich").mockReturnValue(false);
    try {
      await run();
      expect(runtimeLogs).toEqual([
        expect.stringContaining("\nSummary: 2 critical · 3 warn · 5 info\n"),
      ]);
    } finally {
      richSpy.mockRestore();
    }
  });

  it("reports an unexpected fixer failure instead of emitting a successful JSON audit", async () => {
    const failure = new Error("Fixture repair failed");
    fixSecurityFootguns.mockRejectedValueOnce(failure);

    await expect(run("--fix", "--json")).rejects.toBe(failure);
    expect(runtimeLogs).toEqual([]);
  });

  it.each([
    [["--token", "explicit-token"], { token: "explicit-token" }, undefined],
    [["--password", "explicit-password"], { password: "explicit-password" }, undefined],
    [
      ["--auth", "password", "--password", "explicit-password"],
      { password: "explicit-password" },
      { mode: "password", password: "explicit-password" },
    ],
    [
      ["--token", "explicit-token", "--password", "explicit-password"],
      { token: "explicit-token", password: "explicit-password" },
      undefined,
    ],
  ] as const)(
    "forwards deep probe auth for %j without changing resolver mode",
    async (argv, deepProbeAuth, auditGatewayAuthOverride) => {
      await run("--deep", ...argv, "--json");

      expect(lastSecretResolverOptions()?.mode).toBe("read_only_status");
      expect(lastSecurityAuditOptions()).toEqual(
        expect.objectContaining({ deep: true, deepProbeAuth, auditGatewayAuthOverride }),
      );
    },
  );

  it.each([
    ["token", /pass --token <token>/i],
    ["password", /pass --password <password>/i],
  ] as const)(
    "rejects shared-secret auth override without the matching secret",
    async (mode, message) => {
      await expect(run("--auth", mode, "--json")).rejects.toThrow(message);
      expect(runSecurityAuditCore).not.toHaveBeenCalled();
    },
  );
});
