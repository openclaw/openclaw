import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("reports plugin worker starts for a completed startup step", () => {
    vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "0");
    const info = vi.fn();
    const trace = createGatewayStartupTrace({ info } as never);
    const name = "plugins.gateway-load.plugin.first";
    try {
      trace.run(name, () => {
        captureWorkerStartObserver(
          new URL("plugin-generation-preparation.worker.js", import.meta.url),
        )?.();
      });
      trace.detail(name, [["loadAndRegisterMs", 2]]);
      expect(info.mock.calls.map(([message]) => message)).toEqual([
        `startup trace: ${name} loadAndRegisterMs=2.0 workersStarted=1 workerScripts=plugin-generation-preparation.worker.js:1`,
      ]);
    } finally {
      trace.close();
    }
  });

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
        expect(info.mock.calls.map(([message]) => message).join("\n")).not.toContain(
          failure.message,
        );
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
