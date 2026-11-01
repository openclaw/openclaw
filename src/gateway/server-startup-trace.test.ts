import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureCliCommandStartup } from "../cli/command-startup-timing.js";
import { createGatewayDispatchStartupTrace } from "../cli/startup-trace.js";
import { measureDoctorConfigPreflightStep } from "../commands/doctor-config-preflight-measure.js";
import { captureWorkerStartObserver } from "../infra/worker-request-diagnostics.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const eventLoopDelay = vi.hoisted(() => ({
  instances: [] as Array<{
    disable: ReturnType<typeof vi.fn>;
    enable: ReturnType<typeof vi.fn>;
    percentile: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("node:perf_hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:perf_hooks")>();
  return {
    ...actual,
    monitorEventLoopDelay: vi.fn(() => {
      const instance = {
        disable: vi.fn(),
        enable: vi.fn(),
        percentile: vi.fn(() => 0),
        reset: vi.fn(),
      };
      eventLoopDelay.instances.push(instance);
      return { ...instance, max: 0 };
    }),
  };
});

import { createGatewayStartupTrace } from "./server-startup-trace.js";

describe("gateway startup trace", () => {
  const originalArgv = process.argv;
  beforeEach(() => {
    eventLoopDelay.instances.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("attributes overlapping plugin worker starts without counting unrelated recovery", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "0");
    const info = vi.fn();
    const trace = createGatewayStartupTrace({ info } as never);
    const startWorker = (script: string) => {
      captureWorkerStartObserver(new URL(script, import.meta.url))?.();
    };
    const first = "plugins.gateway-load.plugin.first";
    const second = "plugins.gateway-load.plugin.second";
    try {
      const preparing = trace.run(first, async () => {
        await Promise.resolve();
        startWorker("plugin-generation-preparation.worker.js");
      });
      trace.run(second, () => startWorker("git-operation.worker.js"));
      startWorker("session-transcript.worker.js");
      trace.detail(second, [["loadAndRegisterMs", 1]]);
      await preparing;
      trace.detail(first, [["loadAndRegisterMs", 2]]);
      trace.detail("plugins.gateway-load.plugin.fast", [["loadAndRegisterMs", 1]]);
      trace.detail("plugins.gateway-load.plugin.slow", [["loadAndRegisterMs", 250]]);
      await Promise.resolve();
      expect(info.mock.calls.map(([message]) => message)).toEqual([
        `startup trace: ${second} loadAndRegisterMs=1.0 workersStarted=1 workerScripts=git-operation.worker.js:1`,
        `startup trace: ${first} loadAndRegisterMs=2.0 workersStarted=1 workerScripts=plugin-generation-preparation.worker.js:1`,
        "startup trace: plugins.gateway-load.plugin.slow loadAndRegisterMs=250.0 workersStarted=0 workerScripts=none",
      ]);
    } finally {
      trace.close();
    }
  });

  it.each(["0", "1"])(
    "reports process RSS and main heap at phase completion (trace=%s)",
    async (enabled) => {
      vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", enabled);
      const rss = vi.spyOn(process.memoryUsage, "rss").mockReturnValue(128 * 1024 * 1024);
      const info = vi.fn();
      const trace = createGatewayStartupTrace({ info } as never);
      try {
        await trace.measure("sessions.admission", () => {
          rss.mockReturnValue(256 * 1024 * 1024);
        });
        expect(info.mock.calls[0]?.[0]).not.toContain("rssMb=");
        expect(info.mock.calls[1]?.[0]).toMatch(/ rssMb=256\.0 heapUsedMb=\d+\.\d workers=0 /);
        rss.mockReturnValue(512 * 1024 * 1024);
        trace.mark("ready");
        expect(info.mock.calls.at(-1)?.[0]).toMatch(/ rssMb=512\.0 heapUsedMb=\d+\.\d workers=0 /);
      } finally {
        trace.close();
      }
    },
  );

  it.each([
    { trace: "0", duration: 249, fail: false, nested: false, visible: false },
    { trace: undefined, duration: 250, fail: false, nested: false, visible: true },
    { trace: "0", duration: 500, fail: true, nested: false, visible: true },
    { trace: "1", duration: 500, fail: false, nested: false, visible: true },
    { trace: "0", duration: 500, fail: false, nested: true, visible: false },
  ])(
    "reports slow service startup once without payloads ($trace, $duration ms, failure=$fail, nested=$nested)",
    async ({ trace: enabled, duration, fail, nested, visible }) => {
      vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", enabled);
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const log = createSubsystemLogger("gateway-startup-test");
      const info = vi.spyOn(log, "info").mockImplementation(() => {});
      const trace = createGatewayStartupTrace(log, 0);
      const name = `sidecars.plugin-services.plugin-a.service-a${nested ? ".remote-request" : ""}`;
      const failure = new Error("synthetic sensitive service payload");
      try {
        const measured = trace.measure(name, () => {
          now += duration;
          if (fail) {
            throw failure;
          }
        });
        if (fail) {
          await expect(measured).rejects.toBe(failure);
        } else {
          await measured;
        }
        expect(info.mock.calls.map(([message]) => message)).toEqual(
          visible
            ? [
                expect.stringContaining(
                  `startup trace: ${name} ${duration.toFixed(1)}ms total=${duration.toFixed(1)}ms eventLoopMax=0.0ms outcome=${fail ? "failure" : "success"}`,
                ),
              ]
            : [],
        );
      } finally {
        trace.close();
      }
    },
  );

  it.each([
    { updateCanary: false, markers: 2 },
    { updateCanary: true, markers: 0 },
    { updateCanary: true, markers: 1 },
    { updateCanary: true, markers: 2 },
    { updateCanary: true, markers: 3 },
  ])(
    "reports completed Gateway milestones only to a supporting updater ($updateCanary, $markers)",
    async ({ updateCanary, markers }) => {
      vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "0");
      process.argv = [
        "node",
        "openclaw",
        "gateway",
        "run",
        ...Array.from({ length: markers }, () => "--update-canary"),
      ];
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const trace = createGatewayStartupTrace({ info: vi.fn() } as never, 0, updateCanary);
      trace.detail("state.schema-preflight", [["agents", 2]]);
      await trace.measure("config.snapshot", async () => {});
      await expect(
        trace.measure("plugins.bootstrap", async () => {
          throw new Error("plugin startup failed");
        }),
      ).rejects.toThrow("plugin startup failed");
      trace.mark("http.bound");
      trace.mark("tick.1");
      await trace.measure("plugins.bootstrap.tick.2", async () => {});
      trace.close();
      trace.mark("ready");

      const progress = stderr.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("openclaw-update-canary-progress: "));
      expect(progress).toEqual(
        updateCanary && markers >= 2
          ? [
              "openclaw-update-canary-progress: config.snapshot\n",
              "openclaw-update-canary-progress: http.bound\n",
            ]
          : [],
      );
    },
  );

  it("carries bootstrap step counts to ready without reusing them on restart", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "1");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const dispatch = createGatewayDispatchStartupTrace(["node", "openclaw", "gateway"], "entry");
    dispatch.setLineFormatter((message) => message);
    dispatch.mark("bootstrap");
    for (let admission = 0; admission < 2; admission += 1) {
      await measureDoctorConfigPreflightStep(
        "database-admission",
        () => Promise.resolve(),
        (name, run) => measureCliCommandStartup(name, run),
        () => ({ agents: 200 }),
      );
    }
    const info = vi.fn();
    const trace = createGatewayStartupTrace(
      { info } as unknown as Parameters<typeof createGatewayStartupTrace>[0],
      performance.now() - 10,
    );

    trace.mark("process.bootstrap");
    await trace.measure("state.ownership", async () => {});
    await measureDoctorConfigPreflightStep("after-bootstrap", () => Promise.resolve());
    trace.mark("ready");

    const messages = info.mock.calls.map(([message]) => String(message));
    const preBootstrap = messages.find((message) =>
      message.startsWith("startup trace: process.bootstrap "),
    );
    const ownership = messages.find((message) => message.includes("state.ownership"));
    expect(preBootstrap).toContain("total=");
    expect(ownership).toContain("total=");
    expect(messages.indexOf(preBootstrap ?? "")).toBeLessThan(messages.indexOf(ownership ?? ""));
    const admissionStep = messages.find((message) =>
      message.startsWith("startup trace: process.bootstrap.cli.bootstrap.database-admission "),
    );
    expect(admissionStep).toMatch(/start=\d+\.\dms calls=2\.0 agents=400\.0$/);
    expect(admissionStep).not.toContain("rssMb=");
    expect(messages.find((message) => message.startsWith("startup trace: ready "))).toContain(
      "cli.bootstrap.database-admission:",
    );
    expect(messages.join("\n")).not.toContain("after-bootstrap");
    expect(messages.join("\n")).not.toContain("cli.command.doctor.config-preflight");
    expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toMatch(
      /cli.bootstrap.database-admission .* start=\d+\.\dms agents=200/,
    );

    info.mockClear();
    const restartTrace = createGatewayStartupTrace({ info } as never);
    restartTrace.mark("process.bootstrap");
    restartTrace.mark("ready");
    expect(info.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain(
      "bootstrapSteps=",
    );
  });

  it("closes the event-loop monitor once without allowing it to reopen", () => {
    vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "1");
    const trace = createGatewayStartupTrace({ info: vi.fn() } as never);

    trace.close();
    trace.close();
    trace.setConfig({});
    trace.mark("ready");

    expect(eventLoopDelay.instances).toHaveLength(1);
    expect(eventLoopDelay.instances[0]?.enable).toHaveBeenCalledOnce();
    expect(eventLoopDelay.instances[0]?.disable).toHaveBeenCalledOnce();
  });

  it("keeps tracing after a measured error until startup reaches a terminal outcome", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "1");
    const trace = createGatewayStartupTrace({ info: vi.fn() } as never);

    await expect(
      trace.measure("sidecars.channel-start", async () => {
        throw new Error("channel unavailable");
      }),
    ).rejects.toThrow("channel unavailable");

    expect(eventLoopDelay.instances[0]?.disable).not.toHaveBeenCalled();
    trace.mark("sidecars.ready");
    expect(eventLoopDelay.instances[0]?.reset).toHaveBeenCalled();
    expect(eventLoopDelay.instances[0]?.disable).not.toHaveBeenCalled();

    trace.mark("ready");
    expect(eventLoopDelay.instances[0]?.disable).toHaveBeenCalledOnce();
  });
});
