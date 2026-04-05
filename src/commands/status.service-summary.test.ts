import { describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../daemon/service.js";
import type { GatewayServiceEnvArgs } from "../daemon/service.js";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import { readServiceStatusSummary } from "./status.service-summary.js";

function createService(overrides: Partial<GatewayService>): GatewayService {
  return createMockGatewayService({
    label: "systemd",
    loadedText: "enabled",
    notLoadedText: "disabled",
    ...overrides,
  });
}

describe("readServiceStatusSummary", () => {
  it("marks Mullusi-managed services as installed", async () => {
    const summary = await readServiceStatusSummary(
      createService({
        isLoaded: vi.fn(async () => true),
        readCommand: vi.fn(async () => ({ programArguments: ["mullusi", "gateway", "run"] })),
        readRuntime: vi.fn(async () => ({ status: "running" })),
      }),
      "Daemon",
    );

    expect(summary.installed).toBe(true);
    expect(summary.managedByMullusi).toBe(true);
    expect(summary.externallyManaged).toBe(false);
    expect(summary.loadedText).toBe("enabled");
  });

  it("marks running unmanaged services as externally managed", async () => {
    const summary = await readServiceStatusSummary(
      createService({
        readRuntime: vi.fn(async () => ({ status: "running" })),
      }),
      "Daemon",
    );

    expect(summary.installed).toBe(true);
    expect(summary.managedByMullusi).toBe(false);
    expect(summary.externallyManaged).toBe(true);
    expect(summary.loadedText).toBe("running (externally managed)");
  });

  it("keeps missing services as not installed when nothing is running", async () => {
    const summary = await readServiceStatusSummary(createService({}), "Daemon");

    expect(summary.installed).toBe(false);
    expect(summary.managedByMullusi).toBe(false);
    expect(summary.externallyManaged).toBe(false);
    expect(summary.loadedText).toBe("disabled");
  });

  it("passes command environment to runtime and loaded checks", async () => {
    const isLoaded = vi.fn(async ({ env }: GatewayServiceEnvArgs) => {
      return env?.MULLUSI_GATEWAY_PORT === "18790";
    });
    const readRuntime = vi.fn(async (env?: NodeJS.ProcessEnv) => ({
      status: env?.MULLUSI_GATEWAY_PORT === "18790" ? ("running" as const) : ("unknown" as const),
    }));

    const summary = await readServiceStatusSummary(
      createService({
        isLoaded,
        readCommand: vi.fn(async () => ({
          programArguments: ["mullusi", "gateway", "run", "--port", "18790"],
          environment: { MULLUSI_GATEWAY_PORT: "18790" },
        })),
        readRuntime,
      }),
      "Daemon",
    );

    expect(isLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          MULLUSI_GATEWAY_PORT: "18790",
        }),
      }),
    );
    expect(readRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        MULLUSI_GATEWAY_PORT: "18790",
      }),
    );
    expect(summary.installed).toBe(true);
    expect(summary.loaded).toBe(true);
    expect(summary.runtime).toMatchObject({ status: "running" });
  });
});
