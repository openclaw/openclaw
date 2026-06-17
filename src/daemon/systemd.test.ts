// Systemd tests cover Linux service install, start, stop, and status behavior.
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;
type ExecFileMock = (
  command: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: ExecFileCallback,
) => unknown;

const execFileMock = vi.hoisted(() => vi.fn<ExecFileMock>());
const existsSyncMock = vi.hoisted(() => vi.fn(() => false));
const findSystemGatewayServicesMock = vi.hoisted(() =>
  vi.fn<
    () => Promise<
      Array<{
        platform: "linux";
        label: string;
        detail: string;
        scope: "user" | "system";
        marker?: "openclaw" | "clawdbot";
        legacy?: boolean;
      }>
    >
  >(async () => []),
);

vi.mock("./inspect.js", () => ({
  findSystemGatewayServices: () => findSystemGatewayServicesMock(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: existsSyncMock,
}));

vi.mock("./exec-file.js", () => {
  return {
    execFileUtf8: async (
      command: string,
      args: string[],
      options: Omit<ExecFileOptionsWithStringEncoding, "encoding"> = {},
    ) => {
      let settled:
        | {
            stdout: string;
            stderr: string;
            code: number;
          }
        | undefined;

      execFileMock(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
        settled = {
          stdout: stdout ?? "",
          stderr: stderr || error?.message || "",
          code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        };
      });

      if (!settled) {
        throw new Error(`execFile mock did not settle for ${command} ${args.join(" ")}`);
      }
      return settled;
    },
  };
});

import { splitArgsPreservingQuotes } from "./arg-split.js";
import { parseSystemdEnvAssignments, parseSystemdExecStart } from "./systemd-unit.js";
import {
  findInstalledSystemdGatewayScope,
  installSystemdService,
  isNonFatalSystemdInstallProbeError,
  isSystemdServiceEnabled,
  isSystemdUnitActive,
  isSystemdUserServiceAvailable,
  parseSystemdShow,
  readSystemdServiceRuntime,
  readSystemdServiceExecStart,
  restartSystemdService,
  resolveSystemdUserUnitPath,
  stageSystemdService,
  stopSystemdService,
  uninstallSystemdService,
} from "./systemd.js";

type ExecFileError = Error & {
  stderr?: string;
  code?: string | number;
};

const TEST_SERVICE_HOME = "/home/test";
const TEST_MANAGED_HOME = "/tmp/openclaw-test-home";
const GATEWAY_SERVICE = "openclaw-gateway.service";
const NODE_SERVICE = "openclaw-node.service";

const createExecFileError = (
  message: string,
  options: { stderr?: string; code?: string | number } = {},
): ExecFileError => {
  const err = new Error(message) as ExecFileError;
  err.code = options.code ?? 1;
  if (options.stderr) {
    err.stderr = options.stderr;
  }
  return err;
};

const createWritableStreamMock = () => {
  const write = vi.fn();
  return {
    write,
    stdout: { write } as unknown as NodeJS.WritableStream,
  };
};

function mockSystemUnitFiles(files: Record<string, string>) {
  vi.spyOn(fs, "readFile").mockImplementation(async (pathArg) => {
    const p = pathLikeToString(pathArg);
    const content = files[p];
    if (content !== undefined) {
      return content;
    }
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
      code: "ENOENT",
    });
  });
}

function renderCustomGatewayUnit(
  environment: Record<string, string>,
  options: { environmentFiles?: string[] } = {},
): string {
  const environmentLines = Object.entries(environment).map(
    ([key, value]) => `Environment=${key}=${value}`,
  );
  const environmentFileLines = (options.environmentFiles ?? []).map(
    (environmentFile) => `EnvironmentFile=${environmentFile}`,
  );
  return [
    "[Service]",
    "WorkingDirectory=/tmp/openclaw-custom-unit",
    ...environmentFileLines,
    ...environmentLines,
    "ExecStart=/usr/bin/openclaw gateway run",
    "",
  ].join("\n");
}

function requireFirstWrite(write: ReturnType<typeof vi.fn>): string {
  const [call] = write.mock.calls;
  if (!call) {
    throw new Error("expected systemd status write");
  }
  const [value] = call;
  if (value === undefined) {
    throw new Error("expected systemd status write");
  }
  return String(value);
}

function pathLikeToString(pathname: unknown): string {
  if (typeof pathname === "string") {
    return pathname;
  }
  if (pathname instanceof URL) {
    return pathname.pathname;
  }
  if (pathname instanceof Uint8Array) {
    return Buffer.from(pathname).toString("utf8");
  }
  return "";
}

function assertUserSystemctlArgs(args: string[], ...command: string[]) {
  expect(args).toEqual(["--user", ...command]);
}

function assertMachineUserSystemctlArgs(args: string[], user: string, ...command: string[]) {
  expect(args).toEqual(["--machine", `${user}@`, "--user", ...command]);
}

function mockEffectiveUid(uid: number) {
  vi.spyOn(process, "geteuid").mockReturnValue(uid);
}

async function readManagedServiceEnabled(env: NodeJS.ProcessEnv = { HOME: TEST_MANAGED_HOME }) {
  vi.spyOn(fs, "access").mockImplementation(async (pathname) => {
    const pathValue = pathLikeToString(pathname);
    if (pathValue.includes("/.config/systemd/user/")) {
      return undefined;
    }
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  return isSystemdServiceEnabled({ env });
}

function mockReadGatewayServiceFile(
  unitLines: string[],
  extraFiles: Record<string, string | Error> = {},
) {
  return vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
    const pathValue = pathLikeToString(pathname);
    if (pathValue.endsWith(`/${GATEWAY_SERVICE}`)) {
      return unitLines.join("\n");
    }
    const extraFile = extraFiles[pathValue];
    if (typeof extraFile === "string") {
      return extraFile;
    }
    if (extraFile instanceof Error) {
      throw extraFile;
    }
    throw new Error(`unexpected readFile path: ${pathValue}`);
  });
}

async function expectExecStartWithoutEnvironment(envFileLine: string) {
  mockReadGatewayServiceFile(["[Service]", "ExecStart=/usr/bin/openclaw gateway run", envFileLine]);

  const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });
  expect(command?.programArguments).toEqual(["/usr/bin/openclaw", "gateway", "run"]);
  expect(command?.environment).toBeUndefined();
}

const assertRestartSuccess = async (env: NodeJS.ProcessEnv) => {
  const { write, stdout } = createWritableStreamMock();
  await restartSystemdService({ stdout, env });
  expect(write).toHaveBeenCalledTimes(1);
  expect(requireFirstWrite(write)).toContain("Restarted systemd service");
};

beforeEach(() => {
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
});

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

  it("repairs missing user bus environment when the runtime bus exists", async () => {
    mockEffectiveUid(1000);
    existsSyncMock.mockReturnValue(true);
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      assertUserSystemctlArgs(args, "status");
      if (!opts.env) {
        throw new Error("expected systemctl env");
      }
      expect(opts.env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
      expect(opts.env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
      cb(null, "", "");
    });

    await expect(
      isSystemdUserServiceAvailable({
        USER: "debian",
        XDG_RUNTIME_DIR: undefined,
        DBUS_SESSION_BUS_ADDRESS: undefined,
      }),
    ).resolves.toBe(true);
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

  it("returns true when systemd is degraded but still reachable", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(createExecFileError("degraded", { stderr: "degraded\nsome-unit.service failed" }), "", "");
    });

    await expect(isSystemdUserServiceAvailable()).resolves.toBe(true);
  });

  it("falls back to machine user scope when --user bus is unavailable", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["--user", "status"]);
        const err = createExecFileError("Failed to connect to user scope bus via local transport", {
          stderr:
            "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
        });
        cb(err, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["--machine", "debian@", "--user", "status"]);
        cb(null, "", "");
      });

    await expect(isSystemdUserServiceAvailable({ USER: "debian" })).resolves.toBe(true);
  });

  it("does not fall back to machine scope when --user fails with permission denied", async () => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["--user", "status"]);
      cb(
        createExecFileError("Failed to connect to bus: Permission denied", {
          stderr: "Failed to connect to bus: Permission denied",
          code: 1,
        }),
        "",
        "",
      );
    });
    // Only one call should be made: no machine-scope fallback for permission denied errors.
    await expect(isSystemdUserServiceAvailable({ USER: "debian" })).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to direct --user when machine scope fails under sudo", async () => {
    mockEffectiveUid(0);
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertMachineUserSystemctlArgs(args, "ai", "status");
      cb(
        createExecFileError("Failed to connect to bus: No such file or directory", {
          stderr: "Failed to connect to bus: No such file or directory",
          code: 1,
        }),
        "",
        "",
      );
    });

    await expect(isSystemdUserServiceAvailable({ SUDO_USER: "ai" })).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not let preserved USER suppress sudo-to-root machine scope", async () => {
    mockEffectiveUid(0);
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertMachineUserSystemctlArgs(args, "debian", "status");
      cb(null, "", "");
    });

    await expect(
      isSystemdUserServiceAvailable({
        SUDO_USER: "debian",
        USER: "root-env-stale",
        LOGNAME: "root-env-stale",
      }),
    ).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not let stale SUDO_USER override a sudo-u target user scope", async () => {
    mockEffectiveUid(1000);
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "status");
      cb(null, "", "");
    });

    await expect(
      isSystemdUserServiceAvailable({ USER: "openclaw", SUDO_USER: "admin" }),
    ).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("isSystemdServiceEnabled", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
  });

  it("returns false when systemctl is not present", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error("spawn systemctl EACCES") as Error & { code?: string };
      err.code = "EACCES";
      cb(err, "", "");
    });
    const result = await readManagedServiceEnabled();
    expect(result).toBe(false);
  });

  it("returns false without calling systemctl when the managed unit file is missing", async () => {
    const err = new Error("missing unit") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    vi.spyOn(fs, "access").mockRejectedValueOnce(err);

    const result = await isSystemdServiceEnabled({ env: { HOME: "/tmp/openclaw-test-home" } });

    expect(result).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("calls systemctl is-enabled when systemctl is present", async () => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "is-enabled", GATEWAY_SERVICE);
      cb(null, "enabled", "");
    });
    const result = await readManagedServiceEnabled();
    expect(result).toBe(true);
  });

  it("returns false when systemctl reports disabled", async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      const err = new Error("disabled") as Error & { code?: number };
      err.code = 1;
      cb(err, "disabled", "");
    });
    const result = await readManagedServiceEnabled();
    expect(result).toBe(false);
  });

  it("returns false for the WSL2 Ubuntu 24.04 wrapper-only is-enabled failure", async () => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "is-enabled", GATEWAY_SERVICE);
      const err = new Error(
        `Command failed: systemctl --user is-enabled ${GATEWAY_SERVICE}`,
      ) as Error & { code?: number };
      err.code = 1;
      cb(err, "", "");
    });

    await expect(readManagedServiceEnabled()).rejects.toThrow(
      `systemctl is-enabled unavailable: Command failed: systemctl --user is-enabled ${GATEWAY_SERVICE}`,
    );
  });

  it("returns false when is-enabled cannot connect to the user bus without machine fallback", async () => {
    vi.spyOn(os, "userInfo").mockImplementationOnce(() => {
      throw new Error("no user info");
    });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "is-enabled", GATEWAY_SERVICE);
      cb(
        createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
        "",
        "",
      );
    });

    await expect(
      readManagedServiceEnabled({ HOME: TEST_MANAGED_HOME, USER: "", LOGNAME: "" }),
    ).rejects.toThrow("systemctl is-enabled unavailable: Failed to connect to bus");
  });

  it("returns false when both direct and machine-scope is-enabled checks report bus unavailability", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "is-enabled", GATEWAY_SERVICE);
        cb(
          createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
          "",
          "",
        );
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertMachineUserSystemctlArgs(args, "debian", "is-enabled", GATEWAY_SERVICE);
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
      readManagedServiceEnabled({ HOME: TEST_MANAGED_HOME, USER: "debian" }),
    ).rejects.toThrow("systemctl is-enabled unavailable: Failed to connect to user scope bus");
  });

  it("throws when generic wrapper errors report infrastructure failures", async () => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "is-enabled", GATEWAY_SERVICE);
      const err = new Error(
        `Command failed: systemctl --user is-enabled ${GATEWAY_SERVICE}`,
      ) as Error & { code?: number };
      err.code = 1;
      cb(err, "", "read-only file system");
    });

    await expect(readManagedServiceEnabled()).rejects.toThrow(
      "systemctl is-enabled unavailable: read-only file system",
    );
  });

  it("throws when systemctl is-enabled fails for non-state errors", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["--user", "is-enabled", "openclaw-gateway.service"]);
        const err = new Error("Failed to connect to bus") as Error & { code?: number };
        err.code = 1;
        cb(err, "", "Failed to connect to bus");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args[0]).toBe("--machine");
        expect(args[1]).toMatch(/^[^@]+@$/);
        expect(args.slice(2)).toEqual(["--user", "is-enabled", "openclaw-gateway.service"]);
        const err = new Error("permission denied") as Error & { code?: number };
        err.code = 1;
        cb(err, "", "permission denied");
      });
    await expect(readManagedServiceEnabled({ HOME: "/tmp/openclaw-test-home" })).rejects.toThrow(
      "systemctl is-enabled unavailable: permission denied",
    );
  });

  it("returns false when systemctl is-enabled exits with code 4 (not-found)", async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      // On Ubuntu 24.04, `systemctl --user is-enabled <unit>` exits with
      // code 4 and prints "not-found" to stdout when the unit doesn't exist.
      const err = new Error(
        "Command failed: systemctl --user is-enabled openclaw-gateway.service",
      ) as Error & { code?: number };
      err.code = 4;
      cb(err, "not-found\n", "");
    });
    const result = await readManagedServiceEnabled({ HOME: "/tmp/openclaw-test-home" });
    expect(result).toBe(false);
  });
});

