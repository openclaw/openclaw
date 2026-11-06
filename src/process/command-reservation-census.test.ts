import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { findCommandReservationCandidates } from "./command-reservation-census.js";

describe.skipIf(process.platform === "win32")("command reservation census", () => {
  it("names only same-account processes born at reservation time", async () => {
    const reservedAtMs = Date.now();
    // Orphaned by its shell, like a command whose killed spawner never bound it.
    const shell = spawn(
      "/bin/sh",
      ["-c", `${process.execPath} -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 & echo $!`],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const [output] = (await once(shell.stdout, "data")) as [Buffer];
    const orphan = Number(output.toString().trim());
    await once(shell, "close");
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
});
