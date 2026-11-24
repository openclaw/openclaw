import type { DaemonRuntimePinSnapshot } from "../../daemon/runtime-pin-types.js";
const pinSnapshotMock = vi.hoisted(() =>
  vi.fn<() => DaemonRuntimePinSnapshot>(() => ({ revision: "empty", stored: false })),
);
const pinMigrationMock = vi.hoisted(() => vi.fn(async () => {}));
// mock-isolation: Planning tests replace pin storage and migration to avoid touching disk state.
vi.mock("../../daemon/runtime-pin-state.js", () => ({
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, run: () => T) => {
    await pinMigrationMock();
    return run();
  },
  readDaemonRuntimePin: pinSnapshotMock,
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServiceState } from "../../daemon/service.js";
import { requireMockCallArg } from "./lifecycle.test-helpers.js";

const buildGatewayInstallPlanMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      existingEnvironment?: Record<string, string | undefined>;
      existingEnvironmentValueSources?: Record<
        string,
        "inline" | "file" | "inline-and-file" | undefined
      >;
    }) => {
      const preservedFileValue =
        params.existingEnvironmentValueSources?.TELEGRAM_DEFAULT_BOTTOKEN === "file";
      return {
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp/openclaw",
        environment: {
          TELEGRAM_DEFAULT_BOTTOKEN: preservedFileValue
            ? params.existingEnvironment?.TELEGRAM_DEFAULT_BOTTOKEN
            : "placeholder-overwritten-token",
        },
        environmentValueSources: {
          TELEGRAM_DEFAULT_BOTTOKEN: preservedFileValue ? "file" : "inline",
        },
      };
    },
  ),
);
const resolveGatewayInstallTokenMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotForWriteMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() =>
  vi.fn(
    (config: { gateway?: { port?: number } } | undefined, env: NodeJS.ProcessEnv = process.env) => {
      const portMatch = env.OPENCLAW_GATEWAY_PORT?.trim().match(/(?:^|:)(\d+)$/);
      return Number(portMatch?.[1]) || config?.gateway?.port || 18_789;
    },
  ),
);
const resolveStateDirMock = vi.hoisted(() =>
  vi.fn((env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR?.trim() || `${env.HOME}/.openclaw`),
);
const resolveConfigPathCandidateMock = vi.hoisted(() =>
  vi.fn(
    (env: NodeJS.ProcessEnv) =>
      env.OPENCLAW_CONFIG_PATH?.trim() ||
      `${env.OPENCLAW_STATE_DIR?.trim() || `${env.HOME}/.openclaw`}/openclaw.json`,
  ),
);
const resolveOpenClawWrapperPathMock = vi.hoisted(() => vi.fn());
const formatGatewayServiceStartRepairIssuesMock = vi.hoisted(() => vi.fn());
const defaultRuntimeLogMock = vi.hoisted(() => vi.fn());
const assertGatewayServiceMutationAllowedMock = vi.hoisted(() => vi.fn());
const resolveBunRuntimeInfoMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: buildGatewayInstallPlanMock,
}));

vi.mock("../../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  resolveGatewayDaemonRuntime: (programArguments: string[] | undefined) =>
    programArguments?.[0]?.endsWith("/bun") ? "bun" : "node",
}));

vi.mock("../../commands/gateway-install-token.js", () => ({
  resolveGatewayInstallToken: resolveGatewayInstallTokenMock,
}));

vi.mock("../../config/io.js", () => ({
  readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
}));

vi.mock("../../config/paths.js", () => ({
  resolveConfigPathCandidate: resolveConfigPathCandidateMock,
  resolveGatewayPort: resolveGatewayPortMock,
  resolveStateDir: resolveStateDirMock,
}));

vi.mock("../../daemon/program-args.js", () => ({
  OPENCLAW_WRAPPER_ENV_KEY: "OPENCLAW_WRAPPER",
  resolveOpenClawWrapperPath: resolveOpenClawWrapperPathMock,
}));

