import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronServiceDeps } from "./service.js";
import { CronService } from "./service.js";
import { createNoopLogger, installCronTestHooks } from "./service.test-harness.js";

const noopLogger = createNoopLogger();
installCronTestHooks({ logger: noopLogger });

type FakeFsEntry =
  | { kind: "file"; content: string; mtimeMs: number }
  | { kind: "dir"; mtimeMs: number };

const fsState = vi.hoisted(() => ({
  entries: new Map<string, FakeFsEntry>(),
  nowMs: 0,
  fixtureCount: 0,
}));

const abs = (p: string) => path.resolve(p);
const fixturesRoot = abs(path.join("__openclaw_vitest__", "cron", "non-default-agent"));
const isFixturePath = (p: string) => {
  const resolved = abs(p);
  const rootPrefix = `${fixturesRoot}${path.sep}`;
  return resolved === fixturesRoot || resolved.startsWith(rootPrefix);
};

function bumpMtimeMs() {
  fsState.nowMs += 1;
  return fsState.nowMs;
}

function ensureDir(dirPath: string) {
  let current = abs(dirPath);
  while (true) {
    if (!fsState.entries.has(current)) {
      fsState.entries.set(current, { kind: "dir", mtimeMs: bumpMtimeMs() });
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

function setFile(filePath: string, content: string) {
  const resolved = abs(filePath);
  ensureDir(path.dirname(resolved));
  fsState.entries.set(resolved, { kind: "file", content, mtimeMs: bumpMtimeMs() });
}

async function makeStorePath() {
  const dir = path.join(fixturesRoot, `case-${fsState.fixtureCount++}`);
  ensureDir(dir);
  const storePath = path.join(dir, "cron", "jobs.json");
  ensureDir(path.dirname(storePath));
  return { storePath, cleanup: async () => {} };
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const pathMod = await import("node:path");
  const absInMock = (p: string) => pathMod.resolve(p);
  const isFixtureInMock = (p: string) => {
    const resolved = absInMock(p);
    const rootPrefix = `${absInMock(fixturesRoot)}${pathMod.sep}`;
    return resolved === absInMock(fixturesRoot) || resolved.startsWith(rootPrefix);
  };

  const mkErr = (code: string, message: string) => Object.assign(new Error(message), { code });

  const promises = {
    ...actual.promises,
    mkdir: async (p: string) => {
      if (!isFixtureInMock(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.mkdir as any)(p, { recursive: true });
      }
      ensureDir(p);
    },
    readFile: async (p: string) => {
      if (!isFixtureInMock(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.readFile as any)(p, "utf-8");
      }
      const entry = fsState.entries.get(absInMock(p));
      if (!entry || entry.kind !== "file") {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, open '${p}'`);
      }
      return entry.content;
    },
    writeFile: async (p: string, data: string | Uint8Array) => {
      if (!isFixtureInMock(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.writeFile as any)(p, data, "utf-8");
      }
      const content = typeof data === "string" ? data : Buffer.from(data).toString("utf-8");
      setFile(p, content);
    },
    rename: async (from: string, to: string) => {
      if (!isFixtureInMock(from) || !isFixtureInMock(to)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.rename as any)(from, to);
      }
      const fromAbs = absInMock(from);
      const toAbs = absInMock(to);
      const entry = fsState.entries.get(fromAbs);
      if (!entry || entry.kind !== "file") {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
      }
      ensureDir(pathMod.dirname(toAbs));
      fsState.entries.delete(fromAbs);
      fsState.entries.set(toAbs, { ...entry, mtimeMs: bumpMtimeMs() });
    },
    copyFile: async (from: string, to: string) => {
      if (!isFixtureInMock(from) || !isFixtureInMock(to)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.copyFile as any)(from, to);
      }
      const entry = fsState.entries.get(absInMock(from));
      if (!entry || entry.kind !== "file") {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, copyfile '${from}' -> '${to}'`);
      }
      setFile(to, entry.content);
    },
    stat: async (p: string) => {
      if (!isFixtureInMock(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.stat as any)(p);
      }
      const entry = fsState.entries.get(absInMock(p));
      if (!entry) {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, stat '${p}'`);
      }
      return {
        mtimeMs: entry.mtimeMs,
        isDirectory: () => entry.kind === "dir",
        isFile: () => entry.kind === "file",
      };
    },
    access: async (p: string) => {
      if (!isFixtureInMock(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.access as any)(p);
      }
      const entry = fsState.entries.get(absInMock(p));
      if (!entry) {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, access '${p}'`);
      }
    },
    unlink: async (p: string) => {
      if (!isFixtureInMock(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.promises.unlink as any)(p);
      }
      fsState.entries.delete(absInMock(p));
    },
  } as unknown as typeof actual.promises;

  const wrapped = { ...actual, promises };
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = {
    ...actual,
    mkdir: async (p: string, _opts?: unknown) => {
      if (!isFixturePath(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.mkdir as any)(p, { recursive: true });
      }
      ensureDir(p);
    },
    writeFile: async (p: string, data: string, _enc?: unknown) => {
      if (!isFixturePath(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (actual.writeFile as any)(p, data, "utf-8");
      }
      setFile(p, data);
    },
  };
  return { ...wrapped, default: wrapped };
});

beforeEach(() => {
  fsState.entries.clear();
  fsState.nowMs = 0;
  fsState.fixtureCount = 0;
  ensureDir(fixturesRoot);
});

async function createWakeModeNowMainHarness(options: {
  runHeartbeatOnce: NonNullable<CronServiceDeps["runHeartbeatOnce"]>;
}) {
  ensureDir(fixturesRoot);
  const store = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeatNow = vi.fn();

  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent,
    requestHeartbeatNow,
    runHeartbeatOnce: options.runHeartbeatOnce,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    wakeNowHeartbeatBusyMaxWaitMs: 1,
    wakeNowHeartbeatBusyRetryDelayMs: 2,
  });
  await cron.start();
  return { store, cron, enqueueSystemEvent, requestHeartbeatNow };
}

