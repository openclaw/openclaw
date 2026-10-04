import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/service-audit-mocks.js";
import {
  auditGatewayServiceConfig,
  checkTokenDrift,
  needsNodeRuntimeMigration,
  SERVICE_AUDIT_CODES as codes,
} from "./service-audit.js";
import { buildServiceEnvironment } from "./service-env.js";
import {
  execSystemctlUserMock,
  hasIssue,
  resetServiceAuditMocks,
  resolveBunRuntimeInfoMock,
  resolveNodeRuntimeInfoMock,
} from "./test-helpers/service-audit-fixtures.js";

type AuditOptions = Parameters<typeof auditGatewayServiceConfig>[0];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(resetServiceAuditMocks);

function audit(
  command: Partial<NonNullable<AuditOptions["command"]>> = {},
  options: Partial<Omit<AuditOptions, "command">> = {},
) {
  return auditGatewayServiceConfig({
    env: { HOME: "/tmp" },
    platform: "linux",
    ...options,
    command: {
      programArguments: ["/usr/bin/node", "gateway"],
      environment: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      ...command,
    },
  });
}

function minimalPath(platform: NodeJS.Platform, env: AuditOptions["env"]) {
  const servicePath = buildServiceEnvironment({ platform, env, port: 18789 }).PATH;
  if (!servicePath) {
    throw new Error("expected managed service PATH");
  }
  return servicePath;
}

describe("auditGatewayServiceConfig runtime", () => {
  const auditBun = () =>
    audit({ programArguments: ["/opt/homebrew/bin/bun", "gateway"] }, { platform: "darwin" });

  it.each([undefined, "Cannot use SQLite library /opt/broken/libsqlite3.dylib: missing file."])(
    "reports unsupported Bun with SQLite selection error %s",
    async (sqliteSelectionError) => {
      const sqliteVersion = sqliteSelectionError ? null : "3.51.2";
      resolveBunRuntimeInfoMock.mockResolvedValue({
        version: sqliteSelectionError ? "1.4.2" : "1.4.0",
        sqliteVersion,
        sqliteProbe: {
          available: !sqliteSelectionError,
          version: sqliteVersion,
          text: !sqliteSelectionError,
          blob: !sqliteSelectionError,
          json: !sqliteSelectionError,
        },
        nodeSharedSqlite: false,
        status: "unsupported",
        sqliteSelectionError,
      });
      const result = await auditBun();
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: codes.gatewayRuntimeBun,
          message: expect.stringContaining("Bun 1.4+ with WAL-reset-safe node:sqlite is required"),
          detail: sqliteSelectionError
            ? `/opt/homebrew/bin/bun: ${sqliteSelectionError}`
            : "/opt/homebrew/bin/bun",
        }),
      );
    },
  );

  it("accepts Bun with WAL-safe node:sqlite", async () => {
    expect(hasIssue(await auditBun(), codes.gatewayRuntimeBun)).toBe(false);
  });

  it("reports a failed Bun probe without recommending runtime migration", async () => {
    const error = new Error("Bun runtime probe failed at /opt/bun (cwd /root): EACCES");
    resolveBunRuntimeInfoMock.mockResolvedValue({ status: "probe-failed", error });
    const result = await auditBun();
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: codes.gatewayRuntimeProbeFailed,
        detail: error.message,
      }),
    );
    expect(needsNodeRuntimeMigration(result.issues)).toBe(false);
    expect(hasIssue(result, codes.gatewayRuntimeBun)).toBe(false);
  });

  it("flags a supported Node version whose SQLite decoder truncates TEXT", async () => {
    const capabilityError =
      "Node 26.8.1: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954); use 24.16+/26.1+ or a build with the fix";
    resolveNodeRuntimeInfoMock.mockResolvedValue({
      version: "26.8.1",
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: false, blob: true, json: true },
      nodeSharedSqlite: false,
      status: "unsupported",
      capabilityError,
    });
    const result = await audit();
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: codes.gatewayRuntimeNode,
        message: capabilityError,
        detail: "/usr/bin/node",
      }),
    );
    expect(needsNodeRuntimeMigration(result.issues)).toBe(true);
  });

  it("reports a capable vendor Node as a note without requesting migration", async () => {
    const note = "Node 24.15.0: unsupported version, capability check passed.";
    resolveNodeRuntimeInfoMock.mockResolvedValue({
      version: "24.15.0",
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      nodeSharedSqlite: false,
      status: "supported",
      note,
    });
    const result = await audit();
    expect(result.runtimeNote).toBe(note);
    expect(hasIssue(result, codes.gatewayRuntimeNode)).toBe(false);
    expect(needsNodeRuntimeMigration(result.issues)).toBe(false);
  });

  it("preserves Node probe failure and timeout without requesting migration", async () => {
    const error = new Error("Node runtime check failed: access denied");
    resolveNodeRuntimeInfoMock.mockResolvedValue({ status: "probe-failed", error });
    const result = await audit({ environment: undefined }, { timeoutMs: 1234 });
    expect(resolveNodeRuntimeInfoMock).toHaveBeenCalledWith(
      "/usr/bin/node",
      { HOME: "/tmp" },
      1234,
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: codes.gatewayRuntimeProbeFailed,
        detail: error.message,
      }),
    );
    expect(needsNodeRuntimeMigration(result.issues)).toBe(false);
  });
});

