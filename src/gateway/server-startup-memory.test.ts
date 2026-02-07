import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createTestLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const child = vi.fn(() => ({ ...logger, child }));
  const logger = {
    subsystem: "memory",
    trace: vi.fn(),
    debug: vi.fn(),
    info,
    warn,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child,
  };
  return { logger, info, warn };
}

describe("startGatewayMemoryBackendOnBoot", () => {
  const resolveMemoryBackendConfig = vi.fn();
  const getMemorySearchManager = vi.fn();
  const log = createTestLogger();

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    resolveMemoryBackendConfig.mockReset();
    getMemorySearchManager.mockReset();
    log.info.mockReset();
    log.warn.mockReset();

    vi.doMock("../logging/subsystem.js", () => ({
      createSubsystemLogger: () => log.logger,
    }));
    vi.doMock("../memory/backend-config.js", () => ({
      resolveMemoryBackendConfig,
    }));
    vi.doMock("../memory/search-manager.js", () => ({
      getMemorySearchManager,
    }));
  });

  afterEach(() => {
    vi.unmock("../logging/subsystem.js");
    vi.unmock("../memory/backend-config.js");
    vi.unmock("../memory/search-manager.js");
    vi.doUnmock("../logging/subsystem.js");
    vi.doUnmock("../memory/backend-config.js");
    vi.doUnmock("../memory/search-manager.js");
  });

  it("eagerly initializes QMD on boot for the default agent", async () => {
    resolveMemoryBackendConfig.mockReturnValue({
      backend: "qmd",
      citations: "auto",
      qmd: {},
    });
    getMemorySearchManager.mockResolvedValue({ manager: {}, backend: "qmd" });

    const { startGatewayMemoryBackendOnBoot } = await import("./server-startup-memory.js");
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as never;
    await startGatewayMemoryBackendOnBoot({ cfg });

    expect(getMemorySearchManager).toHaveBeenCalledTimes(1);
    expect(getMemorySearchManager).toHaveBeenCalledWith({ cfg, agentId: "main" });
    expect(log.info).toHaveBeenCalledWith("initialized on boot");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not log success when QMD init fails and builtin fallback is used", async () => {
    resolveMemoryBackendConfig.mockReturnValue({
      backend: "qmd",
      citations: "auto",
      qmd: {},
    });
    getMemorySearchManager.mockResolvedValue({
      manager: {},
      backend: "builtin",
      error: "qmd missing",
    });

    const { startGatewayMemoryBackendOnBoot } = await import("./server-startup-memory.js");
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as never;
    await startGatewayMemoryBackendOnBoot({ cfg });

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("boot init failed, using builtin fallback", {
      error: "qmd missing",
    });
  });

  it("defaults the boot init to agentId=main when agents.list is missing/empty", async () => {
    resolveMemoryBackendConfig.mockReturnValue({
      backend: "qmd",
      citations: "auto",
      qmd: {},
    });
    getMemorySearchManager.mockResolvedValue({ manager: {}, backend: "qmd" });

    const { startGatewayMemoryBackendOnBoot } = await import("./server-startup-memory.js");
    const cfg = {} as never;
    await startGatewayMemoryBackendOnBoot({ cfg });

    expect(getMemorySearchManager).toHaveBeenCalledWith({ cfg, agentId: "main" });
  });

  it("does not initialize when memory backend is not qmd", async () => {
    resolveMemoryBackendConfig.mockReturnValue({
      backend: "builtin",
      citations: "auto",
    });

    const { startGatewayMemoryBackendOnBoot } = await import("./server-startup-memory.js");
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as never;
    await startGatewayMemoryBackendOnBoot({ cfg });

    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("getMemorySearchManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unmock("../logging/subsystem.js");
    vi.doUnmock("../memory/search-manager.js");
    vi.doUnmock("../memory/qmd-manager.js");
    vi.doUnmock(import.meta.resolve("../memory/qmd-manager.js"));
    vi.doUnmock("node:child_process");
    vi.unstubAllGlobals();
  });

  it("dedups concurrent QMD init so only one QmdMemoryManager is created", async () => {
    vi.resetModules();
    vi.doUnmock("../memory/search-manager.js");
    vi.doUnmock("../memory/qmd-manager.js");

    const warnSpy = vi.fn();
    const testLogger = {
      subsystem: "memory",
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
      fatal: vi.fn(),
      raw: vi.fn(),
      child: () => testLogger,
    };
    vi.doMock("../logging/subsystem.js", () => ({
      createSubsystemLogger: () => testLogger,
    }));

    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    // Avoid spawning real qmd; always succeed fast.
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: () => {
          const child = new EventEmitter() as never;
          (child as { stdout: EventEmitter }).stdout = new EventEmitter();
          (child as { stderr: EventEmitter }).stderr = new EventEmitter();
          (child as { kill: (signal: string) => void }).kill = () => {};
          queueMicrotask(() => {
            (child as { stdout: EventEmitter }).stdout.emit("data", "[]");
            (child as EventEmitter).emit("close", 0);
          });
          return child;
        },
      };
    });

    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((_fn: never, _ms?: number) => ({}) as never);

    try {
      const { getMemorySearchManager } = await import("../memory/search-manager.js");
      expect(vi.isMockFunction(getMemorySearchManager)).toBe(false);
      const cfg = {
        agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main", default: true }] },
        memory: {
          backend: "qmd",
          qmd: {
            includeDefaultMemory: false,
            update: { interval: "1s", onBoot: false },
            sessions: { enabled: false },
          },
        },
      } as never;
      const p1 = getMemorySearchManager({ cfg, agentId: "main" });
      const p2 = getMemorySearchManager({ cfg, agentId: "main" });

      const [r1, r2] = await Promise.all([p1, p2]);
      if (!r1.manager || !r2.manager) {
        throw new Error(
          `expected qmd manager; got null manager(s). warnings=${JSON.stringify(
            warnSpy.mock.calls,
          )} r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`,
        );
      }
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
      setIntervalSpy.mockRestore();
    }
  });
});

