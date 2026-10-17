import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { GatewayRestartPreparationError } from "../../infra/restart-intent-error.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { expectNoCalls, expectPartialCall } from "./lifecycle-assertions.test-support.js";
import {
  createGatewayServiceRunArgs as createServiceRunArgs,
  lifecycleTestRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  lifecycleRuntimeLogs,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const loadConfig = vi.fn<() => OpenClawConfig>(makeTokenConfig);
const writeGatewayRestartIntentSync = vi.fn();
const clearGatewayRestartIntentSync = vi.fn();
const appendGatewayLifecycleAudit = vi.fn();
const MISSING_SERVICE_PROGRAM = "/openclaw-test-missing-runtime/node";
const scheduledMessage = "restart scheduled, gateway will restart momentarily";
function makeTokenConfig() {
  return { gateway: { auth: { token: "config-token" } } };
}
const serviceSnapshot = {
  label: "TestService",
  loaded: true,
  loadedText: "loaded",
  notLoadedText: "not loaded",
};
const createGatewayLifecycleMutationAudit = vi.fn(
  (params: { action: string; source?: string }) => (mutation: { mode: string; pid?: number }) =>
    appendGatewayLifecycleAudit({
      action: params.action,
      source: params.source ?? "cli",
      ...mutation,
    }),
);

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: lifecycleTestRuntime,
}));

// mock-isolation: These service tests use valid config; preflight has its own guard tests.
vi.mock("./lifecycle-action-preflight.js", () => ({
  getServiceActionPreflightFailure: async () => null,
}));

vi.mock("../../infra/restart-intent.js", () => ({
  prepareGatewayRestartIntentLegacyProcess: async () => undefined,
  clearGatewayRestartIntentSync: () => clearGatewayRestartIntentSync(),
  writeGatewayRestartIntentSync: (opts: unknown) => writeGatewayRestartIntentSync(opts),
  writeGatewayServiceRestartIntentSync: (opts: unknown) => writeGatewayRestartIntentSync(opts),
}));

vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit: (params: unknown) => appendGatewayLifecycleAudit(params),
  createGatewayLifecycleMutationAudit: (params: { action: string; source?: string }) =>
    createGatewayLifecycleMutationAudit(params),
  createServiceLifecycleMutationAudit: (params: { serviceNoun: string; action: string }) =>
    params.serviceNoun === "Gateway" ? createGatewayLifecycleMutationAudit(params) : undefined,
  appendServiceLifecycleRepairAudit: (params: {
    serviceNoun: string;
    action: string;
    pid?: number;
  }) => {
    if (params.serviceNoun === "Gateway") {
      appendGatewayLifecycleAudit({
        action: params.action,
        source: "cli",
        mode: "service-repair",
        ...(params.pid === undefined ? {} : { pid: params.pid }),
      });
    }
  },
}));

// The runtime mock consumes the initialized lifecycle harness, not an early static import.
const { ExitError } = await import("../../runtime.js");
const { runServiceRestart, runServiceStart, runServiceStop } = await import("./lifecycle-core.js");
type StartArgs = Parameters<typeof runServiceStart>[0];
type RestartArgs = Parameters<typeof runServiceRestart>[0];

function start(overrides: Partial<StartArgs> = {}) {
  return runServiceStart({ ...createServiceRunArgs(), ...overrides });
}
function restart(overrides: Partial<RestartArgs> = {}) {
  return runServiceRestart({ ...createServiceRunArgs(), ...overrides });
}
function missingService() {
  service.isLoaded.mockResolvedValue(false);
  service.readCommand.mockResolvedValue(null);
}
function command(programArguments: string[], environment?: Record<string, string>) {
  service.readCommand.mockResolvedValue({ programArguments, ...(environment && { environment }) });
}

type ActionPayload = Parameters<
  ReturnType<typeof import("./response.js").createDaemonActionContext>["emit"]
>[0];

function readJsonLog(): ActionPayload {
  const jsonLine = lifecycleRuntimeLogs.find((line) => line.trim().startsWith("{"));
  return JSON.parse(jsonLine ?? "{}");
}

