import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/service-audit-mocks.js";
import {
  auditGatewayServiceConfig as inspectGatewayServiceConfig,
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
import { seedCompletedRuntimePinMigration } from "./test-helpers/service-audit-runtime-pin.js";

type AuditOptions = Parameters<typeof inspectGatewayServiceConfig>[0];
type Audit = Awaited<ReturnType<typeof inspectGatewayServiceConfig>>;
const findIssue = (result: Audit, code: string) =>
  result.issues.find((entry) => entry.code === code);
function expectIssue(result: Audit, code: string, fields: Record<string, unknown>) {
  expect(findIssue(result, code)).toMatchObject({ code, ...fields });
}
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let runtimePinStateDir: string;
beforeEach(() => {
  resetServiceAuditMocks();
  runtimePinStateDir = tempDirs.make("service-audit-runtime-pin-");
});

async function audit(
  command: Partial<NonNullable<AuditOptions["command"]>> | null = {},
  options: Partial<Omit<AuditOptions, "command">> = {},
) {
  const env = {
    HOME: "/tmp",
    ...options.env,
    OPENCLAW_STATE_DIR: options.env?.OPENCLAW_STATE_DIR ?? runtimePinStateDir,
  };
  await seedCompletedRuntimePinMigration(env);
  return inspectGatewayServiceConfig({
    platform: "linux",
    ...options,
    env,
    command:
      command === null
        ? null
        : {
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

function runtimeInfo(version: string, sqliteVersion: string | null, text = sqliteVersion !== null) {
  const available = sqliteVersion !== null;
  return {
    version,
    sqliteVersion,
    nodeSharedSqlite: false,
    sqliteProbe: { available, version: sqliteVersion, text, blob: available, json: available },
  };
}

it("reports pending pin migration without recommending a different runtime", async () => {
  const result = await inspectGatewayServiceConfig({
    env: { HOME: runtimePinStateDir, OPENCLAW_STATE_DIR: runtimePinStateDir },
    platform: "linux",
    command: {
      programArguments: ["/home/user/.nvm/versions/node/v24.21.0/bin/node", "gateway"],
    },
  });
  expect(result.runtimeNote).toBe("Runtime pin migration pending; run openclaw doctor.");
  expect(hasIssue(result, codes.gatewayRuntimeNodeVersionManager)).toBe(false);
  expect(hasIssue(result, codes.gatewayRuntimeNodeSystemMissing)).toBe(false);
});

const auditBun = () =>
  audit({ programArguments: ["/opt/homebrew/bin/bun", "gateway"] }, { platform: "darwin" });

it.each([undefined, "Cannot use SQLite library /opt/broken/libsqlite3.dylib: missing file."])(
  "reports unsupported Bun with SQLite selection error %s",
  async (sqliteSelectionError) => {
    const sqliteVersion = sqliteSelectionError ? null : "3.51.2";
    resolveBunRuntimeInfoMock.mockResolvedValue({
      ...runtimeInfo(sqliteSelectionError ? "1.4.3" : "1.4.0", sqliteVersion),
      status: "unsupported",
      sqliteSelectionError,
    });
    const result = await auditBun();
    expectIssue(result, codes.gatewayRuntimeBun, {
      message: expect.stringContaining("Bun 1.4.3+ with WAL-reset-safe node:sqlite is required"),
      detail: sqliteSelectionError
        ? `/opt/homebrew/bin/bun: ${sqliteSelectionError}`
        : "/opt/homebrew/bin/bun",
    });
  },
);

it.each([false, true])("reports Node capability status (supported=%s)", async (supported) => {
  const message = supported
    ? "Vendor Node capability check passed."
    : "SQLite truncates TEXT at NUL.";
  resolveNodeRuntimeInfoMock.mockResolvedValue({
    ...runtimeInfo(supported ? "24.15.0" : "26.8.1", "3.53.4", supported),
    status: supported ? "supported" : "unsupported",
    ...(supported ? { note: message } : { capabilityError: message }),
  });
  const result = await audit();
  if (supported) {
    expect(result.runtimeNote).toBe(message);
    expect(hasIssue(result, codes.gatewayRuntimeNode)).toBe(false);
  } else {
    expectIssue(result, codes.gatewayRuntimeNode, { message, detail: "/usr/bin/node" });
  }
  expect(needsNodeRuntimeMigration(result.issues)).toBe(!supported);
});

it.each(["bun", "node"])("preserves %s probe failure without migration", async (runtime) => {
  const error = new Error(`${runtime} runtime probe: access denied`);
  const probe = runtime === "bun" ? resolveBunRuntimeInfoMock : resolveNodeRuntimeInfoMock;
  probe.mockResolvedValue({ status: "probe-failed", error });
  const result = await (runtime === "bun"
    ? auditBun()
    : audit({ environment: undefined }, { timeoutMs: 1234 }));
  if (runtime === "node") {
    expect(probe).toHaveBeenCalledWith(
      "/usr/bin/node",
      { HOME: "/tmp", OPENCLAW_STATE_DIR: runtimePinStateDir },
      1234,
    );
  } else {
    expect(hasIssue(result, codes.gatewayRuntimeBun)).toBe(false);
  }
  expectIssue(result, codes.gatewayRuntimeProbeFailed, { detail: error.message });
  expect(needsNodeRuntimeMigration(result.issues)).toBe(false);
});
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
  const missing = findIssue(result, codes.gatewayPathMissingDirs);
  expect(missing?.message).toContain("/opt/homebrew/bin");
  expect(missing?.message).toContain("/opt/homebrew/sbin");
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
  expectIssue(result, codes.gatewayPathNonMinimal, { detail: "/Users/testuser/.asdf/shims" });
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
it.each([
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
it("classifies expired egress trust as repairable drift, not a custom setting", async () => {
  const expectedCommand = {
    programArguments: ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "gateway"],
    environment: { PATH: "/usr/local/bin:/usr/bin:/bin", CUSTOM_SETTING: "retained" },
  };
  const result = await audit(
    {
      ...expectedCommand,
      environment: {
        ...expectedCommand.environment,
        NODE_EXTRA_CA_CERTS: "/state/a/secret-egress-proxy/gateway-expired/trust-bundle.pem",
      },
    },
    { expectedCommand },
  );
  expectIssue(result, "gateway-egress-proxy-env-embedded", {
    environmentKeys: ["NODE_EXTRA_CA_CERTS"],
  });
  expect(result.definitionDrift).toContainEqual(
    expect.objectContaining({
      kind: "outdated",
      key: "Environment.NODE_EXTRA_CA_CERTS",
    }),
  );
  expect(result.definitionDrift).not.toContainEqual(
    expect.objectContaining({ kind: "unknown-edit" }),
  );
});

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
    const managed = findIssue(result, codes.gatewayManagedEnvEmbedded);
    const proxy = findIssue(result, codes.gatewayProxyEnvEmbedded);
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
it.each([
  ["same-token\r\n", " same-token ", false],
  ["old-token", "new-token", true],
] as const)("compares normalized service token %s", (serviceToken, configToken, changed) => {
  expect(checkTokenDrift({ serviceToken, configToken })).toStrictEqual(
    changed
      ? {
          code: codes.gatewayTokenDrift,
          message:
            "Config token differs from service token. The daemon will use the old token after restart.",
          level: "recommended",
        }
      : null,
  );
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
  const network = ["After=network-online.target", "Wants=network-online.target", "RestartSec=5"];
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
      { ...env(), OPENCLAW_STATE_DIR: runtimePinStateDir },
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

  it.each(["none", ""])(
    "warns about base-unit KillMode=%s when the manager is unavailable",
    async (killMode) => {
      await writeUnit([...network, `KillMode=${killMode}`]);
      const result = await auditUnit();
      expect(
        hasIssue(
          result,
          killMode ? codes.systemdKillModeProcessOrNone : codes.systemdKillModeControlGroup,
        ),
      ).toBe(true);
    },
  );

  it("finds credentials in an orphaned backup without revealing them", async () => {
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    await fs.writeFile(
      `${unitPath}.bak`,
      'Environment = "OPENCLAW_GATEWAY_TOKEN=audit-token" SAFE=kept \\\n  "OPENCLAW_GATEWAY_PASSWORD=audit-password"\n',
      { mode: 0o600 },
    );
    const result = await audit(null, { env: env() });
    expectIssue(result, codes.systemdUnitBackupUnsafe, {
      level: "recommended",
      detail: expect.stringContaining("OPENCLAW_GATEWAY_PASSWORD, OPENCLAW_GATEWAY_TOKEN"),
    });
    expect(JSON.stringify(result.issues)).not.toMatch(/audit-token|audit-password/);
  });

  it("flags permissive backup modes without embedded credentials", async () => {
    await writeUnit([...network, "KillMode=control-group"]);
    await fs.writeFile(`${unitPath}.bak`, "Environment=OPERATOR_SETTING=kept\n");
    await fs.chmod(`${unitPath}.bak`, 0o644);
    const result = await auditUnit();
    expectIssue(result, codes.systemdUnitBackupUnsafe, {
      level: "recommended",
      detail: expect.stringContaining("mode: 644"),
    });
  });

  it.each(["EACCES", "EIO"])("reports a backup inspection failure (%s)", async (code) => {
    await writeUnit([...network, "KillMode=mixed", "TimeoutStopSec=330"]);
    const backupPath = `${unitPath}.bak`;
    const lstat = fs.lstat;
    const inspection = vi
      .spyOn(fs, "lstat")
      .mockImplementation((...args) =>
        args[0] === backupPath
          ? Promise.reject(
              Object.assign(new Error("synthetic backup inspection failure"), { code }),
            )
          : lstat(...args),
      );
    try {
      const result = await auditUnit();
      expect(result.definitionDriftError).toBe(
        `Systemd service backup could not be inspected; check ${backupPath} and retry the service audit.`,
      );
      expect(systemdCodes(result)).toEqual([]);
    } finally {
      inspection.mockRestore();
    }
  });
  it.each([
    { name: "unlimited base timeout", base: "infinity", expected: false },
    { name: "disabled base timeout", base: "0", expected: false },
    { name: "invalid base timeout", base: "invalid", expected: true },
  ])("reports a drain requirement for $name", async ({ base, expected }) => {
    await writeUnit([...network, "KillMode=mixed", `TimeoutStopSec=${base}`]);

    const result = await audit(null, { env: env() });
    const issue = result.issues.find((entry) => entry.code === "systemd-stop-timeout");
    expect(Boolean(issue)).toBe(expected);
    if (expected) {
      expect(issue).toMatchObject({
        message: expect.stringContaining("TimeoutStopSec=330"),
        detail: expect.stringContaining(unitPath),
        level: "recommended",
      });
    }
  });
});
