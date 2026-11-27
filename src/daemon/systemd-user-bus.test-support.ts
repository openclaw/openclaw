import { expect } from "vitest";
import type { ExecResult } from "./exec-file.js";

// Sanitized Debian 12 / systemd 252.39 operator replies (2026-09-12).
export const systemdOperatorBusFixtures = {
  stale: {
    address: "unix:path=/tmp/dbus-stale",
    getUnitFileState: "Call failed: Process org.freedesktop.systemd1 exited with status 1",
  },
  runtime: {
    address: "unix:path=$XDG_RUNTIME_DIR/bus",
    getUnitFileState: "Call failed: No such file or directory",
  },
} as const;

export async function systemdManagerVersionProbe(
  command: string,
  args: string[],
): Promise<ExecResult> {
  // Staging a unit reloads the manager so the next start uses it.
  if (command === "systemctl" && args.join(" ") === "--user daemon-reload") {
    return { code: 0, termination: "exit", stdout: "", stderr: "" };
  }
  expect(command).toBe("busctl");
  expect(args).toEqual([
    "--user",
    "--auto-start=no",
    "get-property",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "Version",
  ]);
  return { code: 0, termination: "exit", stdout: 's "252.39"', stderr: "" };
}
