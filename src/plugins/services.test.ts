import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "./types.js";

const mockedLogger = vi.hoisted(() => ({
  info: vi.fn<(msg: string) => void>(),
  warn: vi.fn<(msg: string) => void>(),
  error: vi.fn<(msg: string) => void>(),
  debug: vi.fn<(msg: string) => void>(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => mockedLogger,
}));

import { STATE_DIR } from "../config/paths.js";
import { startPluginServices } from "./services.js";

function createRegistry(services: OpenClawPluginService[]) {
  const registry = createEmptyPluginRegistry();
  for (const service of services) {
    registry.services.push({ pluginId: "plugin:test", service, source: "test" });
  }
  return registry;
}

describe("startPluginServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts services and stops them in reverse order", async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const contexts: OpenClawPluginServiceContext[] = [];

    const serviceA: OpenClawPluginService = {
      id: "service-a",
      start: (ctx) => {
        starts.push("a");
        contexts.push(ctx);
      },
      stop: () => {
        stops.push("a");
      },
    };
    const serviceB: OpenClawPluginService = {
      id: "service-b",
      start: (ctx) => {
        starts.push("b");
        contexts.push(ctx);
      },
    };
    const serviceC: OpenClawPluginService = {
      id: "service-c",
      start: (ctx) => {
        starts.push("c");
        contexts.push(ctx);
      },
      stop: () => {
        stops.push("c");
      },
    };

    const config = {} as Parameters<typeof startPluginServices>[0]["config"];
    const handle = await startPluginServices({
      registry: createRegistry([serviceA, serviceB, serviceC]),
      config,
      workspaceDir: "/tmp/workspace",
    });
    await handle.stop();

    expect(starts).toEqual(["a", "b", "c"]);
    expect(stops).toEqual(["c", "a"]);
    expect(contexts).toHaveLength(3);
    for (const ctx of contexts) {
      expect(ctx.config).toBe(config);
      expect(ctx.workspaceDir).toBe("/tmp/workspace");
      expect(ctx.stateDir).toBe(STATE_DIR);
      expect(ctx.logger).toBeDefined();
      expect(typeof ctx.logger.info).toBe("function");
      expect(typeof ctx.logger.warn).toBe("function");
      expect(typeof ctx.logger.error).toBe("function");
    }
  });

  it("logs start/stop failures and continues", async () => {
    const stopOk = vi.fn();
    const stopThrows = vi.fn(() => {
      throw new Error("stop failed");
    });

    const handle = await startPluginServices({
      registry: createRegistry([
        {
          id: "service-start-fail",
          start: () => {
            throw new Error("start failed");
          },
          stop: vi.fn(),
        },
        {
          id: "service-ok",
          start: () => undefined,
          stop: stopOk,
        },
        {
          id: "service-stop-fail",
          start: () => undefined,
          stop: stopThrows,
        },
      ]),
      config: {} as Parameters<typeof startPluginServices>[0]["config"],
    });

    await handle.stop();

    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("plugin service failed (service-start-fail):"),
    );
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("plugin service stop failed (service-stop-fail):"),
    );
    expect(stopOk).toHaveBeenCalledOnce();
    expect(stopThrows).toHaveBeenCalledOnce();
  });
});
