import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Mock } from "vitest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { logWarnMock, logDebugMock, logInfoMock } = vi.hoisted(() => ({
  logWarnMock: vi.fn(),
  logDebugMock: vi.fn(),
  logInfoMock: vi.fn(),
}));

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals) => void;
  closeWith: (code?: number | null) => void;
};

function createMockChild(params?: { autoClose?: boolean; closeDelayMs?: number }): MockChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as MockChild;
  child.stdout = stdout;
  child.stderr = stderr;
  child.closeWith = (code = 0) => {
    child.emit("close", code);
  };
  child.kill = () => {
    // Let timeout rejection win in tests that simulate hung QMD commands.
  };
  if (params?.autoClose !== false) {
    const delayMs = params?.closeDelayMs ?? 0;
    if (delayMs <= 0) {
      queueMicrotask(() => {
        child.emit("close", 0);
      });
    } else {
      setTimeout(() => {
        child.emit("close", 0);
      }, delayMs);
    }
  }
  return child;
}

function emitAndClose(
  child: MockChild,
  stream: "stdout" | "stderr",
  data: string,
  code: number = 0,
) {
  queueMicrotask(() => {
    child[stream].emit("data", data);
    child.closeWith(code);
  });
}

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const logger = {
      warn: logWarnMock,
      debug: logDebugMock,
      info: logInfoMock,
      child: () => logger,
    };
    return logger;
  },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn as mockedSpawn } from "node:child_process";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { QmdMemoryManager } from "./qmd-manager.js";

const spawnMock = mockedSpawn as unknown as Mock;