function expectJsonOutput(payload: object) {
  expect(lifecycleRuntimeLogs).toEqual([JSON.stringify(payload, null, 2)]);
}

function clearResponseMocks() {
  lifecycleTestRuntime.exit.mockClear();
  lifecycleTestRuntime.writeJson.mockClear();
  lifecycleTestRuntime.error.mockClear();
}

function expectSingleRefusal(code: number, payload: object) {
  expect(lifecycleTestRuntime.exit).toHaveBeenCalledExactlyOnceWith(code);
  expect(lifecycleTestRuntime.writeJson).toHaveBeenCalledOnce();
  expect(lifecycleTestRuntime.error).not.toHaveBeenCalled();
  expect(lifecycleRuntimeLogs).toHaveLength(1);
  expect(JSON.parse(lifecycleRuntimeLogs[0]!)).toMatchObject(payload);
}

async function expectReportedExit(code: number, run: () => Promise<unknown>) {
  const exit = new ExitError(code);
  await lifecycleTestRuntime.exit.withImplementation(
    (actualCode) => {
      expect(actualCode).toBe(code);
      throw exit;
    },
    async () => {
      await expect(run()).rejects.toBe(exit);
    },
  );
}

it.each(["native-start", "recovered-start", "repaired-start", "restart-repair-refused"] as const)(
  "preserves the single reported outcome through %s catch boundaries",
  async (route) => {
    if (route === "recovered-start") {
      missingService();
    } else if (route === "repaired-start" || route === "restart-repair-refused") {
      command([MISSING_SERVICE_PROGRAM]);
    }
    const refusedRepair = route === "restart-repair-refused";
    const expectedCode = refusedRepair ? 1 : 2;
    const recover = async () => ({ result: "started" as const, loaded: true });
    await writeGatewayRestartIntentSync.withImplementation(
      () => true,
      () =>
        expectReportedExit(expectedCode, () =>
          refusedRepair
            ? restart({ repairLoadedService: async () => null })
            : start({
                onNotLoaded: route === "recovered-start" ? recover : undefined,
                repairLoadedService: route === "repaired-start" ? recover : undefined,
                postStartCheck: async ({ fail }) => {
                  fail("Gateway is still starting", ["inspect"], "still-starting");
                },
              }),
        ),
    );
    expectSingleRefusal(
      expectedCode,
      refusedRepair
        ? {
            ok: false,
            action: "restart",
            error: expect.stringContaining("service needs repair before restart"),
          }
        : {
            ok: false,
            action: "start",
            result: "still-starting",
            error: "Gateway is still starting",
          },
    );
    if (refusedRepair) {
      expect(clearGatewayRestartIntentSync).toHaveBeenCalledOnce();
      expect(service.restart).not.toHaveBeenCalled();
    }
  },
);

it.each(["stop-recovery", "restart-recovery", "restart-owned"] as const)(
  "preserves one reported refusal from %s callbacks",
  async (route) => {
    missingService();
    const refuse = async (ctx: { fail: (message: string) => void }) => {
      ctx.fail("Recovery refused");
      return null;
    };
    await expectReportedExit(1, () =>
      route === "stop-recovery"
        ? runServiceStop({ ...createServiceRunArgs(), onNotLoaded: refuse })
        : restart(
            route === "restart-owned" ? { restartOwnedProcess: refuse } : { onNotLoaded: refuse },
          ),
    );
    expectSingleRefusal(1, {
      ok: false,
      action: route === "stop-recovery" ? "stop" : "restart",
      error: "Recovery refused",
    });
    expectNoCalls(service.restart, service.stop);
  },
);

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  clearResponseMocks();
  mockSystemAccountHome();
  appendGatewayLifecycleAudit.mockClear();
  createGatewayLifecycleMutationAudit.mockClear();
  resetLifecycleRuntimeLogs();
  loadConfig.mockReset().mockReturnValue(makeTokenConfig());
  resetLifecycleServiceMocks();
  writeGatewayRestartIntentSync.mockClear();
  clearGatewayRestartIntentSync.mockClear();
  command([], { OPENCLAW_GATEWAY_TOKEN: "service-token" });
  stubEmptyGatewayEnv();
});

