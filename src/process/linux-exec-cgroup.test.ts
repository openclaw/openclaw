import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { initializeGatewayExecCgroup } from "./linux-exec-cgroup-startup.js";
import {
  getAgentExecCgroup,
  reclaimAgentExecCgroup,
  startAgentExecCgroupCleanup,
  sweepAgentExecCgroups,
  spawnInAgentExecCgroup,
} from "./linux-exec-cgroup.js";
import { createProcessSupervisor } from "./supervisor/supervisor.js";
import { createStubChildAdapter } from "./supervisor/supervisor.test-support.js";

const fixture = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  devices: ["9:127", "8:0"],
  denied: "",
  writable: true,
  mkdir: vi.fn(),
  write: vi.fn<(file: string, value: string) => void>(),
  spawn: vi.fn(),
  remove: vi.fn<(directory: string) => void>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    default: {
      ...original,
      readFileSync: (file: string) => {
        const value = fixture.files[file];
        if (value === undefined) {
          throw Object.assign(new Error(`Missing ${file}`), { code: "ENOENT" });
        }
        return value;
      },
      writeFileSync: fixture.write,
      promises: {
        ...original.promises,
        readFile: async (file: string) => {
          const value = fixture.files[file];
          if (value === undefined) {
            throw Object.assign(new Error(`Missing ${file}`), { code: "ENOENT" });
          }
          return value;
        },
        writeFile: async (file: string, value: string) => fixture.write(file, value),
        rmdir: async (directory: string) => fixture.remove(directory),
        readdir: async (directory: string) =>
          Object.keys(fixture.files)
            .filter((file) => file.startsWith(`${directory}/`) && file.endsWith("/cgroup.events"))
            .map((file) => file.slice(directory.length + 1).split("/")[0]!),
      },
      mkdirSync: fixture.mkdir,
      accessSync: (file: string) => {
        if (!fixture.writable || file === fixture.denied) {
          throw Object.assign(new Error("Read-only delegated subtree"), { code: "EACCES" });
        }
      },
    },
  };
});
vi.mock("./linux-exec-cgroup-device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./linux-exec-cgroup-device.js")>()),
  resolveExecIoDevices: () => fixture.devices,
}));
vi.mock("./child-memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./child-memory.js")>()),
  getHostExecMemoryBudget: () => ({ memoryBytes: 1800 * 1024 ** 2, swapBytes: 0 }),
}));
vi.mock("./supervisor/adapters/child.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supervisor/adapters/child.js")>()),
  createChildAdapter: fixture.spawn,
}));

const root = "/sys/fs/cgroup/system.slice/openclaw.service";
const exec = `${root}/agent-exec`;
const unscoped = `${exec}/unscoped`;
const MiB = 1024 ** 2;
class CgroupWatcher extends EventEmitter implements fs.FSWatcher {
  close = vi.fn(() => this.removeAllListeners());
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
const watchers = new Map<string, CgroupWatcher>();
let cleanupController: AbortController;
const cleanupLog = { info: vi.fn() };
beforeEach(() => {
  cleanupController = new AbortController();
  startAgentExecCgroupCleanup(cleanupController.signal, cleanupLog);
  cleanupLog.info.mockClear();
  watchers.clear();
  vi.spyOn(fs, "watch").mockImplementation(
    (
      file: fs.PathLike,
      options: fs.WatchOptions | fs.WatchListener<string>,
      listener?: fs.WatchListener<string>,
    ) => {
      const watcher = new CgroupWatcher();
      const callback = typeof options === "function" ? options : listener;
      if (callback) {
        watcher.on("change", callback);
      }
      watchers.set(String(file), watcher);
      return watcher;
    },
  );
  mockProcessPlatform("linux");
  vi.spyOn(os, "totalmem").mockReturnValue(2400 * MiB);
  vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  vi.spyOn(process.memoryUsage, "rss").mockReturnValue(0);
  fixture.devices = ["9:127", "8:0"];
  fixture.denied = "";
  fixture.writable = true;
  fixture.files = {
    "/proc/self/cgroup": "0::/system.slice/openclaw.service/gateway\n",
    [`${root}/cgroup.controllers`]: "cpu io memory pids\n",
    [`${root}/cgroup.procs`]: "",
  };
  fixture.write.mockImplementation((file, value) => {
    if (!fixture.writable || file === fixture.denied) {
      throw Object.assign(new Error("Read-only cgroup"), { code: "EROFS" });
    }
    fixture.files[file] = file.endsWith("cgroup.subtree_control")
      ? value.replaceAll("+", "")
      : value;
  });
  fixture.remove.mockImplementation((directory) => {
    for (const file of Object.keys(fixture.files)) {
      if (file.startsWith(`${directory}/`)) {
        delete fixture.files[file];
      }
    }
  });
});
afterEach(async () => {
  cleanupController.abort();
  fixture.files["/proc/self/cgroup"] = "0::/\n";
  await initializeGatewayExecCgroup("/state");
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const mock of [fixture.write, fixture.mkdir, fixture.spawn, fixture.remove]) {
    mock.mockReset();
  }
});