vi.mock("../../daemon/runtime-paths.js", () => ({
  resolveBunRuntimeInfo: resolveBunRuntimeInfoMock,
  resolvePinnedDaemonRuntimePath: vi.fn(async (path) => path),
}));

vi.mock("../../daemon/service.js", () => ({
  formatGatewayServiceStartRepairIssues: formatGatewayServiceStartRepairIssuesMock,
}));

vi.mock("../../infra/gateway-supervision.js", () => ({
  assertGatewayServiceMutationAllowed: assertGatewayServiceMutationAllowedMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: defaultRuntimeLogMock },
}));

const { repairLoadedGatewayServiceForStart } = await import("./start-repair.js");

const homeEnv = { HOME: "/home/openclaw" };
type ServiceCommand = NonNullable<GatewayServiceState["command"]>;

function repairFixture(command: Partial<ServiceCommand> = {}, loaded = true) {
  const service = { install: vi.fn(async () => {}), isLoaded: vi.fn(async () => loaded) };
  const state: GatewayServiceState = {
    installed: true,
    loadState: { status: "loaded" },
    running: false,
    env: {},
    command: {
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: homeEnv,
      ...command,
    },
  };
  const params = {
    service,
    state,
    issues: [{ message: "old port" }],
    json: true,
    stdout: process.stdout,
  };
  return { service, state, params };
}

function expectNoPlanning(service: ReturnType<typeof repairFixture>["service"]) {
  expect(resolveGatewayInstallTokenMock).not.toHaveBeenCalled();
  expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
  expect(service.install).not.toHaveBeenCalled();
}

function installPlan() {
  return requireMockCallArg(buildGatewayInstallPlanMock, "install plan");
}

