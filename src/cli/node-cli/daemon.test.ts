import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeLog = vi.fn();
const nodeService = {
  label: "Node",
  loadedText: "installed",
  notLoadedText: "not installed",
  isLoaded: vi.fn(async () => true),
  readCommand: vi.fn(async () => ({
    programArguments: ["bun", "node-host"],
    sourcePath: `${os.homedir()}/Library/LaunchAgents/ai.openclaw.node.plist`,
    workingDirectory: `${os.homedir()}/.openclaw/node`,
    environment: {},
  })),
  readRuntime: vi.fn(async () => ({ status: "running", pid: 42 })),
};

vi.mock("../../daemon/node-service.js", () => ({
  resolveNodeService: () => nodeService,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: runtimeLog,
  },
}));

const { runNodeDaemonStatus } = await import("./daemon.js");

describe("runNodeDaemonStatus", () => {
  beforeEach(() => {
    runtimeLog.mockReset();
    nodeService.isLoaded.mockClear();
    nodeService.readCommand.mockClear();
    nodeService.readRuntime.mockClear();
  });

  it("shortens service file and working directory paths in human output", async () => {
    const home = os.homedir();

    await runNodeDaemonStatus();

    const lines = runtimeLog.mock.calls.map((call) => String(call[0]));
    expect(lines.join("\n")).toContain("Service file:");
    expect(lines.join("\n")).toContain("~/Library/LaunchAgents/ai.openclaw.node.plist");
    expect(lines.join("\n")).not.toContain(`${home}/Library/LaunchAgents/ai.openclaw.node.plist`);
    expect(lines.join("\n")).toContain("Working dir:");
    expect(lines.join("\n")).toContain("~/.openclaw/node");
    expect(lines.join("\n")).not.toContain(`${home}/.openclaw/node`);
  });
});
