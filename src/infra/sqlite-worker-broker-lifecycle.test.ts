import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createSqliteWorkerLifecycle } from "./sqlite-worker-broker-lifecycle.js";

const createCpuTrackedWorker = vi.hoisted(() => vi.fn());
vi.mock("./worker-cpu.js", () => ({ createCpuTrackedWorker }));
vi.mock("./bun-sqlite-library.js", () => ({ ensureSqliteLibrarySelected: () => {} }));

describe("SQLite worker slots", () => {
  // Bun resolves a `file:` preload by stripping "file://", so tsx's URL breaks on Windows.
  it.each([
    { runtime: "Node", bun: undefined, execArgv: ["--import", import.meta.resolve("tsx/esm")] },
    { runtime: "Bun", bun: "1.4.3", execArgv: [] },
  ])("gives $runtime source workers only the TypeScript loader they need", ({ bun, execArgv }) => {
    const versions = Object.getOwnPropertyDescriptor(process, "versions");
    Object.defineProperty(process, "versions", {
      configurable: true,
      value: { ...process.versions, bun },
    });
    try {
      createCpuTrackedWorker.mockReturnValueOnce(
        Object.assign(new EventEmitter(), { unref: vi.fn() }),
      );
      const lifecycle = createSqliteWorkerLifecycle({
        actors: new Map(),
        slots: new Set(),
        stores: new Map(),
        enqueueClose: vi.fn(),
        fail: vi.fn(),
      });
      lifecycle.createSlot(
        {
          carrierUrl: new URL("file:///openclaw/src/infra/sqlite-store.worker.ts"),
          moduleUrl: new URL("file:///openclaw/src/infra/device-auth-store.sqlite.ts"),
          databasePath: "/state/openclaw.sqlite",
          input: Buffer.alloc(0),
          existingOnly: false,
        },
        false,
        () => ({ fail: vi.fn(), finish: vi.fn(), dispatch: vi.fn() }),
      );
      expect(createCpuTrackedWorker).toHaveBeenLastCalledWith(
        expect.any(URL),
        expect.objectContaining({ execArgv }),
      );
    } finally {
      if (versions) {
        Object.defineProperty(process, "versions", versions);
      }
    }
  });
});