async function addWakeModeNowMainSystemEventJob(
  cron: CronService,
  options?: { name?: string; agentId?: string },
) {
  return cron.add({
    name: options?.name ?? "wakeMode now",
    ...(options?.agentId ? { agentId: options.agentId } : {}),
    enabled: true,
    schedule: { kind: "at", at: new Date(1).toISOString() },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "hello" },
  });
}

describe("CronService – non-default agent main-session jobs", () => {
  it("runs main-session system-event job for default agent via heartbeat", async () => {
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    const { store, cron, enqueueSystemEvent } = await createWakeModeNowMainHarness({
      runHeartbeatOnce,
    });
    const job = await addWakeModeNowMainSystemEventJob(cron, {
      name: "default agent main job",
    });

    await cron.run(job.id, "force");

    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(job.state.lastStatus).toBe("ok");

    cron.stop();
    await store.cleanup();
  });

  it("runs heartbeat for non-default agent when cron bypasses disabled check", async () => {
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    const { store, cron, enqueueSystemEvent } = await createWakeModeNowMainHarness({
      runHeartbeatOnce,
    });
    const job = await addWakeModeNowMainSystemEventJob(cron, {
      name: "non-default agent cron bypass",
      agentId: "docalist",
    });

    await cron.run(job.id, "force");

    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(runHeartbeatOnce).toHaveBeenCalledWith(expect.objectContaining({ agentId: "docalist" }));
    // System event must be enqueued
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ agentId: "docalist" }),
    );
    // With the fix, runHeartbeatOnce succeeds for non-default agents
    // when triggered via cron (reason starts with "cron:")
    expect(job.state.lastStatus).toBe("ok");

    cron.stop();
    await store.cleanup();
  });

  it("runs main-session system-event job for non-default agent when heartbeat returns ran", async () => {
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    const { store, cron, enqueueSystemEvent } = await createWakeModeNowMainHarness({
      runHeartbeatOnce,
    });
    const job = await addWakeModeNowMainSystemEventJob(cron, {
      name: "non-default agent runs",
      agentId: "ops",
    });

    await cron.run(job.id, "force");

    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ agentId: "ops" }),
    );
    expect(job.state.lastStatus).toBe("ok");

    cron.stop();
    await store.cleanup();
  });
});
