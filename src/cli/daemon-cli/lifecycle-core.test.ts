// Daemon lifecycle core tests cover service lifecycle transitions and platform adapters.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { GatewayService } from "../../daemon/service.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { GatewayRestartPreparationError } from "../../infra/restart-intent-error.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createGatewayServiceRunArgs as createServiceRunArgs,
  lifecycleTestRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  lifecycleRuntimeLogs,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const loadConfig = vi.fn<() => OpenClawConfig>(() => ({
  gateway: {
    auth: {
      token: "config-token",
    },
  },
}));
const writeGatewayRestartIntentSync = vi.fn();
const clearGatewayRestartIntentSync = vi.fn();
const appendGatewayLifecycleAudit = vi.fn();
const MISSING_SERVICE_PROGRAM = "/openclaw-test-missing-runtime/node";
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

vi.mock("../../runtime.js", () => ({
  defaultRuntime: lifecycleTestRuntime,
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

const { runServiceRestart, runServiceStart, runServiceStop } = await import("./lifecycle-core.js");

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets assertions ascribe logged JSON shape.
function readJsonLog<T extends object>() {
  const jsonLine = lifecycleRuntimeLogs.find((line) => line.trim().startsWith("{"));
  return JSON.parse(jsonLine ?? "{}") as T;
}

async function withUnsupportedGatewayService(
  run: (unsupportedService: GatewayService) => Promise<void>,
) {
  const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("aix");
  try {
    const { resolveGatewayService } = await import("../../daemon/service.js");
    await run(resolveGatewayService());
  } finally {
    platformSpy.mockRestore();
  }
}

function expectUnsupportedServiceCheckFailure() {
  const payload = readJsonLog<{ ok?: boolean; error?: string }>();
  expect(payload.ok).toBe(false);
  expect(payload.error).toContain(
    "Gateway service check failed: Error: Gateway service install not supported on aix",
  );
}

describe("Gateway service lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mockSystemAccountHome();
    appendGatewayLifecycleAudit.mockClear();
    createGatewayLifecycleMutationAudit.mockClear();
    resetLifecycleRuntimeLogs();
    loadConfig.mockReset();
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
    resetLifecycleServiceMocks();
    writeGatewayRestartIntentSync.mockClear();
    clearGatewayRestartIntentSync.mockClear();
    service.readCommand.mockResolvedValue({
      programArguments: [],
      environment: { OPENCLAW_GATEWAY_TOKEN: "service-token" },
    });
    stubEmptyGatewayEnv();
  });

  it("rejects unsupported-platform start before not-loaded recovery", async () => {
    const onNotLoaded = vi.fn(async () => ({
      result: "started" as const,
      message: "should not run",
      loaded: true,
    }));

    await withUnsupportedGatewayService(async (unsupportedService) => {
      await expect(
        runServiceStart({
          serviceNoun: "Gateway",
          service: unsupportedService,
          renderStartHints: () => ["openclaw gateway install"],
          opts: { json: true },
          onNotLoaded,
        }),
      ).rejects.toThrow("__exit__:1");
    });

    expect(onNotLoaded).not.toHaveBeenCalled();
    expectUnsupportedServiceCheckFailure();
  });

  it("fails restart with the container hint when no service is installed", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue(null);
    const hasInstalledDefinition = vi.fn(async () => false);
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "openclaw-demo-container");

    await expect(
      runServiceRestart({
        serviceNoun: "Gateway",
        service: { ...service, hasInstalledDefinition } as GatewayService,
        renderStartHints: () => [
          "Restart the container or the service that manages it for openclaw-demo-container.",
          "openclaw gateway install",
        ],
        opts: { json: true },
      }),
    ).rejects.toThrow("__exit__:1");

    const payload = readJsonLog<{
      action?: string;
      ok?: boolean;
      error?: string;
      hints?: string[];
      hintItems?: Array<{ kind: string; text: string }>;
    }>();
    expect(payload).toMatchObject({
      action: "restart",
      ok: false,
      error: "Gateway service not loaded.",
    });
    expect(payload.hints).toContain(
      "Restart the container or the service that manages it for openclaw-demo-container.",
    );
    expect(payload.hintItems).toContainEqual(
      expect.objectContaining({ kind: "container-restart" }),
    );
    expect(hasInstalledDefinition).toHaveBeenCalledWith({ env: process.env });
  });

  it("runs the service mutation guard before restarting a loaded service", async () => {
    const beforeServiceMutation = vi.fn();

    await runServiceRestart({
      ...createServiceRunArgs(),
      beforeServiceMutation,
    });

    expect(beforeServiceMutation).toHaveBeenCalledTimes(1);
    expect(beforeServiceMutation.mock.invocationCallOrder[0]).toBeLessThan(
      service.restart.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("aborts loaded-service mutation when the service guard rejects", async () => {
    const repairLoadedService = vi.fn();

    await expect(
      runServiceRestart({
        ...createServiceRunArgs(),
        beforeServiceMutation: () => {
          throw new Error("service mutation denied");
        },
        repairLoadedService,
      }),
    ).rejects.toThrow("service mutation denied");

    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(repairLoadedService).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("repairs managed port drift before restarting", async () => {
    service.readRuntime.mockResolvedValue({ status: "running", pid: 1234 });
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
    });
    type RepairLoadedService = NonNullable<
      Parameters<typeof runServiceRestart>[0]["repairLoadedService"]
    >;
    const repairLoadedService = vi.fn<RepairLoadedService>(async () => ({
      result: "restarted" as const,
      message: "Gateway service definition repaired and restarted.",
      loaded: true,
    }));

    await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true, restartIntent: { waitMs: 2_500 } },
      expectedPort: 19_001,
      repairLoadedService,
    });

    expect(repairLoadedService).toHaveBeenCalledWith(
      expect.objectContaining({
        issues: [
          {
            code: "port-mismatch",
            message: "service port 18789 does not match current gateway config port 19001",
          },
        ],
      }),
    );
    expect(service.restart).not.toHaveBeenCalled();
    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.any(Object),
        reason: "gateway.restart",
        intent: { waitMs: 2_500 },
      }),
    );
    expect(readJsonLog<{ result?: string; message?: string }>()).toMatchObject({
      result: "restarted",
      message: "Gateway service definition repaired and restarted.",
    });
  });

  it.each([false])(
    "keeps Nix restart available without suggesting a forbidden token reinstall (json=%s)",
    async (json) => {
      await withEnvAsync({ OPENCLAW_NIX_MODE: "1" }, async () => {
        await expect(
          runServiceRestart({ ...createServiceRunArgs(true), opts: { json } }),
        ).resolves.toBe(true);

        expect(service.restart).toHaveBeenCalledOnce();
        const output = json
          ? readJsonLog<{ warnings: string[] }>().warnings.join("\n")
          : lifecycleRuntimeLogs.join("\n");
        expect(output).toContain("Config token differs from service token");
        expect(output).toContain("Nix mode detected; service install is disabled.");
        expect(output).not.toContain("gateway install --force");
      });
    },
  );

  it("compares restart drift against config token even when caller env is set", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
    service.readCommand.mockResolvedValue({
      programArguments: [],
      environment: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
    });
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings?.some((warning) => warning.includes("gateway install --force"))).toBe(
      true,
    );
  });

  it("skips drift warning when disabled", async () => {
    await runServiceRestart({
      serviceNoun: "Node",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    const payload = readJsonLog<{ warnings?: string[] }>();
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

    const payload = readJsonLog<{ result?: string; service?: { loaded?: boolean } }>();
    expect(payload.result).toBe("stopped");
    expect(payload.service?.loaded).toBe(false);
    expect(service.stop).toHaveBeenCalledTimes(1);
    const [stopOptions] = service.stop.mock.calls[0] ?? [];
    expect(stopOptions?.env).toBe(process.env);
    expect(stopOptions?.disable).toBe(true);
    expect(onNotLoaded).not.toHaveBeenCalled();
  });

  it("skips restart health checks when restart is only scheduled", async () => {
    const postRestartCheck = vi.fn(async () => {});
    service.restart.mockResolvedValue({ outcome: "scheduled" });

    const result = await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      postRestartCheck,
    });

    expect(result).toBe(true);
    expect(postRestartCheck).not.toHaveBeenCalled();
    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("scheduled");
    expect(payload.message).toBe("restart scheduled, gateway will restart momentarily");
  });

  it("reports startup recovery instead of install hints when restart cannot verify a serving owner", async () => {
    writeGatewayRestartIntentSync.mockImplementationOnce(() => {
      throw new GatewayRestartPreparationError("serving-owner");
    });
    await expect(
      runServiceRestart({
        ...createServiceRunArgs(),
        renderStartHints: () => ["openclaw gateway install"],
      }),
    ).rejects.toThrow("__exit__:1");
    const payload = readJsonLog<{ hints: string[] }>();
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

    await expect(runServiceRestart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.any(Object),
        reason: "gateway.restart",
      }),
    );
    expect(clearGatewayRestartIntentSync).toHaveBeenCalledOnce();
  });

  it.each(["ready", "still-starting", "failed"] as const)(
    "checks an already-running service before reporting start %s",
    async (outcome) => {
      service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });
      const postStartCheck: NonNullable<
        Parameters<typeof runServiceStart>[0]["postStartCheck"]
      > = async ({ fail }) => {
        if (outcome !== "ready") {
          fail(
            "Gateway listener is unavailable.",
            [],
            outcome === "still-starting" ? outcome : undefined,
          );
        }
      };
      const start = runServiceStart({ ...createServiceRunArgs(), postStartCheck });
      if (outcome === "ready") {
        await start;
        expect(readJsonLog()).toMatchObject({ ok: true, result: "already-running" });
      } else {
        await expect(start).rejects.toThrow(`__exit__:${outcome === "still-starting" ? 2 : 1}`);
        expect(readJsonLog()).toMatchObject({
          ok: false,
          error: "Gateway listener is unavailable.",
        });
        if (outcome === "still-starting") {
          expect(readJsonLog()).toMatchObject({ result: "still-starting" });
        }
      }
      expect(lifecycleRuntimeLogs.filter((line) => line.trim().startsWith("{"))).toHaveLength(1);
      expect(service.start).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
    },
  );

  it("preserves the readiness failure and exit code after starting a stopped service", async () => {
    await expect(
      runServiceStart({
        ...createServiceRunArgs(),
        postStartCheck: async ({ fail }) =>
          fail("Gateway is still starting.", [], "still-starting"),
      }),
    ).rejects.toThrow("__exit__:2");
    expect(readJsonLog()).toMatchObject({
      ok: false,
      result: "still-starting",
      error: "Gateway is still starting.",
    });
    expect(lifecycleRuntimeLogs.filter((line) => line.trim().startsWith("{"))).toHaveLength(1);
    expect(service.start).toHaveBeenCalledOnce();
  });

  it.each([["Gateway", "", "", "openclaw gateway", "restart"]] as const)(
    "warns in json with the %s service repair command and active context",
    async (serviceNoun, profile, container, command, repairAction) => {
      vi.stubEnv("OPENCLAW_PROFILE", profile);
      vi.stubEnv("OPENCLAW_CONTAINER_HINT", container);
      service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });
      service.readCommand.mockResolvedValue({
        programArguments: [MISSING_SERVICE_PROGRAM, "openclaw", serviceNoun.toLowerCase()],
      });

      await runServiceStart({
        ...createServiceRunArgs(),
        serviceNoun,
        repairLoadedService: serviceNoun === "Gateway" ? vi.fn(async () => null) : undefined,
      });

      const payload = readJsonLog<{ result?: string; warnings?: string[] }>();
      expect(payload.result).toBe("already-running");
      expect(payload.warnings).toEqual([
        `${serviceNoun} service already running, but its installed service definition needs repair: service command points at a missing path: ${MISSING_SERVICE_PROGRAM}; run \`${command} ${repairAction}\` to apply.`,
      ]);
      expect(service.start).not.toHaveBeenCalled();
    },
  );

  it.each([["Node", "install --force"]])(
    "prints one warning line when an already-running %s service needs repair",
    async (serviceNoun, repairAction) => {
      service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });
      service.readCommand.mockResolvedValue({
        programArguments: [MISSING_SERVICE_PROGRAM, "openclaw", serviceNoun.toLowerCase()],
      });

      await runServiceStart({
        serviceNoun,
        service,
        renderStartHints: () => [],
        repairLoadedService: serviceNoun === "Gateway" ? vi.fn(async () => null) : undefined,
      });

      const repairWarnings = lifecycleRuntimeLogs.filter((line) =>
        line.startsWith(
          `${serviceNoun} service already running, but its installed service definition needs repair:`,
        ),
      );
      expect(repairWarnings).toHaveLength(1);
      expect(repairWarnings[0]).toContain(
        `run \`openclaw ${serviceNoun.toLowerCase()} ${repairAction}\` to apply.`,
      );
      expect(service.start).not.toHaveBeenCalled();
    },
  );

  it("repairs loaded services with port drift during start before reporting success", async () => {
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
    });
    type RepairLoadedService = NonNullable<
      Parameters<typeof runServiceStart>[0]["repairLoadedService"]
    >;
    const repairLoadedService = vi.fn<RepairLoadedService>(async (ctx) => {
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

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      repairLoadedService,
      expectedPort: 19_001,
    });

    expect(repairLoadedService).toHaveBeenCalledTimes(1);
    expect(service.start).not.toHaveBeenCalled();
    const payload = readJsonLog<{
      result?: string;
      message?: string;
      warnings?: string[];
      service?: { loaded?: boolean };
    }>();
    expect(payload.result).toBe("started");
    expect(payload.message).toBe("Gateway service definition repaired and started.");
    expect(payload.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("service port 18789"),
        expect.stringContaining("custom behavior and will be overwritten"),
      ]),
    );
    expect(payload.service?.loaded).toBe(true);
  });

  it.each([["Node", "work", "demo", "openclaw --container demo node"]] as const)(
    "fails %s service start with its own install hint when repair is required",
    async (serviceNoun, profile, container, command) => {
      vi.stubEnv("OPENCLAW_PROFILE", profile);
      vi.stubEnv("OPENCLAW_CONTAINER_HINT", container);
      service.readCommand.mockResolvedValue({
        programArguments: [MISSING_SERVICE_PROGRAM, "openclaw", serviceNoun.toLowerCase()],
      });

      await expect(runServiceStart({ ...createServiceRunArgs(), serviceNoun })).rejects.toThrow(
        "__exit__:1",
      );

      const payload = readJsonLog<{
        ok?: boolean;
        error?: string;
        hints?: string[];
        hintItems?: Array<{ kind: string; text: string }>;
      }>();
      expect(payload.ok).toBe(false);
      expect(payload.error).toContain("service needs repair");
      expect(payload.hints).toEqual([`${command} install --force`]);
      expect(payload.hintItems).toEqual([{ kind: "install", text: `${command} install --force` }]);

      resetLifecycleRuntimeLogs();
      await expect(
        runServiceStart({
          ...createServiceRunArgs(),
          serviceNoun,
          opts: { json: false },
        }),
      ).rejects.toThrow("__exit__:1");
      expect(lifecycleRuntimeLogs).toContain(`Tip: ${command} install --force`);
      expect(service.start).not.toHaveBeenCalled();
    },
  );

  it("fails start with install hints when no service is installed", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue(null);

    await expect(
      runServiceStart({
        serviceNoun: "Gateway",
        service,
        renderStartHints: () => ["openclaw gateway install"],
        opts: { json: true },
      }),
    ).rejects.toThrow("__exit__:1");

    const payload = readJsonLog<{
      ok?: boolean;
      error?: string;
      hints?: string[];
      hintItems?: Array<{ kind: string; text: string }>;
    }>();
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("Gateway service not loaded.");
    expect(payload.hints?.includes("openclaw gateway install")).toBe(true);
    expect(
      payload.hintItems?.some(
        (item) => item.kind === "install" && item.text === "openclaw gateway install",
      ),
    ).toBe(true);
    expect(service.start).not.toHaveBeenCalled();
  });
  it.each(
    (
      [
        ["start-recovery", "start", "started", "service repaired", true, true],
        [
          "already-running",
          "start",
          "already-running",
          "Gateway service already running.",
          true,
          true,
        ],
        ["stop-empty", "stop", "stopped", "", false, true],
        ["stop-missing", "stop", "not-loaded", "Gateway service not loaded.", false, false],
        ["restart-no-message", "restart", "restarted", undefined, false, true],
        [
          "restart-postcheck-scheduled",
          "restart",
          "scheduled",
          "restart scheduled, gateway will restart momentarily",
          true,
          true,
        ],
      ] as const
    ).map(
      ([route, action, result, message, loaded, json]) =>
        [route, json, { route, action, result, message, loaded }] as const,
    ),
  )("preserves exact %s output (json=%s)", async (_route, json, row) => {
    const args = {
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json },
    };
    const postCheck = vi.fn(async () =>
      row.route === "restart-postcheck-scheduled" ? { outcome: "scheduled" as const } : undefined,
    );
    lifecycleTestRuntime.error.mockClear();
    lifecycleTestRuntime.exit.mockClear();
    lifecycleTestRuntime.writeJson.mockClear();
    service.isLoaded.mockResolvedValue(row.loaded);
    service.readCommand.mockResolvedValue(
      row.loaded ? { programArguments: [], environment: {} } : null,
    );
    let result: unknown;
    if (row.route === "start-recovery") {
      service.isLoaded.mockResolvedValue(false);
      result = await runServiceStart({
        ...args,
        onNotLoaded: async () => ({ result: "started", message: row.message, loaded: true }),
        postStartCheck: async () => {
          await postCheck();
        },
      });
    } else if (row.action === "start") {
      service.readRuntime.mockResolvedValue({
        status: "running",
      });
      service.readCommand.mockResolvedValue({ programArguments: [], environment: {} });
      result = await runServiceStart(args);
    } else if (row.action === "stop") {
      result = await runServiceStop({
        ...args,
        ...(row.route === "stop-missing"
          ? {}
          : {
              onNotLoaded: async () => ({ result: "stopped" as const, message: row.message }),
            }),
      });
    } else {
      result = await runServiceRestart({
        ...args,
        postRestartCheck: postCheck,
        ...(!row.loaded
          ? {
              onNotLoaded: async () => ({ result: "restarted" as const, message: row.message }),
            }
          : {}),
      });
    }
    expect(result).toBe(row.action === "restart" ? true : undefined);
    const payload = {
      action: row.action,
      ok: true,
      result: row.result,
      message: row.message,
      service: {
        label: "TestService",
        loaded: row.loaded,
        loadedText: "loaded",
        notLoadedText: "not loaded",
      },
    };
    expect(lifecycleRuntimeLogs).toEqual(
      json ? [JSON.stringify(payload, null, 2)] : row.message ? [row.message] : [],
    );
    expect(lifecycleTestRuntime.error).not.toHaveBeenCalled();
    expect(lifecycleTestRuntime.exit).not.toHaveBeenCalled();
    expect(lifecycleTestRuntime.writeJson).toHaveBeenCalledTimes(json ? 1 : 0);
    if (row.action === "restart" || row.route === "start-recovery") {
      expect(postCheck).toHaveBeenCalledOnce();
      if (json) {
        expect(postCheck.mock.invocationCallOrder[0]).toBeLessThan(
          lifecycleTestRuntime.writeJson.mock.invocationCallOrder[0]!,
        );
      }
    }
  });

  it.each([true])("keeps native lifecycle warn optional and ordered (json=%s)", async (json) => {
    const events: string[] = [];
    service.restart.mockImplementationOnce(async (args) => {
      expect(args.warn === undefined).toBe(!json);
      args.warn?.("native warning");
      events.push("native");
      return { outcome: "completed" };
    });
    await runServiceRestart({
      ...createServiceRunArgs(),
      opts: { json },
      postRestartCheck: async (ctx) => {
        expect(ctx.warn === undefined).toBe(!json);
        ctx.warn?.("post-check warning");
        events.push("post-check");
      },
    });
    expect(events).toEqual(["native", "post-check"]);
    expect(lifecycleRuntimeLogs).toEqual(
      json
        ? [
            JSON.stringify(
              {
                action: "restart",
                ok: true,
                result: "restarted",
                service: {
                  label: "TestService",
                  loaded: true,
                  loadedText: "loaded",
                  notLoadedText: "not loaded",
                },
                warnings: ["native warning", "post-check warning"],
              },
              null,
              2,
            ),
          ]
        : [],
    );
  });

  it.each([true])(
    "never reports recovery success after a failed post-check (json=%s)",
    async (json) => {
      service.isLoaded.mockResolvedValue(false);
      service.readCommand.mockResolvedValue(null);
      lifecycleTestRuntime.log.mockClear();
      lifecycleTestRuntime.error.mockClear();
      lifecycleTestRuntime.writeJson.mockClear();
      await expect(
        runServiceRestart({
          ...createServiceRunArgs(),
          opts: { json },
          onNotLoaded: async () => ({ result: "restarted", message: "must stay hidden" }),
          postRestartCheck: async ({ fail }) => {
            fail("not healthy", ["inspect"], "restart-health-failed");
          },
        }),
      ).rejects.toThrow("__exit__:1");
      expect(lifecycleRuntimeLogs).toEqual(
        json
          ? [
              JSON.stringify(
                {
                  action: "restart",
                  ok: false,
                  error: "not healthy",
                  hints: ["inspect"],
                  result: "restart-health-failed",
                  hintItems: [{ kind: "generic", text: "inspect" }],
                },
                null,
                2,
              ),
            ]
          : ["Tip: inspect"],
      );
      expect(lifecycleTestRuntime.error.mock.calls).toEqual(json ? [] : [["not healthy"]]);
      expect(lifecycleTestRuntime.writeJson).toHaveBeenCalledTimes(json ? 1 : 0);
      if (!json) {
        expect(lifecycleTestRuntime.error.mock.invocationCallOrder[0]).toBeLessThan(
          lifecycleTestRuntime.log.mock.invocationCallOrder[0]!,
        );
      }
      expect(service.restart).not.toHaveBeenCalled();
    },
  );
});