it("rejects unsupported-platform start before not-loaded recovery", async () => {
  const onNotLoaded = vi.fn(async () => ({
    result: "started" as const,
    message: "should not run",
    loaded: true,
  }));

  vi.spyOn(process, "platform", "get").mockReturnValue("aix");
  const { resolveGatewayService } = await import("../../daemon/service.js");
  await expect(
    start({
      serviceNoun: "Gateway",
      service: resolveGatewayService(),
      renderStartHints: () => ["openclaw gateway install"],
      onNotLoaded,
    }),
  ).rejects.toThrow("__exit__:1");

  expect(onNotLoaded).not.toHaveBeenCalled();
  expect(readJsonLog()).toMatchObject({
    ok: false,
    error: expect.stringContaining(
      "Gateway service check failed: Error: Gateway service install not supported on aix",
    ),
  });
});

it("fails restart with the container hint when no service is installed", async () => {
  missingService();
  const hasInstalledDefinition = vi.fn(async () => false);
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", "openclaw-demo-container");

  await expect(
    restart({
      service: { ...service, hasInstalledDefinition },
      renderStartHints: () => [
        "Restart the container or the service that manages it for openclaw-demo-container.",
        "openclaw gateway install",
      ],
    }),
  ).rejects.toThrow("__exit__:1");

  const payload = readJsonLog();
  expect(payload).toMatchObject({
    action: "restart",
    ok: false,
    error: "Gateway service not loaded.",
    hints: expect.arrayContaining([
      "Restart the container or the service that manages it for openclaw-demo-container.",
    ]),
    hintItems: expect.arrayContaining([expect.objectContaining({ kind: "container-restart" })]),
  });
  expect(hasInstalledDefinition).toHaveBeenCalledWith({ env: process.env });
});

