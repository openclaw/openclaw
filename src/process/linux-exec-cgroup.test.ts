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
import { getAgentExecCgroup, spawnInAgentExecCgroup } from "./linux-exec-cgroup.js";
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
        writeFile: async (file: string, value: string) => fixture.write(file, value),
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
beforeEach(() => {
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
});
afterEach(async () => {
  fixture.files["/proc/self/cgroup"] = "0::/\n";
  await initializeGatewayExecCgroup("/state");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const mock of [fixture.write, fixture.mkdir, fixture.spawn]) {
    mock.mockReset();
  }
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