describe("QmdMemoryManager.initialize", () => {
  const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unmock("../logging/subsystem.js");
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  });

  it("arms the interval timer even if the boot update fails", async () => {
    vi.resetModules();

    const log = createTestLogger();
    vi.doMock("../logging/subsystem.js", () => ({
      createSubsystemLogger: () => log.logger,
    }));

    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((_fn: never, _ms?: number) => ({}) as never);

    // Ensure we load the real class (not a prior mock).
    vi.doUnmock("../memory/qmd-manager.js");
    vi.unmock("../memory/qmd-manager.js");
    const { QmdMemoryManager } = await import("../memory/qmd-manager.js");

    vi.spyOn(QmdMemoryManager.prototype as never, "runQmd" as never).mockResolvedValue({
      stdout: "[]",
      stderr: "",
    });

    const bootError = new Error("boot update timed out");
    const runUpdateSpy = vi
      .spyOn(QmdMemoryManager.prototype as never, "runUpdate" as never)
      .mockRejectedValueOnce(bootError);

    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const cfg = {
      agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main", default: true }] },
    } as never;

    const resolved = {
      backend: "qmd",
      citations: "auto",
      qmd: {
        command: "qmd",
        collections: [],
        sessions: { enabled: false },
        includeDefaultMemory: false,
        update: { intervalMs: 1, debounceMs: 0, onBoot: true, embedIntervalMs: 0 },
        limits: { maxResults: 1, maxSnippetChars: 10, maxInjectedChars: 100, timeoutMs: 1 },
      },
    } as never;

    const manager = await QmdMemoryManager.create({ cfg, agentId: "main", resolved });
    expect(manager).not.toBeNull();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(runUpdateSpy).toHaveBeenCalled();

    const intervalOrder = setIntervalSpy.mock.invocationCallOrder[0];
    const updateOrder = runUpdateSpy.mock.invocationCallOrder[0];
    expect(intervalOrder).toBeLessThan(updateOrder);

    setIntervalSpy.mockRestore();
  });
});