it("retires a leaf that is populated at command close and becomes idle later", async () => {
  vi.useFakeTimers();
  await initializeGatewayExecCgroup("/state");
  const directory = getAgentExecCgroup("late-idle")!;
  fixture.files[`${directory}/cgroup.events`] = "populated 1\n";
  fixture.files[`${directory}/cgroup.procs`] = "123\n";
  fixture.files[`${directory}/memory.current`] = String(2 * 1024 ** 3);
  fixture.write.mockImplementation((file) => {
    expect(file).toBe(`${directory}/memory.reclaim`);
    fixture.files[`${directory}/memory.current`] = "0";
  });
  await reclaimAgentExecCgroup(directory);
  expect(fixture.remove).not.toHaveBeenCalled();
  fixture.files[`${directory}/cgroup.events`] = "populated 0\n";
  fixture.files[`${directory}/cgroup.procs`] = "";
  watchers.get(`${directory}/cgroup.events`)?.emit("change", "change", "cgroup.events");
  await vi.runAllTimersAsync();
  expect(fixture.remove).toHaveBeenCalledWith(directory);
  expect(watchers.get(`${directory}/cgroup.events`)?.close).toHaveBeenCalledOnce();
  expect(cleanupLog.info).toHaveBeenLastCalledWith(
    expect.stringContaining(
      "source=watcher reclaimed=1 removed=1 skippedPopulated=0 errors=0 watching=0",
    ),
  );
});

it("sweeps orphaned session leaves without touching live or shared cgroups", async () => {
  vi.useFakeTimers();
  await initializeGatewayExecCgroup("/state");
  const dead = getAgentExecCgroup("orphan")!;
  const live = getAgentExecCgroup("active")!;
  for (const directory of [dead, live, unscoped, exec]) {
    fixture.files[`${directory}/cgroup.events`] =
      directory === live ? "populated 1\n" : "populated 0\n";
    fixture.files[`${directory}/cgroup.procs`] = "";
    fixture.files[`${directory}/memory.current`] = "0";
  }
  await sweepAgentExecCgroups();
  expect(fixture.remove.mock.calls).toEqual([[dead]]);
  expect(cleanupLog.info).toHaveBeenLastCalledWith(
    expect.stringContaining(
      "source=sweep reclaimed=0 removed=1 skippedPopulated=1 errors=0 watching=1",
    ),
  );
});

it("deduplicates and caps watches, rotates sweep overflow, and closes on shutdown", async () => {
  await initializeGatewayExecCgroup("/state");
  const directories = Array.from(
    { length: 257 },
    (_, i) => `${exec}/session-${i.toString(16).padStart(32, "0")}`,
  );
  for (const directory of directories) {
    fixture.files[`${directory}/cgroup.events`] = "populated 1\n";
    fixture.files[`${directory}/cgroup.procs`] = "";
    fixture.files[`${directory}/memory.current`] = "0";
  }
  await Promise.all(directories.map(reclaimAgentExecCgroup));
  await reclaimAgentExecCgroup(directories[0]);
  expect(fs.watch).toHaveBeenCalledTimes(256);
  const overflow = directories[256]!;
  fixture.files[`${overflow}/cgroup.events`] = "populated 0\n";
  await sweepAgentExecCgroups();
  expect(fixture.remove).not.toHaveBeenCalled();
  await sweepAgentExecCgroups();
  expect(fixture.remove.mock.calls).toEqual([[overflow]]);
  cleanupController.abort();
  expect([...watchers.values()].every((watcher) => watcher.close.mock.calls.length === 1)).toBe(
    true,
  );
  await reclaimAgentExecCgroup(directories[0]);
  expect(fs.watch).toHaveBeenCalledTimes(256);
});

