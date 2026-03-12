import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const { getMemorySearchManagerMock } = vi.hoisted(() => ({
  getMemorySearchManagerMock: vi.fn(),
}));
const { chokidarWatchMock, chokidarWatcherMock } = vi.hoisted(() => {
  const watcher = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn(async () => undefined),
  };
  return {
    chokidarWatchMock: vi.fn(() => watcher),
    chokidarWatcherMock: watcher,
  };
});

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager: getMemorySearchManagerMock,
}));

vi.mock("chokidar", () => ({
  default: {
    watch: chokidarWatchMock,
  },
}));

import { startGatewayMemoryBackend } from "./server-startup-memory.js";

function createQmdConfig(agents: OpenClawConfig["agents"]): OpenClawConfig {
  return {
    agents,
    memory: { backend: "qmd", qmd: {} },
  } as OpenClawConfig;
}

function createGatewayLogMock() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("startGatewayMemoryBackend", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockClear();
    chokidarWatchMock.mockClear();
    chokidarWatcherMock.on.mockClear();
  });

  it("skips initialization when memory backend is not qmd", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: { backend: "builtin" },
    } as OpenClawConfig;
    const log = { info: vi.fn(), warn: vi.fn() };

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(chokidarWatchMock).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("initializes qmd backend for each configured agent", async () => {
    const cfg = createQmdConfig({ list: [{ id: "ops", default: true }, { id: "main" }] });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: { search: vi.fn() } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(2);
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(1, { cfg, agentId: "ops" });
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(2, { cfg, agentId: "main" });
    expect(chokidarWatchMock).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenNthCalledWith(
      1,
      'memory startup initialization armed for agent "ops"',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      2,
      'memory startup initialization armed for agent "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs a warning when qmd manager init fails and continues with other agents", async () => {
    const cfg = createQmdConfig({ list: [{ id: "main", default: true }, { id: "ops" }] });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock
      .mockResolvedValueOnce({ manager: null, error: "qmd missing" })
      .mockResolvedValueOnce({ manager: { search: vi.fn() } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'qmd memory startup initialization failed for agent "main": qmd missing',
    );
    expect(log.info).toHaveBeenCalledWith('memory startup initialization armed for agent "ops"');
  });

  it("skips agents with memory search disabled", async () => {
    const cfg = createQmdConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [
        { id: "main", default: true },
        { id: "ops", memorySearch: { enabled: false } },
      ],
    });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: { search: vi.fn() } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({ cfg, agentId: "main" });
    expect(chokidarWatchMock).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('memory startup initialization armed for agent "main"');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("arms postgres memory watchers even when memory search is disabled", async () => {
    const cfg = {
      agents: {
        defaults: { memorySearch: { enabled: false } },
        list: [{ id: "main", default: true, workspace: "/tmp/workspace-main" }],
      },
      memory: { backend: "builtin" },
      persistence: {
        backend: "postgres" as const,
        postgres: {
          url: "postgresql://openclaw:test@localhost/openclaw",
        },
      },
    } as OpenClawConfig;
    const log = createGatewayLogMock();

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(chokidarWatchMock).toHaveBeenCalledWith(
      [
        "/tmp/workspace-main/MEMORY.md",
        "/tmp/workspace-main/memory.md",
        "/tmp/workspace-main/memory/**/*.md",
      ],
      expect.any(Object),
    );
    expect(log.info).toHaveBeenCalledWith('memory startup initialization armed for agent "main"');
  });
});