describe("auditGatewayServiceConfig PATH", () => {
  it("flags version-managed runtimes and missing macOS system directories", async () => {
    const bin = "/Users/test/.nvm/versions/node/v22.0.0/bin";
    const result = await audit(
      {
        programArguments: [`${bin}/node`, "gateway"],
        environment: { PATH: `/usr/bin:/bin:${bin}` },
      },
      { platform: "darwin" },
    );
    expect(hasIssue(result, codes.gatewayRuntimeNodeVersionManager)).toBe(true);
    expect(hasIssue(result, codes.gatewayPathNonMinimal)).toBe(true);
    const issue = result.issues.find((entry) => entry.code === codes.gatewayPathMissingDirs);
    expect(issue?.message).toContain("/opt/homebrew/bin");
    expect(issue?.message).toContain("/opt/homebrew/sbin");
  });

  it("identifies stale Linux manager paths beside the managed PATH", async () => {
    const env = { HOME: "/tmp/openclaw-testuser", PNPM_HOME: "/opt/active-pnpm" };
    const stale = [
      ".volta/bin",
      ".asdf/shims",
      ".nvm/current/bin",
      ".local/share/fnm/current/bin",
      ".fnm/current/bin",
      ".local/share/pnpm",
    ].map((entry) => `${env.HOME}/${entry}`);
    stale.push("/opt/pnpm/bin");
    const result = await audit(
      { environment: { PATH: [minimalPath("linux", env), ...stale].join(":") } },
      { env },
    );
    expect(hasIssue(result, codes.gatewayPathMissingDirs)).toBe(false);
    expect(result.issues.find((entry) => entry.code === codes.gatewayPathNonMinimal)?.detail).toBe(
      stale.join(", "),
    );
  });

  it("requires explicitly configured Linux tool roots", async () => {
    const result = await audit(
      {},
      { env: { HOME: "/tmp/openclaw-testuser", PNPM_HOME: "/opt/pnpm" } },
    );
    expect(
      result.issues.find((entry) => entry.code === codes.gatewayPathMissingDirs)?.message,
    ).toContain("/opt/pnpm");
  });

  it("allows the expected active bin while rejecting unrelated manager paths", async () => {
    const env = { HOME: "/Users/testuser" };
    const expectedServicePath = [
      "/opt/homebrew/opt/node/bin",
      "/Users/testuser/Library/pnpm",
      minimalPath("darwin", env),
    ].join(":");
    const result = await audit(
      {
        programArguments: [
          "/opt/homebrew/opt/node/bin/node",
          "/opt/openclaw/dist/index.js",
          "gateway",
        ],
        environment: { PATH: `${expectedServicePath}:/Users/testuser/.asdf/shims` },
      },
      { env, platform: "darwin", expectedServicePath },
    );
    expect(hasIssue(result, codes.gatewayPathMissingDirs)).toBe(false);
    expect(result.issues.find((entry) => entry.code === codes.gatewayPathNonMinimal)?.detail).toBe(
      "/Users/testuser/.asdf/shims",
    );
  });

  it.each(["current/bin", "aliases/default/bin"])(
    "accepts fnm without the equivalent %s",
    async (omitted) => {
      const env = {
        HOME: "/tmp/openclaw-testuser",
        FNM_DIR: "/tmp/openclaw-testuser/.local/share/fnm",
      };
      const servicePath = minimalPath("linux", env)
        .split(":")
        .filter((entry) => !entry.endsWith(`/fnm/${omitted}`))
        .join(":");
      const result = await audit({ environment: { PATH: servicePath } }, { env });
      expect(hasIssue(result, codes.gatewayPathMissingDirs)).toBe(false);
    },
  );

  it("skips PATH drift checks for semicolon-delimited Windows paths", async () => {
    const result = await audit(
      {
        programArguments: ["C:\\Program Files\\nodejs\\node.exe", "gateway"],
        environment: { PATH: "C:\\Users\\test\\.nvm\\current\\bin;C:\\Windows\\System32" },
      },
      {
        env: { HOME: "C:\\Users\\test" },
        platform: "win32",
        expectedServicePath: "C:\\Program Files\\nodejs;C:\\Windows\\System32",
      },
    );
    expect(hasIssue(result, codes.gatewayPathMissing)).toBe(false);
    expect(hasIssue(result, codes.gatewayPathMissingDirs)).toBe(false);
    expect(hasIssue(result, codes.gatewayPathNonMinimal)).toBe(false);
  });
});

