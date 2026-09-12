import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createFleetService } from "../../fleet/service.runtime.js";

type FleetStatus = Awaited<ReturnType<ReturnType<typeof createFleetService>["status"]>>;

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("../test-runtime-mock.js");
  return { ...createCliRuntimeMock(vi), status: vi.fn() };
});
vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));
vi.mock("../../fleet/service.runtime.js", () => ({
  createFleetService: () => ({ status: mocks.status }),
}));

import { runFleetStatusCommand } from "./commands.runtime.js";

function statusResult(runtime: "docker" | "podman"): FleetStatus {
  return {
    tenant: "acme",
    containerName: "openclaw-cell-acme",
    runtime,
    port: 19_100,
    image: "image",
    created: "2026-01-01T00:00:00.000Z",
    dataDir: "/tmp/acme",
    container: { state: "running", running: true, managed: true },
    health: { status: "ok", url: "http://127.0.0.1:19100/healthz", httpStatus: 200 },
  };
}

describe("fleet status runtime projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeLogs.length = 0;
    mocks.runtimeErrors.length = 0;
  });

  it.each(["docker", "podman"] as const)("shows the recorded %s runtime", async (runtime) => {
    mocks.status.mockResolvedValue(statusResult(runtime));
    await runFleetStatusCommand({ tenant: "acme", json: false });
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith("acme");
    expect(mocks.runtimeLogs).toEqual([
      "Tenant: acme",
      "Container: openclaw-cell-acme",
      `Runtime: ${runtime}`,
      "State: running",
      "Port: 19100",
      "Image: image",
      "Created: 2026-01-01T00:00:00.000Z",
      "Data: /tmp/acme",
      "Health: ok (HTTP 200)",
    ]);
    expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it.each(["docker", "podman"] as const)("leaves %s JSON unchanged", async (runtime) => {
    const result = statusResult(runtime);
    const before = structuredClone(result);
    mocks.status.mockResolvedValue(result);
    await runFleetStatusCommand({ tenant: "acme", json: true });
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(before);
    expect(mocks.defaultRuntime.writeJson.mock.calls[0]?.[0]).toBe(result);
    expect(mocks.runtimeLogs).toEqual([JSON.stringify(before, null, 2)]);
    expect(result).toEqual(before);
  });

  it.each(["missing", "unknown"] as const)(
    "does not confuse runtime identity with container state %s",
    async (state) => {
      const result = statusResult("podman");
      result.container =
        state === "unknown"
          ? { state, running: false, managed: false, error: "Runtime unavailable" }
          : { state, running: false, managed: false };
      result.health = { status: "skipped", url: result.health.url, reason: "No endpoint" };
      mocks.status.mockResolvedValue(result);
      await runFleetStatusCommand({ tenant: "acme", json: false });
      expect(mocks.runtimeLogs).toContain("Runtime: podman");
      expect(mocks.runtimeLogs).toContain(`State: ${state}`);
      expect(mocks.runtimeLogs).toContain("Health: skipped (No endpoint)");
    },
  );

  it("preserves service errors without emitting a partial status", async () => {
    mocks.status.mockRejectedValueOnce(new Error("Unknown fleet tenant"));
    await expect(runFleetStatusCommand({ tenant: "acme", json: false })).rejects.toThrow(
      "Unknown fleet tenant",
    );
    expect(mocks.runtimeLogs).toEqual([]);
    expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
  });
});
