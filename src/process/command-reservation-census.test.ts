import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findCommandReservationCandidates } from "./command-reservation-census.js";

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

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

  it.each([1_000, 4_294_967_294])("reads signed Darwin account rows for uid %i", (uid) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process, "getuid").mockReturnValue(uid);
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      pid: 900,
      output: [],
      stdout: "600 1 -2 S Sun Oct 25 19:58:03 2026\n700 600 1000 S Sun Oct 25 19:58:03 2026\n",
      stderr: "",
      status: 0,
      signal: null,
    });
    syncBuiltinESMExports();
    const reservedAtMs = Date.UTC(2026, 9, 25, 19, 58, 3);
    expect(findCommandReservationCandidates(reservedAtMs)).toEqual([uid === 1_000 ? 700 : 600]);
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
