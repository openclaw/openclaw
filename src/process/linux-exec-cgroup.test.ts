import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  getAgentExecCgroup,
  initializeGatewayExecCgroup,
  spawnInAgentExecCgroup,
} from "./linux-exec-cgroup.js";

const fixture = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  devices: ["9:127", "8:0"],
  denied: "",
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
      mkdirSync: () => undefined,
    },
  };
});
vi.mock("./linux-exec-cgroup-device.js", () => ({
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
  fixture.files = {
    "/proc/self/cgroup": "0::/system.slice/openclaw.service/gateway\n",
    [`${root}/cgroup.controllers`]: "cpu io memory pids\n",
    [`${root}/cgroup.procs`]: "",
  };
  fixture.write.mockImplementation((file, value) => {
    if (file === fixture.denied) {
      throw Object.assign(new Error("Read-only cgroup"), { code: "EROFS" });
    }
    fixture.files[file] = value;
  });
});
afterEach(() => {
  fixture.files["/proc/self/cgroup"] = "0::/\n";
  initializeGatewayExecCgroup("/state");
  vi.restoreAllMocks();
  fixture.write.mockReset();
});

it("divides the aggregate memory IO budget across disks and preserves half of inherited ceilings", () => {
  fixture.files[`${root}/io.max`] =
    "9:127 rbps=1048576 wbps=max riops=200 wiops=max\n8:0 rbps=max wbps=131072 riops=max wiops=max";
  fixture.files["/sys/fs/cgroup/system.slice/io.max"] =
    "9:127 rbps=524288 wbps=524288 riops=max wiops=160";
  expect(initializeGatewayExecCgroup("/state")).toContain("isolation active");
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

it.each(["missing controllers", "populated root", "denied IO policy"])(
  "keeps isolation inactive after %s without failing startup",
  (failure) => {
    if (failure === "missing controllers") {
      fixture.files[`${root}/cgroup.controllers`] = "cpu memory";
    } else if (failure === "populated root") {
      fixture.files[`${root}/cgroup.procs`] = "123";
    } else {
      fixture.denied = `${exec}/io.max`;
    }
    expect(initializeGatewayExecCgroup("/state")).toContain("isolation unavailable");
    expect(getAgentExecCgroup()).toBeUndefined();
    if (failure === "denied IO policy") {
      expect(fixture.files[`${exec}/memory.high`]).toBe("max");
    }
  },
);

it("preserves the spawned handle and reports a failed broker return to the Gateway leaf", () => {
  fixture.denied = `${root}/gateway/cgroup.procs`;
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  const handle = { pid: 321 };
  const spawn = vi.fn(() => handle);
  expect(spawnInAgentExecCgroup(exec, spawn)).toBe(handle);
  expect(spawn).toHaveBeenCalledOnce();
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("could not return"));
});