it("reclaims after exec extinction without blocking completion or shutdown", async ({ signal }) => {
  vi.useFakeTimers();
  await initializeGatewayExecCgroup("/state");
  const directory = getAgentExecCgroup("completed-session")!;
  fixture.files[`${directory}/cgroup.procs`] = "";
  fixture.files[`${directory}/cgroup.events`] = "populated 0\nfrozen 0\n";
  fixture.files[`${directory}/memory.current`] = "19219978649";
  const operations: string[] = [];
  const entered = createDeferred();
  const release = createDeferred();
  vi.spyOn(fs.promises, "writeFile").mockImplementation(async (file, value) => {
    if (file === `${directory}/memory.reclaim`) {
      if (typeof value !== "string") {
        throw new Error("Expected a byte count");
      }
      operations.push(`reclaim ${value}`);
      entered.resolve();
      await release.promise;
      fixture.files[`${directory}/memory.current`] = "0";
    }
  });
  fixture.remove.mockImplementation((target) => {
    expect(target).toBe(directory);
    operations.push("remove");
  });
  const adapter = createStubChildAdapter();
  adapter.pid = undefined;
  fixture.spawn.mockResolvedValue({ adapter, ready: Promise.resolve() });
  const supervisor = createProcessSupervisor();
  const run = await supervisor.spawn({
    mode: "child",
    argv: ["fixture"],
    executionIntent: "agent-tool",
    executionScopeKey: "completed-session",
  });
  expect(operations).toEqual([]);
  adapter.settle(0);
  try {
    await withinTest(entered.promise, signal);
    await withinTest(
      Promise.all([run.wait(), run.waitForExtinction?.(), supervisor.shutdown()]),
      signal,
    );
    expect(operations).toEqual(["reclaim 19219978649"]);
  } finally {
    release.resolve();
    await vi.runAllTimersAsync();
  }
  expect(operations).toEqual(["reclaim 19219978649", "remove"]);
});

it.each(["process", "descendant", "busy race", "missing reclaim", "partial reclaim", "macOS"])(
  "handles session cgroup teardown with %s",
  async (mode) => {
    vi.useFakeTimers();
    await initializeGatewayExecCgroup("/state");
    const directory = getAgentExecCgroup("teardown")!;
    fixture.files[`${directory}/cgroup.procs`] = mode === "process" ? "123\n" : "";
    fixture.files[`${directory}/cgroup.events`] =
      `populated ${mode === "descendant" ? 1 : 0}\nfrozen 0\n`;
    fixture.files[`${directory}/memory.current`] = String(2 * 1024 ** 3);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const reclaims: string[] = [];
    fixture.write.mockImplementation((file, value) => {
      if (file !== `${directory}/memory.reclaim`) {
        throw new Error(`Unexpected write ${file}`);
      }
      reclaims.push(value);
      if (mode === "missing reclaim") {
        throw Object.assign(new Error("unsupported"), { code: "ENOENT" });
      }
      if (mode === "partial reclaim") {
        throw Object.assign(new Error("partial reclaim"), { code: "EAGAIN" });
      }
      fixture.files[`${directory}/memory.current`] = "0";
    });
    fixture.remove.mockImplementation(() => {
      if (mode === "busy race") {
        throw Object.assign(new Error("new exec joined"), { code: "EBUSY" });
      }
    });
    if (mode === "macOS") {
      mockProcessPlatform("darwin");
    }
    const cleanup = reclaimAgentExecCgroup(directory);
    await vi.runAllTimersAsync();
    await cleanup;
    const untouched = ["process", "descendant", "macOS"].includes(mode);
    expect(reclaims).toHaveLength(untouched ? 0 : mode === "partial reclaim" ? 5 : 1);
    expect(fixture.remove).toHaveBeenCalledTimes(untouched ? 0 : 1);
    expect(warning).toHaveBeenCalledTimes(mode === "missing reclaim" ? 1 : 0);
  },
);

