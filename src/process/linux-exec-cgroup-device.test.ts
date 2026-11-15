import { afterEach, expect, it, vi } from "vitest";
import { resolveExecIoDevices } from "./linux-exec-cgroup-device.js";

const fixture = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  directories: {} as Record<string, string[]>,
  links: {} as Record<string, string>,
  sourceDevice: 0n,
  closed: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const missing = (file: string): never => {
    throw Object.assign(new Error(`Missing ${file}`), { code: "ENOENT" });
  };
  return {
    ...original,
    default: {
      ...original,
      openSync: () => 42,
      closeSync: fixture.closed,
      readFileSync: (file: string) => fixture.files[file] ?? missing(file),
      realpathSync: (file: string) => fixture.links[file] ?? missing(file),
      readdirSync: (file: string) => fixture.directories[file] ?? missing(file),
      statSync: () => ({ rdev: fixture.sourceDevice, isBlockDevice: () => true }),
    },
  };
});
afterEach(() => {
  fixture.files = {};
  fixture.directories = {};
  fixture.links = {};
  fixture.closed.mockClear();
});

function mount(type: string, device: string, source: string) {
  fixture.files["/proc/self/fdinfo/42"] = "pos:\t0\nmnt_id:\t25\n";
  fixture.files["/proc/self/mountinfo"] =
    `24 1 8:0 / /state rw - ext4 /dev/sda rw\n` +
    `25 24 ${device} /subvolume /state rw shared:1 - ${type} ${source} rw\n`;
}
function block(device: string, location: string, parent?: string) {
  fixture.links[`/sys/dev/block/${device}`] = `/sys/devices/${location}`;
  fixture.files[`/sys/devices/${location}/dev`] = device;
  if (parent) {
    fixture.files[`/sys/devices/${location}/partition`] = "1";
    fixture.files[`/sys/devices/${location.slice(0, location.lastIndexOf("/"))}/dev`] = parent;
  }
}

it.each([
  ["9:127", "md127", undefined, "9:127"],
  ["253:0", "dm-0", undefined, "253:0"],
  ["259:2", "nvme0n1/nvme0n1p2", "259:0", "259:0"],
] as const)(
  "selects the open mount and keeps the logical whole disk %s",
  (device, location, parent, want) => {
    mount("ext4", device, `/dev/${location.split("/").at(-1)}`);
    block(device, location, parent);
    expect(resolveExecIoDevices("/state")).toEqual([want]);
    expect(fixture.closed).toHaveBeenCalledExactlyOnceWith(42);
  },
);

it("resolves every btrfs member from the source device, retaining md and deduplicating partitions", () => {
  mount("btrfs", "0:38", "/dev/md127");
  fixture.sourceDevice = (9n << 8n) | 127n;
  const directory = "/sys/fs/btrfs/12345678-1234-1234-1234-123456789abc/devices";
  fixture.directories["/sys/fs/btrfs"] = ["features", "12345678-1234-1234-1234-123456789abc"];
  fixture.directories[directory] = ["md127", "vda1", "vda2"];
  for (const [name, device] of [
    ["md127", "9:127"],
    ["vda1", "252:1"],
    ["vda2", "252:2"],
  ] as const) {
    fixture.files[`${directory}/${name}/dev`] = device;
    block(device, name === "md127" ? name : `vda/${name}`, name === "md127" ? undefined : "252:0");
  }
  expect(resolveExecIoDevices("/state")).toEqual(["252:0", "9:127"]);
});

it.each(["overlay", "tmpfs"])("does not invent a block device for %s", (type) => {
  mount(type, "0:38", type);
  expect(() => resolveExecIoDevices("/state")).toThrow("has no block device for IO throttling");
  expect(fixture.closed).toHaveBeenCalledExactlyOnceWith(42);
});