describe("auditGatewayServiceConfig command", () => {
  it.each([
    ["/bin/zsh", "-lc", false],
    ["/usr/local/bin/helper", "-lc", true],
    ["/bin/zsh", "-l", true],
  ] as const)("audits gateway tokens for %s %s", async (executable, flag, missing) => {
    const result = await audit(
      {
        programArguments: [executable, flag, "exec node gateway --port 18890"],
        environment: {},
      },
      { platform: "darwin", expectedPort: 18889 },
    );
    expect(hasIssue(result, codes.gatewayCommandMissing)).toBe(missing);
    expect(hasIssue(result, codes.gatewayPortMismatch)).toBe(false);
    expect(hasIssue(result, codes.gatewayPathMissing)).toBe(true);
  });

  it.each([
    { args: ["--port", "18789"], detail: "18789 -> 18888" },
    { args: ["--port", "18789", "--port=18888"], detail: undefined },
    { args: ["--port", "--port=18888"], detail: "--port=18888 -> 18888" },
  ])("audits the final unconsumed port flag: $args", async ({ args, detail }) => {
    const result = await audit(
      { programArguments: ["/usr/bin/node", "entry.js", "gateway", ...args], environment: {} },
      { platform: "win32", expectedPort: 18888 },
    );
    const issue = result.issues.find((entry) => entry.code === codes.gatewayPortMismatch);
    if (detail === undefined) {
      expect(issue).toBeUndefined();
    } else {
      expect(issue).toStrictEqual({
        code: codes.gatewayPortMismatch,
        message: "Gateway service port does not match current gateway config.",
        detail,
        level: "recommended",
      });
    }
  });
});

