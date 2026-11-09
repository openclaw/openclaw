import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createHostIoPressureProbe } from "./host-io-pressure.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function kernelFixture() {
  const root = roots.make("host-io-pressure-");
  const volume = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const btrfs = path.join(root, "sys/fs/btrfs");
  const stats = path.join(btrfs, volume, "commit_stats");
  const psi = path.join(root, "proc/pressure/io");
  await fs.mkdir(path.dirname(stats), { recursive: true });
  await fs.mkdir(path.dirname(psi), { recursive: true });
  const open = fs.open.bind(fs);
  const readdir = fs.readdir.bind(fs);
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(fs, "open").mockImplementation((target, flags, mode) =>
    open(path.join(root, String(target)), flags, mode),
  );
  vi.spyOn(fs, "readdir").mockImplementation((_target, options) => readdir(btrfs, options));
  return {
    probe: createHostIoPressureProbe(),
    psi: (some: number, full: number) =>
      fs.writeFile(psi, `some avg10=${some} avg60=0.00 total=42\nfull avg10=${full} total=0\n`),
    stats: (commits: number, total: number, last: number, current = 0) =>
      fs.writeFile(
        stats,
        `commits ${commits}\nlast_commit_ms ${last}\nmax_commit_ms 15000\ntotal_commit_ms ${total}\ncur_commit_ms ${current}\n`,
      ),
  };
}

it("backs off for IO stalls, then resumes when recent pressure clears", async () => {
  const fixture = await kernelFixture();
  await fixture.stats(100, 5000, 2);
  for (const [some, full, expected] of [
    [10, 0, true],
    [0, 1, true],
    [0.01, 0, false],
  ] as const) {
    await fixture.psi(some, full);
    expect(await fixture.probe()).toBe(expected);
  }
});

it("uses fresh and in-progress btrfs commits without retaining historical pressure", async () => {
  const fixture = await kernelFixture();
  await fixture.psi(0, 0);
  await fixture.stats(100, 20000, 8000);
  expect(await fixture.probe()).toBe(true);
  expect(await fixture.probe()).toBe(false);
  await fixture.stats(102, 24000, 2);
  expect(await fixture.probe()).toBe(true);
  await fixture.stats(103, 24002, 2);
  expect(await fixture.probe()).toBe(false);
  await fixture.stats(103, 24002, 2, 1500);
  expect(await fixture.probe()).toBe(true);
  await fixture.stats(1, 2, 2);
  expect(await fixture.probe()).toBe(false);
});

it("keeps paced cleanup available without Linux counters", async () => {
  const fixture = await kernelFixture();
  expect(await fixture.probe()).toBe(false);
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  expect(await fixture.probe()).toBe(false);
});
