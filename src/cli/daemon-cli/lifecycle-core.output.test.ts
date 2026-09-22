// Daemon lifecycle output contracts exercise real response owners with shared service fixtures.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
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

let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;
let runServiceStart: typeof import("./lifecycle-core.js").runServiceStart;
let runServiceStop: typeof import("./lifecycle-core.js").runServiceStop;

describe("runServiceRestart token drift", () => {
  beforeAll(async () => {
    ({ runServiceRestart, runServiceStart, runServiceStop } = await import("./lifecycle-core.js"));
  });

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

  it.each(
    [
      {
        route: "start-recovery",
        action: "start",
        result: "started",
        message: "service repaired",
        loaded: true,
      },
      {
        route: "already-running-pid",
        action: "start",
        result: "already-running",
        message: "Gateway service already running (pid 4242).",
        loaded: true,
      },
      {
        route: "already-running",
        action: "start",
        result: "already-running",
        message: "Gateway service already running.",
        loaded: true,
      },
      {
        route: "stop-recovery",
        action: "stop",
        result: "stopped",
        message: "process stopped",
        loaded: false,
      },
      { route: "stop-empty", action: "stop", result: "stopped", message: "", loaded: false },
      {
        route: "stop-missing",
        action: "stop",
        result: "not-loaded",
        message: "Gateway service not loaded.",
        loaded: false,
      },
      {
        route: "restart-recovery",
        action: "restart",
        result: "restarted",
        message: "process restarted",
        loaded: false,
      },
      {
        route: "restart-empty",
        action: "restart",
        result: "restarted",
        message: "",
        loaded: false,
      },
      {
        route: "restart-no-message",
        action: "restart",
        result: "restarted",
        message: undefined,
        loaded: false,
      },
      {
        route: "restart-scheduled",
        action: "restart",
        result: "scheduled",
        message: "restart scheduled, gateway will restart momentarily",
        loaded: true,
      },
      {
        route: "restart-postcheck-scheduled",
        action: "restart",
        result: "scheduled",
        message: "restart scheduled, gateway will restart momentarily",
        loaded: true,
      },
      {
        route: "restart-native",
        action: "restart",
        result: "restarted",
        message: undefined,
        loaded: true,
      },
    ].flatMap((row) => [[row.route, false, row] as const, [row.route, true, row] as const]),
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
        ...(row.route === "already-running-pid" ? { pid: 4242 } : {}),
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
      if (row.route === "restart-scheduled") {
        service.restart.mockResolvedValue({ outcome: "scheduled" });
      }
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
    if (row.route === "restart-scheduled") {
      expect(postCheck).not.toHaveBeenCalled();
    } else if (row.action === "restart" || row.route === "start-recovery") {
      expect(postCheck).toHaveBeenCalledOnce();
      if (json) {
        expect(postCheck.mock.invocationCallOrder[0]).toBeLessThan(
          lifecycleTestRuntime.writeJson.mock.invocationCallOrder[0]!,
        );
      }
    }
  });

  it.each([false, true])(
    "keeps native lifecycle warn optional and ordered (json=%s)",
    async (json) => {
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
    },
  );

  it.each([false, true])(
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
