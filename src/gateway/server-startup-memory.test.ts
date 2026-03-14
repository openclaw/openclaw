import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const { getMemorySearchManagerMock } = vi.hoisted(() => ({
  getMemorySearchManagerMock: vi.fn(),
}));

const { resolveActiveMemoryBackendConfigMock } = vi.hoisted(() => ({
  resolveActiveMemoryBackendConfigMock: vi.fn(),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: getMemorySearchManagerMock,
  resolveActiveMemoryBackendConfig: resolveActiveMemoryBackendConfigMock,
}));

import { startGatewayMemoryBackend } from "./server-startup-memory.js";

function createQmdConfig(agents: OpenClawConfig["agents"]): OpenClawConfig {
  return {
    agents,
    memory: { backend: "qmd", qmd: {} },
  } as OpenClawConfig;
}

function createBuiltinConfig(agents: OpenClawConfig["agents"]): OpenClawConfig {
  return {
    agents,
    memory: { backend: "builtin" },
  } as OpenClawConfig;
}

function createGatewayLogMock() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("startGatewayMemoryBackend", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockClear();
    resolveActiveMemoryBackendConfigMock.mockReset();
    resolveActiveMemoryBackendConfigMock.mockImplementation(({ cfg }: { cfg: OpenClawConfig }) => ({
      backend: cfg.memory?.backend === "qmd" ? "qmd" : "builtin",
      qmd: cfg.memory?.backend === "qmd" ? {} : undefined,
    }));
  });

  it("initializes builtin backend for each configured agent", async () => {
    const cfg = createBuiltinConfig({ list: [{ id: "main", default: true }] });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: { search: vi.fn() } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({ cfg, agentId: "main" });
    expect(log.info).toHaveBeenCalledWith(
      'builtin memory startup initialization armed for agent "main"',
    );
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
    expect(log.info).toHaveBeenNthCalledWith(
      1,
      'qmd memory startup initialization armed for agent "ops"',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      2,
      'qmd memory startup initialization armed for agent "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs a warning when manager init fails and continues with other agents", async () => {
    const cfg = createQmdConfig({ list: [{ id: "main", default: true }, { id: "ops" }] });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock
      .mockResolvedValueOnce({ manager: null, error: "qmd missing" })
      .mockResolvedValueOnce({ manager: { search: vi.fn() } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'qmd memory startup initialization failed for agent "main": qmd missing',
    );
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization armed for agent "ops"',
    );
  });

  it("logs a warning when builtin manager init fails", async () => {
    const cfg = createBuiltinConfig({ list: [{ id: "main", default: true }] });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: null, error: "sqlite error" });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'builtin memory startup initialization failed for agent "main": sqlite error',
    );
    expect(log.info).not.toHaveBeenCalled();
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
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization armed for agent "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});
