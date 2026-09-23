// Register native doubles before importing the service owners.
import path from "node:path";
import { vi } from "vitest";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";

const native = vi.hoisted(() => ({
  command: vi.fn<() => Promise<GatewayServiceCommandConfig>>(),
  task: vi.fn(),
  identity: vi.fn<typeof import("./exec-file.js").execFileUtf8>(),
  launchctl: vi.fn<typeof import("./launchd-exec.js").execLaunchctl>(),
  transport: vi.fn<typeof import("./systemd-user-transport.js").resolveSystemdUserTransport>(),
}));
vi.mock("./service.js", () => ({ resolveGatewayService: () => ({ readCommand: native.command }) }));
vi.mock("./systemd-service-files.js", async (original) => ({
  ...(await original<typeof import("./systemd-service-files.js")>()),
  readSystemdServiceExecStart: native.command,
}));
vi.mock("./systemd-system.js", () => ({
  assertNoSystemSystemdOwnership: async () => {},
  isSystemSystemdOwnershipError: () => false,
}));
vi.mock("./systemd-exec.js", async (original) => ({
  ...(await original<typeof import("./systemd-exec.js")>()),
  assertSystemdAvailable: async () => {},
}));
vi.mock("./systemd-user-transport.js", async (original) => ({
  ...(await original<typeof import("./systemd-user-transport.js")>()),
  resolveSystemdUserTransport: native.transport,
}));
vi.mock("./systemd-scope.js", async (original) => ({
  ...(await original<typeof import("./systemd-scope.js")>()),
  findInstalledSystemdGatewayScope: async () => {
    const unitPath = (await native.command()).sourcePath!;
    return { scope: "user", unitPath, unitName: path.basename(unitPath) };
  },
}));
vi.mock("./launchd-system.js", async (original) => ({
  ...(await original<typeof import("./launchd-system.js")>()),
  assertNoSystemLaunchDaemonOwnership: async () => {},
  inspectSystemLaunchDaemonOwnership: async (label: string) => ({
    status: "absent",
    serviceTarget: `system/${label}`,
  }),
}));
vi.mock("./launchd-exec.js", async (original) => ({
  ...(await original<typeof import("./launchd-exec.js")>()),
  execLaunchctl: native.launchctl,
}));
vi.mock("./launchd-current-service.js", async (original) => ({
  ...(await original<typeof import("./launchd-current-service.js")>()),
  isCurrentProcessInsideLaunchdService: async () => false,
}));
vi.mock("./launchd-runtime.js", async (original) => ({
  ...(await original<typeof import("./launchd-runtime.js")>()),
  resolveLaunchAgentGatewayContext: async (env: GatewayServiceEnv) => ({
    env,
    port: null,
    probeHosts: [],
  }),
}));
vi.mock("../infra/restart-stale-pids.js", async (original) => ({
  ...(await original<typeof import("../infra/restart-stale-pids.js")>()),
  cleanStaleGatewayProcessesSync: vi.fn(),
}));
vi.mock("../infra/ports-probe.js", async (original) => ({
  ...(await original<typeof import("../infra/ports-probe.js")>()),
  probePortUsage: async () => "free",
}));
vi.mock("./schtasks-exec.js", () => ({ execSchtasks: native.task }));
vi.mock("./exec-file.js", async (original) => ({
  ...(await original<typeof import("./exec-file.js")>()),
  execFileUtf8: native.identity,
}));
vi.mock("./schtasks-runtime.js", async (original) => ({
  ...(await original<typeof import("./schtasks-runtime.js")>()),
  readScheduledTaskRuntime: async () => ({ status: "running" }),
  resolveFallbackRuntime: async () => ({ status: "stopped" }),
  waitForScheduledTaskRunningEvidence: async () => true,
}));
vi.mock("../infra/ports-inspect.js", async (original) => ({
  ...(await original<typeof import("../infra/ports-inspect.js")>()),
  inspectPortUsage: async (port: number) => ({ port, status: "free", listeners: [], hints: [] }),
}));
vi.mock("../infra/windows-encoding.js", async (original) => ({
  ...(await original<typeof import("../infra/windows-encoding.js")>()),
  resolveWindowsOemCodePage: () => 437,
  resolveWindowsOemEncoding: () => null,
}));

export { native };
