import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const { getMemorySearchManagerMock } = vi.hoisted(() => ({
  getMemorySearchManagerMock: vi.fn(),
}));

const { resolveActiveMemoryBackendConfigMock } = vi.hoisted(() => ({
  resolveActiveMemoryBackendConfigMock: vi.fn(),
}));

const { listExistingAgentIdsFromDiskMock } = vi.hoisted(() => ({
  listExistingAgentIdsFromDiskMock: vi.fn(() => [] as string[]),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: getMemorySearchManagerMock,
  resolveActiveMemoryBackendConfig: resolveActiveMemoryBackendConfigMock,
}));

vi.mock("./agent-list.js", () => ({
  listExistingAgentIdsFromDisk: listExistingAgentIdsFromDiskMock,
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

function createBuiltinManagerMock() {
  return {
    search: vi.fn(),
    probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
    sync: vi.fn().mockResolvedValue(undefined),
  };
}

describe("startGatewayMemoryBackend", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockClear();
    listExistingAgentIdsFromDiskMock.mockReset();
    listExistingAgentIdsFromDiskMock.mockReturnValue([]);
    resolveActiveMemoryBackendConfigMock.mockReset();
    resolveActiveMemoryBackendConfigMock.mockImplementation(({ cfg }: { cfg: OpenClawConfig }) => ({
      backend: cfg.memory?.backend === "qmd" ? "qmd" : "builtin",
      qmd: cfg.memory?.backend === "qmd" ? {} : undefined,
    }));
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
      'qmd memory startup initialization armed for agent "ops"',
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
      'qmd memory startup initialization armed for agent "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("prewarms builtin backend with embedding probe and index sync", async () => {
    const cfg = createBuiltinConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [{ id: "main", default: true }],
    });
    const log = createGatewayLogMock();
    const manager = createBuiltinManagerMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({ cfg, agentId: "main" });
    expect(manager.probeEmbeddingAvailability).toHaveBeenCalledTimes(1);
    expect(manager.sync).toHaveBeenCalledWith({ reason: "gateway-startup-prewarm" });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(/^memory startup prewarm done for agent "main" in \d+ms$/),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("notes FTS-only mode when embeddings are unavailable", async () => {
    const cfg = createBuiltinConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [{ id: "main", default: true }],
    });
    const log = createGatewayLogMock();
    const manager = createBuiltinManagerMock();
    manager.probeEmbeddingAvailability.mockResolvedValue({ ok: false, error: "no provider" });
    getMemorySearchManagerMock.mockResolvedValue({ manager });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("(FTS-only: no provider)"));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("prewarms dynamically created on-disk agents missing from config", async () => {
    const cfg = createBuiltinConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [{ id: "main", default: true }],
    });
    listExistingAgentIdsFromDiskMock.mockReturnValue(["rabbitmq-1749", "main"]);
    const log = createGatewayLogMock();
    const manager = createBuiltinManagerMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(2);
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(1, { cfg, agentId: "main" });
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(2, {
      cfg,
      agentId: "rabbitmq-1749",
    });
  });

  it("warns and continues when builtin prewarm fails for one agent", async () => {
    const cfg = createBuiltinConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [{ id: "main", default: true }, { id: "ops" }],
    });
    const log = createGatewayLogMock();
    const okManager = createBuiltinManagerMock();
    const failingManager = createBuiltinManagerMock();
    failingManager.sync.mockRejectedValue(new Error("disk full"));
    getMemorySearchManagerMock
      .mockResolvedValueOnce({ manager: failingManager })
      .mockResolvedValueOnce({ manager: okManager });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'memory startup prewarm failed for agent "main": Error: disk full',
    );
    expect(okManager.sync).toHaveBeenCalledTimes(1);
  });

  it("continues with other agents when backend config resolution throws", async () => {
    const cfg = createBuiltinConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [{ id: "main", default: true }, { id: "ops" }],
    });
    const log = createGatewayLogMock();
    const manager = createBuiltinManagerMock();
    resolveActiveMemoryBackendConfigMock
      .mockImplementationOnce(() => {
        throw new Error("bad multimodal config");
      })
      .mockImplementationOnce(() => ({ backend: "builtin" }));
    getMemorySearchManagerMock.mockResolvedValue({ manager });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'memory startup prewarm failed for agent "main": Error: bad multimodal config',
    );
    expect(manager.sync).toHaveBeenCalledTimes(1);
  });

  it("warns when builtin manager cannot be created", async () => {
    const cfg = createBuiltinConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [{ id: "main", default: true }],
    });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: null, error: "plugin unavailable" });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'memory startup prewarm failed for agent "main": plugin unavailable',
    );
  });

  it("caps the number of prewarmed agents", async () => {
    const diskAgents = Array.from({ length: 120 }, (_, i) => `rabbitmq-${i}`);
    listExistingAgentIdsFromDiskMock.mockReturnValue(diskAgents);
    const cfg = createBuiltinConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [{ id: "main", default: true }],
    });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: createBuiltinManagerMock() });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(100);
    expect(log.warn).toHaveBeenCalledWith(
      "memory startup prewarm capped at 100 agents (21 skipped)",
    );
  });
});
