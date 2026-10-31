import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { initializeGatewayExecCgroup } from "./linux-exec-cgroup-startup.js";
import { getAgentExecCgroup, spawnInAgentExecCgroup } from "./linux-exec-cgroup.js";

const fixture = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  devices: ["9:127", "8:0"],
  denied: "",
  writable: true,
  mkdir: vi.fn(),
  write: vi.fn<(file: string, value: string) => void>(),
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

const root = "/sys/fs/cgroup/system.slice/openclaw.service";
const exec = `${root}/agent-exec`;
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
    if (file === fixture.denied) {
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
  for (const mock of [fixture.write, fixture.mkdir]) {
    mock.mockReset();
  }
});

it("preserves half of inherited ceilings on both solid-state and rotational disks", async () => {
  fixture.files["/sys/dev/block/9:127/queue/rotational"] = "0\n";
  fixture.files["/sys/dev/block/8:0/queue/rotational"] = "1\n";
  fixture.files[`${root}/io.max`] =
    "9:127 rbps=1048576 wbps=max riops=200 wiops=max\n8:0 rbps=max wbps=131072 riops=max wiops=max";
  fixture.files["/sys/fs/cgroup/system.slice/io.max"] =
    "9:127 rbps=524288 wbps=524288 riops=max wiops=160";
  expect(await initializeGatewayExecCgroup("/state")).toContain("isolation active");
  expect(getAgentExecCgroup()).toBe(exec);
  expect(fixture.files[`${exec}/memory.high`]).toBe("629145600");
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
  "gives each non-rotational disk its own IO ceiling independent of host RAM (%s bytes)",
  async (memory) => {
    vi.mocked(os.totalmem).mockReturnValue(memory);
    for (const device of fixture.devices) {
      fixture.files[`/sys/dev/block/${device}/queue/rotational`] = "0\n";
    }
    expect(await initializeGatewayExecCgroup("/state")).toContain("isolation active");
    expect(fixture.write.mock.calls.filter(([file]) => file.endsWith("/io.max"))).toEqual([
      [`${exec}/io.max`, "9:127 rbps=167772160 wbps=167772160 riops=40960 wiops=40960"],
      [`${exec}/io.max`, "8:0 rbps=167772160 wbps=167772160 riops=40960 wiops=40960"],
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
  "leaves every cgroup unchanged for %s, even with an earlier kernel policy",
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
    expect(fixture.files).toEqual(before);
    expect(fixture.write).not.toHaveBeenCalled();
    expect(fixture.mkdir).not.toHaveBeenCalled();
    expect(getAgentExecCgroup()).toBeUndefined();
  },
);

it("does not discover an earlier policy after state-device resolution fails", async () => {
  await initializeGatewayExecCgroup("/state");
  expect(getAgentExecCgroup()).toBe(exec);
  fixture.devices = [];
  expect(await initializeGatewayExecCgroup("/state")).toContain("isolation unavailable");
  expect(getAgentExecCgroup()).toBeUndefined();
});

it("discovers helper placement from its own delegated service and rechecks writability", async () => {
  expect(getAgentExecCgroup()).toBeUndefined();
  await initializeGatewayExecCgroup("/state");
  expect(getAgentExecCgroup()).toBe(exec);
  fixture.files["/proc/self/cgroup"] = "0::/system.slice/openclaw.service/agent-exec\n";
  expect(getAgentExecCgroup()).toBe(exec);
  fixture.writable = false;
  expect(getAgentExecCgroup()).toBeUndefined();
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
