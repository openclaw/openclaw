import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { isSystemdUserServiceAvailable, isSystemdServiceEnabled } from "./systemd.js";

describe("systemd availability", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("returns true when systemctl --user succeeds", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, "", "");
    });
    await expect(isSystemdUserServiceAvailable()).resolves.toBe(true);
  });

  it("returns false when systemd user bus is unavailable", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error("Failed to connect to bus") as Error & {
        stderr?: string;
        code?: number;
      };
      err.stderr = "Failed to connect to bus";
      err.code = 1;
      cb(err, "", "");
    });
    await expect(isSystemdUserServiceAvailable()).resolves.toBe(false);
  });
});

describe("isSystemdServiceEnabled", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("returns false when DBUS env vars are missing", async () => {
    // Simulate the error when $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR are not set
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error(
        "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
      ) as Error & {
        stderr?: string;
        code?: number;
      };
      err.stderr =
        "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined";
      err.code = 1;
      cb(err, "", "");
    });
    // Should gracefully return false instead of throwing
    await expect(isSystemdServiceEnabled({ env: {} })).resolves.toBe(false);
  });

  it("returns true when service is enabled", async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      callCount++;
      if (callCount === 1) {
        // First call: systemctl --user status (availability check)
        cb(null, "", "");
      } else {
        // Second call: systemctl --user is-enabled
        cb(null, "enabled", "");
      }
    });
    await expect(isSystemdServiceEnabled({ env: {} })).resolves.toBe(true);
  });

  it("returns false when service is not enabled", async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      callCount++;
      if (callCount === 1) {
        // First call: systemctl --user status (availability check)
        cb(null, "", "");
      } else {
        // Second call: systemctl --user is-enabled returns non-zero for disabled
        const err = new Error("disabled") as Error & { code?: number };
        err.code = 1;
        cb(err, "", "");
      }
    });
    await expect(isSystemdServiceEnabled({ env: {} })).resolves.toBe(false);
  });
});