describe("isSystemdUnitActive", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
  });

  it("checks user-scoped units through the user systemd manager", async () => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "is-active", "--quiet", GATEWAY_SERVICE);
      cb(null, "", "");
    });

    await expect(isSystemdUnitActive({ HOME: TEST_MANAGED_HOME }, GATEWAY_SERVICE)).resolves.toBe(
      true,
    );
  });

  it("checks system-scoped units without the user manager", async () => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
      cb(createExecFileError("inactive", { code: 3 }), "", "");
    });

    await expect(
      isSystemdUnitActive({ HOME: TEST_MANAGED_HOME }, GATEWAY_SERVICE, "system"),
    ).resolves.toBe(false);
  });
});

describe("system-scope gateway unit detection (openclaw#87577)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
    findSystemGatewayServicesMock.mockReset();
    findSystemGatewayServicesMock.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockUnitFileLayout(layout: { user?: boolean; system?: string | false }) {
    vi.spyOn(fs, "access").mockImplementation(async (pathArg) => {
      const p = pathLikeToString(pathArg);
      if (layout.user && p.includes("/.config/systemd/user/")) {
        return undefined;
      }
      if (typeof layout.system === "string" && p === layout.system) {
        return undefined;
      }
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
  }

  it("findInstalledSystemdGatewayScope prefers active system scope when both exist", async () => {
    mockUnitFileLayout({
      user: true,
      system: "/etc/systemd/system/openclaw-gateway.service",
    });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
      cb(null, "", "");
    });

    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toEqual({
      scope: "system",
      unitName: GATEWAY_SERVICE,
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
      conflictingUnit: {
        scope: "user",
        unitName: GATEWAY_SERVICE,
        unitPath: `${TEST_MANAGED_HOME}/.config/systemd/user/openclaw-gateway.service`,
      },
    });
  });

  it("findInstalledSystemdGatewayScope keeps user scope when the system unit is inactive and disabled", async () => {
    mockUnitFileLayout({
      user: true,
      system: "/etc/systemd/system/openclaw-gateway.service",
    });
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
        cb(createExecFileError("inactive", { code: 3 }), "", "inactive");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["is-enabled", GATEWAY_SERVICE]);
        cb(createExecFileError("disabled"), "disabled\n", "");
      });

    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toEqual({
      scope: "user",
      unitName: GATEWAY_SERVICE,
      unitPath: `${TEST_MANAGED_HOME}/.config/systemd/user/openclaw-gateway.service`,
      conflictingUnit: {
        scope: "system",
        unitName: GATEWAY_SERVICE,
        unitPath: "/etc/systemd/system/openclaw-gateway.service",
      },
    });
  });

  it("findInstalledSystemdGatewayScope detects system-scope unit in /etc/systemd/system", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toEqual({
      scope: "system",
      unitName: GATEWAY_SERVICE,
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    });
  });

  it("findInstalledSystemdGatewayScope falls back to /usr/lib/systemd/system", async () => {
    mockUnitFileLayout({ system: "/usr/lib/systemd/system/openclaw-gateway.service" });
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result?.scope).toBe("system");
    expect(result?.unitPath).toBe("/usr/lib/systemd/system/openclaw-gateway.service");
  });

  it("findInstalledSystemdGatewayScope returns null when no unit file exists", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([]);
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toBeNull();
  });

  it("findInstalledSystemdGatewayScope falls back to marker-owned system unit with custom name", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw.service",
        detail: "unit: /etc/systemd/system/openclaw.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "default",
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
    });
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toEqual({
      scope: "system",
      unitName: "openclaw.service",
      unitPath: "/etc/systemd/system/openclaw.service",
    });
  });

  it("findInstalledSystemdGatewayScope ignores marker-owned custom system units with a different profile", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-staging.service",
        detail: "unit: /etc/systemd/system/openclaw-staging.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw-staging.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "staging",
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
    });

    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });

    expect(result).toBeNull();
  });

  it("findInstalledSystemdGatewayScope matches OPENCLAW_PROFILE=Default with the current default profile", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-default.service",
        detail: "unit: /etc/systemd/system/openclaw-default.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw-default.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "Default",
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
    });

    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });

    expect(result).toEqual({
      scope: "system",
      unitName: "openclaw-default.service",
      unitPath: "/etc/systemd/system/openclaw-default.service",
    });
  });

  it("findInstalledSystemdGatewayScope matches current OPENCLAW_GATEWAY_PORT=127.0.0.1:18789 with candidate port 18789", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-loopback.service",
        detail: "unit: /etc/systemd/system/openclaw-loopback.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw-loopback.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "default",
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
    });

    const result = await findInstalledSystemdGatewayScope({
      HOME: TEST_MANAGED_HOME,
      OPENCLAW_GATEWAY_PORT: "127.0.0.1:18789",
    });

    expect(result).toEqual({
      scope: "system",
      unitName: "openclaw-loopback.service",
      unitPath: "/etc/systemd/system/openclaw-loopback.service",
    });
  });

  it("findInstalledSystemdGatewayScope parses multiple inline Environment assignments for custom identity", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-inline-env.service",
        detail: "unit: /etc/systemd/system/openclaw-inline-env.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw-inline-env.service": [
        "[Service]",
        "WorkingDirectory=/tmp/openclaw-custom-unit",
        "Environment=OPENCLAW_SERVICE_MARKER=openclaw OPENCLAW_SERVICE_KIND=gateway OPENCLAW_PROFILE=default OPENCLAW_GATEWAY_PORT=18789",
        "ExecStart=/usr/bin/openclaw gateway run",
        "",
      ].join("\n"),
    });

    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });

    expect(result).toEqual({
      scope: "system",
      unitName: "openclaw-inline-env.service",
      unitPath: "/etc/systemd/system/openclaw-inline-env.service",
    });
  });

  it("findInstalledSystemdGatewayScope ignores marker-owned custom system units with a different gateway port", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-alt-port.service",
        detail: "unit: /etc/systemd/system/openclaw-alt-port.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw-alt-port.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "default",
        OPENCLAW_GATEWAY_PORT: "28888",
      }),
    });

    const result = await findInstalledSystemdGatewayScope({
      HOME: TEST_MANAGED_HOME,
      OPENCLAW_GATEWAY_PORT: "18789",
    });

    expect(result).toBeNull();
  });

  it("findInstalledSystemdGatewayScope ignores marker-owned custom system units with a different OPENCLAW_CONFIG_PATH", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-alt-config.service",
        detail: "unit: /etc/systemd/system/openclaw-alt-config.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw-alt-config.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "default",
        OPENCLAW_GATEWAY_PORT: "18789",
        OPENCLAW_CONFIG_PATH: "/etc/openclaw/other-config.json",
      }),
    });

    const result = await findInstalledSystemdGatewayScope({
      HOME: TEST_MANAGED_HOME,
      OPENCLAW_CONFIG_PATH: "/etc/openclaw/current-config.json",
    });

    expect(result).toBeNull();
  });

  it("findInstalledSystemdGatewayScope matches omitted OPENCLAW_PROFILE with the current default profile", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-default.service",
        detail: "unit: /etc/systemd/system/openclaw-default.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw-default.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
    });

    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });

    expect(result).toEqual({
      scope: "system",
      unitName: "openclaw-default.service",
      unitPath: "/etc/systemd/system/openclaw-default.service",
    });
  });

  it("findInstalledSystemdGatewayScope ignores omitted OPENCLAW_PROFILE for a non-default current profile", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-default.service",
        detail: "unit: /etc/systemd/system/openclaw-default.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw-default.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
    });

    const result = await findInstalledSystemdGatewayScope({
      HOME: TEST_MANAGED_HOME,
      OPENCLAW_PROFILE: "work",
    });

    expect(result).toBeNull();
  });

  it("findInstalledSystemdGatewayScope ignores marker-owned custom system units missing OPENCLAW_GATEWAY_PORT", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-missing-port.service",
        detail: "unit: /etc/systemd/system/openclaw-missing-port.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw-missing-port.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "default",
      }),
    });

    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });

    expect(result).toBeNull();
  });

  it("findInstalledSystemdGatewayScope merges EnvironmentFile OPENCLAW_CONFIG_PATH and OPENCLAW_GATEWAY_PORT for custom identity", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-env-file.service",
        detail: "unit: /etc/systemd/system/openclaw-env-file.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw-env-file.service": renderCustomGatewayUnit(
        {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
          OPENCLAW_PROFILE: "default",
        },
        { environmentFiles: ["/etc/openclaw/gateway.env"] },
      ),
      "/etc/openclaw/gateway.env": [
        "OPENCLAW_CONFIG_PATH=/etc/openclaw/current-config.json",
        "OPENCLAW_GATEWAY_PORT=[::1]:18789",
      ].join("\n"),
    });

    const result = await findInstalledSystemdGatewayScope({
      HOME: TEST_MANAGED_HOME,
      OPENCLAW_CONFIG_PATH: "/etc/openclaw/current-config.json",
      OPENCLAW_GATEWAY_PORT: "18789",
    });

    expect(result).toEqual({
      scope: "system",
      unitName: "openclaw-env-file.service",
      unitPath: "/etc/systemd/system/openclaw-env-file.service",
    });
  });

  it("findInstalledSystemdGatewayScope skips mismatched custom units and selects a matching marker-owned system unit", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-staging.service",
        detail: "unit: /etc/systemd/system/openclaw-staging.service",
        scope: "system",
        marker: "openclaw",
      },
      {
        platform: "linux",
        label: "openclaw-default.service",
        detail: "unit: /etc/systemd/system/openclaw-default.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw-staging.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "staging",
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
      "/etc/systemd/system/openclaw-default.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "default",
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
    });

    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });

    expect(result).toEqual({
      scope: "system",
      unitName: "openclaw-default.service",
      unitPath: "/etc/systemd/system/openclaw-default.service",
    });
  });

  it("prefers an active marker-owned custom system unit over a stale canonical user unit", async () => {
    mockUnitFileLayout({ user: true, system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw.service",
        detail: "unit: /etc/systemd/system/openclaw.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "default",
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
    });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-active", "--quiet", "openclaw.service"]);
      cb(null, "", "");
    });

    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });

    expect(result).toEqual({
      scope: "system",
      unitName: "openclaw.service",
      unitPath: "/etc/systemd/system/openclaw.service",
      conflictingUnit: {
        scope: "user",
        unitName: GATEWAY_SERVICE,
        unitPath: `${TEST_MANAGED_HOME}/.config/systemd/user/openclaw-gateway.service`,
      },
    });
  });

  it("keeps a canonical user unit when a marker-owned custom system unit is inactive and disabled", async () => {
    mockUnitFileLayout({ user: true, system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw.service",
        detail: "unit: /etc/systemd/system/openclaw.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "default",
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
    });
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["is-active", "--quiet", "openclaw.service"]);
        cb(createExecFileError("inactive", { code: 3 }), "", "inactive");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["is-enabled", "openclaw.service"]);
        cb(createExecFileError("disabled", { code: 1 }), "disabled\n", "");
      });

    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });

    expect(result).toEqual({
      scope: "user",
      unitName: GATEWAY_SERVICE,
      unitPath: `${TEST_MANAGED_HOME}/.config/systemd/user/openclaw-gateway.service`,
      conflictingUnit: {
        scope: "system",
        unitName: "openclaw.service",
        unitPath: "/etc/systemd/system/openclaw.service",
      },
    });
  });

  it("findInstalledSystemdGatewayScope ignores legacy clawdbot system units in the marker fallback", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "clawdbot.service",
        detail: "unit: /etc/systemd/system/clawdbot.service",
        scope: "system",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toBeNull();
  });

  it("isSystemdServiceEnabled queries the marker-owned custom system unit name", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw.service",
        detail: "unit: /etc/systemd/system/openclaw.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "default",
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
    });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-enabled", "openclaw.service"]);
      cb(null, "enabled\n", "");
    });
    await expect(isSystemdServiceEnabled({ env: { HOME: TEST_MANAGED_HOME } })).resolves.toBe(true);
  });

  it("restartSystemdService surfaces sudo guidance using the marker-owned custom unit name", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw.service",
        detail: "unit: /etc/systemd/system/openclaw.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockSystemUnitFiles({
      "/etc/systemd/system/openclaw.service": renderCustomGatewayUnit({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_PROFILE: "default",
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
    });
    mockEffectiveUid(1000);
    const { stdout, write } = createWritableStreamMock();
    await expect(
      restartSystemdService({ stdout, env: { HOME: TEST_MANAGED_HOME } }),
    ).rejects.toThrow(
      /openclaw\.service is a system-scope unit \(\/etc\/systemd\/system\/openclaw\.service\); run `sudo systemctl restart openclaw\.service`/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("isSystemdServiceEnabled reports true for an enabled system-scope unit", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-enabled", GATEWAY_SERVICE]);
      cb(null, "enabled\n", "");
    });
    await expect(isSystemdServiceEnabled({ env: { HOME: TEST_MANAGED_HOME } })).resolves.toBe(true);
  });

  it("isSystemdServiceEnabled reports false for a disabled system-scope unit", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-enabled", GATEWAY_SERVICE]);
      cb(createExecFileError("disabled", { code: 1 }), "disabled\n", "");
    });
    await expect(isSystemdServiceEnabled({ env: { HOME: TEST_MANAGED_HOME } })).resolves.toBe(
      false,
    );
  });

  it("readSystemdServiceRuntime queries the system manager for system-scope units", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args[0]).toBe("show");
      expect(args).not.toContain("--user");
      cb(
        null,
        [
          "Id=openclaw-gateway.service",
          "ActiveState=active",
          "SubState=running",
          "MainPID=4242",
        ].join("\n"),
        "",
      );
    });
    const runtime = await readSystemdServiceRuntime({ HOME: TEST_MANAGED_HOME });
    expect(runtime.status).toBe("running");
    expect(runtime.pid).toBe(4242);
    expect(runtime.systemd?.unit).toBe("openclaw-gateway.service");
  });

  it("restartSystemdService refuses to use the user manager when the unit is system-scope and the caller is not root", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    mockEffectiveUid(1000);
    const { stdout, write } = createWritableStreamMock();
    await expect(
      restartSystemdService({ stdout, env: { HOME: TEST_MANAGED_HOME } }),
    ).rejects.toThrow(
      /system-scope unit .* run `sudo systemctl restart openclaw-gateway\.service`/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("restartSystemdService restarts the system unit directly when running as root", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    mockEffectiveUid(0);
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["restart", GATEWAY_SERVICE]);
      cb(null, "", "");
    });
    const { stdout, write } = createWritableStreamMock();
    const result = await restartSystemdService({ stdout, env: { HOME: TEST_MANAGED_HOME } });
    expect(result).toEqual({ outcome: "completed" });
    expect(requireFirstWrite(write)).toContain("Restarted systemd service");
  });

  it("stopSystemdService surfaces sudo guidance for system-scope units without root", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    mockEffectiveUid(1000);
    const { stdout } = createWritableStreamMock();
    await expect(stopSystemdService({ stdout, env: { HOME: TEST_MANAGED_HOME } })).rejects.toThrow(
      /sudo systemctl stop openclaw-gateway\.service/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("isNonFatalSystemdInstallProbeError", () => {
  it("matches wrapper-only WSL install probe failures", () => {
    expect(
      isNonFatalSystemdInstallProbeError(
        new Error("Command failed: systemctl --user is-enabled openclaw-gateway.service"),
      ),
    ).toBe(true);
  });

  it("matches bus-unavailable install probe failures", () => {
    expect(
      isNonFatalSystemdInstallProbeError(
        new Error("systemctl is-enabled unavailable: Failed to connect to bus"),
      ),
    ).toBe(true);
  });

  it("does not match real infrastructure failures", () => {
    expect(
      isNonFatalSystemdInstallProbeError(
        new Error("systemctl is-enabled unavailable: read-only file system"),
      ),
    ).toBe(false);
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

  it("rejects pid and exit status values with junk suffixes", () => {
    const output = [
      "ActiveState=inactive",
      "SubState=dead",
      "MainPID=42abc",
      "ExecMainStatus=2ms",
      "ExecMainCode=exited",
    ].join("\n");
    expect(parseSystemdShow(output)).toEqual({
      activeState: "inactive",
      subState: "dead",
      execMainCode: "exited",
    });
  });

  it("rejects invalid cgroup counters as junk", () => {
    const output = [
      "ActiveState=active",
      "SubState=running",
      "MainPID=1",
      "ExecMainStatus=0",
      "ExecMainCode=running",
      "KillMode=process",
      "TasksCurrent=42abc",
      "MemoryCurrent=11GB",
    ].join("\n");
    expect(parseSystemdShow(output)).toEqual({
      activeState: "active",
      subState: "running",
      mainPid: 1,
      execMainStatus: 0,
      execMainCode: "running",
      killMode: "process",
    });
  });
});

describe("readSystemdServiceRuntime", () => {
  it("surfaces systemd cgroup metrics and KillMode", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "status");
        cb(null, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(
          args,
          "show",
          GATEWAY_SERVICE,
          "--no-page",
          "--property",
          "Id,ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent",
        );
        cb(
          null,
          [
            "Id=openclaw-gateway.service",
            "ActiveState=active",
            "SubState=running",
            "MainPID=1234",
            "ExecMainStatus=0",
            "ExecMainCode=running",
            "KillMode=process",
            "TasksCurrent=807",
            "MemoryCurrent=11918534246",
          ].join("\n"),
          "",
        );
      });
    const runtime = await readSystemdServiceRuntime({ HOME: TEST_MANAGED_HOME });
    expect(runtime).toEqual({
      status: "running",
      state: "active",
      subState: "running",
      pid: 1234,
      lastExitStatus: 0,
      lastExitReason: "running",
      systemd: {
        unit: "openclaw-gateway.service",
        killMode: "process",
        tasksCurrent: 807,
        memoryCurrent: 11_918_534_246,
      },
    });
  });
});

describe("resolveSystemdUserUnitPath", () => {
  it.each([
    {
      name: "uses default service name when OPENCLAW_PROFILE is unset",
      env: { HOME: "/home/test" },
      expected: "/home/test/.config/systemd/user/openclaw-gateway.service",
    },
    {
      name: "uses profile-specific service name when OPENCLAW_PROFILE is set to a custom value",
      env: { HOME: "/home/test", OPENCLAW_PROFILE: "jbphoenix" },
      expected: "/home/test/.config/systemd/user/openclaw-gateway-jbphoenix.service",
    },
    {
      name: "prefers OPENCLAW_SYSTEMD_UNIT over OPENCLAW_PROFILE",
      env: {
        HOME: "/home/test",
        OPENCLAW_PROFILE: "jbphoenix",
        OPENCLAW_SYSTEMD_UNIT: "custom-unit",
      },
      expected: "/home/test/.config/systemd/user/custom-unit.service",
    },
    {
      name: "handles OPENCLAW_SYSTEMD_UNIT with .service suffix",
      env: {
        HOME: "/home/test",
        OPENCLAW_SYSTEMD_UNIT: "custom-unit.service",
      },
      expected: "/home/test/.config/systemd/user/custom-unit.service",
    },
    {
      name: "trims whitespace from OPENCLAW_SYSTEMD_UNIT",
      env: {
        HOME: "/home/test",
        OPENCLAW_SYSTEMD_UNIT: "  custom-unit  ",
      },
      expected: "/home/test/.config/systemd/user/custom-unit.service",
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveSystemdUserUnitPath(env)).toBe(expected);
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

describe("parseSystemdEnvAssignments", () => {
  it("parses single-quoted whole assignments", () => {
    expect(
      parseSystemdEnvAssignments("'OPENCLAW_GATEWAY_TOKEN=single quoted token' FOO=bar"),
    ).toEqual([
      { key: "OPENCLAW_GATEWAY_TOKEN", value: "single quoted token" },
      { key: "FOO", value: "bar" },
    ]);
  });

  it("keeps apostrophes inside unquoted assignment values literal", () => {
    expect(parseSystemdEnvAssignments("FOO=can't OPENCLAW_GATEWAY_TOKEN=token")).toEqual([
      { key: "FOO", value: "can't" },
      { key: "OPENCLAW_GATEWAY_TOKEN", value: "token" },
    ]);
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

describe("readSystemdServiceExecStart", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads OPENCLAW_GATEWAY_TOKEN from EnvironmentFile", async () => {
    const readFileSpy = mockReadGatewayServiceFile(
      ["[Service]", "ExecStart=/usr/bin/openclaw gateway run", "EnvironmentFile=%h/.openclaw/.env"],
      { [`${TEST_SERVICE_HOME}/.openclaw/.env`]: "OPENCLAW_GATEWAY_TOKEN=env-file-token\n" },
    );

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });
    expect(command?.environment?.OPENCLAW_GATEWAY_TOKEN).toBe("env-file-token");
    expect(readFileSpy).toHaveBeenCalledTimes(2);
  });

  it("lets EnvironmentFile override inline Environment values", async () => {
    mockReadGatewayServiceFile(
      [
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
        "EnvironmentFile=%h/.openclaw/.env",
        'Environment="OPENCLAW_GATEWAY_TOKEN=inline-token"',
      ],
      { [`${TEST_SERVICE_HOME}/.openclaw/.env`]: "OPENCLAW_GATEWAY_TOKEN=env-file-token\n" },
    );

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });
    expect(command?.environment?.OPENCLAW_GATEWAY_TOKEN).toBe("env-file-token");
    expect(command?.environmentValueSources?.OPENCLAW_GATEWAY_TOKEN).toBe("inline-and-file");
  });

  it("ignores missing optional EnvironmentFile entries", async () => {
    await expectExecStartWithoutEnvironment("EnvironmentFile=-%h/.openclaw/missing.env");
  });

  it("keeps parsing when non-optional EnvironmentFile entries are missing", async () => {
    await expectExecStartWithoutEnvironment("EnvironmentFile=%h/.openclaw/missing.env");
  });

  it("supports multiple EnvironmentFile entries and quoted paths", async () => {
    vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      const pathValue = pathLikeToString(pathname);
      if (pathValue.endsWith("/openclaw-gateway.service")) {
        return [
          "[Service]",
          "ExecStart=/usr/bin/openclaw gateway run",
          'EnvironmentFile=%h/.openclaw/first.env "%h/.openclaw/second env.env"',
        ].join("\n");
      }
      if (pathValue === "/home/test/.openclaw/first.env") {
        return "OPENCLAW_GATEWAY_TOKEN=first-token\n"; // pragma: allowlist secret
      }
      if (pathValue === "/home/test/.openclaw/second env.env") {
        return 'OPENCLAW_GATEWAY_PASSWORD="second password"\n'; // pragma: allowlist secret
      }
      throw new Error(`unexpected readFile path: ${pathValue}`);
    });

    const command = await readSystemdServiceExecStart({ HOME: "/home/test" });
    expect(command?.environment).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "first-token",
      OPENCLAW_GATEWAY_PASSWORD: "second password", // pragma: allowlist secret
    });
  });

  it("resolves relative EnvironmentFile paths from the unit directory", async () => {
    vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      const pathValue = pathLikeToString(pathname);
      if (pathValue.endsWith("/openclaw-gateway.service")) {
        return [
          "[Service]",
          "ExecStart=/usr/bin/openclaw gateway run",
          "EnvironmentFile=./gateway.env ./override.env",
        ].join("\n");
      }
      if (pathValue.endsWith("/.config/systemd/user/gateway.env")) {
        return [
          "OPENCLAW_GATEWAY_TOKEN=relative-token", // pragma: allowlist secret
          "OPENCLAW_GATEWAY_PASSWORD=relative-password", // pragma: allowlist secret
        ].join("\n");
      }
      if (pathValue.endsWith("/.config/systemd/user/override.env")) {
        return "OPENCLAW_GATEWAY_TOKEN=override-token\n"; // pragma: allowlist secret
      }
      throw new Error(`unexpected readFile path: ${pathValue}`);
    });

    const command = await readSystemdServiceExecStart({ HOME: "/home/test" });
    expect(command?.environment).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "override-token",
      OPENCLAW_GATEWAY_PASSWORD: "relative-password", // pragma: allowlist secret
    });
  });

  it("parses EnvironmentFile content with comments and quoted values", async () => {
    vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      const pathValue = pathLikeToString(pathname);
      if (pathValue.endsWith("/openclaw-gateway.service")) {
        return [
          "[Service]",
          "ExecStart=/usr/bin/openclaw gateway run",
          "EnvironmentFile=%h/.openclaw/gateway.env",
        ].join("\n");
      }
      if (pathValue === "/home/test/.openclaw/gateway.env") {
        return [
          "# comment",
          "; another comment",
          'OPENCLAW_GATEWAY_TOKEN="quoted token"', // pragma: allowlist secret
          "OPENCLAW_GATEWAY_PASSWORD=quoted-password", // pragma: allowlist secret
        ].join("\n");
      }
      throw new Error(`unexpected readFile path: ${pathValue}`);
    });

    const command = await readSystemdServiceExecStart({ HOME: "/home/test" });
    expect(command?.environment).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "quoted token",
      OPENCLAW_GATEWAY_PASSWORD: "quoted-password", // pragma: allowlist secret
    });
    expect(command?.environmentValueSources).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "file",
      OPENCLAW_GATEWAY_PASSWORD: "file", // pragma: allowlist secret
    });
  });
});

