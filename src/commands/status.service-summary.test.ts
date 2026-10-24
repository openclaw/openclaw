import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as gatewayServiceLayout from "../daemon/service-layout.js";
import type { GatewayServiceEnvArgs } from "../daemon/service-types.js";
import type { GatewayService } from "../daemon/service.js";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveStatusServiceSummaries } from "./status-runtime-shared.ts";
import { readGatewayServiceStatusForTest } from "./status.service-summary.test-support.ts";
import { getStatusOverviewRowValue } from "./status.test-support.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createService(overrides: Partial<GatewayService>): GatewayService {
  return createMockGatewayService({
    label: "systemd",
    loadedText: "enabled",
    notLoadedText: "disabled",
    ...overrides,
  });
}

afterEach(() => vi.restoreAllMocks());

function readService(overrides: Partial<GatewayService>, activePackageRoot: string | null = null) {
  return readGatewayServiceStatusForTest(createService(overrides), activePackageRoot);
}

it("reports installation facts with usable guidance", async () => {
  const serviceVersion = "2026.9.4";
  const root = await fs.realpath(tempDirs.make("openclaw-status-prefix-drift-"));
  const serviceRoot = path.join(root, "prefix-a", "lib", "node_modules", "openclaw");
  const activeRoot = path.join(root, "prefix-b", "lib", "node_modules", "openclaw");
  for (const [fixturePackageRoot, version] of [
    [serviceRoot, serviceVersion],
    [activeRoot, "2026.9.17"],
  ] as const) {
    await fs.mkdir(path.join(fixturePackageRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(fixturePackageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
    );
    await fs.writeFile(path.join(fixturePackageRoot, "dist", "index.js"), "export {};\n");
  }
  const service = createService({
    isLoaded: vi.fn(async () => true),
    readCommand: vi.fn(async () => ({
      programArguments: [process.execPath, path.join(serviceRoot, "dist", "index.js"), "gateway"],
    })),
    readRuntime: vi.fn(async () => ({ status: "running" })),
  });
  const accountHome = root;
  vi.spyOn(os, "homedir").mockReturnValue(accountHome);
  vi.spyOn(os, "userInfo").mockImplementation(() => ({
    uid: 1000,
    gid: 1000,
    username: "status-fixture",
    homedir: accountHome,
    shell: "/bin/sh",
  }));
  const summary = await withEnvAsync(
    {
      HOME: accountHome,
      USERPROFILE: accountHome,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_CONTAINER_HINT: undefined,
      OPENCLAW_NIX_MODE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_LAUNCHD_LABEL: undefined,
      OPENCLAW_SYSTEMD_UNIT: undefined,
      OPENCLAW_WINDOWS_TASK_NAME: undefined,
    },
    () => readService(service, activeRoot),
  );
  const output = getStatusOverviewRowValue("Gateway service", {
    gatewayService: summary,
    gatewayReachable: false,
    gatewayProbe: { error: "protocol mismatch" },
    gatewaySelf: null,
  });
  expect(output).toContain(`${serviceRoot} (${serviceVersion})`);
  expect(output).toContain(`${activeRoot} (2026.9.17)`);
  expect(output).toContain("openclaw doctor --fix");
  expect(output).toContain("openclaw gateway install --force");

  const alias = path.join(root, "active-package");
  await fs.symlink(serviceRoot, alias, "dir");
  const aligned = await readService(service, alias);
  expect(aligned.installationDrift).toBeUndefined();
});
it.each([
  ["running", false, true, "running (externally managed)"],
  ["unknown", true, false, "disabled"],
] as const)(
  "reports unmanaged service state: %s",
  async (status, missingUnit, installed, loadedText) => {
    const summary = await readService({
      readRuntime: vi.fn(async () => ({ status, missingUnit })),
    });
    expect(summary).toMatchObject({
      installed,
      managedByOpenClaw: false,
      externallyManaged: installed,
      loadedText,
    });
    if (missingUnit) {
      expect(getStatusOverviewRowValue("Gateway service", { gatewayService: summary })).toBe(
        "systemd not installed",
      );
    }
  },
);

it("reports load inspection failures without a readable definition", async () => {
  const failInspection = vi.fn(async () => {
    throw new Error("service manager permission denied");
  });
  const summary = await readService({ isLoaded: failInspection });

  expect(summary.installed).toBe(false);
  expect(summary.loadState).toEqual({
    status: "unknown",
    detail: "Error: service manager permission denied",
  });
  expect(getStatusOverviewRowValue("Gateway service", { gatewayService: summary })).toBe(
    "systemd unknown (inspection failed: Error: service manager permission denied) · stopped",
  );
});

it("preserves running service state when optional layout diagnostics fail", async () => {
  using layoutSpy = vi
    .spyOn(gatewayServiceLayout, "summarizeGatewayServiceLayout")
    .mockRejectedValue(new Error("package metadata is unreadable"));

  const summary = await readService({
    isLoaded: vi.fn(async () => true),
    readCommand: vi.fn(async () => ({ programArguments: ["openclaw", "gateway", "run"] })),
    readRuntime: vi.fn(async () => ({ status: "running", pid: 1234 })),
  });

  expect(layoutSpy).toHaveBeenCalledWith({ programArguments: ["openclaw", "gateway", "run"] });
  expect(summary).toMatchObject({
    label: "systemd",
    installed: true,
    loadState: { status: "loaded" },
    managedByOpenClaw: true,
    externallyManaged: false,
    loadedText: "enabled",
    runtime: { status: "running", pid: 1234 },
  });
  expect(summary.layout).toBeUndefined();
});

it("passes command environment to runtime and loaded checks", async () => {
  const isLoaded = vi.fn(async ({ env }: GatewayServiceEnvArgs) => {
    return env?.OPENCLAW_GATEWAY_PORT === "18789";
  });
  const readRuntime = vi.fn(async (env?: NodeJS.ProcessEnv) => ({
    status: env?.OPENCLAW_GATEWAY_PORT === "18789" ? ("running" as const) : ("unknown" as const),
  }));

  const summary = await readService({
    isLoaded,
    readCommand: vi.fn(async () => ({
      programArguments: ["openclaw", "gateway", "run", "--port", "18789"],
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
    })),
    readRuntime,
  });

  expect(isLoaded.mock.calls[0]?.[0]?.env?.OPENCLAW_GATEWAY_PORT).toBe("18789");
  expect(readRuntime.mock.calls[0]?.[0]?.OPENCLAW_GATEWAY_PORT).toBe("18789");
  expect(summary.installed).toBe(true);
  expect(summary.loadState).toEqual({ status: "loaded" });
  expect(summary.runtime?.status).toBe("running");
});

it("includes suspicious systemd cgroup hygiene in the service runtime summary", async () => {
  const systemd = {
    unit: "openclaw-gateway.service",
    killMode: "process",
    tasksCurrent: 807,
    memoryCurrent: 11_918_534_246,
  };
  const summary = await readService({
    isLoaded: async () => true,
    readRuntime: async () => ({ status: "running", pid: 1234, systemd }),
  });
  expect(summary).toMatchObject({
    loaded: true,
    runtimeShort: "running (pid 1234, cgroup hygiene: KillMode=process, tasks=807, memory=11.1GiB)",
  });
  expect(summary.runtime?.systemd).toEqual(systemd);
});

it("keeps gateway status readable for unsupported service adapters", async () => {
  const detail = "Gateway service install not supported on aix";
  const summary = await readService({
    label: "Gateway service",
    isLoaded: async () => {
      throw new Error(detail);
    },
    readRuntime: async () => ({ status: "unknown", detail }),
  });
  expect(summary).toMatchObject({
    label: "Gateway service",
    installed: false,
    loaded: null,
    runtimeShort: "unknown (Gateway service install not supported on aix)",
  });
});

it.each(["stopped", "running"] as const)(
  "shows a masked Gateway's recovery hint while %s",
  async (status) => {
    const message =
      "Service is masked. Run systemctl --user unmask openclaw-gateway.service, then retry.";
    const summary = await readService({
      readRuntime: async () => ({
        status,
        detail: message,
        systemd: { scope: "user", startRefusal: { reason: "masked", message } },
      }),
    });
    const output = getStatusOverviewRowValue("Gateway service", { gatewayService: summary });
    expect(output).toContain(message);
    expect(output).not.toContain("not installed");
    expect(output?.split(message)).toHaveLength(2);
  },
);

it("renders root-status recovery guidance for a rejected node runtime", async () => {
  vi.spyOn(await import("../daemon/service.js"), "resolveGatewayService").mockReturnValue(
    createService({}),
  );
  vi.spyOn(
    await import("../infra/openclaw-root.js"),
    "resolveOpenClawPackageRoot",
  ).mockResolvedValue(null);
  vi.spyOn(await import("../daemon/node-service.js"), "resolveNodeService").mockReturnValue(
    createService({
      label: "systemd user",
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
