import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/schtasks-base-mocks.js";
import type { WindowsProcessSnapshotEntry } from "./schtasks-process-snapshot.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

const installedCommand: GatewayServiceCommandConfig = {
  programArguments: [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\openclaw\\dist\\index.js",
    "gateway",
    "--port",
    "18789",
  ],
  environment: { OPENCLAW_GATEWAY_PORT: "18789" },
};

const processSnapshot: WindowsProcessSnapshotEntry[] = [
  {
    ProcessId: 6001,
    CommandLine:
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\openclaw\\dist\\index.js" gateway --port 18789 --task-supervisor-child=65536',
  },
  {
    ProcessId: 6000,
    CommandLine:
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\openclaw\\dist\\index.js" gateway --port 18789 --task-supervisor',
  },
  { ProcessId: 9999, CommandLine: "powershell.exe" },
];

const terminateGatewayProcessTree = vi.hoisted(() =>
  vi.fn(async (_pid: number, _assertCurrent?: () => void) => {}),
);

vi.mock("./schtasks-layout.js", async (original) => ({
  ...(await original<typeof import("./schtasks-layout.js")>()),
  readScheduledTaskCommand: async () => installedCommand,
}));

vi.mock("./schtasks-process-snapshot.js", async (original) => ({
  ...(await original<typeof import("./schtasks-process-snapshot.js")>()),
  readWindowsProcessSnapshot: () => processSnapshot,
}));

vi.mock("./schtasks-process.js", async (original) => ({
  ...(await original<typeof import("./schtasks-process.js")>()),
  terminateGatewayProcessTree,
}));

const { stopStartupEntry } = await import("./schtasks-runtime.js");

describe("Windows login-item stop", () => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    terminateGatewayProcessTree.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("terminates the Startup supervisor before its Gateway child", async () => {
    await stopStartupEntry({ OPENCLAW_GATEWAY_PORT: "18789" } as never, new PassThrough() as never);

    const killed = terminateGatewayProcessTree.mock.calls.map(([pid]) => pid);
    expect(killed).toEqual([6000, 6001]);
  });
});
