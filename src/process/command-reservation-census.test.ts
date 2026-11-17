import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  findCommandReservationCandidates,
  parseDarwinProcessBirths,
} from "./command-reservation-census.js";

// Orphaned by its shell, like a command whose killed spawner never bound it.
async function spawnOrphan(): Promise<number> {
  const shell = spawn(
    "/bin/sh",
    ["-c", `${process.execPath} -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 & echo $!`],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const [output] = (await once(shell.stdout, "data")) as [Buffer];
  await once(shell, "close");
  return Number(output.toString().trim());
}

describe.skipIf(process.platform === "win32")("command reservation census", () => {
  it("names only same-account processes born at reservation time", async () => {
    const reservedAtMs = Date.now();
    const orphan = await spawnOrphan();
    // This process's own workers are not candidates, even when born in the window.
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(worker, "spawn");
    try {
      const candidates = findCommandReservationCandidates(reservedAtMs);
      expect(candidates).toContain(orphan);
      expect(candidates).not.toContain(worker.pid);
      expect(candidates).not.toContain(process.pid);
      expect(findCommandReservationCandidates(reservedAtMs - 3_600_000)).not.toContain(orphan);
      expect(findCommandReservationCandidates(reservedAtMs + 3_600_000)).not.toContain(orphan);
    } finally {
      process.kill(orphan, "SIGKILL");
      worker.kill("SIGKILL");
      await once(worker, "close");
    }
  });

  it("reads Darwin rows for accounts printed as a negative uid", () => {
    const uid = process.getuid?.();
    expect(
      parseDarwinProcessBirths(
        `  600     1    -2 S    Sun Oct 25 19:58:03 2026    \n  700   600 ${uid} Z+   Sun Oct 25 19:58:03 2026\n`,
      ),
    ).toEqual([{ pid: 700, ppid: 600, bornAtMs: Date.UTC(2026, 9, 25, 19, 58, 3), zombie: true }]);

    // Running as nobody itself: Node reports the unsigned uid.
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(4_294_967_294);
    try {
      expect(
        parseDarwinProcessBirths("  600     1    -2 S    Sun Oct 25 19:58:03 2026\n"),
      ).toMatchObject([{ pid: 600 }]);
    } finally {
      getuid.mockRestore();
    }
  });

  it("keeps orphans a settling init adopted", async () => {
    const reservedAtMs = Date.now();
    const orphan = await spawnOrphan();
    const pid = Object.getOwnPropertyDescriptor(process, "pid")!;
    Object.defineProperty(process, "pid", { ...pid, value: 1 });
    try {
      expect(findCommandReservationCandidates(reservedAtMs)).toContain(orphan);
    } finally {
      Object.defineProperty(process, "pid", pid);
      process.kill(orphan, "SIGKILL");
    }
  });
});