it("runs the service mutation guard before restarting a loaded service", async () => {
  const beforeServiceMutation = vi.fn();

  await restart({ beforeServiceMutation });

  expect(beforeServiceMutation).toHaveBeenCalledTimes(1);
  expect(beforeServiceMutation.mock.invocationCallOrder[0]).toBeLessThan(
    service.restart.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
});

it("aborts loaded-service mutation when the service guard rejects", async () => {
  const repairLoadedService = vi.fn();

  await expect(
    restart({
      beforeServiceMutation: () => {
        throw new Error("service mutation denied");
      },
      repairLoadedService,
    }),
  ).rejects.toThrow("service mutation denied");

  expectNoCalls(writeGatewayRestartIntentSync, repairLoadedService, service.restart);
});

it("repairs managed port drift before restarting", async () => {
  service.readRuntime.mockResolvedValue({ status: "running", pid: 1234 });
  command(["openclaw", "gateway", "--port", "18789"], { OPENCLAW_GATEWAY_PORT: "18789" });
  const repairLoadedService = vi.fn<NonNullable<RestartArgs["repairLoadedService"]>>(async () => ({
    result: "restarted" as const,
    message: "Gateway service definition repaired and restarted.",
    loaded: true,
  }));

  await restart({
    opts: { json: true, restartIntent: { waitMs: 2_500 } },
    expectedPort: 19_001,
    repairLoadedService,
  });

  expectPartialCall(repairLoadedService, {
    issues: [
      {
        code: "port-mismatch",
        message: "service port 18789 does not match current gateway config port 19001",
      },
    ],
  });
  expect(service.restart).not.toHaveBeenCalled();
  expectPartialCall(writeGatewayRestartIntentSync, {
    env: expect.any(Object),
    reason: "gateway.restart",
    intent: { waitMs: 2_500 },
  });
  expect(readJsonLog()).toMatchObject({
    result: "restarted",
    message: "Gateway service definition repaired and restarted.",
  });
});

it("keeps Nix restart available without suggesting a forbidden token reinstall", async () => {
  await withEnvAsync({ OPENCLAW_NIX_MODE: "1" }, async () => {
    await expect(
      runServiceRestart({ ...createServiceRunArgs(true), opts: { json: false } }),
    ).resolves.toBe(true);

    expect(service.restart).toHaveBeenCalledOnce();
    const output = lifecycleRuntimeLogs.join("\n");
    expect(output).toContain("Config token differs from service token");
    expect(output).toContain("Nix mode detected; service install is disabled.");
    expect(output).not.toContain("gateway install --force");
  });
});

it("compares restart drift against config token even when caller env is set", async () => {
  command([], { OPENCLAW_GATEWAY_TOKEN: "env-token" });
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");

  await runServiceRestart(createServiceRunArgs(true));

  const payload = readJsonLog();
  expect(payload.warnings?.some((warning) => warning.includes("gateway install --force"))).toBe(
    true,
  );
});

it("skips drift warning when disabled", async () => {
  await restart({ serviceNoun: "Node" });

  expectNoCalls(loadConfig, service.readCommand, writeGatewayRestartIntentSync);
  const payload = readJsonLog();
  expect(payload.warnings).toBeUndefined();
});

it("runs a requested managed stop even when the service is not loaded", async () => {
  const onNotLoaded = vi.fn(async () => ({
    result: "stopped" as const,
    message: "Gateway stop signal sent to unmanaged process on port 18789: 4200.",
  }));
  service.isLoaded.mockResolvedValue(false);

  await runServiceStop({
    serviceNoun: "Gateway",
    service,
    opts: { json: true, disable: true },
    stopWhenNotLoaded: true,
    onNotLoaded,
  });

  expect(readJsonLog()).toMatchObject({ result: "stopped", service: { loaded: false } });
  expect(service.stop).toHaveBeenCalledTimes(1);
  const [stopOptions] = service.stop.mock.calls[0] ?? [];
  expect(stopOptions).toMatchObject({ env: process.env, disable: true });
  expect(stopOptions?.env).toBe(process.env);
  expect(onNotLoaded).not.toHaveBeenCalled();
});

it("skips restart health checks when restart is only scheduled", async () => {
  const postRestartCheck = vi.fn(async () => {});
  service.restart.mockResolvedValue({ outcome: "scheduled" });

  const result = await restart({ postRestartCheck });

  expect(result).toBe(true);
  expect(postRestartCheck).not.toHaveBeenCalled();
  expect(readJsonLog()).toMatchObject({
    result: "scheduled",
    message: scheduledMessage,
  });
});

it("reports startup recovery instead of install hints when restart cannot verify a serving owner", async () => {
  writeGatewayRestartIntentSync.mockImplementationOnce(() => {
    throw new GatewayRestartPreparationError("serving-owner");
  });
  await expect(restart({ renderStartHints: () => ["openclaw gateway install"] })).rejects.toThrow(
    "__exit__:1",
  );
  const payload = readJsonLog();
  expect(payload.hints).toEqual([
    "openclaw gateway status --deep",
    "Fix the reported startup failure, then run `openclaw gateway start` to wait for readiness without restarting the process.",
  ]);
  expect(service.restart).not.toHaveBeenCalled();
});

it("clears restart intent when service-manager restart fails before signaling", async () => {
  service.readRuntime.mockResolvedValue({ status: "running", pid: 1234 });
  writeGatewayRestartIntentSync.mockReturnValueOnce(true);
  service.restart.mockRejectedValueOnce(new Error("launchctl failed before signaling"));

  await expect(restart()).rejects.toThrow("__exit__:1");

  expectPartialCall(writeGatewayRestartIntentSync, {
    env: expect.any(Object),
    reason: "gateway.restart",
  });
  expect(clearGatewayRestartIntentSync).toHaveBeenCalledOnce();
});

it.each(["ready", "still-starting", "failed"] as const)(
  "checks an already-running service before reporting start %s",
  async (outcome) => {
    service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });
    const postStartCheck: NonNullable<StartArgs["postStartCheck"]> = async ({ fail }) => {
      if (outcome !== "ready") {
        fail(
          "Gateway listener is unavailable.",
          [],
          outcome === "still-starting" ? outcome : undefined,
        );
      }
    };
    const pendingStart = start({ postStartCheck });
    if (outcome === "ready") {
      await pendingStart;
      expect(readJsonLog()).toMatchObject({ ok: true, result: "already-running" });
    } else {
      await expect(pendingStart).rejects.toThrow(
        `__exit__:${outcome === "still-starting" ? 2 : 1}`,
      );
      expect(readJsonLog()).toMatchObject({
        ok: false,
        error: "Gateway listener is unavailable.",
      });
      if (outcome === "still-starting") {
        expect(readJsonLog()).toMatchObject({ result: "still-starting" });
      }
    }
    expect(lifecycleRuntimeLogs.filter((line) => line.trim().startsWith("{"))).toHaveLength(1);
    expectNoCalls(service.start, service.restart);
  },
);

