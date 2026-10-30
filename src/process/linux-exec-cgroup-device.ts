import fs from "node:fs";
import path from "node:path";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { hasErrnoCode } from "../infra/errno.js";

function readDevice(file: string): string {
  const device = fs.readFileSync(file, "utf8").trim();
  if (!/^\d+:\d+$/u.test(device)) {
    throw new Error(`Invalid block device identity in ${file}`);
  }
  return device;
}

function wholeDevice(device: string): string {
  if (!/^\d+:\d+$/u.test(device)) {
    throw new Error("State mount has no block device identity");
  }
  let directory = fs.realpathSync(`/sys/dev/block/${device}`);
  try {
    fs.readFileSync(path.join(directory, "partition"), "utf8");
    // blkcg rejects partition device numbers. Keep md/dm disks at their logical
    // layer; descending into slaves would charge RAID IO at a different boundary.
    directory = path.dirname(directory);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  return readDevice(path.join(directory, "dev"));
}

function btrfsDevices(source: string): string[] {
  const stat = fs.statSync(source, { bigint: true });
  if (!stat.isBlockDevice()) {
    throw new Error("Btrfs state mount source is not a block device");
  }
  // Linux dev_t encoding; btrfs mountinfo's device can be a synthetic 0:* value.
  const major = ((stat.rdev >> 8n) & 0xfffn) | ((stat.rdev >> 32n) & 0xfffff000n);
  const minor = (stat.rdev & 0xffn) | ((stat.rdev >> 12n) & 0xffffff00n);
  const sourceDevice = `${major}:${minor}`;
  for (const name of fs.readdirSync("/sys/fs/btrfs")) {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(name)) {
      continue;
    }
    const directory = `/sys/fs/btrfs/${name}/devices`;
    const devices = fs
      .readdirSync(directory)
      .map((entry) => readDevice(`${directory}/${entry}/dev`));
    if (devices.includes(sourceDevice)) {
      return devices;
    }
  }
  throw new Error("Cannot identify every backing device of the btrfs state mount");
}

/** Resolve the opened state directory's mount, including bind and stacked mounts. */
export function resolveExecIoDevices(stateDir: string): string[] {
  const fd = fs.openSync(stateDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    const mountId = /^mnt_id:\s+(\d+)$/mu.exec(
      fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"),
    )?.[1];
    const fields = fs
      .readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .find((line) => mountId && line.startsWith(`${mountId} `))
      ?.split(" ");
    const boundary = fields?.indexOf("-") ?? -1;
    const device = fields?.[2];
    const type = fields?.[boundary + 1];
    const source = fields?.[boundary + 2];
    if (boundary < 6 || !device || !type || !source) {
      throw new Error("Cannot identify the state directory's mounted filesystem");
    }
    if (type !== "btrfs" && device.startsWith("0:")) {
      throw new Error(`State filesystem ${type} has no block device for IO throttling`);
    }
    const devices = type === "btrfs" ? btrfsDevices(decodeMountInfoPath(source)) : [device];
    return [...new Set(devices.map(wholeDevice))].toSorted();
  } finally {
    fs.closeSync(fd);
  }
}
