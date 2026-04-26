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

  it("skips builtin startup work when the provider is not explicitly local", async () => {
    const cfg = createBuiltinConfig({ list: [{ id: "main", default: true }] });
    const log = { info: vi.fn(), warn: vi.fn() };

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("prewarms builtin local embeddings for explicitly local memory search", async () => {
    const cfg = createBuiltinConfig({
      defaults: { memorySearch: { enabled: true, provider: "local" } },
      list: [{ id: "main", default: true }],
    });
    const log = createGatewayLogMock();
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    getMemorySearchManagerMock.mockResolvedValue({
      manager: {
        search: vi.fn(),
        readFile: vi.fn(),
        status: vi.fn(),
        probeEmbeddingAvailability,
        probeVectorAvailability: vi.fn(async () => true),
        close: vi.fn(),
      },
    });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({ cfg, agentId: "main" });
    expect(probeEmbeddingAvailability).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      'builtin local memory startup prewarm completed for agent "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs a warning when builtin local embedding prewarm reports unavailable", async () => {
    const cfg = createBuiltinConfig({
      defaults: { memorySearch: { enabled: true, provider: "local" } },
      list: [{ id: "main", default: true }],
    });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock.mockResolvedValue({
      manager: {
        search: vi.fn(),
        readFile: vi.fn(),
        status: vi.fn(),
        probeEmbeddingAvailability: vi.fn(async () => ({ ok: false, error: "model missing" })),
        probeVectorAvailability: vi.fn(async () => false),
        close: vi.fn(),
      },
    });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'builtin local memory startup prewarm failed for agent "main": model missing',
    );
    expect(log.info).not.toHaveBeenCalled();
  });

  it("initializes qmd backend for each configured agent", async () => {
    const cfg = createQmdConfig({ list: [{ id: "ops", default: true }, { id: "main" }] });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: { search: vi.fn() } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(2);
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(1, { cfg, agentId: "ops" });
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(2, { cfg, agentId: "main" });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization armed for 2 agents: "ops", "main"',
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
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization armed for 1 agent: "ops"',
    );
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
      'qmd memory startup initialization armed for 1 agent: "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});