describe("QmdMemoryManager", () => {
  let fixtureRoot: string;
  let fixtureCount = 0;
  let tmpRoot: string;
  let workspaceDir: string;
  let stateDir: string;
  let cfg: OpenClawConfig;
  const agentId = "main";

  async function createManager(params?: { mode?: "full" | "status"; cfg?: OpenClawConfig }) {
    const cfgToUse = params?.cfg ?? cfg;
    const resolved = resolveMemoryBackendConfig({ cfg: cfgToUse, agentId });
    const manager = await QmdMemoryManager.create({
      cfg: cfgToUse,
      agentId,
      resolved,
      mode: params?.mode ?? "status",
    });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }
    return { manager, resolved };
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qmd-manager-test-fixtures-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createMockChild());
    logWarnMock.mockReset();
    logDebugMock.mockReset();
    logInfoMock.mockReset();
    tmpRoot = path.join(fixtureRoot, `case-${fixtureCount++}`);
    await fs.mkdir(tmpRoot);
    workspaceDir = path.join(tmpRoot, "workspace");
    await fs.mkdir(workspaceDir);
    stateDir = path.join(tmpRoot, "state");
    await fs.mkdir(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    cfg = {
      agents: {
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.OPENCLAW_STATE_DIR;
  });

  it("debounces back-to-back sync calls", async () => {
    const { manager, resolved } = await createManager();

    const baselineCalls = spawnMock.mock.calls.length;

    await manager.sync({ reason: "manual" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 1);

    await manager.sync({ reason: "manual-again" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 1);

    (manager as unknown as { lastUpdateAt: number | null }).lastUpdateAt =
      Date.now() - (resolved.qmd?.update.debounceMs ?? 0) - 10;

    await manager.sync({ reason: "after-wait" });
    // `search` mode does not require qmd embed side effects.
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 2);

    await manager.close();
  });

  it("runs boot update in background by default", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    expect(releaseUpdate).not.toBeNull();
    (releaseUpdate as (() => void) | null)?.();
    await manager?.close();
  });

  it("skips qmd command side effects in status mode initialization", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "5m", debounceMs: 60_000, onBoot: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "status" });
    expect(spawnMock).not.toHaveBeenCalled();
    await manager?.close();
  });

  it("can be configured to block startup on boot update", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 60_000,
            onBoot: true,
            waitForBootSync: true,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const updateSpawned = createDeferred<void>();
    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        updateSpawned.resolve();
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const createPromise = QmdMemoryManager.create({ cfg, agentId, resolved, mode: "full" });
    await updateSpawned.promise;
    let created = false;
    void createPromise.then(() => {
      created = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(created).toBe(false);
    (releaseUpdate as (() => void) | null)?.();
    const manager = await createPromise;
    await manager?.close();
  });

  it("times out collection bootstrap commands", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 60_000,
            onBoot: false,
            commandTimeoutMs: 15,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return createMockChild({ autoClose: false });
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager?.close();
  });

  it("rebinds sessions collection when existing collection path targets another agent", async () => {
    const devAgentId = "dev";
    const devWorkspaceDir = path.join(tmpRoot, "workspace-dev");
    await fs.mkdir(devWorkspaceDir);
    cfg = {
      ...cfg,
      agents: {
        list: [
          { id: agentId, default: true, workspace: workspaceDir },
          { id: devAgentId, workspace: devWorkspaceDir },
        ],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: devWorkspaceDir, pattern: "**/*.md", name: "workspace" }],
          sessions: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const sessionCollectionName = `sessions-${devAgentId}`;
    const wrongSessionsPath = path.join(stateDir, "agents", agentId, "qmd", "sessions");
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { name: sessionCollectionName, path: wrongSessionsPath, mask: "**/*.md" },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId: devAgentId });
    const manager = await QmdMemoryManager.create({
      cfg,
      agentId: devAgentId,
      resolved,
      mode: "full",
    });
    expect(manager).toBeTruthy();
    await manager?.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeSessions = commands.find(
      (args) =>
        args[0] === "collection" && args[1] === "remove" && args[2] === sessionCollectionName,
    );
    expect(removeSessions).toBeDefined();

    const addSessions = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === sessionCollectionName;
    });
    expect(addSessions).toBeDefined();
    expect(addSessions?.[2]).toBe(path.join(stateDir, "agents", devAgentId, "qmd", "sessions"));
  });

  it("rebinds managed collections when qmd only reports collection names", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          sessions: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const sessionCollectionName = `sessions-${agentId}`;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([`workspace-${agentId}`, sessionCollectionName]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeSessions = commands.find(
      (args) =>
        args[0] === "collection" && args[1] === "remove" && args[2] === sessionCollectionName,
    );
    expect(removeSessions).toBeDefined();
    const removeWorkspace = commands.find(
      (args) =>
        args[0] === "collection" && args[1] === "remove" && args[2] === `workspace-${agentId}`,
    );
    expect(removeWorkspace).toBeDefined();

    const addSessions = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === sessionCollectionName;
    });
    expect(addSessions).toBeDefined();
  });

  it("times out qmd update during sync when configured", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            updateTimeoutMs: 20,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        return createMockChild({ autoClose: false });
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const createPromise = QmdMemoryManager.create({ cfg, agentId, resolved, mode: "status" });
    await vi.advanceTimersByTimeAsync(0);
    const manager = await createPromise;
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }
    const syncPromise = manager.sync({ reason: "manual" });
    const rejected = expect(syncPromise).rejects.toThrow("qmd update timed out after 20ms");
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    await manager.close();
  });

  it("rebuilds managed collections once when qmd update fails with null-byte ENOTDIR", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(
            child,
            "stderr",
            "ENOTDIR: not a directory, open '/tmp/workspace/MEMORY.md^@'",
            1,
          );
          return child;
        }
        queueMicrotask(() => {
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove")
      .map((args) => args[2]);
    const addCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "add")
      .map((args) => args[args.indexOf("--name") + 1]);

    expect(updateCalls).toBe(2);
    expect(removeCalls).toEqual(["memory-root-main", "memory-alt-main", "memory-dir-main"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-alt-main", "memory-dir-main"]);
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("suspected null-byte collection metadata"),
    );

    await manager.close();
  });

  it("does not rebuild collections for generic qmd update failures", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stderr",
          "ENOTDIR: not a directory, open '/tmp/workspace/MEMORY.md'",
          1,
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).rejects.toThrow(
      "ENOTDIR: not a directory, open '/tmp/workspace/MEMORY.md'",
    );

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove");
    expect(removeCalls).toHaveLength(0);

    await manager.close();
  });

  it("uses configured qmd search mode command", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]).toEqual([
      "search",
      "test",
      "--json",
      "-n",
      String(resolved.qmd?.limits.maxResults),
      "-c",
      "workspace-main",
    ]);
    expect(
      spawnMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "query"),
    ).toBe(false);
    expect(maxResults).toBeGreaterThan(0);
    await manager.close();
  });

  it("retries search with qmd query when configured mode rejects flags", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "unknown flag: --json", 2);
        return child;
      }
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchAndQueryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1])
      .filter(
        (args): args is string[] => Array.isArray(args) && ["search", "query"].includes(args[0]),
      );
    expect(searchAndQueryCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
    ]);
    await manager.close();
  });

  it("queues a forced sync behind an in-flight update", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            updateTimeoutMs: 1_000,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const firstUpdateSpawned = createDeferred<void>();
    let updateCalls = 0;
    let releaseFirstUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          const first = createMockChild({ autoClose: false });
          releaseFirstUpdate = () => first.closeWith(0);
          firstUpdateSpawned.resolve();
          return first;
        }
        return createMockChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inFlight = manager.sync({ reason: "interval" });
    const forced = manager.sync({ reason: "manual", force: true });

    await firstUpdateSpawned.promise;
    expect(updateCalls).toBe(1);
    if (!releaseFirstUpdate) {
      throw new Error("first update release missing");
    }
    (releaseFirstUpdate as () => void)();

    await Promise.all([inFlight, forced]);
    expect(updateCalls).toBe(2);
    await manager.close();
  });

  it("honors multiple forced sync requests while forced queue is active", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            updateTimeoutMs: 1_000,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const firstUpdateSpawned = createDeferred<void>();
    const secondUpdateSpawned = createDeferred<void>();
    let updateCalls = 0;
    let releaseFirstUpdate: (() => void) | null = null;
    let releaseSecondUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          const first = createMockChild({ autoClose: false });
          releaseFirstUpdate = () => first.closeWith(0);
          firstUpdateSpawned.resolve();
          return first;
        }
        if (updateCalls === 2) {
          const second = createMockChild({ autoClose: false });
          releaseSecondUpdate = () => second.closeWith(0);
          secondUpdateSpawned.resolve();
          return second;
        }
        return createMockChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inFlight = manager.sync({ reason: "interval" });
    const forcedOne = manager.sync({ reason: "manual", force: true });

    await firstUpdateSpawned.promise;
    expect(updateCalls).toBe(1);
    if (!releaseFirstUpdate) {
      throw new Error("first update release missing");
    }
    (releaseFirstUpdate as () => void)();

    await secondUpdateSpawned.promise;
    const forcedTwo = manager.sync({ reason: "manual-again", force: true });

    if (!releaseSecondUpdate) {
      throw new Error("second update release missing");
    }
    (releaseSecondUpdate as () => void)();

    await Promise.all([inFlight, forcedOne, forcedTwo]);
    expect(updateCalls).toBe(3);
    await manager.close();
  });

  it("scopes qmd queries to managed collections", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();

    await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }
    const searchCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "search");
    expect(searchCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["search", "test", "--json", "-n", String(maxResults), "-c", "notes-main"],
    ]);
    await manager.close();
  });

  it("runs qmd query per collection when query mode has multiple collection filters", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const queryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "query");
    expect(queryCalls).toEqual([
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "notes-main"],
    ]);
    await manager.close();
  });

  it("uses per-collection query fallback when search mode rejects flags", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "unknown flag: --json", 2);
        return child;
      }
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchAndQueryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "search" || args[0] === "query");
    expect(searchAndQueryCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "notes-main"],
    ]);
    await manager.close();
  });

  it("fails closed when no managed collections are configured", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager();

    const results = await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toEqual([]);
    expect(
      spawnMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "query"),
    ).toBe(false);
    await manager.close();
  });

  it("diversifies mixed session and memory search results so memory hits are retained", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([{ docid: "m1", score: 0.6, snippet: "@@ -1,1\nmemory fact" }]),
        );
        return child;
      }
      if (args[0] === "search" && args.includes("sessions-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { docid: "s1", score: 0.99, snippet: "@@ -1,1\nsession top 1" },
            { docid: "s2", score: 0.95, snippet: "@@ -1,1\nsession top 2" },
            { docid: "s3", score: 0.91, snippet: "@@ -1,1\nsession top 3" },
            { docid: "s4", score: 0.88, snippet: "@@ -1,1\nsession top 4" },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (_query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          switch (arg) {
            case "m1":
              return [{ collection: "workspace-main", path: "memory/facts.md" }];
            case "s1":
            case "s2":
            case "s3":
            case "s4":
              return [
                {
                  collection: "sessions-main",
                  path: `${String(arg)}.md`,
                },
              ];
            default:
              return [];
          }
        },
      }),
      close: () => {},
    };

    const results = await manager.search("fact", {
      maxResults: 4,
      sessionKey: "agent:main:slack:dm:u123",
    });

    expect(results).toHaveLength(4);
    expect(results.some((entry) => entry.source === "memory")).toBe(true);
    expect(results.some((entry) => entry.source === "sessions")).toBe(true);
    await manager.close();
  });

  it("logs and continues when qmd embed times out", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            embedTimeoutMs: 20,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "embed") {
        return createMockChild({ autoClose: false });
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const createPromise = QmdMemoryManager.create({ cfg, agentId, resolved, mode: "status" });
    await vi.advanceTimersByTimeAsync(0);
    const manager = await createPromise;
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }
    const syncPromise = manager.sync({ reason: "manual" });
    const resolvedSync = expect(syncPromise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    await resolvedSync;
    await manager.close();
  });

  it("skips qmd embed in search mode even for forced sync", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "status" });
    await manager.sync({ reason: "manual", force: true });

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"]]);
    await manager.close();
  });

  it("retries boot update when qmd reports a retryable lock error", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: {
            interval: "0s",
            debounceMs: 60_000,
            onBoot: true,
            waitForBootSync: true,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(child, "stderr", "SQLITE_BUSY: database is locked", 2);
        } else {
          emitAndClose(child, "stdout", "", 0);
        }
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });

    expect(updateCalls).toBe(2);
    await manager.close();
  });

  it("scopes by channel for agent-prefixed session keys", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          scope: {
            default: "deny",
            rules: [{ action: "allow", match: { channel: "slack" } }],
          },
        },
      },
    } as OpenClawConfig;
    const { manager } = await createManager();

    const isAllowed = (key?: string) =>
      (manager as unknown as { isScopeAllowed: (key?: string) => boolean }).isScopeAllowed(key);
    expect(isAllowed("agent:main:slack:channel:c123")).toBe(true);
    expect(isAllowed("agent:main:slack:direct:u123")).toBe(true);
    expect(isAllowed("agent:main:slack:dm:u123")).toBe(true);
    expect(isAllowed("agent:main:discord:direct:u123")).toBe(false);
    expect(isAllowed("agent:main:discord:channel:c123")).toBe(false);

    await manager.close();
  });

  it("logs when qmd scope denies search", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          scope: {
            default: "deny",
            rules: [{ action: "allow", match: { chatType: "direct" } }],
          },
        },
      },
    } as OpenClawConfig;
    const { manager } = await createManager();

    logWarnMock.mockClear();
    const beforeCalls = spawnMock.mock.calls.length;
    await expect(
      manager.search("blocked", { sessionKey: "agent:main:discord:channel:c123" }),
    ).resolves.toEqual([]);

    expect(spawnMock.mock.calls.length).toBe(beforeCalls);
    expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining("qmd search denied by scope"));
    expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining("chatType=channel"));

    await manager.close();
  });

  it("blocks non-markdown or symlink reads for qmd paths", async () => {
    const { manager } = await createManager();

    const textPath = path.join(workspaceDir, "secret.txt");
    await fs.writeFile(textPath, "nope", "utf-8");
    await expect(manager.readFile({ relPath: "qmd/workspace-main/secret.txt" })).rejects.toThrow(
      "path required",
    );

    const target = path.join(workspaceDir, "target.md");
    await fs.writeFile(target, "ok", "utf-8");
    const link = path.join(workspaceDir, "link.md");
    await fs.symlink(target, link);
    await expect(manager.readFile({ relPath: "qmd/workspace-main/link.md" })).rejects.toThrow(
      "path required",
    );

    await manager.close();
  });

  it("reads only requested line ranges without loading the whole file", async () => {
    const readFileSpy = vi.spyOn(fs, "readFile");
    const text = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join("\n");
    await fs.writeFile(path.join(workspaceDir, "window.md"), text, "utf-8");

    const { manager } = await createManager();

    const result = await manager.readFile({ relPath: "window.md", from: 10, lines: 3 });
    expect(result.text).toBe("line-10\nline-11\nline-12");
    expect(readFileSpy).not.toHaveBeenCalled();

    await manager.close();
    readFileSpy.mockRestore();
  });

  it("returns empty text when a qmd workspace file does not exist", async () => {
    const { manager } = await createManager();
    const result = await manager.readFile({ relPath: "ghost.md" });
    expect(result).toEqual({ text: "", path: "ghost.md" });
    await manager.close();
  });

  it("returns empty text when a qmd file disappears before partial read", async () => {
    const relPath = "qmd-window.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.writeFile(absPath, "one\ntwo\nthree", "utf-8");

    const { manager } = await createManager();

    const realOpen = fs.open;
    let injected = false;
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof realOpen>) => {
        const [target, options] = args;
        if (!injected && typeof target === "string" && path.resolve(target) === absPath) {
          injected = true;
          const err = new Error("gone") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return realOpen(target, options);
      });

    const result = await manager.readFile({ relPath, from: 2, lines: 1 });
    expect(result).toEqual({ text: "", path: relPath });

    openSpy.mockRestore();
    await manager.close();
  });

  it("reuses exported session markdown files when inputs are unchanged", async () => {
    const writeFileSpy = vi.spyOn(fs, "writeFile");
    const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "session-1.jsonl");
    await fs.writeFile(
      sessionFile,
      '{"type":"message","message":{"role":"user","content":"hello"}}\n',
      "utf-8",
    );

    const currentMemory = cfg.memory;
    cfg = {
      ...cfg,
      memory: {
        ...currentMemory,
        qmd: {
          ...currentMemory?.qmd,
          sessions: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager();

    const reasonCount = writeFileSpy.mock.calls.length;
    await manager.sync({ reason: "manual" });
    const firstExportWrites = writeFileSpy.mock.calls.length;
    expect(firstExportWrites).toBe(reasonCount + 1);

    await manager.sync({ reason: "manual" });
    expect(writeFileSpy.mock.calls.length).toBe(firstExportWrites);

    await fs.writeFile(
      sessionFile,
      '{"type":"message","message":{"role":"user","content":"follow-up update"}}\n',
      "utf-8",
    );
    await manager.sync({ reason: "manual" });
    expect(writeFileSpy.mock.calls.length).toBe(firstExportWrites + 1);

    await manager.close();
    writeFileSpy.mockRestore();
  });

  it("throws when sqlite index is busy", async () => {
    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: {
        prepare: () => {
          all: () => never;
          get: () => never;
        };
        close: () => void;
      } | null;
      resolveDocLocation: (docid?: string) => Promise<unknown>;
    };
    const busyStmt: { all: () => never; get: () => never } = {
      all: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
      get: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    };

    inner.db = {
      prepare: () => busyStmt,
      close: () => {},
    };
    await expect(inner.resolveDocLocation("abc123")).rejects.toThrow(
      "qmd index busy while reading results",
    );
    await manager.close();
  });

  it("fails search when sqlite index is busy so caller can fallback", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([{ docid: "abc123", score: 1, snippet: "@@ -1,1\nremember this" }]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: () => { all: () => never }; close: () => void } | null;
    };
    inner.db = {
      prepare: () => ({
        all: () => {
          throw new Error("SQLITE_BUSY: database is locked");
        },
      }),
      close: () => {},
    };
    await expect(
      manager.search("busy lookup", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow("qmd index busy while reading results");
    await manager.close();
  });

  it("prefers exact docid match before prefix fallback for qmd document lookups", async () => {
    const prepareCalls: string[] = [];
    const exactDocid = "abc123";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { docid: exactDocid, score: 1, snippet: "@@ -5,2\nremember this\nnext line" },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (query: string) => {
        prepareCalls.push(query);
        return {
          all: (arg: unknown) => {
            if (query.includes("hash = ?")) {
              return [];
            }
            if (query.includes("hash LIKE ?")) {
              expect(arg).toBe(`${exactDocid}%`);
              return [{ collection: "workspace-main", path: "notes/welcome.md" }];
            }
            throw new Error(`unexpected sqlite query: ${query}`);
          },
        };
      },
      close: () => {},
    };

    const results = await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toEqual([
      {
        path: "notes/welcome.md",
        startLine: 5,
        endLine: 6,
        score: 1,
        snippet: "@@ -5,2\nremember this\nnext line",
        source: "memory",
      },
    ]);

    expect(prepareCalls).toHaveLength(2);
    expect(prepareCalls[0]).toContain("hash = ?");
    expect(prepareCalls[1]).toContain("hash LIKE ?");
    await manager.close();
  });

  it("prefers collection hint when resolving duplicate qmd document hashes", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    const duplicateDocid = "dup-123";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { docid: duplicateDocid, score: 0.9, snippet: "@@ -3,1\nworkspace hit" },
          ]),
        );
        return child;
      }
      if (args[0] === "search" && args.includes("notes-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(duplicateDocid)) {
            return [
              { collection: "stale-workspace", path: "notes/welcome.md" },
              { collection: "workspace-main", path: "notes/welcome.md" },
            ];
          }
          return [];
        },
      }),
      close: () => {},
    };

    const results = await manager.search("workspace", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toEqual([
      {
        path: "notes/welcome.md",
        startLine: 3,
        endLine: 3,
        score: 0.9,
        snippet: "@@ -3,1\nworkspace hit",
        source: "memory",
      },
    ]);
    await manager.close();
  });

  it("errors when qmd output exceeds command output safety cap", async () => {
    const noisyPayload = "x".repeat(240_000);
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", noisyPayload);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("noise", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/too much output/);
    await manager.close();
  });

  it("treats plain-text no-results stdout as an empty result set", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "No results found.");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("missing", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);
    await manager.close();
  });

  it("treats plain-text no-results stdout without punctuation as empty", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "No results found\n\n");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("missing", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);
    await manager.close();
  });

  it("treats plain-text no-results stderr as an empty result set", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "No results found.\n");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("missing", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);
    await manager.close();
  });

  it("throws when stdout is empty without the no-results marker", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        queueMicrotask(() => {
          child.stdout.emit("data", "   \n");
          child.stderr.emit("data", "unexpected parser error");
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("missing", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/qmd query returned invalid JSON/);
    await manager.close();
  });
  describe("model cache symlink", () => {
    let defaultModelsDir: string;
    let customModelsDir: string;
    let savedXdgCacheHome: string | undefined;

    beforeEach(async () => {
      // Redirect XDG_CACHE_HOME so symlinkSharedModels finds our fake models
      // directory instead of the real ~/.cache.
      savedXdgCacheHome = process.env.XDG_CACHE_HOME;
      const fakeCacheHome = path.join(tmpRoot, "fake-cache");
      process.env.XDG_CACHE_HOME = fakeCacheHome;

      defaultModelsDir = path.join(fakeCacheHome, "qmd", "models");
      await fs.mkdir(defaultModelsDir, { recursive: true });
      await fs.writeFile(path.join(defaultModelsDir, "model.bin"), "fake-model");

      customModelsDir = path.join(stateDir, "agents", agentId, "qmd", "xdg-cache", "qmd", "models");
    });

    afterEach(() => {
      if (savedXdgCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = savedXdgCacheHome;
      }
    });

    it("symlinks default model cache into custom XDG_CACHE_HOME on first run", async () => {
      const { manager } = await createManager({ mode: "full" });
      expect(manager).toBeTruthy();

      const stat = await fs.lstat(customModelsDir);
      expect(stat.isSymbolicLink()).toBe(true);
      const target = await fs.readlink(customModelsDir);
      expect(target).toBe(defaultModelsDir);

      // Models are accessible through the symlink.
      const content = await fs.readFile(path.join(customModelsDir, "model.bin"), "utf-8");
      expect(content).toBe("fake-model");

      await manager.close();
    });

    it("does not overwrite existing models directory", async () => {
      // Pre-create the custom models dir with different content.
      await fs.mkdir(customModelsDir, { recursive: true });
      await fs.writeFile(path.join(customModelsDir, "custom-model.bin"), "custom");

      const { manager } = await createManager({ mode: "full" });
      expect(manager).toBeTruthy();

      // Should still be a real directory, not a symlink.
      const stat = await fs.lstat(customModelsDir);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isDirectory()).toBe(true);

      // Custom content should be preserved.
      const content = await fs.readFile(path.join(customModelsDir, "custom-model.bin"), "utf-8");
      expect(content).toBe("custom");

      await manager.close();
    });

    it("skips symlink when no default models exist", async () => {
      // Remove the default models dir.
      await fs.rm(defaultModelsDir, { recursive: true, force: true });

      const { manager } = await createManager({ mode: "full" });
      expect(manager).toBeTruthy();

      // Custom models dir should not exist (no symlink created).
      await expect(fs.lstat(customModelsDir)).rejects.toThrow();
      expect(logWarnMock).not.toHaveBeenCalledWith(
        expect.stringContaining("failed to symlink qmd models directory"),
      );

      await manager.close();
    });
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
