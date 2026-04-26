import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginServiceContext } from "./plugin-entry.js";
import { createPluginServiceLifecycleTestHarness } from "./testing.js";

const harnesses: Array<{ cleanup: () => Promise<void> }> = [];

afterEach(async () => {
  const current = harnesses.splice(0);
  await Promise.all(current.map((harness) => harness.cleanup()));
});

describe("plugin service lifecycle test harness", () => {
  it("starts and stops a registered service with a usable state directory", async () => {
    const harness = await createPluginServiceLifecycleTestHarness();
    harnesses.push(harness);
    const starts: string[] = [];
    const stops: string[] = [];

    harness.registerService({
      id: "state-dir-probe",
      async start(ctx) {
        starts.push(ctx.stateDir);
        await fs.writeFile(path.join(ctx.stateDir, "service-probe.txt"), "ok", "utf8");
      },
      stop(ctx) {
        stops.push(ctx.stateDir);
      },
    });

    await harness.startServices();
    await harness.stopServices();

    expect(starts).toEqual([harness.stateDir]);
    expect(stops).toEqual([harness.stateDir]);
    await expect(
      fs.readFile(path.join(harness.stateDir, "service-probe.txt"), "utf8"),
    ).resolves.toBe("ok");
  });

  it("throws on empty or duplicate service ids", async () => {
    const harness = await createPluginServiceLifecycleTestHarness();
    harnesses.push(harness);

    expect(() =>
      harness.registerService({
        id: "   ",
        start() {},
      }),
    ).toThrow("registerService: service.id must not be empty");

    harness.registerService({
      id: "duplicate-service",
      start() {},
    });

    expect(() =>
      harness.registerService({
        id: "duplicate-service",
        start() {},
      }),
    ).toThrow('registerService: a service with id "duplicate-service" is already registered');
  });

  it("runs a registered hook that can write a generic whitelist record through service state", async () => {
    const harness = await createPluginServiceLifecycleTestHarness();
    harnesses.push(harness);
    let serviceContext: OpenClawPluginServiceContext | undefined;

    harness.registerService({
      id: "generic-record-service",
      start(ctx) {
        serviceContext = ctx;
      },
      stop() {
        serviceContext = undefined;
      },
    });
    harness.registerHook("gateway_start", async () => {
      if (!serviceContext) {
        throw new Error("service context unavailable");
      }
      const dir = path.join(serviceContext.stateDir, "generic-whitelist");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "record.json"), JSON.stringify({ allowed: true }), "utf8");
    });

    await harness.startServices();
    await harness.runGatewayStart({ port: 1234 });

    await expect(
      fs.readFile(path.join(harness.stateDir, "generic-whitelist", "record.json"), "utf8"),
    ).resolves.toBe(JSON.stringify({ allowed: true }));

    await harness.stopServices();
    expect(serviceContext).toBeUndefined();
  });

  it("keeps hook write failure non-fatal while services remain stoppable", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const harness = await createPluginServiceLifecycleTestHarness({ logger });
    harnesses.push(harness);
    const stops: string[] = [];
    let serviceContext: OpenClawPluginServiceContext | undefined;

    harness.registerService({
      id: "write-failure-service",
      start(ctx) {
        serviceContext = ctx;
      },
      stop(ctx) {
        stops.push(ctx.stateDir);
      },
    });
    harness.registerHook("gateway_start", async () => {
      if (!serviceContext) {
        throw new Error("service context unavailable");
      }
      const filePath = path.join(serviceContext.stateDir, "generic-whitelist");
      await fs.writeFile(filePath, "not a directory", "utf8");
      await fs.mkdir(path.join(filePath, "records"), { recursive: true });
    });

    await harness.startServices();
    await expect(harness.runGatewayStart()).resolves.toBeUndefined();
    await harness.stopServices();

    expect(stops).toEqual([harness.stateDir]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
