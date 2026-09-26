import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureCliCommandStartup } from "../cli/command-startup-timing.js";
import { createGatewayDispatchStartupTrace } from "../cli/startup-trace.js";
import { measureDoctorConfigPreflightStep } from "../commands/doctor-config-preflight-measure.js";

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
  beforeEach(() => {
    eventLoopDelay.instances.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

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