it("warns in JSON with the Gateway restart repair command", async () => {
  vi.stubEnv("OPENCLAW_PROFILE", "");
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
  service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });
  command([MISSING_SERVICE_PROGRAM, "openclaw", "gateway"]);

  await start({ repairLoadedService: vi.fn(async () => null) });

  expect(readJsonLog()).toMatchObject({
    result: "already-running",
    warnings: [
      `Gateway service already running, but its installed service definition needs repair: service command points at a missing path: ${MISSING_SERVICE_PROGRAM}; run \`openclaw gateway restart\` to apply.`,
    ],
  });
  expect(service.start).not.toHaveBeenCalled();
});

it("prints one warning line when an already-running Node service needs repair", async () => {
  service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });
  command([MISSING_SERVICE_PROGRAM, "openclaw", "node"]);

  await start({ serviceNoun: "Node", opts: undefined });

  const repairWarnings = lifecycleRuntimeLogs.filter((line) =>
    line.startsWith(
      "Node service already running, but its installed service definition needs repair:",
    ),
  );
  expect(repairWarnings).toHaveLength(1);
  expect(repairWarnings[0]).toContain("run `openclaw node install --force` to apply.");
  expect(service.start).not.toHaveBeenCalled();
});

it("repairs loaded services with port drift during start before reporting success", async () => {
  command(["openclaw", "gateway", "--port", "18789"]);
  const repairLoadedService = vi.fn<NonNullable<StartArgs["repairLoadedService"]>>(async (ctx) => {
    ctx.warn?.(
      "Existing generated LaunchAgent env wrapper contains custom behavior and will be overwritten.",
    );
    return {
      result: "started" as const,
      message: "Gateway service definition repaired and started.",
      warnings: ["service port 18789 does not match current gateway config port 19001"],
      loaded: true,
    };
  });

  await start({ repairLoadedService, expectedPort: 19_001 });

  expect(repairLoadedService).toHaveBeenCalledTimes(1);
  expect(service.start).not.toHaveBeenCalled();
  expect(readJsonLog()).toMatchObject({
    result: "started",
    message: "Gateway service definition repaired and started.",
    warnings: expect.arrayContaining([
      expect.stringContaining("service port 18789"),
      expect.stringContaining("custom behavior and will be overwritten"),
    ]),
    service: { loaded: true },
  });
});

it("fails Node service start with its container-scoped install hint when repair is required", async () => {
  const nodeCommand = "openclaw --container demo node";
  vi.stubEnv("OPENCLAW_PROFILE", "work");
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", "demo");
  command([MISSING_SERVICE_PROGRAM, "openclaw", "node"]);

  await expect(start({ serviceNoun: "Node" })).rejects.toThrow("__exit__:1");

  const payload = readJsonLog();
  expect(payload).toMatchObject({
    ok: false,
    error: expect.stringContaining("service needs repair"),
    hints: [`${nodeCommand} install --force`],
  });
  expect(payload.hintItems).toEqual([{ kind: "install", text: `${nodeCommand} install --force` }]);

  resetLifecycleRuntimeLogs();
  await expect(start({ serviceNoun: "Node", opts: { json: false } })).rejects.toThrow("__exit__:1");
  expect(lifecycleRuntimeLogs).toContain(`Tip: ${nodeCommand} install --force`);
  expect(service.start).not.toHaveBeenCalled();
});

