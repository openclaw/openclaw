import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  checkSystemdUserEnvPreflight,
  checkSystemdUserServiceAvailable,
  isSystemdUserServiceAvailable,
} from "./systemd.js";

describe("systemd availability", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    // Set required env vars for tests that need systemctl to work
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("returns false when XDG_RUNTIME_DIR is missing", async () => {
    // Pass explicit env without XDG_RUNTIME_DIR to test preflight validation
    const result = await checkSystemdUserServiceAvailable({
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    expect(result.available).toBe(false);
    expect(result.missingEnvVars).toContain("XDG_RUNTIME_DIR");
  });

  it("returns false when DBUS_SESSION_BUS_ADDRESS is missing", async () => {
    // Pass explicit env without DBUS_SESSION_BUS_ADDRESS to test preflight validation
    const result = await checkSystemdUserServiceAvailable({
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(result.available).toBe(false);
    expect(result.missingEnvVars).toContain("DBUS_SESSION_BUS_ADDRESS");
  });

  it("checkSystemdUserEnvPreflight detects missing XDG_RUNTIME_DIR", () => {
    const result = checkSystemdUserEnvPreflight({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("XDG_RUNTIME_DIR");
  });

  it("checkSystemdUserEnvPreflight detects missing DBUS_SESSION_BUS_ADDRESS", () => {
    const result = checkSystemdUserEnvPreflight({ XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("DBUS_SESSION_BUS_ADDRESS");
  });

  it("checkSystemdUserEnvPreflight passes when both vars are set", () => {
    const result = checkSystemdUserEnvPreflight({
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });
});
