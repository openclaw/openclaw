import path from "node:path";
import { vi } from "vitest";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";

const native = vi.hoisted(() => ({
  taskState: 3,
  command: vi.fn<() => Promise<GatewayServiceCommandConfig>>(),
  task: vi.fn(),
  identity: vi.fn<typeof import("./exec-file.js").execFileUtf8>(),
  launchctl: vi.fn<typeof import("./launchd-exec.js").execLaunchctl>(),
  transport: vi.fn<typeof import("./systemd-user-transport.js").resolveSystemdUserTransport>(),
}));
const partial = vi.hoisted(() => <T>(patch: Partial<T>) => async (load: () => Promise<T>) => ({
  ...(await load()),
  ...patch,
}));
vi.mock("./service.js", () => ({ resolveGatewayService: () => ({ readCommand: native.command }) }));
// mock-isolation: Preserve exports through partial; replace native command inspection.
vi.mock("./systemd-service-files.js", partial({ readSystemdServiceExecStart: native.command }));
vi.mock("./systemd-system.js", () => ({
  assertNoSystemSystemdOwnership: async () => {},
  isSystemSystemdOwnershipError: () => false,
}));
// mock-isolation: Preserve exports through partial; bypass host systemd availability.
vi.mock("./systemd-exec.js", partial({ assertSystemdAvailable: async () => {} }));
// mock-isolation: Preserve exports through partial; replace host transport discovery.
vi.mock("./systemd-user-transport.js", partial({ resolveSystemdUserTransport: native.transport }));
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
// mock-isolation: Preserve exports through partial; replace native launchctl execution.
vi.mock("./launchd-exec.js", partial({ execLaunchctl: native.launchctl }));
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
// mock-isolation: Backup compensation mutates only the fixture's task registration and policy.
vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: native.task,
  execScheduledTaskEnabledChange: (taskName: string, enabled: boolean) =>
    native.task(["/Change", "/TN", taskName, enabled ? "/ENABLE" : "/DISABLE"]),
}));
vi.mock("./schtasks-state-probe.js", async (original) => ({
  ...(await original<typeof import("./schtasks-state-probe.js")>()),
  probeScheduledTaskExists: () => true,
  probeScheduledTaskState: () => ({ status: "found", state: native.taskState }),
}));
vi.mock("./schtasks-process-snapshot.js", async (original) => ({
  ...(await original<typeof import("./schtasks-process-snapshot.js")>()),
  readWindowsProcessSnapshot: () => [
    { ProcessId: 9999, CommandLine: "powershell.exe", Name: "powershell.exe" },
  ],
}));
// mock-isolation: Preserve exports through partial; replace native identity commands.
vi.mock("./exec-file.js", partial({ execFileUtf8: native.identity }));
vi.mock("../infra/windows-port-pids.js", async (original) => ({
  ...(await original<typeof import("../infra/windows-port-pids.js")>()),
  readWindowsPortUsageSync: () => "free",
}));
vi.mock("./schtasks-runtime.js", async (original) => ({
  ...(await original<typeof import("./schtasks-runtime.js")>()),
  readScheduledTaskRuntime: async () => ({
    status: native.taskState === 4 ? "running" : "stopped",
  }),
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