it("fails start with install hints when no service is installed", async () => {
  missingService();

  await expect(start({ renderStartHints: () => ["openclaw gateway install"] })).rejects.toThrow(
    "__exit__:1",
  );

  expect(readJsonLog()).toMatchObject({
    ok: false,
    error: "Gateway service not loaded.",
    hints: expect.arrayContaining(["openclaw gateway install"]),
    hintItems: expect.arrayContaining([
      expect.objectContaining({ kind: "install", text: "openclaw gateway install" }),
    ]),
  });
  expect(service.start).not.toHaveBeenCalled();
});
it.each([
  ["start-recovery", "start", "started", "service repaired", true, true],
  ["stop-empty", "stop", "stopped", "", false, true],
  ["stop-missing", "stop", "not-loaded", "Gateway service not loaded.", false, false],
  ["restart-no-message", "restart", "restarted", undefined, false, true],
  ["scheduled", "restart", "scheduled", scheduledMessage, true, true],
] as const)("preserves exact %s output", async (route, action, result, message, loaded, json) => {
  const args = { ...createServiceRunArgs(), opts: { json } };
  const postCheck = vi.fn(async () =>
    route === "scheduled" ? { outcome: "scheduled" as const } : undefined,
  );
  service.isLoaded.mockResolvedValue(loaded);
  service.readCommand.mockResolvedValue(loaded ? { programArguments: [], environment: {} } : null);
  let returned: unknown;
  if (route === "start-recovery") {
    service.isLoaded.mockResolvedValue(false);
    returned = await runServiceStart({
      ...args,
      onNotLoaded: async () => ({ result: "started", message, loaded: true }),
      postStartCheck: async () => {
        await postCheck();
      },
    });
  } else if (action === "stop") {
    returned = await runServiceStop({
      ...args,
      onNotLoaded:
        route === "stop-missing" ? undefined : async () => ({ result: "stopped", message }),
    });
  } else {
    returned = await runServiceRestart({
      ...args,
      postRestartCheck: postCheck,
      onNotLoaded: loaded ? undefined : async () => ({ result: "restarted", message }),
    });
  }
  expect(returned).toBe(action === "restart" ? true : undefined);
  const payload = {
    action,
    ok: true,
    result,
    message,
    service: { ...serviceSnapshot, loaded },
  };
  expect(lifecycleRuntimeLogs).toEqual(
    json ? [JSON.stringify(payload, null, 2)] : message ? [message] : [],
  );
  expectNoCalls(lifecycleTestRuntime.error, lifecycleTestRuntime.exit);
  expect(lifecycleTestRuntime.writeJson).toHaveBeenCalledTimes(json ? 1 : 0);
  if (action === "restart" || route === "start-recovery") {
    expect(postCheck).toHaveBeenCalledOnce();
    if (json) {
      expect(postCheck.mock.invocationCallOrder[0]).toBeLessThan(
        lifecycleTestRuntime.writeJson.mock.invocationCallOrder[0]!,
      );
    }
  }
});

it("keeps native lifecycle warnings ordered in JSON", async () => {
  const events: string[] = [];
  service.restart.mockImplementationOnce(async (args) => {
    expect(args.warn).toBeDefined();
    args.warn?.("native warning");
    events.push("native");
    return { outcome: "completed" };
  });
  await restart({
    postRestartCheck: async (ctx) => {
      expect(ctx.warn).toBeDefined();
      ctx.warn?.("post-check warning");
      events.push("post-check");
    },
  });
  expect(events).toEqual(["native", "post-check"]);
  expectJsonOutput({
    action: "restart",
    ok: true,
    result: "restarted",
    service: serviceSnapshot,
    warnings: ["native warning", "post-check warning"],
  });
});

it("never reports recovery success after a failed post-check", async () => {
  missingService();
  await expect(
    restart({
      onNotLoaded: async () => ({ result: "restarted", message: "must stay hidden" }),
      postRestartCheck: async ({ fail }) => {
        fail("not healthy", ["inspect"], "restart-health-failed");
      },
    }),
  ).rejects.toThrow("__exit__:1");
  expectJsonOutput({
    action: "restart",
    ok: false,
    error: "not healthy",
    hints: ["inspect"],
    result: "restart-health-failed",
    hintItems: [{ kind: "generic", text: "inspect" }],
  });
  expect(lifecycleTestRuntime.error.mock.calls).toEqual([]);
  expect(lifecycleTestRuntime.writeJson).toHaveBeenCalledOnce();
  expect(service.restart).not.toHaveBeenCalled();
});
