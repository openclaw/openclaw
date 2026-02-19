import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { splitArgsPreservingQuotes } from "./arg-split.js";
import { parseSystemdExecStart } from "./systemd-unit.js";
import {
  isSystemdUserServiceAvailable,
  isSystemLevelService,
  parseSystemdShow,
  restartSystemdService,
  resolveSystemdUserUnitPath,
  stopSystemdService,
} from "./systemd.js";

describe("systemd availability", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    delete process.env.OPENCLAW_SYSTEMD_SYSTEM;
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

  it("returns true for system-level service even when user bus fails", async () => {
    process.env.OPENCLAW_SYSTEMD_SYSTEM = "1";
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      // System-level: systemctl status (no --user) exits 3 when no units loaded
      const err = new Error("exit code 3") as Error & {
        stderr?: string;
        code?: number;
      };
      err.code = 3;
      err.stderr = "";
      cb(err, "", "");
    });
    await expect(isSystemdUserServiceAvailable()).resolves.toBe(true);
  });
});

describe("isSystemLevelService", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_SYSTEMD_SYSTEM;
  });

  it("returns false by default", () => {
    expect(isSystemLevelService()).toBe(false);
  });

  it("returns true when OPENCLAW_SYSTEMD_SYSTEM=1", () => {
    process.env.OPENCLAW_SYSTEMD_SYSTEM = "1";
    expect(isSystemLevelService()).toBe(true);
  });

  it("returns true when OPENCLAW_SYSTEMD_SYSTEM=true", () => {
    process.env.OPENCLAW_SYSTEMD_SYSTEM = "true";
    expect(isSystemLevelService()).toBe(true);
  });

  it("returns false when OPENCLAW_SYSTEMD_SYSTEM=0", () => {
    process.env.OPENCLAW_SYSTEMD_SYSTEM = "0";
    expect(isSystemLevelService()).toBe(false);
  });
});

describe("systemd runtime parsing", () => {
  it("parses active state details", () => {
    const output = [
      "ActiveState=inactive",
      "SubState=dead",
      "MainPID=0",
      "ExecMainStatus=2",
      "ExecMainCode=exited",
    ].join("\n");
    expect(parseSystemdShow(output)).toEqual({
      activeState: "inactive",
      subState: "dead",
      execMainStatus: 2,
      execMainCode: "exited",
    });
  });
});

describe("resolveSystemdUserUnitPath", () => {
  it("uses default service name when OPENCLAW_PROFILE is unset", () => {
    const env = { HOME: "/home/test" };
    expect(resolveSystemdUserUnitPath(env)).toBe(
      "/home/test/.config/systemd/user/openclaw-gateway.service",
    );
  });

  it("uses profile-specific service name when OPENCLAW_PROFILE is set to a custom value", () => {
    const env = { HOME: "/home/test", OPENCLAW_PROFILE: "jbphoenix" };
    expect(resolveSystemdUserUnitPath(env)).toBe(
      "/home/test/.config/systemd/user/openclaw-gateway-jbphoenix.service",
    );
  });

  it("prefers OPENCLAW_SYSTEMD_UNIT over OPENCLAW_PROFILE", () => {
    const env = {
      HOME: "/home/test",
      OPENCLAW_PROFILE: "jbphoenix",
      OPENCLAW_SYSTEMD_UNIT: "custom-unit",
    };
    expect(resolveSystemdUserUnitPath(env)).toBe(
      "/home/test/.config/systemd/user/custom-unit.service",
    );
  });

  it("resolves to /etc/systemd/system/ for system-level services", () => {
    process.env.OPENCLAW_SYSTEMD_SYSTEM = "1";
    const env = {
      HOME: "/home/test",
      OPENCLAW_SYSTEMD_UNIT: "openclaw",
    };
    expect(resolveSystemdUserUnitPath(env)).toBe("/etc/systemd/system/openclaw.service");
    delete process.env.OPENCLAW_SYSTEMD_SYSTEM; // also cleaned by describe-level afterEach if added
  });

  it("handles OPENCLAW_SYSTEMD_UNIT with .service suffix", () => {
    const env = {
      HOME: "/home/test",
      OPENCLAW_SYSTEMD_UNIT: "custom-unit.service",
    };
    expect(resolveSystemdUserUnitPath(env)).toBe(
      "/home/test/.config/systemd/user/custom-unit.service",
    );
  });

  it("trims whitespace from OPENCLAW_SYSTEMD_UNIT", () => {
    const env = {
      HOME: "/home/test",
      OPENCLAW_SYSTEMD_UNIT: "  custom-unit  ",
    };
    expect(resolveSystemdUserUnitPath(env)).toBe(
      "/home/test/.config/systemd/user/custom-unit.service",
    );
  });
});

describe("splitArgsPreservingQuotes", () => {
  it("splits on whitespace outside quotes", () => {
    expect(splitArgsPreservingQuotes('/usr/bin/openclaw gateway start --name "My Bot"')).toEqual([
      "/usr/bin/openclaw",
      "gateway",
      "start",
      "--name",
      "My Bot",
    ]);
  });

  it("supports systemd-style backslash escaping", () => {
    expect(
      splitArgsPreservingQuotes('openclaw --name "My \\"Bot\\"" --foo bar', {
        escapeMode: "backslash",
      }),
    ).toEqual(["openclaw", "--name", 'My "Bot"', "--foo", "bar"]);
  });

  it("supports schtasks-style escaped quotes while preserving other backslashes", () => {
    expect(
      splitArgsPreservingQuotes('openclaw --path "C:\\\\Program Files\\\\OpenClaw"', {
        escapeMode: "backslash-quote-only",
      }),
    ).toEqual(["openclaw", "--path", "C:\\\\Program Files\\\\OpenClaw"]);

    expect(
      splitArgsPreservingQuotes('openclaw --label "My \\"Quoted\\" Name"', {
        escapeMode: "backslash-quote-only",
      }),
    ).toEqual(["openclaw", "--label", 'My "Quoted" Name']);
  });
});

describe("parseSystemdExecStart", () => {
  it("preserves quoted arguments", () => {
    const execStart = '/usr/bin/openclaw gateway start --name "My Bot"';
    expect(parseSystemdExecStart(execStart)).toEqual([
      "/usr/bin/openclaw",
      "gateway",
      "start",
      "--name",
      "My Bot",
    ]);
  });
});

describe("systemd service control", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("stops the resolved user unit", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, "", ""))
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["--user", "stop", "openclaw-gateway.service"]);
        cb(null, "", "");
      });
    const write = vi.fn();
    const stdout = { write } as unknown as NodeJS.WritableStream;

    await stopSystemdService({ stdout, env: {} });

    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain("Stopped systemd service");
  });

  it("restarts a profile-specific user unit", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, "", ""))
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["--user", "restart", "openclaw-gateway-work.service"]);
        cb(null, "", "");
      });
    const write = vi.fn();
    const stdout = { write } as unknown as NodeJS.WritableStream;

    await restartSystemdService({ stdout, env: { OPENCLAW_PROFILE: "work" } });

    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain("Restarted systemd service");
  });

  it("surfaces stop failures with systemctl detail", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, "", ""))
      .mockImplementationOnce((_cmd, _args, _opts, cb) => {
        const err = new Error("stop failed") as Error & { code?: number };
        err.code = 1;
        cb(err, "", "permission denied");
      });

    await expect(
      stopSystemdService({
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        env: {},
      }),
    ).rejects.toThrow("systemctl stop failed: permission denied");
  });
});