it("serializes reclamation across completed sessions", async () => {
  vi.useFakeTimers();
  await initializeGatewayExecCgroup("/state");
  const directories = [getAgentExecCgroup("first")!, getAgentExecCgroup("second")!];
  for (const directory of directories) {
    fixture.files[`${directory}/cgroup.procs`] = "";
    fixture.files[`${directory}/cgroup.events`] = "populated 0\n";
    fixture.files[`${directory}/memory.current`] = String(2 * 1024 ** 3);
  }
  const entered = createDeferred();
  const release = createDeferred();
  const writes: string[] = [];
  vi.spyOn(fs.promises, "writeFile").mockImplementation(async (file) => {
    if (typeof file !== "string") {
      throw new Error("Expected a cgroup path");
    }
    writes.push(file);
    if (writes.length === 1) {
      entered.resolve();
      await release.promise;
    }
    fixture.files[file.replace("memory.reclaim", "memory.current")] = "0";
  });
  const cleanups = directories.map(reclaimAgentExecCgroup);
  await entered.promise;
  expect(writes).toEqual([`${directories[0]}/memory.reclaim`]);
  release.resolve();
  await vi.runAllTimersAsync();
  await Promise.all(cleanups);
  expect(writes).toEqual(directories.map((directory) => `${directory}/memory.reclaim`));
  expect(fixture.remove.mock.calls).toEqual(directories.map((directory) => [directory]));
});

it("recreates an empty session leaf removed between launch preparation and broker join", async () => {
  await initializeGatewayExecCgroup("/state");
  const directory = getAgentExecCgroup("joining-session")!;
  const write = fixture.write.getMockImplementation()!;
  let joined = false;
  let removed = true;
  fixture.mkdir.mockClear();
  fixture.write.mockImplementation((file, value) => {
    if (file === `${directory}/cgroup.procs`) {
      if (removed) {
        removed = false;
        throw Object.assign(new Error("retired before join"), { code: "ENOENT" });
      }
      joined = true;
    }
    write(file, value);
  });
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  spawnInAgentExecCgroup(directory, () => expect(joined).toBe(true));
  expect(fixture.mkdir).toHaveBeenCalledWith(directory, { recursive: true });
  expect(warning).not.toHaveBeenCalled();
});

it.each(["owned", "internal", "external", "nested Gateway", "write failure"])(
  "applies full-budget cache protection before native construction for %s",
  async (mode) => {
    await initializeGatewayExecCgroup("/state");
    const io = fixture.files[`${exec}/io.max`];
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    if (mode === "write failure") {
      fixture.denied = `${exec}/memory.high`;
    }
    const supervisor = createProcessSupervisor();
    const observed: string[] = [];
    fixture.spawn.mockImplementation(async () => {
      observed.push(expectDefined(fixture.files[`${exec}/memory.high`], "memory.high policy"));
      const adapter = createStubChildAdapter();
      adapter.pid = undefined;
      adapter.settle(0);
      return { adapter, ready: Promise.resolve() };
    });
    try {
      for (
        let attempt = 0;
        attempt < (mode === "owned" || mode === "nested Gateway" ? 2 : 1);
        attempt++
      ) {
        if (attempt) {
          if (mode === "nested Gateway") {
            fixture.files["/proc/self/cgroup"] =
              "0::/system.slice/openclaw.service/agent-exec/unscoped\n";
            expect(await initializeGatewayExecCgroup("/nested-state")).toContain("unavailable");
          } else {
            // A startup refresh removes the old throttle; the next exec restores it.
            await initializeGatewayExecCgroup("/state");
            expect(fixture.files[`${exec}/memory.high`]).toBe("max");
          }
        }
        const run = await supervisor.spawn({
          mode: "child",
          argv: ["fixture"],
          executionIntent: mode === "internal" ? "gateway-internal" : "agent-tool",
          ...(mode === "external" ? { cleanupOwnership: "external" } : {}),
        });
        expect((await run.wait()).exitCode).toBe(0);
      }
      expect(observed).toEqual(
        mode === "owned" || mode === "nested Gateway" ? ["1887436800", "1887436800"] : ["max"],
      );
      expect(fixture.files[`${exec}/io.max`]).toBe(io);
      expect(fixture.files[`${exec}/memory.max`]).toBeUndefined();
      expect(warning.mock.calls.length).toBe(mode === "write failure" ? 1 : 0);
    } finally {
      await supervisor.shutdown();
    }
  },
);

