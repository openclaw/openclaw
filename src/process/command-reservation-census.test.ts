import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { findCommandReservationCandidates } from "./command-reservation-census.js";

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

  it("filters Darwin census rows at the reservation boundary, including signed UIDs", () => {
    const reservedAtMs = Date.UTC(2026, 9, 25, 19, 58, 3);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(4_294_967_294);
    const census = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      pid: 604,
      status: 0,
      signal: null,
      output: [],
      stderr: "",
      stdout: [
        "600 1 -2 S Sun Oct 25 19:58:03 2026",
        "601 1 501 S Sun Oct 25 19:58:03 2026",
        "602 1 -2 S Sun Oct 25 18:58:03 2026",
        "603 1 -2 S unreadable-start-time",
        "604 1 -2 S Sun Oct 25 19:58:03 2026",
        `${process.pid} 1 -2 S Sun Oct 25 19:58:03 2026`,
        `605 ${process.pid} -2 S Sun Oct 25 19:58:03 2026`,
        "",
      ].join("\n"),
    });
    syncBuiltinESMExports();
    try {
      expect(findCommandReservationCandidates(reservedAtMs)).toEqual([600, 603]);
      census.mockReturnValueOnce({
        pid: 604,
        status: 0,
        signal: null,
        output: [],
        stderr: "",
        stdout: "unreadable-row",
      });
      expect(() => findCommandReservationCandidates(reservedAtMs)).toThrow(
        "Darwin process census is unreadable",
      );
      census.mockReturnValueOnce({
        pid: 604,
        status: 1,
        signal: null,
        output: [],
        stderr: "unavailable",
        stdout: "",
      });
      expect(() => findCommandReservationCandidates(reservedAtMs)).toThrow(
        "Darwin process census is unavailable",
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
      census.mockRestore();
      syncBuiltinESMExports();
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
