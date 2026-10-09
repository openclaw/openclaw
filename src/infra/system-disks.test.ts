import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  platform: vi.fn(() => "linux"),
  readFile: vi.fn(),
  stat: vi.fn(),
  statfs: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, platform: mocks.platform } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: { ...actual, readFile: mocks.readFile, stat: mocks.stat, statfs: mocks.statfs },
  };
});
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: mocks.runCommandWithTimeout }));

describe("system disk snapshots", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.platform.mockReturnValue("linux");
    mocks.statfs.mockResolvedValue({ blocks: 2000n, frsize: 1024n, bavail: 1000n });
  });
  afterEach(() => vi.useRealTimers());

  it("reports distinct Linux storage mounts without EFI, bind aliases, memory or image filesystems", async () => {
    mocks.readFile.mockResolvedValue(
      [
        "1 0 8:1 / / rw - ext4 /dev/sda1 rw",
        "2 1 8:2 /work /srv/bind rw - xfs /dev/sdb1 rw",
        "3 1 8:2 / /mnt/data\\040disk rw - xfs /dev/sdb1 rw",
        "4 1 0:1 / /run rw - tmpfs tmpfs rw",
        "5 1 7:0 / /snap/package ro - squashfs /dev/loop0 ro",
        "6 1 0:2 / /tank rw - zfs tank rw",
        "7 1 8:3 / /boot/efi rw - vfat /dev/sda3 rw",
        "8 1 8:4 / /efi rw - vfat /dev/sda4 rw",
        "9 1 8:5 / /mnt/efi-data rw - vfat /dev/sdc1 rw",
        "10 1 8:6 / /boot rw - ext4 /dev/sda6 rw",
      ].join("\n"),
    );
    const { readSystemDisks } = await import("./system-disks.js");
    expect(await readSystemDisks()).toEqual([
      { path: "/", totalBytes: 2_048_000, availableBytes: 1_024_000 },
      { path: "/boot", totalBytes: 2_048_000, availableBytes: 1_024_000 },
      { path: "/mnt/data disk", totalBytes: 2_048_000, availableBytes: 1_024_000 },
      { path: "/mnt/efi-data", totalBytes: 2_048_000, availableBytes: 1_024_000 },
      { path: "/tank", totalBytes: 2_048_000, availableBytes: 1_024_000 },
    ]);
    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it.each(["removed", "remaining"])(
    "keeps one container root when a volume disappears with its directory %s",
    async (directory) => {
      mocks.readFile
        .mockResolvedValueOnce(
          "1 0 0:5 / / rw - overlay overlay rw\n2 1 8:1 / /data rw - ext4 /dev/sdb rw",
        )
        .mockResolvedValue("1 0 0:5 / / rw - overlay overlay rw");
      mocks.statfs.mockImplementation(async (path: string) => {
        if (path === "/data" && directory === "removed") {
          throw new Error("ENOENT");
        }
        return { blocks: 2000n, frsize: 1024n, bavail: -1n };
      });
      const { readSystemDisks } = await import("./system-disks.js");
      expect(await readSystemDisks()).toEqual([
        { path: "/", totalBytes: 2_048_000, availableBytes: 0 },
      ]);
    },
  );

  it.each(["tmpfs tmpfs", "nfs server:/root", "nfs4 server:/root"])(
    "excludes a non-local Linux root (%s) without hiding local data disks",
    async (filesystem) => {
      mocks.readFile.mockResolvedValue(
        `1 0 0:5 / / rw - ${filesystem} rw\n2 1 8:1 / /data rw - ext4 /dev/sdb rw`,
      );
      const { readSystemDisks } = await import("./system-disks.js");
      expect((await readSystemDisks())?.map((disk) => disk.path)).toEqual(["/data"]);
    },
  );

  it.each([
    {
      name: "stacked local mounts and their separate bind aliases",
      mounts: [
        "7 90 8:4 / /data rw - xfs /dev/upper rw",
        "4 7 8:5 / /data/visible rw - ext4 /dev/visible rw",
        "1 0 8:1 / / rw - ext4 /dev/root rw",
        "90 1 8:2 / /data rw - ext4 /dev/lower rw",
        "80 90 8:3 / /data/hidden rw - ext4 /dev/hidden rw",
        "6 1 8:2 / /archive rw - ext4 /dev/lower rw",
      ],
      paths: ["/", "/archive", "/data", "/data/visible"],
    },
    {
      name: "a non-local mount covering a local mount and its children",
      mounts: [
        "4 7 8:5 / /data/visible rw - ext4 /dev/visible rw",
        "7 90 0:9 / /data rw - tmpfs tmpfs rw",
        "90 1 8:2 / /data rw - ext4 /dev/lower rw",
        "1 0 8:1 / / rw - ext4 /dev/root rw",
        "80 90 8:3 / /data/hidden rw - ext4 /dev/hidden rw",
      ],
      paths: ["/", "/data/visible"],
    },
    {
      name: "a mount covering an ordinary directory with an older nested mount",
      mounts: [
        "80 1 8:3 / /data/hidden rw - ext4 /dev/hidden rw",
        "7 1 0:9 / /data rw - tmpfs tmpfs rw",
        "4 7 8:5 / /data/visible rw - ext4 /dev/visible rw",
        "6 1 8:6 / /data2 rw - ext4 /dev/sibling rw",
        "1 0 8:1 / / rw - ext4 /dev/root rw",
      ],
      paths: ["/", "/data/visible", "/data2"],
    },
  ])("samples only accessible filesystems under $name", async ({ mounts, paths }) => {
    mocks.readFile.mockResolvedValue(mounts.join("\n"));
    const { readSystemDisks } = await import("./system-disks.js");
    expect((await readSystemDisks())?.map((disk) => disk.path)).toEqual(paths);
    expect(
      mocks.statfs.mock.calls
        .map(([path]) => path)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(paths);
  });

  it("keeps macOS root and browsable volumes without duplicating hidden APFS volumes", async () => {
    mocks.platform.mockReturnValue("darwin");
    mocks.stat.mockImplementation(async (path: string) => ({
      dev: path === "/" ? 3n : 2n,
      rdev: path === "/dev/disk3s1s1" ? 1n : 2n,
    }));
    mocks.runCommandWithTimeout.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
        "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, root data)",
        "/dev/disk3s6 on /System/Volumes/VM (apfs, local, nobrowse)",
        "/dev/disk7s1 on /Volumes/Data Disk (apfs, local, nodev, nosuid)",
        "devfs on /dev (devfs, local, nobrowse)",
        "server:/share on /Volumes/Network (nfs)",
      ].join("\n"),
    });
    const { readSystemDisks } = await import("./system-disks.js");
    expect((await readSystemDisks())?.map((disk) => disk.path)).toEqual([
      "/",
      "/Volumes/Data Disk",
    ]);
  });

  it.each([
    [[{ Path: "C:\\", Capacity: 1000, FreeSpace: 200 }], ["C:\\"]],
    [
      [
        { Path: "C:\\", Capacity: 1000, FreeSpace: 200 },
        { Path: "C:\\Data\\", Capacity: 2000, FreeSpace: 1500 },
        { Path: "E:\\", Capacity: null, FreeSpace: null },
      ],
      ["C:\\", "C:\\Data\\"],
    ],
  ])("reports ready Windows volumes including folder-mounted storage: %j", async (rows, paths) => {
    mocks.platform.mockReturnValue("win32");
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify(rows.length === 1 ? rows[0] : rows),
    });
    const { readSystemDisks } = await import("./system-disks.js");
    expect((await readSystemDisks())?.map((disk) => disk.path)).toEqual(paths);
  });

  it("shares in-flight probes and refreshes mount membership after the sample expires", async () => {
    vi.useFakeTimers();
    mocks.readFile.mockResolvedValue("1 0 8:1 / / rw - ext4 /dev/sda1 rw");
    const { readSystemDisks } = await import("./system-disks.js");
    const pending = readSystemDisks();
    expect(readSystemDisks()).toBe(pending);
    await pending;
    mocks.readFile.mockResolvedValue(
      "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 8:2 / /data rw - xfs /dev/sdb1 rw",
    );
    expect(await readSystemDisks()).toHaveLength(1);
    vi.advanceTimersByTime(29_999);
    expect(await readSystemDisks()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(await readSystemDisks()).toHaveLength(2);
  });

  it("returns unavailable on probe failure and recovers on the next sample", async () => {
    vi.useFakeTimers();
    mocks.readFile.mockRejectedValueOnce(new Error("unavailable"));
    const { readSystemDisks } = await import("./system-disks.js");
    expect(await readSystemDisks()).toBeUndefined();
    mocks.readFile.mockResolvedValue("1 0 8:1 / / rw - ext4 /dev/sda1 rw");
    vi.advanceTimersByTime(30_001);
    expect(await readSystemDisks()).toHaveLength(1);
  });

  it("returns unavailable when every filesystem probe fails", async () => {
    mocks.readFile.mockResolvedValue(
      "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 8:2 / /data rw - xfs /dev/sdb1 rw",
    );
    mocks.statfs.mockRejectedValue(new Error("unavailable"));
    const { readSystemDisks } = await import("./system-disks.js");
    expect(await readSystemDisks()).toBeUndefined();
  });

  it.each([
    { blocks: 500n, frsize: 4096n, bavail: 250n, df: "/dev/disk 2000 800 1000 45% /" },
    { blocks: 5n, frsize: 512n, bavail: 1n, df: "/dev/disk 3 2 1 67% /" },
    { blocks: 500n, frsize: 4096n, bavail: -1n, df: "/dev/disk 2000 2004 -4 101% /" },
    {
      blocks: 500n,
      frsize: 4096n,
      bavail: 0xffffffffffffffffn,
      df: "/dev/disk 2000 2004 -4 101% /",
    },
  ])(
    "matches df -kP byte values for $df without spawning",
    async ({ blocks, frsize, bavail, df }) => {
      mocks.readFile.mockResolvedValue("1 0 8:1 / / rw - ext4 /dev/sda1 rw");
      mocks.statfs.mockResolvedValue({
        blocks,
        frsize,
        bavail,
        bsize: 65536n,
        bfree: bavail + 20n,
      });
      const fields = df.split(" ");
      const { readSystemDisks } = await import("./system-disks.js");
      expect(await readSystemDisks()).toEqual([
        {
          path: "/",
          totalBytes: Number(fields[1]) * 1024,
          availableBytes: Math.max(0, Number(fields[3]) * 1024),
        },
      ]);
      expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    },
  );

  it("keeps completed disks when another filesystem probe hangs", async () => {
    vi.useFakeTimers();
    mocks.readFile.mockResolvedValue(
      "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 8:2 / /data rw - xfs /dev/sdb1 rw",
    );
    mocks.statfs.mockImplementation(async (path: string) =>
      path === "/data" ? new Promise(() => {}) : { blocks: 2000n, frsize: 1024n, bavail: 1000n },
    );
    const { readSystemDisks } = await import("./system-disks.js");
    const pending = readSystemDisks();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual([
      { path: "/", totalBytes: 2_048_000, availableBytes: 1_024_000 },
    ]);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await readSystemDisks()).toBeUndefined();
    expect(mocks.statfs).toHaveBeenCalledTimes(2);
  });

  it("omits a volume replaced at the same path while reading its filesystem", async () => {
    mocks.readFile
      .mockResolvedValueOnce("1 0 8:1 / /data rw - ext4 /dev/sda1 rw")
      .mockResolvedValue("2 0 8:1 / /data rw - ext4 /dev/sda1 rw");
    const { readSystemDisks } = await import("./system-disks.js");
    expect(await readSystemDisks()).toEqual([]);
  });

  it("keeps Btrfs subvolumes whose stat device differs from mountinfo", async () => {
    mocks.readFile.mockResolvedValue("1 0 0:39 /@ / rw - btrfs /dev/sda2 rw");
    mocks.stat.mockResolvedValue({ dev: 44n });
    const { readSystemDisks } = await import("./system-disks.js");
    expect(await readSystemDisks()).toEqual([
      { path: "/", totalBytes: 2_048_000, availableBytes: 1_024_000 },
    ]);
  });

  it("bounds native work across cache refreshes while a filesystem remains blocked", async () => {
    vi.useFakeTimers();
    mocks.readFile.mockResolvedValue(
      [
        "1 0 8:1 / / rw - ext4 /dev/sda1 rw",
        "2 1 8:2 / /a rw - ext4 /dev/sdb rw",
        "3 1 8:3 / /b rw - ext4 /dev/sdc rw",
        "4 1 8:4 / /c rw - ext4 /dev/sdd rw",
      ].join("\n"),
    );
    const blocked = createDeferred<{ blocks: bigint; frsize: bigint; bavail: bigint }>();
    mocks.statfs.mockReturnValue(blocked.promise);
    const { readSystemDisks } = await import("./system-disks.js");
    for (let refresh = 0; refresh < 3; refresh++) {
      const pending = readSystemDisks();
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toBeUndefined();
      expect(mocks.statfs).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_001);
    }
    blocked.resolve({ blocks: 2000n, frsize: 1024n, bavail: 1000n });
    await vi.advanceTimersByTimeAsync(0);
    mocks.readFile.mockResolvedValue("5 0 8:1 / /fresh rw - ext4 /dev/sda1 rw");
    expect(await readSystemDisks()).toEqual([
      { path: "/fresh", totalBytes: 2_048_000, availableBytes: 1_024_000 },
    ]);
  });

  it("bounds the response when post-probe mount validation remains blocked", async () => {
    vi.useFakeTimers();
    mocks.readFile
      .mockResolvedValueOnce("1 0 8:1 / / rw - ext4 /dev/sda1 rw")
      .mockReturnValue(new Promise(() => {}));
    const { readSystemDisks } = await import("./system-disks.js");
    let settled = false;
    const pending = readSystemDisks().then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBe(true);
    expect(await pending).toBeUndefined();
  });
});
