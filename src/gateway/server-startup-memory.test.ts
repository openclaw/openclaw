/**
 * Gateway startup memory-service tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryQmdUpdateConfig } from "../config/types.memory.js";

const { getMemorySearchManagerMock } = vi.hoisted(() => ({
  getMemorySearchManagerMock: vi.fn(),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: getMemorySearchManagerMock,
}));

import { startGatewayMemoryBackend } from "./server-startup-memory.js";

function createQmdConfig(
  agents: OpenClawConfig["agents"],
  update: MemoryQmdUpdateConfig = { startup: "immediate" },
): OpenClawConfig {
  return {
    agents,
    memory: { backend: "qmd", qmd: { update } },
  } as OpenClawConfig;
}

function createGatewayLogMock() {
  return { info: vi.fn(), warn: vi.fn() };
}

function createQmdManagerMock() {
  return {
    search: vi.fn(),
    sync: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

async function startMemoryBackendForTest(cfg: OpenClawConfig) {
  const log = createGatewayLogMock();
  await startGatewayMemoryBackend({ cfg, log });
  return log;
}

async function startQmdBackendWithManager(cfg: OpenClawConfig) {
  getMemorySearchManagerMock.mockResolvedValue({ manager: createQmdManagerMock() });
  return await startMemoryBackendForTest(cfg);
}

async function startQmdBackendWithTrackedManager(cfg: OpenClawConfig) {
  const manager = createQmdManagerMock();
  getMemorySearchManagerMock.mockResolvedValue({ manager });
  const log = await startMemoryBackendForTest(cfg);
  return { log, manager };
}

function expectNoMemoryBackendStartup(log: ReturnType<typeof createGatewayLogMock>) {
  expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
  expect(log.info).not.toHaveBeenCalled();
  expect(log.warn).not.toHaveBeenCalled();
}

function expectQmdManagerRequests(cfg: OpenClawConfig, agentIds: string[]) {
  expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(agentIds.length);
  for (const [index, agentId] of agentIds.entries()) {
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(index + 1, {
      cfg,
      agentId,
    });
  }
}

function expectStartupInitialized(
  log: ReturnType<typeof createGatewayLogMock>,
  count: number,
  agents: string,
) {
  const noun = count === 1 ? "agent" : "agents";
  expect(log.info).toHaveBeenCalledWith(
    `qmd memory startup initialized for ${count} ${noun}: ${agents}`,
  );
}

describe("startGatewayMemoryBackend", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockClear();
  });

  it("skips initialization when memory backend is not qmd", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: { backend: "builtin" },
    } as OpenClawConfig;

    const log = await startMemoryBackendForTest(cfg);

    expectNoMemoryBackendStartup(log);
  });

  it("keeps qmd managers lazy when startup refresh is not opted in", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: { backend: "qmd", qmd: {} },
    } as OpenClawConfig;

    const log = await startMemoryBackendForTest(cfg);

    expectNoMemoryBackendStartup(log);
  });

  it("initializes qmd startup managers for the default and explicitly configured agents", async () => {
    const cfg = createQmdConfig({
      list: [
        { id: "ops", default: true },
        { id: "main", memorySearch: { enabled: true } },
        { id: "lazy" },
      ],
    });

    const log = await startQmdBackendWithManager(cfg);

    expectQmdManagerRequests(cfg, ["ops", "main"]);
    expectStartupInitialized(log, 2, '"ops", "main"');
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization deferred for 1 agent: "lazy"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("initializes all qmd agents when memory search is explicitly enabled in defaults", async () => {
    const cfg = createQmdConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [{ id: "ops", default: true }, { id: "main" }],
    });

    const log = await startQmdBackendWithManager(cfg);

    expectQmdManagerRequests(cfg, ["ops", "main"]);
    expectStartupInitialized(log, 2, '"ops", "main"');
    expect(log.info.mock.calls.some(([message]) => String(message).includes("deferred"))).toBe(
      false,
    );
  });

  it("logs a warning when qmd manager init fails and continues with other agents", async () => {
    const cfg = createQmdConfig({
      list: [
        { id: "main", default: true },
        { id: "ops", memorySearch: { enabled: true } },
      ],
    });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock
      .mockResolvedValueOnce({ manager: null, error: "qmd missing" })
      .mockResolvedValueOnce({ manager: createQmdManagerMock() });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'qmd memory startup initialization failed for agent "main": qmd missing',
    );
    expectStartupInitialized(log, 1, '"ops"');
  });

  it("skips agents with memory search disabled", async () => {
    const cfg = createQmdConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [
        { id: "main", default: true },
        { id: "ops", memorySearch: { enabled: false } },
      ],
    });

    const log = await startQmdBackendWithManager(cfg);

    expectQmdManagerRequests(cfg, ["main"]);
    expectStartupInitialized(log, 1, '"main"');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("arms qmd interval maintenance when boot refresh is disabled", async () => {
    const cfg = createQmdConfig(
      {
        list: [{ id: "main", default: true }],
      },
      { startup: "immediate", onBoot: false, interval: "5m", embedInterval: "0s" },
    );

    const { log, manager } = await startQmdBackendWithTrackedManager(cfg);

    expectQmdManagerRequests(cfg, ["main"]);
    expectStartupInitialized(log, 1, '"main"');
    expect(manager.sync).not.toHaveBeenCalled();
    expect(manager.close).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("arms qmd embed maintenance when boot refresh and interval updates are disabled", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: {
        backend: "qmd",
        qmd: {
          searchMode: "query",
          update: { startup: "immediate", onBoot: false, interval: "0s", embedInterval: "5m" },
        },
      },
    } as OpenClawConfig;

    const { log, manager } = await startQmdBackendWithTrackedManager(cfg);

    expectQmdManagerRequests(cfg, ["main"]);
    expectStartupInitialized(log, 1, '"main"');
    expect(manager.sync).not.toHaveBeenCalled();
    expect(manager.close).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not initialize qmd managers when background work is disabled", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: {
        backend: "qmd",
        qmd: {
          update: { startup: "immediate", onBoot: false, interval: "0s", embedInterval: "0s" },
        },
      },
    } as OpenClawConfig;

    const log = await startMemoryBackendForTest(cfg);

    expectNoMemoryBackendStartup(log);
  });
});
