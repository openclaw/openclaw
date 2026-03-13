import os from "node:os";

import { describe, expect, it, vi } from "vitest";

import { createExecFileError, mockExecFileUtf8, resetMockExecFileUtf8 } from "../test-utils/exec-file.js";

const { execFileMock } = mockExecFileUtf8();

function mockManagedUnitPresent() {
  execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
    expect(args).toEqual(["--user", "list-unit-files", "openclaw-gateway.service"]);
    cb(null, "openclaw-gateway.service enabled\n", "");
  });
}

describe("isSystemdServiceEnabled", () => {
  beforeEach(() => {
    resetMockExecFileUtf8();
  });

  it("returns false when systemctl reports disabled", async () => {
    const { isSystemdServiceEnabled } = await import("./systemd.js");

    mockManagedUnitPresent();
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["--user", "is-enabled", "openclaw-gateway.service"]);
      cb(null, "disabled\n", "");
    });

    const result = await isSystemdServiceEnabled({ env: { HOME: "/tmp/openclaw-test-home" } });
    expect(result).toBe(false);
  });

  it("returns true when systemctl reports enabled", async () => {
    const { isSystemdServiceEnabled } = await import("./systemd.js");

    mockManagedUnitPresent();
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["--user", "is-enabled", "openclaw-gateway.service"]);
      cb(null, "enabled\n", "");
    });

    const result = await isSystemdServiceEnabled({ env: { HOME: "/tmp/openclaw-test-home" } });
    expect(result).toBe(true);
  });

  it("returns false when systemctl writes not-found to stdout but stderr has generic exec error", async () => {
    const { isSystemdServiceEnabled } = await import("./systemd.js");

    mockManagedUnitPresent();
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["--user", "is-enabled", "openclaw-gateway.service"]);
      const err = new Error(
        "Command failed: systemctl --user is-enabled openclaw-gateway.service",
      ) as Error & { code?: number };
      err.code = 1;
      cb(err, "not-found", "Command failed: systemctl --user is-enabled openclaw-gateway.service");
    });

    const result = await isSystemdServiceEnabled({ env: { HOME: "/tmp/openclaw-test-home" } });
    expect(result).toBe(false);
  });

  it("throws when systemctl is-enabled fails for non-state errors", async () => {
    const { isSystemdServiceEnabled } = await import("./systemd.js");

    mockManagedUnitPresent();
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["--user", "is-enabled", "openclaw-gateway.service"]);
      cb(createExecFileError("boom", { stderr: "read-only file system" }), "", "");
    });

    await expect(
      isSystemdServiceEnabled({ env: { HOME: "/tmp/openclaw-test-home" } }),
    ).rejects.toThrow("systemctl is-enabled unavailable: read-only file system");
  });

  it("returns false when is-enabled cannot connect to the user bus without machine fallback", async () => {
    const { isSystemdServiceEnabled } = await import("./systemd.js");

    mockManagedUnitPresent();
    vi.spyOn(os, "userInfo").mockImplementationOnce(() => {
      throw new Error("no user info");
    });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["--user", "is-enabled", "openclaw-gateway.service"]);
      cb(
        createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
        "",
        "",
      );
    });

    await expect(
      isSystemdServiceEnabled({
        env: { HOME: "/tmp/openclaw-test-home", USER: "", LOGNAME: "" },
      }),
    ).rejects.toThrow("systemctl is-enabled unavailable: Failed to connect to bus");
  });

  it("returns false when both direct and machine-scope is-enabled checks report bus unavailability", async () => {
    const { isSystemdServiceEnabled } = await import("./systemd.js");

    mockManagedUnitPresent();
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["--user", "is-enabled", "openclaw-gateway.service"]);
        cb(
          createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
          "",
          "",
        );
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual([
          "--machine",
          "debian@",
          "--user",
          "is-enabled",
          "openclaw-gateway.service",
        ]);
        cb(
          createExecFileError("Failed to connect to user scope bus via local transport", {
            stderr:
              "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
          }),
          "",
          "",
        );
      });

    await expect(
      isSystemdServiceEnabled({
        env: { HOME: "/tmp/openclaw-test-home", USER: "debian" },
      }),
    ).rejects.toThrow("systemctl is-enabled unavailable: Failed to connect to user scope bus");
  });
});
