import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { resolveNodeService } from "./node-service.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";
import { mockSystemAccountHome } from "./service.test-helpers.js";

const discoverFreeBsdService = vi.hoisted(() =>
  vi.fn<typeof import("../../scripts/lib/freebsd-service-discovery.mjs").discoverFreeBsdService>(),
);

vi.mock("../../scripts/lib/freebsd-service-discovery.mjs", () => ({ discoverFreeBsdService }));

beforeEach(() => {
  mockSystemAccountHome();
  discoverFreeBsdService.mockReset().mockResolvedValue({
    schema: 1,
    service: "openclaw",
    status: "unknown",
    reason: "root-required",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FreeBSD service adapters", () => {
  it("keeps FreeBSD service ownership external and explains the package and foreground paths", async () => {
    mockProcessPlatform("freebsd");
    const service = resolveGatewayService();
    const runtime = await service.readRuntime(process.env);
    expect(runtime.status).toBe("unknown");
    expect(runtime.detail).toContain("not supported by this CLI on FreeBSD");
    expect(runtime.detail).toContain("openclaw_user to your onboarding account");
    expect(runtime.detail).toContain('openclaw_enable="YES" in /etc/rc.conf');
    expect(runtime.detail).toContain("`service openclaw start` (or stop/restart/status) as root");
    expect(runtime.detail).toContain("`openclaw gateway run` as your onboarding account");

    const args = {
      env: process.env,
      stdout: process.stdout,
      programArguments: ["openclaw", "gateway", "run"],
    };
    for (const action of ["stage", "install", "uninstall", "start", "stop", "restart"] as const) {
      await expect(service[action](args)).rejects.toThrow(runtime.detail);
    }
    await expect(service.isLoaded(args)).rejects.toThrow(runtime.detail);
    await expect(service.readCommand(process.env)).resolves.toBeNull();
    await expect(readGatewayServiceState(service)).resolves.toMatchObject({
      installed: false,
      loadState: { status: "unknown", detail: `Error: ${runtime.detail}` },
      running: false,
      command: null,
      runtime,
    });
  });

  it("gives FreeBSD node hosts their own foreground recovery command", async () => {
    mockProcessPlatform("freebsd");
    const service = resolveNodeService();
    expect(service.isAbsent).toBeUndefined();
    const runtime = await service.readRuntime(process.env);
    expect(runtime.status).toBe("unknown");
    expect(runtime.detail).toContain("Node service management is not supported");
    expect(runtime.detail).toContain("`openclaw node run`");
    expect(runtime.detail).not.toContain("service openclaw");
    expect(runtime.detail).not.toContain("openclaw gateway run");
    const args = {
      env: process.env,
      stdout: process.stdout,
      programArguments: ["openclaw", "node", "run"],
    };
    for (const action of ["stage", "install", "uninstall", "start", "stop", "restart"] as const) {
      await expect(service[action](args)).rejects.toThrow(runtime.detail);
    }
    await expect(service.isLoaded(args)).rejects.toThrow(runtime.detail);
    await expect(service.readCommand(process.env)).resolves.toBeNull();
    await expect(readGatewayServiceState(service)).resolves.toMatchObject({
      installed: false,
      loadState: { status: "unknown", detail: `Error: ${runtime.detail}` },
      running: false,
      runtime,
    });
    expect(discoverFreeBsdService).not.toHaveBeenCalled();
  });

  it("consumes fresh FreeBSD absence without granting service-management authority", async () => {
    mockProcessPlatform("freebsd");
    const service = resolveGatewayService();
    const observation = {
      schema: 1 as const,
      service: "openclaw" as const,
      context: { cwd: "/", env: { HOME: "/", PATH: "/sbin:/bin:/usr/sbin:/usr/bin", LC_ALL: "C" } },
      directories: ["/etc/rc.d", "/usr/local/etc/rc.d"],
      definitions: [],
      selected: null,
    };
    discoverFreeBsdService.mockResolvedValueOnce({ ...observation, status: "absent" });
    await expect(readGatewayServiceState(service, { timeoutMs: 250 })).resolves.toMatchObject({
      installed: false,
      loadState: { status: "not-loaded" },
      running: false,
      command: null,
      runtime: { status: "stopped", missingUnit: true },
    });
    expect(discoverFreeBsdService).toHaveBeenLastCalledWith({
      timeoutMs: 250,
      registerExitCleanup: expect.any(Function),
    });
    discoverFreeBsdService.mockResolvedValueOnce({
      ...observation,
      status: "present",
      definitions: [{ path: "/usr/local/etc/rc.d/openclaw", executable: false }],
    });
    await expect(readGatewayServiceState(service)).resolves.toMatchObject({
      loadState: { status: "unknown" },
    });
    expect(discoverFreeBsdService).toHaveBeenCalledTimes(2);
    await expect(service.start({ stdout: process.stdout })).rejects.toThrow(
      service.managementUnsupportedReason,
    );
  });
});