it.for(["cancellation", "authority revocation"])(
  "preserves the active scope during a pending cache write and %s",
  async (event, { signal }) => {
    await initializeGatewayExecCgroup("/state");
    const supervisor = createProcessSupervisor();
    const cleanup = supervisor.acquireScopeCleanup("scope", { processTree: "transport-only" });
    const survivor = createStubChildAdapter();
    const successor = createStubChildAdapter();
    successor.settle(0);
    survivor.pid = successor.pid = undefined;
    fixture.spawn
      .mockResolvedValueOnce({ adapter: survivor, ready: Promise.resolve() })
      .mockResolvedValueOnce({ adapter: successor, ready: Promise.resolve() });
    const input = {
      mode: "child" as const,
      argv: ["fixture"],
      executionIntent: "agent-tool" as const,
      scopeKey: "scope",
    };
    const active = await supervisor.spawn(input);
    fixture.files[`${exec}/memory.high`] = "max";
    const entered = createDeferred();
    const release = createDeferred();
    vi.spyOn(fs.promises, "writeFile").mockImplementationOnce(async (file, value) => {
      if (typeof file !== "string" || typeof value !== "string") {
        throw new Error("Expected a cgroup policy path and text");
      }
      expect(file).toBe(`${exec}/memory.high`);
      entered.resolve();
      await release.promise;
      fixture.write(file, value);
    });
    let current = true;
    const pending = supervisor.spawn({
      ...input,
      runId: "pending",
      replaceExistingScope: true,
      assertCurrent: () => {
        if (!current) {
          throw new Error("execution authority revoked");
        }
      },
    });
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, pending, "cache write was not awaited"),
        signal,
      );
      expect(fixture.spawn).toHaveBeenCalledOnce();
      expect(survivor.killMock).not.toHaveBeenCalled();
      if (event === "cancellation") {
        supervisor.cancel("pending");
      } else {
        current = false;
      }
      release.resolve();
      if (event === "cancellation") {
        await expect((await pending).wait()).resolves.toMatchObject({ reason: "manual-cancel" });
      } else {
        await expect(pending).rejects.toThrow("execution authority revoked");
      }
      expect(fixture.spawn).toHaveBeenCalledOnce();
      expect(survivor.killMock).not.toHaveBeenCalled();
      survivor.settle(0);
      await active.wait();
      await cleanup();
      const valid = await supervisor.spawn(input);
      await expect(valid.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
      expect(fixture.spawn).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      survivor.settle(0);
      await Promise.allSettled([pending]);
      await supervisor.shutdown();
    }
  },
);

it("preserves half of inherited ceilings on both solid-state and rotational disks", async () => {
  fixture.files["/sys/dev/block/9:127/queue/rotational"] = "0\n";
  fixture.files["/sys/dev/block/8:0/queue/rotational"] = "1\n";
  fixture.files[`${root}/io.max`] =
    "9:127 rbps=1048576 wbps=max riops=200 wiops=max\n8:0 rbps=max wbps=131072 riops=max wiops=max";
  fixture.files["/sys/fs/cgroup/system.slice/io.max"] =
    "9:127 rbps=524288 wbps=524288 riops=max wiops=160";
  expect(await initializeGatewayExecCgroup("/state")).toContain("isolation active");
  expect(getAgentExecCgroup()).toBe(unscoped);
  expect(fixture.files[`${exec}/memory.high`]).toBe("max");
  expect(fixture.files[`${exec}/memory.max`]).toBeUndefined();
  expect(fixture.files[`${exec}/cpu.weight`]).toBe("10");
  const limits = fixture.write.mock.calls
    .filter(([file]) => file === `${exec}/io.max`)
    .map(([, line]) => {
      const [device, ...fields] = line.split(" ");
      return Object.assign({ device }, Object.fromEntries(fields.map((field) => field.split("="))));
    });
  expect(limits).toEqual([
    { device: "9:127", rbps: "262144", wbps: "262144", riops: "100", wiops: "80" },
    { device: "8:0", rbps: "524288", wbps: "65536", riops: "128", wiops: "128" },
  ]);
  expect(
    fixture.write.mock.calls.every(
      ([file]) => file === `${root}/cgroup.subtree_control` || file.startsWith(`${exec}/`),
    ),
  ).toBe(true);
});

