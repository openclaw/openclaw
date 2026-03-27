import type { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncEvent } from "../projects/sync-types.js";
import type { GatewayBroadcastFn } from "./server-broadcast.js";
import { ProjectGatewayService } from "./server-projects.js";

// Mock ProjectSyncService — use a real class so `new` works in forks pool
const mockStart = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockStop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockDiscoverProjects = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);

/** The most recently constructed mock instance (set by the class constructor). */
let lastMockInstance: EventEmitter | null = null;

vi.mock("../projects/sync-service.js", () => {
  const { EventEmitter } = require("node:events");
  return {
    ProjectSyncService: class MockProjectSyncService extends EventEmitter {
      constructor(_projectsRoot: string) {
        super();
        lastMockInstance = this;
        this.start = mockStart;
        this.stop = mockStop;
        this.discoverProjects = mockDiscoverProjects;
      }
      start: typeof mockStart;
      stop: typeof mockStop;
      discoverProjects: typeof mockDiscoverProjects;
    },
  };
});

describe("ProjectGatewayService", () => {
  let tmpDir: string;
  let broadcast: GatewayBroadcastFn;
  let broadcastCalls: Array<{ event: string; payload: unknown }>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proj-gw-test-"));
    broadcastCalls = [];
    broadcast = (event: string, payload: unknown) => {
      broadcastCalls.push({ event, payload });
    };
    vi.clearAllMocks();
    lastMockInstance = null;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("constructor accepts projectsRoot and broadcast without throwing", () => {
    expect(() => new ProjectGatewayService(tmpDir, broadcast)).not.toThrow();
  });

  it("start() creates a ProjectSyncService, calls its start(), and subscribes to sync events", async () => {
    const svc = new ProjectGatewayService(tmpDir, broadcast);
    await svc.start();
    expect(mockStart).toHaveBeenCalledOnce();
    // Verify it subscribed to sync events by emitting one
    const event: SyncEvent = { type: "project:changed", project: "test" };
    lastMockInstance!.emit("sync", event);
    expect(broadcastCalls).toHaveLength(1);
  });

  it("stop() calls ProjectSyncService.stop() and removes listeners", async () => {
    const svc = new ProjectGatewayService(tmpDir, broadcast);
    await svc.start();
    await svc.stop();
    expect(mockStop).toHaveBeenCalledOnce();
    // After stop, events should not trigger broadcast
    lastMockInstance!.emit("sync", { type: "project:changed", project: "test" });
    expect(broadcastCalls).toHaveLength(0);
  });

  it('on SyncEvent "project:changed", broadcast is called with ("projects.changed", { project })', async () => {
    const svc = new ProjectGatewayService(tmpDir, broadcast);
    await svc.start();
    lastMockInstance!.emit("sync", { type: "project:changed", project: "myproj" } satisfies SyncEvent);
    expect(broadcastCalls).toEqual([{ event: "projects.changed", payload: { project: "myproj" } }]);
  });

  it('on SyncEvent "task:changed", broadcast is called with ("projects.board.changed", { project })', async () => {
    const svc = new ProjectGatewayService(tmpDir, broadcast);
    await svc.start();
    lastMockInstance!.emit("sync", {
      type: "task:changed",
      project: "myproj",
      taskId: "TASK-001",
    } satisfies SyncEvent);
    expect(broadcastCalls).toEqual([
      { event: "projects.board.changed", payload: { project: "myproj" } },
    ]);
  });

  it('on SyncEvent "task:deleted", broadcast is called with ("projects.board.changed", { project })', async () => {
    const svc = new ProjectGatewayService(tmpDir, broadcast);
    await svc.start();
    lastMockInstance!.emit("sync", {
      type: "task:deleted",
      project: "myproj",
      taskId: "TASK-002",
    } satisfies SyncEvent);
    expect(broadcastCalls).toEqual([
      { event: "projects.board.changed", payload: { project: "myproj" } },
    ]);
  });

  it('on SyncEvent "queue:changed", broadcast is called with ("projects.queue.changed", { project })', async () => {
    const svc = new ProjectGatewayService(tmpDir, broadcast);
    await svc.start();
    lastMockInstance!.emit("sync", {
      type: "queue:changed",
      project: "myproj",
    } satisfies SyncEvent);
    expect(broadcastCalls).toEqual([
      { event: "projects.queue.changed", payload: { project: "myproj" } },
    ]);
  });

  it('on SyncEvent "reindex:complete", broadcast is NOT called', async () => {
    const svc = new ProjectGatewayService(tmpDir, broadcast);
    await svc.start();
    lastMockInstance!.emit("sync", {
      type: "reindex:complete",
      project: "myproj",
    } satisfies SyncEvent);
    expect(broadcastCalls).toHaveLength(0);
  });

  describe("data-read methods", () => {
    it("listProjects() discovers projects and reads .index/project.json for each", async () => {
      // Create a project dir with .index/project.json
      const projDir = path.join(tmpDir, "alpha");
      const indexDir = path.join(projDir, ".index");
      await fs.mkdir(indexDir, { recursive: true });
      const projectData = { name: "alpha", description: "Test project", indexedAt: "2026-01-01T00:00:00Z" };
      await fs.writeFile(path.join(indexDir, "project.json"), JSON.stringify(projectData));

      mockDiscoverProjects.mockResolvedValueOnce([projDir]);

      const svc = new ProjectGatewayService(tmpDir, broadcast);
      await svc.start();
      const result = await svc.listProjects();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: "alpha", description: "Test project" });
    });

    it("listProjects() returns empty array when projectsRoot does not exist", async () => {
      mockDiscoverProjects.mockResolvedValueOnce([]);

      const svc = new ProjectGatewayService("/nonexistent/path", broadcast);
      await svc.start();
      const result = await svc.listProjects();
      expect(result).toEqual([]);
    });

    it("getProject(name) reads .index/project.json and returns ProjectIndex", async () => {
      const projDir = path.join(tmpDir, "beta");
      const indexDir = path.join(projDir, ".index");
      await fs.mkdir(indexDir, { recursive: true });
      const projectData = { name: "Beta", description: "Another project", indexedAt: "2026-01-01T00:00:00Z" };
      await fs.writeFile(path.join(indexDir, "project.json"), JSON.stringify(projectData));

      const svc = new ProjectGatewayService(tmpDir, broadcast);
      const result = await svc.getProject("beta");
      expect(result).toMatchObject({ name: "Beta", indexedAt: "2026-01-01T00:00:00Z" });
    });

    it("getProject(name) returns null when .index/project.json does not exist", async () => {
      const svc = new ProjectGatewayService(tmpDir, broadcast);
      const result = await svc.getProject("nonexistent");
      expect(result).toBeNull();
    });

    it("getBoard(name) reads .index/board.json and returns BoardIndex", async () => {
      const projDir = path.join(tmpDir, "gamma");
      const indexDir = path.join(projDir, ".index");
      await fs.mkdir(indexDir, { recursive: true });
      const boardData = {
        columns: [{ name: "Backlog", tasks: [] }],
        indexedAt: "2026-01-01T00:00:00Z",
      };
      await fs.writeFile(path.join(indexDir, "board.json"), JSON.stringify(boardData));

      const svc = new ProjectGatewayService(tmpDir, broadcast);
      const result = await svc.getBoard("gamma");
      expect(result).toMatchObject({ columns: [{ name: "Backlog", tasks: [] }] });
    });

    it("getBoard(name) returns null when .index/board.json does not exist", async () => {
      const svc = new ProjectGatewayService(tmpDir, broadcast);
      const result = await svc.getBoard("nonexistent");
      expect(result).toBeNull();
    });

    it("getQueue(name) reads .index/queue.json and returns QueueIndex", async () => {
      const projDir = path.join(tmpDir, "delta");
      const indexDir = path.join(projDir, ".index");
      await fs.mkdir(indexDir, { recursive: true });
      const queueData = {
        available: [],
        claimed: [],
        blocked: [],
        done: [],
        indexedAt: "2026-01-01T00:00:00Z",
      };
      await fs.writeFile(path.join(indexDir, "queue.json"), JSON.stringify(queueData));

      const svc = new ProjectGatewayService(tmpDir, broadcast);
      const result = await svc.getQueue("delta");
      expect(result).toMatchObject({ available: [], indexedAt: "2026-01-01T00:00:00Z" });
    });

    it("getQueue(name) returns null when .index/queue.json does not exist", async () => {
      const svc = new ProjectGatewayService(tmpDir, broadcast);
      const result = await svc.getQueue("nonexistent");
      expect(result).toBeNull();
    });
  });
});