describe("repairLoadedGatewayServiceForStart", () => {
  beforeEach(() => {
    pinSnapshotMock.mockReset().mockReturnValue({ revision: "empty", stored: false });
    pinMigrationMock.mockReset().mockResolvedValue(undefined);
    vi.stubEnv("HOME", homeEnv.HOME);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "");
    vi.stubEnv("OPENCLAW_HOME", "");
    vi.stubEnv("OPENCLAW_PROFILE", "");
    vi.stubEnv("OPENCLAW_STATE_DIR", "");
    vi.clearAllMocks();
    resolveGatewayInstallTokenMock.mockReset().mockResolvedValue({ warnings: [] });
    readConfigFileSnapshotForWriteMock.mockReset().mockResolvedValue({
      snapshot: { exists: true, valid: true, sourceConfig: {}, config: {} },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });
    resolveOpenClawWrapperPathMock.mockReset().mockResolvedValue("/usr/bin/openclaw");
    formatGatewayServiceStartRepairIssuesMock.mockReset().mockReturnValue("stale service port");
    assertGatewayServiceMutationAllowedMock.mockReset();
    resolveBunRuntimeInfoMock.mockReset().mockResolvedValue({ status: "supported" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("leaves the service untouched when runtime-pin migration is pending", async () => {
    const failure = new Error("Runtime pin migration pending; run openclaw doctor.");
    pinMigrationMock.mockRejectedValueOnce(failure);
    const { service, params } = repairFixture({
      programArguments: ["/usr/bin/node", "/fixture/openclaw.mjs", "gateway"],
    });
    await expect(repairLoadedGatewayServiceForStart(params)).rejects.toBe(failure);
    expect(pinSnapshotMock).not.toHaveBeenCalled();
    expectNoPlanning(service);
  });

  it.each([
    {
      kind: "sealed",
      reason: "foreign-owner",
      artifact: "service-file",
      guidance: "deployment owner",
    },
    {
      kind: "unknown",
      reason: "unsafe-permissions",
      artifact: "service-directory",
      guidance: "chmod go-w",
    },
  ] as const)(
    "explains $reason without exposing raw details or doing config/token work",
    async ({ guidance, ...capability }) => {
      const { service, state, params } = repairFixture({
        programArguments: ["/usr/bin/openclaw", "gateway"],
      });
      state.env = homeEnv;
      const guarded = {
        ...service,
        readDefinitionMutationCapability: vi.fn(async () => ({
          ...capability,
          detail: "repair-inspection-secret-canary",
        })),
      };
      for (const action of ["start", "restart"] as const) {
        const repair =
          action === "restart"
            ? repairLoadedGatewayServiceForStart({ ...params, service: guarded, action })
            : repairLoadedGatewayServiceForStart({ ...params, service: guarded });
        await expect(repair).rejects.toThrow(`SERVICE_DEFINITION_${capability.kind.toUpperCase()}`);
        await expect(repair).rejects.toThrow(guidance);
        await expect(repair).rejects.not.toThrow("secret-canary");
      }
      expect(readConfigFileSnapshotForWriteMock).not.toHaveBeenCalled();
      expectNoPlanning(service);
    },
  );

  it("preserves the managed base environment when an environment-only drop-in overrides it", async () => {
    pinSnapshotMock.mockReturnValue({
      revision: "prior",
      stored: true,
      pin: { runtime: "bun", path: "/inactive/bun" },
    });
    const existingEnvironment = {
      ...homeEnv,
      OPENCLAW_WRAPPER: "/usr/bin/openclaw",
      TELEGRAM_DEFAULT_BOTTOKEN: "existing-env-file-token",
    };
    const existingEnvironmentValueSources = { TELEGRAM_DEFAULT_BOTTOKEN: "file" as const };
    const programArguments = ["/usr/bin/node", "/usr/local/bin/openclaw", "gateway"];
    const { service, state, params } = repairFixture({
      programArguments,
      environment: {
        ...existingEnvironment,
        OPENCLAW_WRAPPER: "/srv/operator/openclaw",
        OPERATOR_DROPIN_ONLY: "operator-owned",
        NODE_OPTIONS: "--max-old-space-size=512",
        TELEGRAM_DEFAULT_BOTTOKEN: "operator-drop-in-token",
      },
      environmentValueSources: { TELEGRAM_DEFAULT_BOTTOKEN: "inline" },
      managedDefinition: {
        programArguments,
        environment: existingEnvironment,
        environmentValueSources: existingEnvironmentValueSources,
      },
      managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
    });
    await repairLoadedGatewayServiceForStart(params);
    const plan = installPlan();
    expect(plan.existingCommand).toBe(state.command);
    expect(plan.existingEnvironment).toBe(existingEnvironment);
    expect(plan.existingEnvironmentValueSources).toBe(existingEnvironmentValueSources);
    expect(plan.env).not.toHaveProperty("OPERATOR_DROPIN_ONLY");
    expect(plan.pinnedRuntimePath).toBe("/inactive/bun");
    expect(resolveOpenClawWrapperPathMock).toHaveBeenCalledWith("/usr/bin/openclaw");
    expect(resolveBunRuntimeInfoMock).not.toHaveBeenCalled();
    expect(service.install).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: { TELEGRAM_DEFAULT_BOTTOKEN: "existing-env-file-token" },
        environmentValueSources: { TELEGRAM_DEFAULT_BOTTOKEN: "file" },
      }),
    );
  });

  it.each([
    { status: "supported", expectedRuntime: "bun" },
    { status: "probe-failed", expectedRuntime: null },
    { status: "unsupported", sqliteSelectionError: true, expectedRuntime: null },
  ])(
    "repairs installed Bun only with a known probe result ($status, selection error: $sqliteSelectionError)",
    async ({ status, sqliteSelectionError, expectedRuntime }) => {
      const error = new Error("Bun runtime probe failed: EACCES");
      const selectionError = "Invalid OPENCLAW_SQLITE_LIBRARY";
      resolveBunRuntimeInfoMock.mockResolvedValue({
        status,
        error,
        ...(sqliteSelectionError ? { sqliteSelectionError: selectionError } : {}),
      });
      const { service, params } = repairFixture({
        programArguments: ["/home/openclaw/.bun/bin/bun", "openclaw", "gateway", "--port", "18789"],
        environment: { ...homeEnv, OPENCLAW_GATEWAY_PORT: "18789" },
      });
      const repair = repairLoadedGatewayServiceForStart(params);
      if (expectedRuntime === null) {
        await expect(repair).rejects.toThrow(
          status === "probe-failed" ? error.message : selectionError,
        );
        expectNoPlanning(service);
      } else {
        await repair;
        expect(installPlan()).toMatchObject({
          runtime: "bun",
          runtimePath: "/home/openclaw/.bun/bin/bun",
        });
      }
    },
  );

  describe.each(["linux", "win32"] as const)("operator overrides on %s", (platform) => {
    it.each([
      ["command", { launcher: "command" as const }, homeEnv],
      [
        "gateway target environment",
        { environment: { keys: ["OPENCLAW_STATE_DIR"] } },
        { ...homeEnv, OPENCLAW_STATE_DIR: "/srv/operator-state" },
      ],
    ])(
      "refuses an ineffective stopped-service repair for a %s override",
      async (_, overrides, environment) => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: platform });
        try {
          const managedDefinition = {
            programArguments: ["/usr/bin/openclaw", "gateway", "run"],
            workingDirectory: "/srv/openclaw",
            environment: homeEnv,
          };
          const { service, params } = repairFixture({
            ...managedDefinition,
            environment,
            sourcePath: "/home/openclaw/.config/systemd/user/openclaw-work.service",
            managedDefinition,
            managedOverrides: overrides,
          });
          await expect(repairLoadedGatewayServiceForStart(params)).rejects.toThrow(
            platform === "win32"
              ? /Scheduled Task.*registered action and working directory/
              : /systemd drop-in.*systemctl --user cat openclaw-work\.service/,
          );
          expect(readConfigFileSnapshotForWriteMock).not.toHaveBeenCalled();
          expectNoPlanning(service);
        } finally {
          Object.defineProperty(process, "platform", { value: originalPlatform });
        }
      },
    );
  });

  it("refuses start repair when ambient state, config, and port target a different service", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/home/openclaw/stress-state");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "/home/openclaw/stress-state/openclaw.json");
    const config = { gateway: { port: 18_999 } };
    readConfigFileSnapshotForWriteMock.mockResolvedValue({
      snapshot: { exists: true, valid: true, sourceConfig: config, config },
      writeOptions: { expectedConfigPath: "/home/openclaw/stress-state/openclaw.json" },
    });
    const { service, params } = repairFixture({
      programArguments: ["/usr/bin/openclaw", "gateway", "--port", "18789"],
      environment: { ...homeEnv, OPENCLAW_GATEWAY_PORT: "18789" },
    });
    await expect(repairLoadedGatewayServiceForStart(params)).rejects.toThrow(
      [
        "Refusing to repair the managed Gateway service because the current invocation targets a different Gateway:",
        '- OPENCLAW_STATE_DIR: installed="/home/openclaw/.openclaw", ambient="/home/openclaw/stress-state"',
        '- OPENCLAW_CONFIG_PATH: installed="/home/openclaw/.openclaw/openclaw.json", ambient="/home/openclaw/stress-state/openclaw.json"',
        '- gateway.port: installed="18789", ambient="18999"',
        "Run `openclaw gateway start` with the installed state directory, config path, and port (or unset conflicting environment overrides). To retarget intentionally, run `openclaw gateway install --force`.",
      ].join("\n"),
    );
    expectNoPlanning(service);
  });

  it("refuses repair when a legacy service does not identify its installed state directory", async () => {
    vi.stubEnv("HOME", "/home/ambient-user");
    const { service, params } = repairFixture({
      programArguments: ["/usr/bin/openclaw", "gateway", "--port", "18789"],
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
    });
    await expect(repairLoadedGatewayServiceForStart(params)).rejects.toThrow(
      "installed state directory cannot be determined",
    );
    expectNoPlanning(service);
  });

  it("fails restart repair when the post-install probe returns false", async () => {
    const { service, params } = repairFixture({}, false);
    await expect(
      repairLoadedGatewayServiceForStart({ ...params, action: "restart" }),
    ).rejects.toThrow("Gateway service is not loaded after repair.");
    expect(service.install).toHaveBeenCalledTimes(1);
  });
});