describe("stageSystemdService", () => {
  async function withStageFixture(
    run: (context: {
      env: Record<string, string>;
      stateDir: string;
      unitPath: string;
      envFilePath: string;
      nodeEnvFilePath: string;
    }) => Promise<void>,
  ): Promise<void> {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-stage-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-stage-test",
    };
    const unitPath = resolveSystemdUserUnitPath(env);
    const envFilePath = path.join(stateDir, "gateway.systemd.env");
    const nodeEnvFilePath = path.join(stateDir, "node.systemd.env");

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await run({ env, stateDir, unitPath, envFilePath, nodeEnvFilePath });
    } finally {
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  }

  function mockSystemctlStatusOk(): void {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "status");
      cb(null, "", "");
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
  });

  it("writes dotenv-backed values to a separate env file and keeps inline env minimal", async () => {
    await withStageFixture(async ({ env, stateDir, unitPath, envFilePath }) => {
      await fs.writeFile(
        path.join(stateDir, ".env"),
        ["OPENCLAW_GATEWAY_TOKEN=dotenv-token", "LLM_API_KEY=dotenv-key"].join("\n"),
        "utf8",
      );

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_TOKEN: "dotenv-token",
          LLM_API_KEY: "dotenv-key",
          OPENCLAW_GATEWAY_PORT: "18789",
        },
      });

      const [unit, envFile, envFileStat] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(envFilePath, "utf8"),
        fs.stat(envFilePath),
      ]);

      expect(unit).toContain(`EnvironmentFile=-${envFilePath}`);
      expect(unit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
      expect(unit).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=dotenv-token");
      expect(unit).not.toContain("Environment=LLM_API_KEY=dotenv-key");
      expect(envFile).toBe("OPENCLAW_GATEWAY_TOKEN=dotenv-token\nLLM_API_KEY=dotenv-key\n");
      expect(envFileStat.mode & 0o777).toBe(0o600);
    });
  });

  it("writes node file-backed managed values to the node env file instead of the unit", async () => {
    await withStageFixture(async ({ env, stateDir, unitPath, envFilePath, nodeEnvFilePath }) => {
      await fs.rm(stateDir, { recursive: true, force: true });

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_TOKEN: "file-backed-token",
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_SERVICE_KIND: "node",
        },
        environmentValueSources: {
          OPENCLAW_GATEWAY_TOKEN: "file",
        },
      });

      const [unit, envFile, envFileStat] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(nodeEnvFilePath, "utf8"),
        fs.stat(nodeEnvFilePath),
      ]);

      expect(unit).toContain(`EnvironmentFile=-${nodeEnvFilePath}`);
      expect(unit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
      expect(unit).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=file-backed-token");
      expect(envFile).toBe("OPENCLAW_GATEWAY_TOKEN=file-backed-token\n");
      expect(envFileStat.mode & 0o777).toBe(0o600);
      await expect(fs.access(envFilePath)).rejects.toThrow();
    });
  });

  it("migrates operator entries from the legacy gateway env file when writing node env files", async () => {
    await withStageFixture(async ({ env, unitPath, envFilePath, nodeEnvFilePath }) => {
      const legacyGatewayEnvFile =
        ["OPENCLAW_GATEWAY_TOKEN=legacy-node-token", "OPENROUTER_API_KEY=operator-key"].join("\n") +
        "\n";
      await fs.writeFile(envFilePath, legacyGatewayEnvFile, {
        encoding: "utf8",
        mode: 0o600,
      });

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_TOKEN: "fresh-file-token",
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_SERVICE_KIND: "node",
        },
        environmentValueSources: {
          OPENCLAW_GATEWAY_TOKEN: "file",
        },
      });

      const [unit, nodeEnvFile, gatewayEnvFile] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(nodeEnvFilePath, "utf8"),
        fs.readFile(envFilePath, "utf8"),
      ]);

      expect(unit).toContain(`EnvironmentFile=-${nodeEnvFilePath}`);
      expect(unit).not.toContain("OPENCLAW_GATEWAY_TOKEN=fresh-file-token");
      expect(nodeEnvFile).toBe(
        "OPENROUTER_API_KEY=operator-key\nOPENCLAW_GATEWAY_TOKEN=fresh-file-token\n",
      );
      expect(gatewayEnvFile).toBe(legacyGatewayEnvFile);
    });
  });

  it("clears stale node file-backed managed keys without touching the gateway env file", async () => {
    await withStageFixture(async ({ env, unitPath, envFilePath, nodeEnvFilePath }) => {
      await fs.writeFile(envFilePath, "OPENCLAW_GATEWAY_TOKEN=stale-token\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.writeFile(nodeEnvFilePath, "OPENCLAW_GATEWAY_TOKEN=stale-node-token\n", {
        encoding: "utf8",
        mode: 0o600,
      });

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_SERVICE_KIND: "node",
        },
        environmentValueSources: {
          OPENCLAW_GATEWAY_TOKEN: "file",
        },
      });

      const unit = await fs.readFile(unitPath, "utf8");

      expect(unit).not.toContain("EnvironmentFile=");
      await expect(fs.access(nodeEnvFilePath)).rejects.toThrow();
      await expect(fs.readFile(envFilePath, "utf8")).resolves.toBe(
        "OPENCLAW_GATEWAY_TOKEN=stale-token\n",
      );
    });
  });

  it("does not re-stage unresolved inline-and-file values from preserved service env (#88274)", async () => {
    await withStageFixture(async ({ env, unitPath, envFilePath }) => {
      await fs.writeFile(envFilePath, "LLM_API_KEY=$SECRET_FROM_SHELL\n", {
        encoding: "utf8",
        mode: 0o600,
      });

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: {
          LLM_API_KEY: "$SECRET_FROM_SHELL",
          OPENCLAW_GATEWAY_PORT: "18789",
        },
        environmentValueSources: {
          LLM_API_KEY: "inline-and-file",
        },
      });

      const unit = await fs.readFile(unitPath, "utf8");
      expect(unit).not.toContain("EnvironmentFile=");
      expect(unit).not.toContain("LLM_API_KEY");
      expect(unit).not.toContain("$SECRET_FROM_SHELL");
      await expect(fs.access(envFilePath)).rejects.toThrow();
    });
  });

  it("sanitizes file-backed managed values out of the backup unit on re-stage", async () => {
    await withStageFixture(async ({ env, unitPath }) => {
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(
        unitPath,
        [
          "[Service]",
          "ExecStart=/usr/bin/openclaw node run",
          "Environment=FOO=bar OPENCLAW_GATEWAY_TOKEN=inline-token BAZ=qux",
          "Environment=OPENCLAW_GATEWAY_TOKEN=token-only-line",
          "Environment='OPENCLAW_GATEWAY_TOKEN=single-quoted-token' FROM_SINGLE=kept",
          "Environment=OPENCLAW_GATEWAY_PORT=18789",
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 },
      );
      await fs.chmod(unitPath, 0o600);

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_TOKEN: "fresh-token",
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_SERVICE_KIND: "node",
        },
        environmentValueSources: {
          OPENCLAW_GATEWAY_TOKEN: "file",
        },
      });

      const [unit, backupUnit, backupStat] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(`${unitPath}.bak`, "utf8"),
        fs.stat(`${unitPath}.bak`),
      ]);

      expect(unit).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=fresh-token");
      expect(backupUnit).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=inline-token");
      expect(backupUnit).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=token-only-line");
      expect(backupUnit).not.toContain("single-quoted-token");
      expect(backupUnit).toContain("Environment=FOO=bar BAZ=qux");
      expect(backupUnit).toContain("Environment=FROM_SINGLE=kept");
      expect(backupUnit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
      expect(backupStat.mode & 0o777).toBe(0o600);
    });
  });

  it("keeps inline overrides out of the generated env file", async () => {
    await withStageFixture(async ({ env, stateDir, unitPath, envFilePath }) => {
      await fs.writeFile(
        path.join(stateDir, ".env"),
        ["OPENCLAW_GATEWAY_TOKEN=stale-token", "LLM_API_KEY=dotenv-key"].join("\n"),
        "utf8",
      );

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_TOKEN: "fresh-token",
          LLM_API_KEY: "dotenv-key",
        },
      });

      const [unit, envFile] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(envFilePath, "utf8"),
      ]);

      expect(unit).toContain(`EnvironmentFile=-${envFilePath}`);
      expect(unit).toContain("Environment=OPENCLAW_GATEWAY_TOKEN=fresh-token");
      expect(envFile).toBe("LLM_API_KEY=dotenv-key\n");
    });
  });

  it("clears stale inline-managed keys from env file on re-stage (#76860)", async () => {
    await withStageFixture(async ({ env, stateDir, unitPath, envFilePath }) => {
      // Existing env file carries a stale OPENCLAW_GATEWAY_TOKEN that the
      // operator previously wrote there but staging now supplies inline.
      await fs.writeFile(
        envFilePath,
        ["OPENCLAW_GATEWAY_TOKEN=stale-gateway-token", "OPENROUTER_API_KEY=or-operator-key"].join(
          "\n",
        ) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      await fs.writeFile(path.join(stateDir, ".env"), "LLM_API_KEY=dotenv-key\n", "utf8");

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        // Staging manages OPENCLAW_GATEWAY_TOKEN inline; OPENCLAW_SERVICE_MANAGED_ENV_KEYS
        // marks it as an OpenClaw-managed key so the stale env-file copy is cleared.
        environment: {
          OPENCLAW_GATEWAY_TOKEN: "fresh-gateway-token",
          LLM_API_KEY: "dotenv-key",
          OPENROUTER_API_KEY: "or-operator-key",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENCLAW_GATEWAY_TOKEN",
        },
        environmentValueSources: {
          OPENCLAW_GATEWAY_TOKEN: "inline-and-file",
          LLM_API_KEY: "inline",
          OPENROUTER_API_KEY: "file",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "inline",
        },
      });

      const [unit, envFile] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(envFilePath, "utf8"),
      ]);
      // Stale inline-managed key must be removed from the env file so the
      // fresh inline Environment= value wins (EnvironmentFile would override it).
      expect(envFile).not.toContain("OPENCLAW_GATEWAY_TOKEN");
      // Operator-added key not managed inline must survive.
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
      expect(envFile).toContain("LLM_API_KEY=dotenv-key");
      expect(unit).toContain("Environment=OPENCLAW_GATEWAY_TOKEN=fresh-gateway-token");
      expect(unit).not.toContain("Environment=OPENROUTER_API_KEY=or-operator-key");
      expect(unit).not.toContain("Environment=LLM_API_KEY=dotenv-key");
    });
  });

  it("preserves operator secrets when incoming .env is empty (#76860)", async () => {
    await withStageFixture(async ({ env, envFilePath }) => {
      // Existing env file has only operator-added secrets; state-dir .env is absent/empty.
      await fs.writeFile(envFilePath, "OPENROUTER_API_KEY=or-operator-key\n", {
        encoding: "utf8",
        mode: 0o600,
      });

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

      const envFile = await fs.readFile(envFilePath, "utf8");
      // Operator-only secret must survive even when no dotenv vars are staged.
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
    });
  });

  it("preserves operator-added secrets in existing env file on re-stage (#76860)", async () => {
    await withStageFixture(async ({ env, stateDir, envFilePath }) => {
      // Simulate operator pre-populating gateway.systemd.env with provider API keys.
      await fs.writeFile(
        envFilePath,
        [
          "ANTHROPIC_API_KEY=sk-ant-operator-secret",
          "OPENROUTER_API_KEY=or-operator-key",
          "LLM_API_KEY=old-value",
        ].join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      // State-dir .env only provides LLM_API_KEY (not the provider secrets).
      await fs.writeFile(path.join(stateDir, ".env"), "LLM_API_KEY=new-value\n", "utf8");

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: { LLM_API_KEY: "new-value" },
      });

      const envFile = await fs.readFile(envFilePath, "utf8");
      // Operator secrets must survive; state-dir key gets updated value.
      expect(envFile).toContain("ANTHROPIC_API_KEY=sk-ant-operator-secret");
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
      expect(envFile).toContain("LLM_API_KEY=new-value");
    });
  });

  it("removes a stale literal reference on re-stage when state-dir .env now skips that key (#88274)", async () => {
    await withStageFixture(async ({ env, stateDir, envFilePath }) => {
      // A prior install generated a literal reference for LLM_API_KEY (an unexpanded
      // $VAR that dotenv stored verbatim) and an operator-managed provider secret.
      await fs.writeFile(
        envFilePath,
        ["LLM_API_KEY=$SECRET_FROM_SHELL", "OPENROUTER_API_KEY=or-operator-key"].join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      // The state-dir .env still declares LLM_API_KEY but now as an unresolved
      // shell reference, so the parser skips it from the managed environment.
      await fs.writeFile(path.join(stateDir, ".env"), "LLM_API_KEY=$SECRET_FROM_SHELL\n", "utf8");

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

      const envFile = await fs.readFile(envFilePath, "utf8");
      // The stale literal reference for the skipped managed key is dropped...
      expect(envFile).not.toContain("LLM_API_KEY");
      expect(envFile).not.toContain("$SECRET_FROM_SHELL");
      // ...while operator-only secrets (never in state-dir .env) are preserved.
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
    });
  });

  it("removes a stale literal reference after the state-dir .env line is removed (#88274)", async () => {
    await withStageFixture(async ({ env, envFilePath }) => {
      await fs.writeFile(
        envFilePath,
        ["LLM_API_KEY=$SECRET_FROM_SHELL", "OPENROUTER_API_KEY=or-operator-key"].join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

      const envFile = await fs.readFile(envFilePath, "utf8");
      expect(envFile).not.toContain("LLM_API_KEY");
      expect(envFile).not.toContain("$SECRET_FROM_SHELL");
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
    });
  });

  it("keeps an operator secret that merely shares a name absent from state-dir .env (#88274)", async () => {
    await withStageFixture(async ({ env, stateDir, envFilePath }) => {
      // Operator-managed env file holds two secrets; neither is in state-dir .env.
      await fs.writeFile(
        envFilePath,
        [
          "ANTHROPIC_API_KEY=sk-ant-operator-secret",
          "OPENROUTER_API_KEY=or-operator-key",
          "LOWERCASE_LITERAL_API_KEY=$ecret123",
        ].join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      // State-dir .env only skips an unrelated key (LLM_API_KEY). Operator keys must
      // not be treated as stale just because they are absent from the staged env.
      await fs.writeFile(path.join(stateDir, ".env"), "LLM_API_KEY=${UNRESOLVED}\n", "utf8");

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

      const envFile = await fs.readFile(envFilePath, "utf8");
      expect(envFile).toContain("ANTHROPIC_API_KEY=sk-ant-operator-secret");
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
      expect(envFile).toContain("LOWERCASE_LITERAL_API_KEY=$ecret123");
      expect(envFile).not.toContain("LLM_API_KEY");
    });
  });
});

describe("systemd service install and uninstall", () => {
  async function withNodeSystemdFixture(
    run: (context: {
      env: Record<string, string>;
      unitPath: string;
      nodeEnvFilePath: string;
    }) => Promise<void>,
  ): Promise<void> {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
      OPENCLAW_SERVICE_KIND: "node",
    };
    const unitPath = resolveSystemdUserUnitPath(env);
    const nodeEnvFilePath = path.join(stateDir, "node.systemd.env");

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await run({ env, unitPath, nodeEnvFilePath });
    } finally {
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
    findSystemGatewayServicesMock.mockReset();
    findSystemGatewayServicesMock.mockResolvedValue([]);
  });

  it("retires an active same-name system-scope gateway unit after staging a user unit", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-install-test",
    };
    const unitPath = resolveSystemdUserUnitPath(env);
    try {
      await fs.mkdir(stateDir, { recursive: true });
      const realAccess = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === "/etc/systemd/system/openclaw-gateway-install-test.service") {
          return undefined;
        }
        return await realAccess(pathname, mode);
      });
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-active", "--quiet", "openclaw-gateway-install-test.service"]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-enabled", "openclaw-gateway-install-test.service"]);
          cb(null, "enabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["disable", "--now", "openclaw-gateway-install-test.service"]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", "openclaw-gateway-install-test.service");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", "openclaw-gateway-install-test.service");
          cb(null, "", "");
        });

      const { write, stdout } = createWritableStreamMock();
      await installSystemdService({
        env,
        stdout,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
        },
      });

      await expect(fs.readFile(unitPath, "utf8")).resolves.toContain("openclaw gateway run");
      expect(write.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
        "Retired conflicting systemd service",
      );
      expect(execFileMock).toHaveBeenCalledTimes(7);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("leaves inactive disabled same-name system-scope unit files alone during user install", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-inactive-system-test",
    };
    const unitPath = resolveSystemdUserUnitPath(env);
    try {
      await fs.mkdir(stateDir, { recursive: true });
      const realAccess = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === "/etc/systemd/system/openclaw-gateway-inactive-system-test.service") {
          return undefined;
        }
        return await realAccess(pathname, mode);
      });
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual([
            "is-active",
            "--quiet",
            "openclaw-gateway-inactive-system-test.service",
          ]);
          cb(createExecFileError("inactive"), "", "inactive");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-enabled", "openclaw-gateway-inactive-system-test.service"]);
          cb(createExecFileError("disabled"), "disabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", "openclaw-gateway-inactive-system-test.service");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", "openclaw-gateway-inactive-system-test.service");
          cb(null, "", "");
        });

      const { write, stdout } = createWritableStreamMock();
      await installSystemdService({
        env,
        stdout,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
        },
      });

      await expect(fs.readFile(unitPath, "utf8")).resolves.toContain("openclaw gateway run");
      expect(write.mock.calls.map(([value]) => String(value)).join("\n")).not.toContain(
        "Retired conflicting systemd service",
      );
      expect(execFileMock).toHaveBeenCalledTimes(6);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("does not stop an active system unit when user install preflight fails", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-preflight-test",
    };
    try {
      await fs.mkdir(stateDir, { recursive: true });
      const realAccess = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === "/etc/systemd/system/openclaw-gateway-preflight-test.service") {
          return undefined;
        }
        return await realAccess(pathname, mode);
      });
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-active", "--quiet", "openclaw-gateway-preflight-test.service"]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-enabled", "openclaw-gateway-preflight-test.service"]);
          cb(null, "enabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(
            createExecFileError("Failed to connect to bus: Permission denied", {
              stderr: "Failed to connect to bus: Permission denied",
            }),
            "",
            "",
          );
        });

      await expect(
        installSystemdService({
          env,
          stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
          programArguments: ["/usr/bin/openclaw", "gateway", "run"],
          workingDirectory: "/tmp",
          environment: {
            OPENCLAW_GATEWAY_PORT: "18789",
          },
        }),
      ).rejects.toThrow(
        "systemctl --user unavailable: Failed to connect to bus: Permission denied",
      );

      expect(execFileMock).toHaveBeenCalledTimes(3);
      expect(execFileMock.mock.calls.some(([, args]) => args[0] === "disable")).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("retires an active marker-owned custom system unit during user install", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
    };
    try {
      await fs.mkdir(stateDir, { recursive: true });
      findSystemGatewayServicesMock.mockResolvedValueOnce([
        {
          platform: "linux",
          label: "openclaw.service",
          detail: "unit: /etc/systemd/system/openclaw.service",
          scope: "system",
          marker: "openclaw",
        },
      ]);
      mockSystemUnitFiles({
        "/etc/systemd/system/openclaw.service": renderCustomGatewayUnit({
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
          OPENCLAW_PROFILE: "default",
          OPENCLAW_GATEWAY_PORT: "18789",
        }),
      });
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-active", "--quiet", "openclaw.service"]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-enabled", "openclaw.service"]);
          cb(null, "enabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["disable", "--now", "openclaw.service"]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", GATEWAY_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", GATEWAY_SERVICE);
          cb(null, "", "");
        });

      const { write, stdout } = createWritableStreamMock();
      await installSystemdService({
        env,
        stdout,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
        },
      });

      expect(write.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
        "openclaw.service (/etc/systemd/system/openclaw.service)",
      );
      expect(execFileMock).toHaveBeenCalledTimes(7);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("installSystemdService does not retire a profile-mismatched marker-owned custom system unit during user install", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
    };
    try {
      await fs.mkdir(stateDir, { recursive: true });
      findSystemGatewayServicesMock.mockResolvedValueOnce([
        {
          platform: "linux",
          label: "openclaw-staging.service",
          detail: "unit: /etc/systemd/system/openclaw-staging.service",
          scope: "system",
          marker: "openclaw",
        },
      ]);
      mockSystemUnitFiles({
        "/etc/systemd/system/openclaw-staging.service": renderCustomGatewayUnit({
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
          OPENCLAW_PROFILE: "staging",
          OPENCLAW_GATEWAY_PORT: "18789",
        }),
      });
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", GATEWAY_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", GATEWAY_SERVICE);
          cb(null, "", "");
        });

      const { write, stdout } = createWritableStreamMock();
      await installSystemdService({
        env,
        stdout,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
        },
      });

      const output = write.mock.calls.map(([value]) => String(value)).join("\n");
      expect(output).not.toContain("Retired conflicting systemd service");
      expect(execFileMock.mock.calls.some(([, args]) => args[0] === "disable")).toBe(false);
      expect(execFileMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("installSystemdService retires a marker-owned custom system unit when the gateway port comes from the install options environment", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
    };
    try {
      await fs.mkdir(stateDir, { recursive: true });
      findSystemGatewayServicesMock.mockResolvedValueOnce([
        {
          platform: "linux",
          label: "openclaw-alt-port.service",
          detail: "unit: /etc/systemd/system/openclaw-alt-port.service",
          scope: "system",
          marker: "openclaw",
        },
      ]);
      mockSystemUnitFiles({
        "/etc/systemd/system/openclaw-alt-port.service": renderCustomGatewayUnit({
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
          OPENCLAW_PROFILE: "default",
          OPENCLAW_GATEWAY_PORT: "28888",
        }),
      });
      execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
        const joined = args.join(" ");
        if (joined === "--user status" || joined === "--user daemon-reload") {
          cb(null, "", "");
          return;
        }
        if (
          joined === "--user enable openclaw-gateway.service" ||
          joined === "--user restart openclaw-gateway.service"
        ) {
          cb(null, "", "");
          return;
        }
        if (joined === "is-active --quiet openclaw-alt-port.service") {
          cb(null, "", "");
          return;
        }
        if (joined === "is-enabled openclaw-alt-port.service") {
          cb(null, "enabled\n", "");
          return;
        }
        if (joined === "disable --now openclaw-alt-port.service") {
          cb(null, "", "");
          return;
        }
        cb(null, "", "");
      });

      const { write, stdout } = createWritableStreamMock();
      await installSystemdService({
        env,
        stdout,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_PORT: "28888",
        },
      });

      const output = write.mock.calls.map(([value]) => String(value)).join("\n");
      expect(output).toContain("Retired conflicting systemd service");
      expect(output).toContain("openclaw-alt-port.service");
      expect(execFileMock).toHaveBeenCalledTimes(7);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("removes newly staged user unit files when system unit retirement fails", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-retire-failure-test",
    };
    const unitPath = resolveSystemdUserUnitPath(env);
    const envFilePath = path.join(stateDir, "gateway.systemd.env");
    try {
      await fs.mkdir(stateDir, { recursive: true });
      const realAccess = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === "/etc/systemd/system/openclaw-gateway-retire-failure-test.service") {
          return undefined;
        }
        return await realAccess(pathname, mode);
      });
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual([
            "is-active",
            "--quiet",
            "openclaw-gateway-retire-failure-test.service",
          ]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-enabled", "openclaw-gateway-retire-failure-test.service"]);
          cb(null, "enabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual([
            "disable",
            "--now",
            "openclaw-gateway-retire-failure-test.service",
          ]);
          cb(createExecFileError("permission denied"), "", "permission denied");
        });

      await expect(
        installSystemdService({
          env,
          stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
          programArguments: ["/usr/bin/openclaw", "gateway", "run"],
          workingDirectory: "/tmp",
          environment: {
            OPENCLAW_GATEWAY_TOKEN: "replacement-token",
            OPENCLAW_GATEWAY_PORT: "18789",
          },
          environmentValueSources: {
            OPENCLAW_GATEWAY_TOKEN: "file",
          },
        }),
      ).rejects.toThrow(
        /system-scope openclaw-gateway-retire-failure-test\.service already exists/,
      );

      await expect(fs.access(unitPath)).rejects.toThrow();
      await expect(fs.access(envFilePath)).rejects.toThrow();
      expect(execFileMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("restores the system unit when replacement user activation fails", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-activation-test",
    };
    try {
      await fs.mkdir(stateDir, { recursive: true });
      const realAccess = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === "/etc/systemd/system/openclaw-gateway-activation-test.service") {
          return undefined;
        }
        return await realAccess(pathname, mode);
      });
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual([
            "is-active",
            "--quiet",
            "openclaw-gateway-activation-test.service",
          ]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-enabled", "openclaw-gateway-activation-test.service"]);
          cb(null, "enabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["disable", "--now", "openclaw-gateway-activation-test.service"]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", "openclaw-gateway-activation-test.service");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", "openclaw-gateway-activation-test.service");
          cb(createExecFileError("restart failed"), "", "bad environment");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(
            args,
            "disable",
            "--now",
            "openclaw-gateway-activation-test.service",
          );
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["enable", "--now", "openclaw-gateway-activation-test.service"]);
          cb(null, "", "");
        });

      await expect(
        installSystemdService({
          env,
          stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
          programArguments: ["/usr/bin/openclaw", "gateway", "run"],
          workingDirectory: "/tmp",
          environment: {
            OPENCLAW_GATEWAY_PORT: "18789",
          },
        }),
      ).rejects.toThrow("systemctl restart failed: bad environment");

      expect(execFileMock).toHaveBeenCalledTimes(9);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("restores the custom system unit when replacement user cleanup fails", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
    };
    try {
      await fs.mkdir(stateDir, { recursive: true });
      findSystemGatewayServicesMock.mockResolvedValueOnce([
        {
          platform: "linux",
          label: "openclaw.service",
          detail: "unit: /etc/systemd/system/openclaw.service",
          scope: "system",
          marker: "openclaw",
        },
      ]);
      mockSystemUnitFiles({
        "/etc/systemd/system/openclaw.service": renderCustomGatewayUnit({
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
          OPENCLAW_PROFILE: "default",
          OPENCLAW_GATEWAY_PORT: "18789",
        }),
      });
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-active", "--quiet", "openclaw.service"]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-enabled", "openclaw.service"]);
          cb(null, "enabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["disable", "--now", "openclaw.service"]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", GATEWAY_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", GATEWAY_SERVICE);
          cb(createExecFileError("restart failed"), "", "bad environment");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "disable", "--now", GATEWAY_SERVICE);
          cb(createExecFileError("user bus unavailable"), "", "user bus unavailable");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["enable", "--now", "openclaw.service"]);
          cb(null, "", "");
        });

      await expect(
        installSystemdService({
          env,
          stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
          programArguments: ["/usr/bin/openclaw", "gateway", "run"],
          workingDirectory: "/tmp",
          environment: {
            OPENCLAW_GATEWAY_PORT: "18789",
          },
        }),
      ).rejects.toThrow(
        "systemctl restart failed: bad environment; failed to disable replacement user unit openclaw-gateway.service: user bus unavailable",
      );

      expect(execFileMock).toHaveBeenCalledTimes(9);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("restores an enabled inactive system unit without starting it when user activation fails", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-enabled-inactive-test",
    };
    try {
      await fs.mkdir(stateDir, { recursive: true });
      const realAccess = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === "/etc/systemd/system/openclaw-gateway-enabled-inactive-test.service") {
          return undefined;
        }
        return await realAccess(pathname, mode);
      });
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual([
            "is-active",
            "--quiet",
            "openclaw-gateway-enabled-inactive-test.service",
          ]);
          cb(createExecFileError("inactive", { code: 3 }), "", "inactive");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-enabled", "openclaw-gateway-enabled-inactive-test.service"]);
          cb(null, "enabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual([
            "disable",
            "--now",
            "openclaw-gateway-enabled-inactive-test.service",
          ]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", "openclaw-gateway-enabled-inactive-test.service");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(
            args,
            "restart",
            "openclaw-gateway-enabled-inactive-test.service",
          );
          cb(createExecFileError("restart failed"), "", "bad environment");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(
            args,
            "disable",
            "--now",
            "openclaw-gateway-enabled-inactive-test.service",
          );
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["enable", "openclaw-gateway-enabled-inactive-test.service"]);
          cb(null, "", "");
        });

      await expect(
        installSystemdService({
          env,
          stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
          programArguments: ["/usr/bin/openclaw", "gateway", "run"],
          workingDirectory: "/tmp",
          environment: {
            OPENCLAW_GATEWAY_PORT: "18789",
          },
        }),
      ).rejects.toThrow("systemctl restart failed: bad environment");

      expect(execFileMock).toHaveBeenCalledTimes(9);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("restores an active disabled system unit without enabling it when user activation fails", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-active-disabled-test",
    };
    try {
      await fs.mkdir(stateDir, { recursive: true });
      const realAccess = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === "/etc/systemd/system/openclaw-gateway-active-disabled-test.service") {
          return undefined;
        }
        return await realAccess(pathname, mode);
      });
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual([
            "is-active",
            "--quiet",
            "openclaw-gateway-active-disabled-test.service",
          ]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-enabled", "openclaw-gateway-active-disabled-test.service"]);
          cb(createExecFileError("disabled", { code: 1 }), "disabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual([
            "disable",
            "--now",
            "openclaw-gateway-active-disabled-test.service",
          ]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", "openclaw-gateway-active-disabled-test.service");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", "openclaw-gateway-active-disabled-test.service");
          cb(createExecFileError("restart failed"), "", "bad environment");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(
            args,
            "disable",
            "--now",
            "openclaw-gateway-active-disabled-test.service",
          );
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["start", "openclaw-gateway-active-disabled-test.service"]);
          cb(null, "", "");
        });

      await expect(
        installSystemdService({
          env,
          stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
          programArguments: ["/usr/bin/openclaw", "gateway", "run"],
          workingDirectory: "/tmp",
          environment: {
            OPENCLAW_GATEWAY_PORT: "18789",
          },
        }),
      ).rejects.toThrow("systemctl restart failed: bad environment");

      expect(execFileMock).toHaveBeenCalledTimes(9);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("activates the OPENCLAW_SYSTEMD_UNIT override during install", async () => {
    await withNodeSystemdFixture(async ({ env, unitPath }) => {
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", NODE_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", NODE_SERVICE);
          cb(null, "", "");
        });

      await installSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        },
      });

      const unit = await fs.readFile(unitPath, "utf8");
      expect(unitPath).toMatch(/openclaw-node\.service$/);
      expect(unit).toContain("openclaw node run");
      expect(execFileMock).toHaveBeenCalledTimes(4);
    });
  });

  it("retries enable after reloading again when systemd cannot see the written unit yet", async () => {
    await withNodeSystemdFixture(async ({ env }) => {
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", NODE_SERVICE);
          cb(
            createExecFileError("enable failed"),
            "",
            "Unit file openclaw-node.service does not exist.",
          );
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", NODE_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", NODE_SERVICE);
          cb(null, "", "");
        });

      await installSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        },
      });

      expect(execFileMock).toHaveBeenCalledTimes(6);
    });
  });

  it("falls back to machine user scope when install activation hits a no-medium user bus failure", async () => {
    await withNodeSystemdFixture(async ({ env }) => {
      const installEnv = { ...env, USER: "debian" };
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", NODE_SERVICE);
          cb(
            createExecFileError("Failed to connect to bus: No medium found", {
              stderr: "Failed to connect to bus: No medium found",
            }),
            "",
            "",
          );
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "debian", "enable", NODE_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", NODE_SERVICE);
          cb(null, "", "");
        });

      await installSystemdService({
        env: installEnv,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        },
      });

      expect(execFileMock).toHaveBeenCalledTimes(5);
    });
  });

  it("uses the sudo-u target user for install activation machine-scope retry", async () => {
    await withNodeSystemdFixture(async ({ env }) => {
      mockEffectiveUid(1000);
      const installEnv = { ...env, USER: "openclaw", SUDO_USER: "admin" };
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", NODE_SERVICE);
          cb(
            createExecFileError("Failed to connect to bus: No medium found", {
              stderr: "Failed to connect to bus: No medium found",
            }),
            "",
            "",
          );
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "openclaw", "enable", NODE_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", NODE_SERVICE);
          cb(null, "", "");
        });

      await installSystemdService({
        env: installEnv,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        },
      });

      expect(execFileMock).toHaveBeenCalledTimes(5);
    });
  });

  it("surfaces install activation user-bus failures as systemd unavailable errors", async () => {
    await withNodeSystemdFixture(async ({ env }) => {
      vi.spyOn(os, "userInfo").mockImplementation(() => {
        throw new Error("no user info");
      });
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", NODE_SERVICE);
          cb(
            createExecFileError("Failed to connect to bus: No medium found", {
              stderr: "Failed to connect to bus: No medium found",
            }),
            "",
            "",
          );
        });

      await expect(
        installSystemdService({
          env,
          stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
          programArguments: ["/usr/bin/openclaw", "node", "run"],
          workingDirectory: "/tmp",
          environment: {
            OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
          },
        }),
      ).rejects.toThrow("systemctl --user unavailable: Failed to connect to bus: No medium found");

      expect(execFileMock).toHaveBeenCalledTimes(3);
    });
  });

  it("disables the OPENCLAW_SYSTEMD_UNIT override during uninstall", async () => {
    await withNodeSystemdFixture(async ({ env, unitPath, nodeEnvFilePath }) => {
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, "[Unit]\nDescription=OpenClaw Node\n", "utf8");
      await fs.writeFile(
        nodeEnvFilePath,
        "OPENCLAW_GATEWAY_TOKEN=stale-node-token\nOPENROUTER_API_KEY=operator-key\n",
        { encoding: "utf8", mode: 0o600 },
      );

      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "disable", "--now", NODE_SERVICE);
          cb(null, "", "");
        });

      const { write, stdout } = createWritableStreamMock();
      await uninstallSystemdService({ env, stdout });

      let accessError: NodeJS.ErrnoException | undefined;
      try {
        await fs.access(unitPath);
      } catch (error) {
        accessError = error as NodeJS.ErrnoException;
      }
      expect(accessError?.code).toBe("ENOENT");
      await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toBe(
        "OPENROUTER_API_KEY=operator-key\n",
      );
      expect(requireFirstWrite(write)).toContain("Removed systemd service");
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });
  });

  it("preserves node env file values when unit removal fails during uninstall", async () => {
    await withNodeSystemdFixture(async ({ env, unitPath, nodeEnvFilePath }) => {
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, "[Unit]\nDescription=OpenClaw Node\n", "utf8");
      await fs.writeFile(
        nodeEnvFilePath,
        "OPENCLAW_GATEWAY_TOKEN=stale-node-token\nOPENROUTER_API_KEY=operator-key\n",
        { encoding: "utf8", mode: 0o600 },
      );

      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "disable", "--now", NODE_SERVICE);
          cb(null, "", "");
        });

      const unlinkError = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      unlinkError.code = "EACCES";
      vi.spyOn(fs, "unlink").mockRejectedValueOnce(unlinkError);

      const { stdout } = createWritableStreamMock();
      await expect(uninstallSystemdService({ env, stdout })).rejects.toThrow(
        "EACCES: permission denied",
      );

      await expect(fs.readFile(unitPath, "utf8")).resolves.toContain("OpenClaw Node");
      await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toBe(
        "OPENCLAW_GATEWAY_TOKEN=stale-node-token\nOPENROUTER_API_KEY=operator-key\n",
      );
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe("systemd service control", () => {
  const assertMachineRestartArgs = (args: string[]) => {
    assertMachineUserSystemctlArgs(args, "debian", "restart", GATEWAY_SERVICE);
  };

  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("stops the resolved user unit", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, "", ""))
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "stop", GATEWAY_SERVICE);
        cb(null, "", "");
      });
    const write = vi.fn();
    const stdout = { write } as unknown as NodeJS.WritableStream;

    await stopSystemdService({ stdout, env: {} });

    expect(write).toHaveBeenCalledTimes(1);
    expect(requireFirstWrite(write)).toContain("Stopped systemd service");
  });

  it("allows stop when systemd status is degraded but available", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) =>
        cb(
          createExecFileError("degraded", { stderr: "degraded\nsome-unit.service failed" }),
          "",
          "",
        ),
      )
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "stop", GATEWAY_SERVICE);
        cb(null, "", "");
      });

    await stopSystemdService({
      stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      env: {},
    });
  });

  it("restarts a profile-specific user unit", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, "", ""))
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "restart", "openclaw-gateway-work.service");
        cb(null, "", "");
      });
    await assertRestartSuccess({ OPENCLAW_PROFILE: "work" });
  });

  it("retires a conflicting user unit before restarting the active system unit", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-control-"));
    const home = path.join(tempHomeRoot, "home");
    const userUnitPath = path.join(home, ".config", "systemd", "user", GATEWAY_SERVICE);
    try {
      await fs.mkdir(path.dirname(userUnitPath), { recursive: true });
      await fs.writeFile(userUnitPath, "[Unit]\nDescription=OpenClaw Gateway\n", "utf8");
      const realAccess = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === "/etc/systemd/system/openclaw-gateway.service") {
          return undefined;
        }
        return await realAccess(pathname, mode);
      });
      mockEffectiveUid(0);
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "debian", "is-active", "--quiet", GATEWAY_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "debian", "is-enabled", GATEWAY_SERVICE);
          cb(null, "enabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "debian", "disable", "--now", GATEWAY_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["restart", GATEWAY_SERVICE]);
          cb(null, "", "");
        });

      const { write, stdout } = createWritableStreamMock();
      await restartSystemdService({ stdout, env: { HOME: home, SUDO_USER: "debian" } });

      await expect(fs.access(userUnitPath)).rejects.toThrow();
      expect(requireFirstWrite(write)).toContain("Retired conflicting systemd service");
      expect(write.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
        "Restarted systemd service",
      );
      expect(execFileMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("keeps system restart successful when retired user unit cleanup fails", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-control-"));
    const home = path.join(tempHomeRoot, "home");
    const userUnitPath = path.join(home, ".config", "systemd", "user", GATEWAY_SERVICE);
    try {
      await fs.mkdir(path.dirname(userUnitPath), { recursive: true });
      await fs.writeFile(userUnitPath, "[Unit]\nDescription=OpenClaw Gateway\n", "utf8");
      const realAccess = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === "/etc/systemd/system/openclaw-gateway.service") {
          return undefined;
        }
        return await realAccess(pathname, mode);
      });
      const realUnlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation(async (pathname) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === userUnitPath) {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return await realUnlink(pathname);
      });
      mockEffectiveUid(0);
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "debian", "is-active", "--quiet", GATEWAY_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "debian", "is-enabled", GATEWAY_SERVICE);
          cb(null, "enabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "debian", "disable", "--now", GATEWAY_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["restart", GATEWAY_SERVICE]);
          cb(null, "", "");
        });

      const { write, stdout } = createWritableStreamMock();
      await restartSystemdService({ stdout, env: { HOME: home, SUDO_USER: "debian" } });

      const output = write.mock.calls.map(([value]) => String(value)).join("\n");
      expect(output).toContain("Could not retire conflicting systemd service");
      expect(output).toContain("permission denied");
      expect(output).toContain("Restarted systemd service");
      expect(execFileMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("keeps a conflicting user unit when non-root restart needs sudo for the system unit", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-control-"));
    const home = path.join(tempHomeRoot, "home");
    const userUnitPath = path.join(home, ".config", "systemd", "user", GATEWAY_SERVICE);
    try {
      await fs.mkdir(path.dirname(userUnitPath), { recursive: true });
      await fs.writeFile(userUnitPath, "[Unit]\nDescription=OpenClaw Gateway\n", "utf8");
      const realAccess = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === "/etc/systemd/system/openclaw-gateway.service") {
          return undefined;
        }
        return await realAccess(pathname, mode);
      });
      mockEffectiveUid(1000);
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "disable", "--now", GATEWAY_SERVICE);
          cb(null, "", "");
        });

      const { stdout } = createWritableStreamMock();
      await expect(restartSystemdService({ stdout, env: { HOME: home } })).rejects.toThrow(
        /openclaw-gateway\.service is a system-scope unit .*sudo systemctl restart openclaw-gateway\.service/,
      );

      await expect(fs.access(userUnitPath)).resolves.toBeUndefined();
      expect(execFileMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("does not fail a system restart when pre-action user-unit retirement fails", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-control-"));
    const home = path.join(tempHomeRoot, "home");
    const userUnitPath = path.join(home, ".config", "systemd", "user", GATEWAY_SERVICE);
    try {
      await fs.mkdir(path.dirname(userUnitPath), { recursive: true });
      await fs.writeFile(userUnitPath, "[Unit]\nDescription=OpenClaw Gateway\n", "utf8");
      const realAccess = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === "/etc/systemd/system/openclaw-gateway.service") {
          return undefined;
        }
        return await realAccess(pathname, mode);
      });
      mockEffectiveUid(0);
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "debian", "is-active", "--quiet", GATEWAY_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "debian", "is-enabled", GATEWAY_SERVICE);
          cb(null, "enabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "debian", "disable", "--now", GATEWAY_SERVICE);
          cb(
            createExecFileError("Failed to connect to bus", {
              stderr: "Failed to connect to bus",
            }),
            "",
            "Failed to connect to bus",
          );
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["restart", GATEWAY_SERVICE]);
          cb(null, "", "");
        });

      const { write, stdout } = createWritableStreamMock();
      await restartSystemdService({ stdout, env: { HOME: home, SUDO_USER: "debian" } });

      await expect(fs.access(userUnitPath)).resolves.toBeUndefined();
      const output = write.mock.calls.map(([value]) => String(value)).join("\n");
      expect(output).toContain("Could not retire conflicting systemd service");
      expect(output).toContain("Failed to connect to bus");
      expect(output).toContain("Restarted systemd service");
      expect(execFileMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("restores a retired user unit when root restart of the system unit fails", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-control-"));
    const home = path.join(tempHomeRoot, "home");
    const userUnitPath = path.join(home, ".config", "systemd", "user", GATEWAY_SERVICE);
    try {
      await fs.mkdir(path.dirname(userUnitPath), { recursive: true });
      await fs.writeFile(userUnitPath, "[Unit]\nDescription=OpenClaw Gateway\n", "utf8");
      const realAccess = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        const pathValue = pathLikeToString(pathname);
        if (pathValue === "/etc/systemd/system/openclaw-gateway.service") {
          return undefined;
        }
        return await realAccess(pathname, mode);
      });
      mockEffectiveUid(0);
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "is-active", "--quiet", GATEWAY_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "is-enabled", GATEWAY_SERVICE);
          cb(null, "enabled\n", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "disable", "--now", GATEWAY_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["restart", GATEWAY_SERVICE]);
          cb(createExecFileError("restart failed"), "", "permission denied");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", "--now", GATEWAY_SERVICE);
          cb(null, "", "");
        });

      const { stdout } = createWritableStreamMock();
      await expect(restartSystemdService({ stdout, env: { HOME: home } })).rejects.toThrow(
        "systemctl restart failed: permission denied",
      );

      await expect(fs.access(userUnitPath)).resolves.toBeUndefined();
      expect(execFileMock).toHaveBeenCalledTimes(6);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
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

  it("throws the user-bus error before stop when systemd is unavailable", async () => {
    vi.spyOn(os, "userInfo").mockImplementationOnce(() => {
      throw new Error("no user info");
    });
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(
        createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
        "",
        "",
      );
    });

    await expect(
      stopSystemdService({
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        env: { USER: "", LOGNAME: "" },
      }),
    ).rejects.toThrow("systemctl --user unavailable: Failed to connect to bus");
  });

  it("targets the sudo caller's user scope when SUDO_USER is set", async () => {
    mockEffectiveUid(0);
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertMachineUserSystemctlArgs(args, "debian", "status");
        cb(null, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertMachineRestartArgs(args);
        cb(null, "", "");
      });
    await assertRestartSuccess({ SUDO_USER: "debian" });
  });

  it("keeps direct --user scope when SUDO_USER is root", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "status");
        cb(null, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "restart", GATEWAY_SERVICE);
        cb(null, "", "");
      });
    await assertRestartSuccess({ SUDO_USER: "root", USER: "root" });
  });

  it("falls back to machine user scope for restart when user bus env is missing", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "status");
        const err = createExecFileError("Failed to connect to user scope bus", {
          stderr:
            "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
        });
        cb(err, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertMachineUserSystemctlArgs(args, "debian", "status");
        cb(null, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "restart", GATEWAY_SERVICE);
        const err = createExecFileError("Failed to connect to user scope bus", {
          stderr: "Failed to connect to user scope bus",
        });
        cb(err, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertMachineRestartArgs(args);
        cb(null, "", "");
      });
    await assertRestartSuccess({ USER: "debian" });
  });
});