describe("auditGatewayServiceConfig environment sources", () => {
  it.each([
    { source: undefined, token: "old-token", embedded: true, mismatch: true },
    { source: "inline-and-file", token: "new-token", embedded: true, mismatch: false },
    { source: "file", token: "old-token", embedded: false, mismatch: false },
  ] as const)(
    "reports only exposed values for source $source",
    async ({ source, token, embedded, mismatch }) => {
      const result = await audit(
        {
          environment: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            OPENCLAW_GATEWAY_TOKEN: token,
            OPENCLAW_GATEWAY_PASSWORD: "active-password",
            OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENROUTER_API_KEY",
            OPENROUTER_API_KEY: "or-test",
            TAVILY_API_KEY: "tvly-test",
            HTTP_PROXY: "http://proxy.local:7890",
            HTTPS_PROXY: "https://proxy.local:7890",
            NO_PROXY: "localhost,127.0.0.1",
            https_proxy: "https://lowercase.local:7890",
          },
          environmentValueSources:
            source === undefined
              ? undefined
              : {
                  OPENCLAW_GATEWAY_TOKEN: source,
                  OPENCLAW_GATEWAY_PASSWORD: source,
                  openrouter_api_key: source,
                  tavily_api_key: source,
                  http_proxy: source,
                  https_proxy: source,
                  no_proxy: source,
                },
        },
        { expectedGatewayToken: "new-token", expectedManagedServiceEnvKeys: ["TAVILY_API_KEY"] },
      );
      expect(hasIssue(result, codes.gatewayTokenEmbedded)).toBe(embedded);
      expect(hasIssue(result, codes.gatewayTokenMismatch)).toBe(mismatch);
      expect(hasIssue(result, codes.gatewayPasswordEmbedded)).toBe(embedded);
      const managed = result.issues.find((entry) => entry.code === codes.gatewayManagedEnvEmbedded);
      const proxy = result.issues.find((entry) => entry.code === codes.gatewayProxyEnvEmbedded);
      if (embedded) {
        expect(managed?.environmentKeys).toEqual(["OPENROUTER_API_KEY", "TAVILY_API_KEY"]);
        expect(proxy?.environmentKeys).toEqual([
          "HTTPS_PROXY",
          "HTTP_PROXY",
          "NO_PROXY",
          "https_proxy",
        ]);
        expect(proxy?.detail).toContain("HTTPS_PROXY");
      } else {
        expect(managed).toBeUndefined();
        expect(proxy).toBeUndefined();
      }
      expect(JSON.stringify(result.issues)).not.toMatch(
        /old-token|new-token|active-password|tvly-test|or-test|proxy\.local|lowercase\.local/,
      );
    },
  );
});

describe("checkTokenDrift", () => {
  it("normalizes whitespace before comparing tokens", () => {
    expect(
      checkTokenDrift({ serviceToken: "same-token\r\n", configToken: " same-token " }),
    ).toBeNull();
  });
  it("detects token drift without choosing an installation action", () => {
    expect(checkTokenDrift({ serviceToken: "old-token", configToken: "new-token" })).toStrictEqual({
      code: codes.gatewayTokenDrift,
      message:
        "Config token differs from service token. The daemon will use the old token after restart.",
      level: "recommended",
    });
  });
});