it.each([2400 * MiB, 201828433920])(
  "gives each non-rotational disk 250 MiB/s and 40,960 IOPS independent of host RAM (%s bytes)",
  async (memory) => {
    vi.mocked(os.totalmem).mockReturnValue(memory);
    for (const device of fixture.devices) {
      fixture.files[`/sys/dev/block/${device}/queue/rotational`] = "0\n";
    }
    expect(await initializeGatewayExecCgroup("/state")).toContain("isolation active");
    expect(fixture.write.mock.calls.filter(([file]) => file === `${exec}/io.max`)).toEqual([
      [`${exec}/io.max`, "9:127 rbps=262144000 wbps=262144000 riops=40960 wiops=40960"],
      [`${exec}/io.max`, "8:0 rbps=262144000 wbps=262144000 riops=40960 wiops=40960"],
    ]);
  },
);

it.each(["missing controllers", "populated root", "denied IO policy"])(
  "keeps isolation inactive after %s without failing startup",
  async (failure) => {
    if (failure === "missing controllers") {
      fixture.files[`${root}/cgroup.controllers`] = "cpu memory";
    } else if (failure === "populated root") {
      fixture.files[`${root}/cgroup.procs`] = "123";
    } else {
      fixture.denied = `${exec}/io.max`;
    }
    expect(await initializeGatewayExecCgroup("/state")).toContain("isolation unavailable");
    expect(getAgentExecCgroup()).toBeUndefined();
    if (failure === "denied IO policy") {
      expect(fixture.files[`${exec}/memory.high`]).toBe("max");
    }
  },
);

it.each(["flat service", "foreign scope", "missing controllers", "unwritable", "unwritable leaf"])(
  "preserves IO and placement for %s while lifting an accessible legacy throttle",
  async (failure) => {
    fixture.files[`${exec}/memory.high`] = "1024";
    fixture.files[`${exec}/io.max`] = "9:127 rbps=1024 wbps=1024";
    fixture.files[`${root}/cgroup.subtree_control`] = "cpu io memory";
    if (failure === "flat service") {
      fixture.files["/proc/self/cgroup"] = "0::/system.slice/openclaw.service\n";
    } else if (failure === "foreign scope") {
      fixture.files["/proc/self/cgroup"] = "0::/system.slice/other.scope/gateway\n";
    } else if (failure === "missing controllers") {
      fixture.files[`${root}/cgroup.controllers`] = "cpu memory";
    } else if (failure === "unwritable") {
      fixture.writable = false;
    } else {
      fixture.denied = `${exec}/cgroup.procs`;
    }
    const before = { ...fixture.files };
    expect(await initializeGatewayExecCgroup("/state")).toContain("isolation unavailable");
    const lifted = failure !== "foreign scope" && failure !== "unwritable";
    expect(fixture.files).toEqual({
      ...before,
      ...(lifted ? { [`${exec}/memory.high`]: "max" } : {}),
    });
    expect(fixture.write.mock.calls).toEqual(
      failure === "foreign scope" ? [] : [[`${exec}/memory.high`, "max"]],
    );
    expect(fixture.mkdir).not.toHaveBeenCalled();
    expect(getAgentExecCgroup()).toBeUndefined();
  },
);

it("preserves working IO and helper placement when state-device resolution is unavailable", async () => {
  await initializeGatewayExecCgroup("/state");
  expect(getAgentExecCgroup()).toBe(unscoped);
  fixture.devices = [];
  expect(await initializeGatewayExecCgroup("/state")).toContain("isolation active");
  expect(getAgentExecCgroup()).toBe(unscoped);
});

