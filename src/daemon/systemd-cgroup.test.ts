import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isSystemdControlGroupEmpty } from "./systemd-cgroup.js";

const CGROUP2 = 0x63677270;
const CGROUP1 = 0x27e0eb;
const dirs = useAutoCleanupTempDirTracker(afterEach);
const group = "/system.slice/openclaw-gateway.service";
const statfs = fs.statfsSync;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A cgroup tree in a temp directory whose mounts report the given filesystem types. */
function cgroupTree(mounts: Record<string, number>, files: Record<string, string>) {
  const root = dirs.make("systemd-cgroup-");
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }
  vi.spyOn(fs, "statfsSync").mockImplementation(((dir: string) => {
    const relative = path.relative(root, dir);
    const type = mounts[relative === "" ? "." : relative];
    return type === undefined ? statfs(dir) : Object.assign(statfs(root), { type });
  }) as typeof fs.statfsSync);
  return root;
}

describe("systemd unit cgroup emptiness", () => {
  it.each<{ name: string; mounts: Record<string, number>; base: string }>([
    { name: "unified", mounts: { ".": CGROUP2 }, base: "" },
    { name: "hybrid", mounts: { unified: CGROUP2 }, base: "unified" },
  ])("reads the unit's population on a $name hierarchy", ({ mounts, base }) => {
    const populated = cgroupTree(mounts, {
      [path.join(base, group, "cgroup.events")]: "populated 1\nfrozen 0\n",
    });
    expect(isSystemdControlGroupEmpty(group, populated)).toBe(false);

    const empty = cgroupTree(mounts, {
      [path.join(base, group, "cgroup.events")]: "populated 0\nfrozen 0\n",
    });
    expect(isSystemdControlGroupEmpty(group, empty)).toBe(true);

    // systemd removes the group once nothing is left in it.
    expect(isSystemdControlGroupEmpty(group, cgroupTree(mounts, {}))).toBe(true);
  });

  it("counts processes in descendant groups on a legacy hierarchy", () => {
    const survivor = cgroupTree(
      { systemd: CGROUP1 },
      {
        [path.join("systemd", group, "cgroup.procs")]: "",
        [path.join("systemd", group, "child", "cgroup.procs")]: "4242\n",
      },
    );
    expect(isSystemdControlGroupEmpty(group, survivor)).toBe(false);

    const empty = cgroupTree(
      { systemd: CGROUP1 },
      { [path.join("systemd", group, "cgroup.procs")]: "" },
    );
    expect(isSystemdControlGroupEmpty(group, empty)).toBe(true);
    expect(isSystemdControlGroupEmpty(group, cgroupTree({ systemd: CGROUP1 }, {}))).toBe(true);
  });

  it("refuses to call a missing group empty outside a hierarchy systemd tracks units in", () => {
    // A legacy controller mount without the named systemd hierarchy, as on a hybrid host
    // whose unified mount is missing.
    const root = cgroupTree({ memory: CGROUP1 }, {});
    expect(() => isSystemdControlGroupEmpty(group, root)).toThrow(/cannot be verified/u);
  });

  it("rejects group paths that leave the hierarchy", () => {
    const root = cgroupTree({ ".": CGROUP2 }, {});
    for (const unsafe of ["", "/", "relative", "/system.slice/../x", "/a//b"]) {
      expect(() => isSystemdControlGroupEmpty(unsafe, root)).toThrow(/cannot be verified/u);
    }
  });
});
