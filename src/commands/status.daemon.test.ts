import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import { resolveStatusServiceSummaries } from "./status-runtime-shared.ts";
import { getStatusOverviewRowValue } from "./status.test-support.js";

const mocks = vi.hoisted(() => ({ resolveGatewayService: vi.fn(), resolveNodeService: vi.fn() }));
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: mocks.resolveGatewayService,
}));
vi.mock("../daemon/node-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/node-service.js")>()),
  resolveNodeService: mocks.resolveNodeService,
}));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => null,
}));

beforeEach(() => {
  mocks.resolveGatewayService.mockReturnValue(createMockGatewayService());
  mocks.resolveNodeService.mockReturnValue(createMockGatewayService());
});
afterEach(() => vi.restoreAllMocks());

function mockGateway(overrides: Parameters<typeof createMockGatewayService>[0]) {
  mocks.resolveGatewayService.mockReturnValue(createMockGatewayService(overrides));
}

it("includes suspicious systemd cgroup hygiene in the service runtime summary", async () => {
  const systemd = {
    unit: "openclaw-gateway.service",
    killMode: "process",
    tasksCurrent: 807,
    memoryCurrent: 11_918_534_246,
  };
  mockGateway({
    isLoaded: async () => true,
    readRuntime: async () => ({ status: "running", pid: 1234, systemd }),
  });
  const [summary] = await resolveStatusServiceSummaries();
  expect(summary.loaded).toBe(true);
  expect(summary.runtimeShort).toBe(
    "running (pid 1234, cgroup hygiene: KillMode=process, tasks=807, memory=11.1GiB)",
  );
  expect(summary.runtime?.systemd).toEqual(systemd);
});

it("keeps gateway status readable for unsupported service adapters", async () => {
  const detail = "Gateway service install not supported on aix";
  mockGateway({
    label: "Gateway service",
    isLoaded: async () => {
      throw new Error(detail);
    },
    readRuntime: async () => ({ status: "unknown", detail }),
  });
  const [summary] = await resolveStatusServiceSummaries();
  expect(summary).toMatchObject({ label: "Gateway service", installed: false, loaded: null });
  expect(summary.runtimeShort).toBe("unknown (Gateway service install not supported on aix)");
});

it.each(["stopped", "running"] as const)(
  "shows a masked Gateway's recovery hint while %s",
  async (status) => {
    const message =
      "Service is masked. Run systemctl --user unmask openclaw-gateway.service, then retry.";
    mockGateway({
      readRuntime: async () => ({
        status,
        detail: message,
        systemd: { scope: "user", startRefusal: { reason: "masked", message } },
      }),
    });

    const [summary] = await resolveStatusServiceSummaries();
    const output = getStatusOverviewRowValue("Gateway service", { gatewayService: summary });

    expect(output).toContain(message);
    expect(output).not.toContain("not installed");
    expect(output?.split(message)).toHaveLength(2);
  },
);

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
  const [, summary] = await resolveStatusServiceSummaries();
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
