import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const inspectPortUsageMock = vi.hoisted(() => vi.fn());

const defaultRuntime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
};

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../../infra/ports.js", () => ({
  inspectPortUsage: (...args: unknown[]) => inspectPortUsageMock(...args),
  classifyPortListener: (listener: { commandLine?: string; command?: string }) => {
    const raw = `${listener.commandLine ?? ""} ${listener.command ?? ""}`.toLowerCase();
    return raw.includes("openclaw") ? "gateway" : "unknown";
  },
}));

const service = {
  label: "systemd",
  loadedText: "enabled",
  notLoadedText: "disabled",
  install: vi.fn(),
  uninstall: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  isLoaded: vi.fn(),
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
};

let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;
let runServiceStop: typeof import("./lifecycle-core.js").runServiceStop;

describe("daemon lifecycle not-loaded signal fallback", () => {
  beforeAll(async () => {
    ({ runServiceRestart, runServiceStop } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    service.isLoaded.mockResolvedValue(false);
    inspectPortUsageMock.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4242, commandLine: "openclaw gateway run" }],
      hints: [],
    });
  });

  it("runServiceRestart signals gateway pid with SIGUSR1 when service is not loaded", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const restarted = await runServiceRestart({
        serviceNoun: "Gateway",
        service,
        renderStartHints: () => ["openclaw gateway install"],
        notLoadedPortSignalFallback: {
          port: 18789,
          signal: "SIGUSR1",
          result: "restarted",
        },
      });

      expect(restarted).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(4242, "SIGUSR1");
      expect(service.restart).not.toHaveBeenCalled();
      expect(defaultRuntime.log).toHaveBeenCalledWith(expect.stringContaining("SIGUSR1"));
    } finally {
      killSpy.mockRestore();
    }
  });

  it("runServiceStop signals gateway pid with SIGTERM when service is not loaded", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await runServiceStop({
        serviceNoun: "Gateway",
        service,
        notLoadedPortSignalFallback: {
          port: 18789,
          signal: "SIGTERM",
          result: "stopped",
        },
      });

      expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
      expect(service.stop).not.toHaveBeenCalled();
      expect(defaultRuntime.log).toHaveBeenCalledWith(expect.stringContaining("SIGTERM"));
    } finally {
      killSpy.mockRestore();
    }
  });
});
