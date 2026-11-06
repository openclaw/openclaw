import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { findCommandReservationCandidates } from "./command-reservation-census.js";

describe.skipIf(process.platform === "win32")("command reservation census", () => {
  it("names only same-account processes born at reservation time", async () => {
    const reservedAtMs = Date.now();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");
    try {
      expect(findCommandReservationCandidates(reservedAtMs)).toContain(child.pid);
      expect(findCommandReservationCandidates(reservedAtMs - 3_600_000)).not.toContain(child.pid);
      expect(findCommandReservationCandidates(reservedAtMs + 3_600_000)).not.toContain(child.pid);
      expect(findCommandReservationCandidates(reservedAtMs)).not.toContain(process.pid);
    } finally {
      child.kill("SIGKILL");
      await once(child, "close");
    }
  });
});
