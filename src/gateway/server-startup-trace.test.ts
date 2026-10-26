import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureCliCommandStartup } from "../cli/command-startup-timing.js";
import { createGatewayDispatchStartupTrace } from "../cli/startup-trace.js";
import { measureDoctorConfigPreflightStep } from "../commands/doctor-config-preflight-measure.js";
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
        expect(info.mock.calls[1]?.[0]).toMatch(/ rssMb=256\.0 heapUsedMb=\d+\.\d$/);
        rss.mockReturnValue(512 * 1024 * 1024);
        trace.mark("ready");
        expect(info.mock.calls.at(-1)?.[0]).toMatch(/ rssMb=512\.0 heapUsedMb=\d+\.\d$/);
      } finally {
        trace.close();
      }
    },
  );

  it.each([
    { enabled: "0", fail: false },
    { enabled: "0", fail: true },
    { enabled: "1", fail: false },
  ])(
    "summarizes recovery once at phase end ($enabled, failure=$fail)",
    async ({ enabled, fail }) => {
      vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", enabled);
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const log = createSubsystemLogger("gateway-startup-test");
      const info = vi.spyOn(log, "info").mockImplementation(() => {});
      const trace = createGatewayStartupTrace(log, 0);
      const step = (name: string, ms: number) =>
        trace.measure(name, () => {
          now += ms;
        });
      const failure = new Error("synthetic private recovery payload");
      try {
        trace.mark("ready");
        info.mockClear();
        const recovery = trace.measure("sidecars.subagent-recovery", async () => {
          await step("sidecars.recovery-readers", 100);
          await trace.measure("sidecars.delivery-recovery", async () => {
            await step("sidecars.delivery-discovery", 10);
            await step("sidecars.delivery-entries", 20);
            await step("sidecars.delivery-history", 30);
            await step("sidecars.delivery-replay", 15);
            await step("sidecars.delivery-replay", 25);
            await step("sidecars.delivery-notices", 200);
            await step("sidecars.delivery-notices", 300);
            await step("sidecars.delivery-retry-wait", 1_000);
          });
          await step("sidecars.exec-recovery", 20);
          await step("sidecars.subagent-load", 30);
          await trace.measure("sidecars.subagent-activation", async () => {
            await step("sidecars.subagent-bind", 10);
            trace.detail("sidecars.subagent-activation", [
              ["registryActivationAuthorityRestoreMs", 6],
              ["registryActivationPublishMs", 2],
              ["registryActivationYieldMs", 1],
              ["registryActivationRuns", 6],
              ["registryActivationActiveRuns", 2],
              ["registryActivationRecoveredRuns", 1],
              ["registryActivationPublishedRuns", 5],
            ]);
            await step("sidecars.subagent-requesters", 5);
            await trace.measure("sidecars.subagent-resume", async () => {
              await step("sidecars.subagent-reserve", 3);
              now += 17;
              trace.detail("sidecars.subagent-activation", [
                ["registryActivationSessionReadMs", 7],
                ["registryActivationYieldMs", 2],
              ]);
            });
            await trace.measure("sidecars.subagent-interrupted", () => {
              now += 5;
              if (fail) {
                throw failure;
              }
            });
          });
        });
        if (fail) {
          await expect(recovery).rejects.toBe(failure);
        } else {
          await recovery;
        }
        const messages = info.mock.calls.map(([message]) => message);
        const summary = messages.filter((message) => message.includes("readersMs="));
        expect(summary).toEqual([
          expect.stringContaining(
            `startup ${enabled === "1" ? "trace" : "phase"}: sidecars.subagent-recovery 1790.0ms total=1790.0ms ${enabled === "1" ? "eventLoopMax=0.0ms " : ""}readersMs=100.0 execMs=20.0 registryLoadMs=30.0 registryActivationMs=40.0 registryActivationBindMs=10.0 registryActivationRequestersMs=5.0 registryActivationReserveMs=3.0 registryActivationResumeMs=20.0 registryActivationAuthorityRestoreMs=6.0 registryActivationPublishMs=2.0 registryActivationSessionReadMs=7.0 registryActivationYieldMs=3.0 registryActivationRuns=6.0 registryActivationActiveRuns=2.0 registryActivationRecoveredRuns=1.0 registryActivationPublishedRuns=5.0 outcome=${fail ? "failure" : "success"}`,
          ),
        ]);
        if (enabled === "0") {
          expect(messages).toHaveLength(2);
        }
        expect(messages.join("\n")).not.toContain(failure.message);

        info.mockClear();
        await trace.measure("sidecars.subagent-recovery", () => {});
        expect(info.mock.calls.at(-1)?.[0]).toContain(
          "readersMs=0.0 execMs=0.0 registryLoadMs=0.0 registryActivationMs=0.0 registryActivationBindMs=0.0 registryActivationRequestersMs=0.0 registryActivationReserveMs=0.0 registryActivationResumeMs=0.0 registryActivationAuthorityRestoreMs=0.0 registryActivationPublishMs=0.0 registryActivationSessionReadMs=0.0 registryActivationYieldMs=0.0 registryActivationRuns=0.0 registryActivationActiveRuns=0.0 registryActivationRecoveredRuns=0.0 registryActivationPublishedRuns=0.0 outcome=success",
        );
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