it("discovers helper placement from its own delegated service and rechecks writability", async () => {
  expect(getAgentExecCgroup()).toBeUndefined();
  await initializeGatewayExecCgroup("/state");
  expect(getAgentExecCgroup()).toBe(unscoped);
  fixture.files["/proc/self/cgroup"] = "0::/system.slice/openclaw.service/agent-exec\n";
  expect(getAgentExecCgroup()).toBe(unscoped);
  fixture.writable = false;
  expect(getAgentExecCgroup()).toBeUndefined();
});

it("shares one half-budget across a session's commands and keeps other sessions separate", async () => {
  fixture.devices = ["9:127"];
  fixture.files["/sys/dev/block/9:127/queue/rotational"] = "0";
  await initializeGatewayExecCgroup("/state");
  const parentPolicy = fixture.files[`${exec}/io.max`];
  const first = getAgentExecCgroup("agent:main:first");
  expect(first).toMatch(new RegExp(`^${exec}/session-[a-f0-9]{32}$`));
  expect(getAgentExecCgroup(" agent:main:first ")).toBe(first);
  const second = getAgentExecCgroup("agent:main:second");
  expect(second).not.toBe(first);
  for (const directory of [first, second, getAgentExecCgroup()]) {
    expect(fixture.files[`${directory}/io.max`]).toBe(
      "9:127 rbps=131072000 wbps=131072000 riops=20480 wiops=20480",
    );
  }
  expect(fixture.files[`${exec}/io.max`]).toBe(parentPolicy);
  expect(fixture.files[`${exec}/cgroup.subtree_control`]).toBe("cpu io memory");
  fixture.files["/proc/self/cgroup"] = `0::${first!.slice("/sys/fs/cgroup".length)}\n`;
  expect(getAgentExecCgroup("agent:main:first")).toBe(first);
  const handle = { pid: 321 };
  expect(spawnInAgentExecCgroup(first, () => handle)).toBe(handle);
  expect(fixture.write).toHaveBeenLastCalledWith(`${root}/gateway/cgroup.procs`, "0");
});

it("keeps failed session policy setup inside the prepared shared budget", async () => {
  await initializeGatewayExecCgroup("/state");
  const session = getAgentExecCgroup("agent:main:first");
  fixture.denied = `${session}/io.max`;
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  expect(getAgentExecCgroup("agent:main:first")).toBe(unscoped);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("shared exec budget"));
});

it("retains a populated flat aggregate without changing or moving its commands", async () => {
  await initializeGatewayExecCgroup("/state");
  fixture.files[`${exec}/cgroup.subtree_control`] = "";
  fixture.files[`${exec}/cgroup.procs`] = "123";
  fixture.write.mockClear();
  expect(await initializeGatewayExecCgroup("/state")).toContain("shared sampler");
  expect(fixture.write).not.toHaveBeenCalled();
  expect(getAgentExecCgroup("agent:main:first")).toBe(exec);
});

it("preserves the spawned handle and reports a failed broker return to the Gateway leaf", () => {
  fixture.denied = `${root}/gateway/cgroup.procs`;
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  const handle = { pid: 321 };
  const spawn = vi.fn(() => handle);
  expect(spawnInAgentExecCgroup(exec, spawn)).toBe(handle);
  expect(spawn).toHaveBeenCalledOnce();
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("could not return"));
});

it("reports a legacy memory throttle that could not be removed while preserving IO", async () => {
  await initializeGatewayExecCgroup("/state");
  fixture.files[`${exec}/memory.high`] = "1024";
  fixture.denied = `${exec}/memory.high`;
  const diagnostic = await initializeGatewayExecCgroup("/state");
  expect(diagnostic).toContain("isolation active");
  expect(diagnostic).toContain("memory.high throttle could not be removed");
  expect(fixture.files[`${exec}/memory.high`]).toBe("1024");
  expect(getAgentExecCgroup()).toBe(unscoped);
});

it("keeps Gateway startup available when procfs placement facts cannot be read", async () => {
  delete fixture.files["/proc/self/cgroup"];
  expect(await initializeGatewayExecCgroup("/state")).toContain("sampled memory protection");
  expect(fixture.write).not.toHaveBeenCalled();
  expect(getAgentExecCgroup()).toBeUndefined();
});
