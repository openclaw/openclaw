import { expect, it, vi } from "vitest";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import { getDaemonStatusSummary, getNodeDaemonStatusSummary } from "./status.daemon.js";
import { getStatusOverviewRowValue } from "./status.test-support.js";

const mocks = vi.hoisted(() => ({ resolveGatewayService: vi.fn(), resolveNodeService: vi.fn() }));
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: mocks.resolveGatewayService,
}));
vi.mock("../daemon/node-service.js", () => ({ resolveNodeService: mocks.resolveNodeService }));

it("includes suspicious systemd cgroup hygiene in the service runtime summary", async () => {
  mocks.resolveGatewayService.mockReturnValue(
    createMockGatewayService({
      isLoaded: async () => true,
      readRuntime: async () => ({
        status: "running",
        pid: 1234,
        systemd: {
          unit: "openclaw-gateway.service",
          killMode: "process",
          tasksCurrent: 807,
          memoryCurrent: 11_918_534_246,
        },
      }),
    }),
  );
  const summary = await getDaemonStatusSummary();
  expect(summary.loaded).toBe(true);
  expect(summary.runtimeShort).toBe(
    "running (pid 1234, cgroup hygiene: KillMode=process, tasks=807, memory=11.1GiB)",
  );
  expect(summary.runtime?.systemd).toEqual({
    unit: "openclaw-gateway.service",
    killMode: "process",
    tasksCurrent: 807,
    memoryCurrent: 11_918_534_246,
  });
});

it("keeps gateway status readable for unsupported service adapters", async () => {
  const detail = "Gateway service install not supported on aix";
  mocks.resolveGatewayService.mockReturnValue(
    createMockGatewayService({
      label: "Gateway service",
      isLoaded: async () => {
        throw new Error(detail);
      },
      readRuntime: async () => ({ status: "unknown", detail }),
    }),
  );
  const summary = await getDaemonStatusSummary();
  expect(summary).toMatchObject({ label: "Gateway service", installed: false, loaded: null });
  expect(summary.runtimeShort).toBe("unknown (Gateway service install not supported on aix)");
});

it("renders root-status recovery guidance for a rejected node runtime", async () => {
  mocks.resolveNodeService.mockReturnValue(
    createMockGatewayService({
      label: "systemd user",
      loadedText: "enabled",
      notLoadedText: "disabled",
      readRuntime: async () => {
        throw new Error("node service manager unavailable");
      },
    }),
  );
  const summary = await getNodeDaemonStatusSummary();
  expect(summary.runtime).toEqual({
    status: "unknown",
    detail: "service runtime inspection failed; retry with openclaw status --deep",
    inspectionFailure: {
      code: "service-runtime-inspection-failed",
      detail: "node service manager unavailable",
    },
  });
  expect(getStatusOverviewRowValue("Node service", { nodeService: summary })).toBe(
    "systemd user disabled (inspection failed: service runtime inspection failed; retry with openclaw status --deep) · unknown",
  );
});