describe("auditGatewayServiceConfig systemd", () => {
  let home: string;
  let unitPath: string;
  beforeEach(() => {
    home = tempDirs.make("openclaw-service-audit-");
    unitPath = path.join(home, ".config/systemd/user/openclaw-audit.service");
  });
  const env = () => ({ HOME: home, OPENCLAW_SYSTEMD_UNIT: "openclaw-audit.service" });
  const auditUnit = (timeoutMs?: number) => audit({}, { env: env(), timeoutMs });
  async function writeUnit(lines: string[]) {
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    await fs.writeFile(
      unitPath,
      [
        "[Unit]",
        "Description=OpenClaw Gateway",
        "[Service]",
        ...lines,
        "ExecStart=/usr/bin/node gateway",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
  }
  function manager(lines: string[]) {
    execSystemctlUserMock.mockResolvedValueOnce({
      stdout: lines.join("\n"),
      stderr: "",
      code: 0,
      termination: "exit",
    });
  }
  const systemdCodes = (result: Awaited<ReturnType<typeof audit>>) =>
    result.issues.filter((issue) => issue.code.startsWith("systemd-")).map((issue) => issue.code);

  it.each([
    {
      unit: ["KillMode=mixed"],
      effective: ["KillMode=control-group"],
      expected: [
        codes.systemdStopTimeout,
        codes.systemdAfterNetworkOnline,
        codes.systemdWantsNetworkOnline,
        codes.systemdRestartSec,
        codes.systemdKillModeControlGroup,
      ],
    },
    {
      unit: ["Wants=network-online.target", "RestartSec=100ms", "KillMode=control-group"],
      effective: [
        "After=basic.target network-online.target",
        "Wants=basic.target",
        "RestartUSec=5s",
        "KillMode=mixed",
      ],
      expected: [codes.systemdStopTimeout, codes.systemdWantsNetworkOnline],
    },
  ])("uses manager settings wholesale over $unit", async ({ unit, effective, expected }) => {
    await writeUnit(unit);
    manager(["LoadState=loaded", ...effective]);
    expect(systemdCodes(await auditUnit(321))).toEqual(expected);
    expect(execSystemctlUserMock).toHaveBeenCalledExactlyOnceWith(
      env(),
      [
        "show",
        "openclaw-audit.service",
        "--no-page",
        "--property",
        "After,Wants,RestartUSec,KillMode,LoadState,TimeoutStopUSec",
      ],
      321,
    );
  });

  it("does not repair masked manager defaults or fall back to the base unit", async () => {
    await writeUnit(["KillMode=control-group"]);
    manager([
      "Wants=",
      "After=",
      "LoadState=masked",
      "RestartUSec=100ms",
      "KillMode=control-group",
    ]);
    expect(systemdCodes(await auditUnit())).toEqual([]);
  });

  it.each(["process", "none", ""])(
    "warns about base-unit KillMode=%s when the manager is unavailable",
    async (killMode) => {
      await writeUnit([
        "After=network-online.target",
        "Wants=network-online.target",
        "RestartSec=5",
        `KillMode=${killMode}`,
      ]);
      const result = await auditUnit();
      expect(
        hasIssue(
          result,
          killMode ? codes.systemdKillModeProcessOrNone : codes.systemdKillModeControlGroup,
        ),
      ).toBe(true);
    },
  );

  it("accepts resilient continued settings when the manager is unavailable", async () => {
    const continuation = "\\\n  # continued setting \\\n  ; ignored comment\n  ";
    await writeUnit([
      `After=basic.target ${continuation}network-online.target`,
      `Wants=basic.target ${continuation}network-online.target`,
      `RestartSec=${continuation}5s`,
      `KillMode=${continuation}mixed`,
      `TimeoutStopSec=${continuation}330`,
    ]);
    expect(systemdCodes(await auditUnit())).toEqual([]);
  });

  it("finds credentials in an orphaned backup without revealing them", async () => {
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    await fs.writeFile(
      `${unitPath}.bak`,
      'Environment = "OPENCLAW_GATEWAY_TOKEN=audit-token" SAFE=kept \\\n  "OPENCLAW_GATEWAY_PASSWORD=audit-password"\n',
      { mode: 0o600 },
    );
    const result = await auditGatewayServiceConfig({
      env: env(),
      platform: "linux",
      command: null,
    });
    expect(
      result.issues.find((entry) => entry.code === codes.systemdUnitBackupUnsafe),
    ).toMatchObject({
      level: "recommended",
      detail: expect.stringContaining("OPENCLAW_GATEWAY_PASSWORD, OPENCLAW_GATEWAY_TOKEN"),
    });
    expect(JSON.stringify(result.issues)).not.toMatch(/audit-token|audit-password/);
  });

  it("flags permissive backup modes without embedded credentials", async () => {
    await writeUnit([
      "After=network-online.target",
      "Wants=network-online.target",
      "RestartSec=5",
      "KillMode=control-group",
    ]);
    await fs.writeFile(`${unitPath}.bak`, "Environment=OPERATOR_SETTING=kept\n");
    await fs.chmod(`${unitPath}.bak`, 0o644);
    const result = await auditUnit();
    expect(
      result.issues.find((entry) => entry.code === codes.systemdUnitBackupUnsafe),
    ).toMatchObject({
      level: "recommended",
      detail: expect.stringContaining("mode: 644"),
    });
  });
});
