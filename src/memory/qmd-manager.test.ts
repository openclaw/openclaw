import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn as mockedSpawn } from "node:child_process";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { QmdMemoryManager } from "./qmd-manager.js";

const spawnMock = mockedSpawn as unknown as vi.Mock;

describe("QmdMemoryManager", () => {
  let fixtureRoot: string;
  let fixtureCount = 0;
  let tmpRoot: string;
  let workspaceDir: string;
  let stateDir: string;
  let cfg: OpenClawConfig;
  const agentId = "main";

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
    await fs.mkdir(tmpRoot, { recursive: true });
    workspaceDir = path.join(tmpRoot, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    stateDir = path.join(tmpRoot, "state");
    await fs.mkdir(stateDir, { recursive: true });
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
    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }

    const baselineCalls = spawnMock.mock.calls.length;

    await manager.sync({ reason: "manual" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 2);

    await manager.sync({ reason: "manual-again" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 2);

    (manager as unknown as { lastUpdateAt: number | null }).lastUpdateAt =
      Date.now() - (resolved.qmd?.update.debounceMs ?? 0) - 10;

    await manager.sync({ reason: "after-wait" });
    // By default we refresh embeddings less frequently than index updates.
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 3);

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

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const createPromise = QmdMemoryManager.create({ cfg, agentId, resolved });
    const race = await Promise.race([
      createPromise.then(() => "created" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 40)),
    ]);
    expect(race).toBe("created");
    await waitForCondition(() => releaseUpdate !== null, 200);
    releaseUpdate?.();
    const manager = await createPromise;
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

    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const createPromise = QmdMemoryManager.create({ cfg, agentId, resolved });
    const race = await Promise.race([
      createPromise.then(() => "created" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 40)),
    ]);
    expect(race).toBe("timeout");
    await waitForCondition(() => releaseUpdate !== null, 200);
    releaseUpdate?.();
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

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    await manager?.close();
  });

  it("times out qmd update during sync when configured", async () => {
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
    const createPromise = QmdMemoryManager.create({ cfg, agentId, resolved });
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

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchCall = spawnMock.mock.calls.find((call) => call[1]?.[0] === "search");
    expect(searchCall?.[1]).toEqual(["search", "test", "--json"]);
    expect(spawnMock.mock.calls.some((call) => call[1]?.[0] === "query")).toBe(false);
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

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchAndQueryCalls = spawnMock.mock.calls
      .map((call) => call[1])
      .filter(
        (args): args is string[] => Array.isArray(args) && ["search", "query"].includes(args[0]),
      );
    expect(searchAndQueryCalls).toEqual([
      ["search", "test", "--json"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace"],
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

    let updateCalls = 0;
    let releaseFirstUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          const first = createMockChild({ autoClose: false });
          releaseFirstUpdate = () => first.closeWith(0);
          return first;
        }
        return createMockChild();
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }

    const inFlight = manager.sync({ reason: "interval" });
    const forced = manager.sync({ reason: "manual", force: true });

    await waitForCondition(() => updateCalls >= 1, 80);
    expect(updateCalls).toBe(1);
    if (!releaseFirstUpdate) {
      throw new Error("first update release missing");
    }
    releaseFirstUpdate();

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

    let updateCalls = 0;
    let releaseFirstUpdate: (() => void) | null = null;
    let releaseSecondUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          const first = createMockChild({ autoClose: false });
          releaseFirstUpdate = () => first.closeWith(0);
          return first;
        }
        if (updateCalls === 2) {
          const second = createMockChild({ autoClose: false });
          releaseSecondUpdate = () => second.closeWith(0);
          return second;
        }
        return createMockChild();
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }

    const inFlight = manager.sync({ reason: "interval" });
    const forcedOne = manager.sync({ reason: "manual", force: true });

    await waitForCondition(() => updateCalls >= 1, 80);
    expect(updateCalls).toBe(1);
    if (!releaseFirstUpdate) {
      throw new Error("first update release missing");
    }
    releaseFirstUpdate();

    await waitForCondition(() => updateCalls >= 2, 120);
    const forcedTwo = manager.sync({ reason: "manual-again", force: true });

    if (!releaseSecondUpdate) {
      throw new Error("second update release missing");
    }
    releaseSecondUpdate();

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
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    const queryCall = spawnMock.mock.calls.find((call) => call[1]?.[0] === "query");
    expect(queryCall?.[1]).toEqual([
      "query",
      "test",
      "--json",
      "-n",
      String(maxResults),
      "-c",
      "workspace",
      "-c",
      "notes",
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

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }

    const results = await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toEqual([]);
    expect(spawnMock.mock.calls.some((call) => call[1]?.[0] === "query")).toBe(false);
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
    const createPromise = QmdMemoryManager.create({ cfg, agentId, resolved });
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
    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }

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
    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }

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

  it("symlinks shared qmd models into the agent cache", async () => {
    const defaultCacheHome = path.join(tmpRoot, "default-cache");
    const sharedModelsDir = path.join(defaultCacheHome, "qmd", "models");
    await fs.mkdir(sharedModelsDir, { recursive: true });
    const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = defaultCacheHome;
    const symlinkSpy = vi.spyOn(fs, "symlink");

    try {
      const resolved = resolveMemoryBackendConfig({ cfg, agentId });
      const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
      expect(manager).toBeTruthy();
      if (!manager) {
        throw new Error("manager missing");
      }

      const targetModelsDir = path.join(
        stateDir,
        "agents",
        agentId,
        "qmd",
        "xdg-cache",
        "qmd",
        "models",
      );
      const modelsStat = await fs.lstat(targetModelsDir);
      expect(modelsStat.isSymbolicLink() || modelsStat.isDirectory()).toBe(true);
      expect(
        symlinkSpy.mock.calls.some(
          (call) => call[0] === sharedModelsDir && call[1] === targetModelsDir,
        ),
      ).toBe(true);

      await manager.close();
    } finally {
      symlinkSpy.mockRestore();
      if (previousXdgCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = previousXdgCacheHome;
      }
    }
  });

  it("blocks non-markdown or symlink reads for qmd paths", async () => {
    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }

    const textPath = path.join(workspaceDir, "secret.txt");
    await fs.writeFile(textPath, "nope", "utf-8");
    await expect(manager.readFile({ relPath: "qmd/workspace/secret.txt" })).rejects.toThrow(
      "path required",
    );

    const target = path.join(workspaceDir, "target.md");
    await fs.writeFile(target, "ok", "utf-8");
    const link = path.join(workspaceDir, "link.md");
    await fs.symlink(target, link);
    await expect(manager.readFile({ relPath: "qmd/workspace/link.md" })).rejects.toThrow(
      "path required",
    );

    await manager.close();
  });

  it("throws when sqlite index is busy", async () => {
    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }
    const inner = manager as unknown as {
      db: { prepare: () => { get: () => never }; close: () => void } | null;
      resolveDocLocation: (docid?: string) => Promise<unknown>;
    };
    inner.db = {
      prepare: () => ({
        get: () => {
          throw new Error("SQLITE_BUSY: database is locked");
        },
      }),
      close: () => {},
    };
    await expect(inner.resolveDocLocation("abc123")).rejects.toThrow(
      "qmd index busy while reading results",
    );
    await manager.close();
  });

  it("fails search when sqlite index is busy so caller can fallback", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
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

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }
    const inner = manager as unknown as {
      db: { prepare: () => { get: () => never }; close: () => void } | null;
    };
    inner.db = {
      prepare: () => ({
        get: () => {
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

  it("treats plain-text no-results stdout as an empty result set", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "No results found.");
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }

    await expect(
      manager.search("missing", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);
    await manager.close();
  });

  it("treats plain-text no-results stdout without punctuation as empty", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "No results found\n\n");
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }

    await expect(
      manager.search("missing", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);
    await manager.close();
  });

  it("treats plain-text no-results stderr as an empty result set", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "No results found.\n");
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }

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

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }

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
      const resolved = resolveMemoryBackendConfig({ cfg, agentId });
      const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
      expect(manager).toBeTruthy();

      const stat = await fs.lstat(customModelsDir);
      expect(stat.isSymbolicLink()).toBe(true);
      const target = await fs.readlink(customModelsDir);
      expect(target).toBe(defaultModelsDir);

      // Models are accessible through the symlink.
      const content = await fs.readFile(path.join(customModelsDir, "model.bin"), "utf-8");
      expect(content).toBe("fake-model");

      await manager!.close();
    });

    it("does not overwrite existing models directory", async () => {
      // Pre-create the custom models dir with different content.
      await fs.mkdir(customModelsDir, { recursive: true });
      await fs.writeFile(path.join(customModelsDir, "custom-model.bin"), "custom");

      const resolved = resolveMemoryBackendConfig({ cfg, agentId });
      const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
      expect(manager).toBeTruthy();

      // Should still be a real directory, not a symlink.
      const stat = await fs.lstat(customModelsDir);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isDirectory()).toBe(true);

      // Custom content should be preserved.
      const content = await fs.readFile(path.join(customModelsDir, "custom-model.bin"), "utf-8");
      expect(content).toBe("custom");

      await manager!.close();
    });

    it("skips symlink when no default models exist", async () => {
      // Remove the default models dir.
      await fs.rm(defaultModelsDir, { recursive: true, force: true });

      const resolved = resolveMemoryBackendConfig({ cfg, agentId });
      const manager = await QmdMemoryManager.create({ cfg, agentId, resolved });
      expect(manager).toBeTruthy();

      // Custom models dir should not exist (no symlink created).
      await expect(fs.lstat(customModelsDir)).rejects.toThrow();
      expect(logWarnMock).not.toHaveBeenCalledWith(
        expect.stringContaining("failed to symlink qmd models directory"),
      );

      await manager!.close();
    });
  });
});

async function waitForCondition(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was not met in time");
}
