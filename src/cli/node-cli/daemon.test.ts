import { beforeEach, describe, expect, it, vi } from "vitest";
import { runNodeDaemonInstall, runNodeDaemonStatus } from "./daemon.js";

const serviceMock = vi.hoisted(() => ({
  install: vi.fn(),
  isLoaded: vi.fn(),
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  stage: vi.fn(),
  stop: vi.fn(),
  uninstall: vi.fn(),
}));

const runtimeMock = vi.hoisted(() => ({
  error: vi.fn(),
  log: vi.fn(),
  writeJson: vi.fn(),
}));

const loadNodeHostConfigMock = vi.hoisted(() => vi.fn());
const buildNodeInstallPlanMock = vi.hoisted(() => vi.fn());

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMock,
}));

vi.mock("../../node-host/config.js", () => ({
  loadNodeHostConfig: loadNodeHostConfigMock,
}));

vi.mock("../../commands/node-daemon-install-helpers.js", () => ({
  buildNodeInstallPlan: buildNodeInstallPlanMock,
}));

vi.mock("../../daemon/node-service.js", () => ({
  resolveNodeService: () => ({
    label: "com.openclaw.node",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    ...serviceMock,
  }),
}));

describe("node daemon CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadNodeHostConfigMock.mockResolvedValue(null);
    buildNodeInstallPlanMock.mockResolvedValue({
      description: "OpenClaw Node",
      environment: {},
      programArguments: ["openclaw", "node", "run"],
      workingDirectory: "/tmp/openclaw-node",
    });
    serviceMock.isLoaded.mockResolvedValue(false);
    serviceMock.readCommand.mockResolvedValue(null);
    serviceMock.readRuntime.mockResolvedValue({ status: "running", pid: 123 });
  });

  it("short-circuits install when the node service is already loaded", async () => {
    serviceMock.isLoaded.mockResolvedValue(true);

    await runNodeDaemonInstall({ json: true });

    expect(buildNodeInstallPlanMock).not.toHaveBeenCalled();
    expect(serviceMock.install).not.toHaveBeenCalled();
    expect(runtimeMock.writeJson).toHaveBeenCalledWith({
      action: "install",
      ok: true,
      result: "already-installed",
      message: "Node service already loaded.",
      service: {
        label: "com.openclaw.node",
        loaded: true,
        loadedText: "loaded",
        notLoadedText: "not loaded",
      },
      hintItems: undefined,
      warnings: undefined,
    });
  });

  it("renders status JSON from the resolved node service", async () => {
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readCommand.mockResolvedValue({
      environment: { OPENCLAW_LOG_PREFIX: "node" },
      programArguments: ["openclaw", "node", "run"],
      sourcePath: "/tmp/openclaw-node.plist",
      workingDirectory: "/tmp/openclaw-node",
    });
    serviceMock.readRuntime.mockResolvedValue({ status: "running", pid: 123 });

    await runNodeDaemonStatus({ json: true });

    expect(runtimeMock.writeJson).toHaveBeenCalledWith({
      service: {
        label: "com.openclaw.node",
        loaded: true,
        loadedText: "loaded",
        notLoadedText: "not loaded",
        command: {
          environment: { OPENCLAW_LOG_PREFIX: "node" },
          programArguments: ["openclaw", "node", "run"],
          sourcePath: "/tmp/openclaw-node.plist",
          workingDirectory: "/tmp/openclaw-node",
        },
        runtime: { status: "running", pid: 123 },
      },
    });
  });
});
