import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessExecFile } = await import("../../test/helpers/node-builtin-mocks.js");
  return mockNodeChildProcessExecFile(
    Object.assign(execFileMock, {
      __promisify__: vi.fn(),
    }) as typeof import("node:child_process").execFile,
  );
});

import path from "node:path";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import { parseSystemdExecStart } from "./systemd-unit.js";
import {
  isNonFatalSystemdInstallProbeError,
  isSystemdServiceEnabled,
  isSystemdUserServiceAvailable,
  parseSystemdShow,
  readSystemdServiceExecStart,
  restartSystemdService,
  resolveSystemdUserManagedDropInPath,
  resolveSystemdUserUnitPath,
  stageSystemdService,
  stopSystemdService,
} from "./systemd.js";

type ExecFileError = Error & {
  stderr?: string;
  code?: string | number;
};

const TEST_SERVICE_HOME = "/home/test";
const TEST_MANAGED_HOME = "/tmp/openclaw-test-home";
const GATEWAY_SERVICE = "openclaw-gateway.service";

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

async function readManagedServiceEnabled(env: NodeJS.ProcessEnv = { HOME: TEST_MANAGED_HOME }) {
  vi.spyOn(fs, "access").mockResolvedValue(undefined);
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
  expect(String(write.mock.calls[0]?.[0])).toContain("Restarted systemd service");
};

describe("systemd unit path resolution", () => {
  it("rejects path-like OPENCLAW_SYSTEMD_UNIT overrides", () => {
    expect(() =>
      resolveSystemdUserUnitPath({
        HOME: TEST_SERVICE_HOME,
        OPENCLAW_SYSTEMD_UNIT: "../../.ssh/authorized_keys",
      }),
    ).toThrow("OPENCLAW_SYSTEMD_UNIT must be a systemd service name");
  });

  it("accepts plain unit-name overrides with an optional service suffix", () => {
    expect(
      resolveSystemdUserUnitPath({
        HOME: TEST_SERVICE_HOME,
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-custom.service",
      }),
    ).toBe("/home/test/.config/systemd/user/openclaw-gateway-custom.service");
  });
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
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["--user", "is-enabled", "openclaw-gateway.service"]);
        const err = new Error("Failed to connect to bus") as Error & { code?: number };
        err.code = 1;
        cb(err, "", "Failed to connect to bus");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args[0]).toBe("--machine");
        expect(String(args[1])).toMatch(/^[^@]+@$/);
        expect(args.slice(2)).toEqual(["--user", "is-enabled", "openclaw-gateway.service"]);
        const err = new Error("permission denied") as Error & { code?: number };
        err.code = 1;
        cb(err, "", "permission denied");
      });
    await expect(
      isSystemdServiceEnabled({ env: { HOME: "/tmp/openclaw-test-home" } }),
    ).rejects.toThrow("systemctl is-enabled unavailable: permission denied");
  });

  it("returns false when systemctl is-enabled exits with code 4 (not-found)", async () => {
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      // On Ubuntu 24.04, `systemctl --user is-enabled <unit>` exits with
      // code 4 and prints "not-found" to stdout when the unit doesn't exist.
      const err = new Error(
        "Command failed: systemctl --user is-enabled openclaw-gateway.service",
      ) as Error & { code?: number };
      err.code = 4;
      cb(err, "not-found\n", "");
    });
    const result = await isSystemdServiceEnabled({ env: { HOME: "/tmp/openclaw-test-home" } });
    expect(result).toBe(false);
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
    // Main unit + managed drop-in probe (absent here) + resolved env file.
    expect(readFileSpy).toHaveBeenCalledTimes(3);
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
    expect(command?.environmentValueSources?.OPENCLAW_GATEWAY_TOKEN).toBe("file");
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

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await run({ env, stateDir, unitPath, envFilePath });
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
    expect(String(write.mock.calls[0]?.[0])).toContain("Stopped systemd service");
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

describe("stageSystemdService drop-in migration", () => {
  const tempHomes: string[] = [];

  beforeEach(() => {
    // Clear fs.readFile spies from earlier describe blocks so this one runs
    // against real fs. We want real file-write behavior here — only the
    // systemctl probe should be mocked.
    vi.restoreAllMocks();
    execFileMock.mockReset();
    // Every writeSystemdUnit path asserts systemd is available before touching
    // disk. Return success for any systemctl call so the integration can focus
    // on file-write behavior.
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, "", "");
    });
  });

  afterEach(async () => {
    const cleanupTargets = tempHomes.splice(0);
    await Promise.all(
      cleanupTargets.map(async (tmpHome) => {
        await fs.rm(tmpHome, { recursive: true, force: true });
      }),
    );
  });

  async function makeTempHome(): Promise<string> {
    const tmpRoot = os.tmpdir();
    const tmpHome = await fs.mkdtemp(path.join(tmpRoot, "openclaw-systemd-test-"));
    tempHomes.push(tmpHome);
    return tmpHome;
  }

  it("writes main unit + managed drop-in on a fresh install", async () => {
    const tmpHome = await makeTempHome();
    const env = { HOME: tmpHome };
    const { stdout } = createWritableStreamMock();

    await stageSystemdService({
      env,
      stdout,
      description: "OpenClaw Gateway",
      programArguments: [
        "/usr/bin/node",
        "/opt/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "fresh-token",
        OPENCLAW_SERVICE_VERSION: "2026.4.12",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENCLAW_GATEWAY_TOKEN,OPENCLAW_SERVICE_VERSION",
        HOME: tmpHome,
        PATH: "/usr/bin",
      },
    });

    const unitPath = resolveSystemdUserUnitPath(env);
    const dropInPath = resolveSystemdUserManagedDropInPath(env);
    const unitText = await fs.readFile(unitPath, "utf8");
    const [dropInText, dropInStat] = await Promise.all([
      fs.readFile(dropInPath, "utf8"),
      fs.stat(dropInPath),
    ]);

    // Main unit has non-managed env inline but no managed keys or sentinel.
    expect(unitText).toContain(
      "ExecStart=/usr/bin/node /opt/openclaw/dist/index.js gateway --port 18789",
    );
    expect(unitText).toContain(`Environment=HOME=${tmpHome}`);
    expect(unitText).toContain("Environment=PATH=/usr/bin");
    expect(unitText).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(unitText).not.toContain("OPENCLAW_SERVICE_MANAGED_ENV_KEYS");

    // Drop-in carries the managed keys + sentinel.
    expect(dropInText).toContain("Environment=OPENCLAW_GATEWAY_TOKEN=fresh-token");
    expect(dropInText).toContain("Environment=OPENCLAW_SERVICE_VERSION=2026.4.12");
    expect(dropInText).toContain(
      "Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENCLAW_GATEWAY_TOKEN,OPENCLAW_SERVICE_VERSION",
    );
    expect(dropInText).toContain("Auto-managed by openclaw");
    expect(dropInStat.mode & 0o777).toBe(0o600);
  });

  it("migrates inline managed env out of a legacy unit while preserving user EnvironmentFile= and Environment=", async () => {
    const tmpHome = await makeTempHome();
    const env = { HOME: tmpHome };
    const { stdout } = createWritableStreamMock();

    // Seed a legacy-style unit with inline managed env + user customizations.
    const unitPath = resolveSystemdUserUnitPath(env);
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    const legacyUnit = [
      "[Unit]",
      "Description=OpenClaw Gateway (v2026.4.11)",
      "",
      "[Service]",
      "ExecStart=/usr/bin/node /opt/openclaw/dist/entry.js gateway --port 18789",
      "Restart=always",
      "Environment=OPENCLAW_GATEWAY_TOKEN=legacy-token",
      "Environment=OPENCLAW_SERVICE_VERSION=2026.4.11",
      `EnvironmentFile=${tmpHome}/.openclaw/workspace/.env`,
      `Environment=HOME=${tmpHome}`,
      "Environment=USER_ADDED_VAR=keep-this",
      "Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENCLAW_GATEWAY_TOKEN,OPENCLAW_SERVICE_VERSION",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    await fs.writeFile(unitPath, legacyUnit, "utf8");

    await stageSystemdService({
      env,
      stdout,
      description: "OpenClaw Gateway",
      // Entry filename intentionally bumped entry.js -> index.js to verify
      // the targeted ExecStart update hits only that line.
      programArguments: [
        "/usr/bin/node",
        "/opt/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "rotated-token",
        OPENCLAW_SERVICE_VERSION: "2026.4.12",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENCLAW_GATEWAY_TOKEN,OPENCLAW_SERVICE_VERSION",
        HOME: tmpHome,
      },
    });

    const dropInPath = resolveSystemdUserManagedDropInPath(env);
    const unitText = await fs.readFile(unitPath, "utf8");
    const dropInText = await fs.readFile(dropInPath, "utf8");

    // Managed env is gone from the main unit.
    expect(unitText).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(unitText).not.toContain("OPENCLAW_SERVICE_VERSION=");
    expect(unitText).not.toContain("OPENCLAW_SERVICE_MANAGED_ENV_KEYS");

    // User customizations survived migration byte-for-byte.
    expect(unitText).toContain(`EnvironmentFile=${tmpHome}/.openclaw/workspace/.env`);
    expect(unitText).toContain("Environment=USER_ADDED_VAR=keep-this");
    expect(unitText).toContain(`Environment=HOME=${tmpHome}`);
    expect(unitText).toContain("[Install]");
    expect(unitText).toContain("WantedBy=default.target");

    // ExecStart was updated (entry.js -> index.js) without touching anything
    // else on that line or adjacent lines.
    expect(unitText).toContain(
      "ExecStart=/usr/bin/node /opt/openclaw/dist/index.js gateway --port 18789",
    );
    expect(unitText).not.toContain("dist/entry.js");

    // Drop-in holds the rotated managed values; old values are not sticky.
    expect(dropInText).toContain("Environment=OPENCLAW_GATEWAY_TOKEN=rotated-token");
    expect(dropInText).toContain("Environment=OPENCLAW_SERVICE_VERSION=2026.4.12");
    expect(dropInText).not.toContain("legacy-token");
    expect(dropInText).not.toContain("2026.4.11");

    // Backup of the pre-migration unit is captured alongside.
    await expect(fs.access(`${unitPath}.bak`)).resolves.toBeUndefined();
  });

  it("rebuilds the main unit when a legacy file is missing ExecStart", async () => {
    const tmpHome = await makeTempHome();
    const env = { HOME: tmpHome };
    const { stdout } = createWritableStreamMock();

    const unitPath = resolveSystemdUserUnitPath(env);
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    const malformedUnit = [
      "[Unit]",
      "Description=OpenClaw Gateway (broken)",
      "",
      "[Service]",
      "Restart=always",
      "Environment=OPENCLAW_GATEWAY_TOKEN=legacy-token",
      "Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENCLAW_GATEWAY_TOKEN",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    await fs.writeFile(unitPath, malformedUnit, "utf8");

    await stageSystemdService({
      env,
      stdout,
      description: "OpenClaw Gateway",
      programArguments: [
        "/usr/bin/node",
        "/opt/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
      workingDirectory: "/srv/openclaw",
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "rotated-token",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENCLAW_GATEWAY_TOKEN",
        HOME: tmpHome,
      },
    });

    const unitText = await fs.readFile(unitPath, "utf8");
    const dropInText = await fs.readFile(resolveSystemdUserManagedDropInPath(env), "utf8");

    expect(unitText).toContain(
      "ExecStart=/usr/bin/node /opt/openclaw/dist/index.js gateway --port 18789",
    );
    expect(unitText).toContain("WorkingDirectory=/srv/openclaw");
    expect(unitText).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(dropInText).toContain("Environment=OPENCLAW_GATEWAY_TOKEN=rotated-token");
    await expect(fs.access(`${unitPath}.bak`)).resolves.toBeUndefined();
  });

  it("updates stale WorkingDirectory without rewriting user directives", async () => {
    const tmpHome = await makeTempHome();
    const env = { HOME: tmpHome };
    const { stdout } = createWritableStreamMock();

    const unitPath = resolveSystemdUserUnitPath(env);
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    const legacyUnit = [
      "[Unit]",
      "Description=OpenClaw Gateway",
      "",
      "[Service]",
      "ExecStart=/usr/bin/node /opt/openclaw/dist/index.js gateway --port 18789",
      "Restart=always",
      "KillMode=control-group",
      "WorkingDirectory=/old/worktree",
      `Environment=HOME=${tmpHome}`,
      `EnvironmentFile=${tmpHome}/.openclaw/workspace/.env`,
      "Environment=OPENCLAW_GATEWAY_TOKEN=legacy-token",
      "Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENCLAW_GATEWAY_TOKEN",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    await fs.writeFile(unitPath, legacyUnit, "utf8");

    await stageSystemdService({
      env,
      stdout,
      description: "OpenClaw Gateway",
      programArguments: [
        "/usr/bin/node",
        "/opt/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
      workingDirectory: "/new/worktree",
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "rotated-token",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENCLAW_GATEWAY_TOKEN",
        HOME: tmpHome,
      },
    });

    const unitText = await fs.readFile(unitPath, "utf8");

    expect(unitText).toContain("WorkingDirectory=/new/worktree");
    expect(unitText).not.toContain("WorkingDirectory=/old/worktree");
    expect(unitText).toContain(`EnvironmentFile=${tmpHome}/.openclaw/workspace/.env`);
    expect(unitText).toContain(`Environment=HOME=${tmpHome}`);
  });

  it("leaves main unit byte-identical when nothing drifted between upgrades", async () => {
    const tmpHome = await makeTempHome();
    const env = { HOME: tmpHome };
    const { stdout } = createWritableStreamMock();

    // First install — writes the initial main unit + drop-in.
    const programArguments = [
      "/usr/bin/node",
      "/opt/openclaw/dist/index.js",
      "gateway",
      "--port",
      "18789",
    ];
    const baseEnv = {
      OPENCLAW_GATEWAY_TOKEN: "token",
      OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENCLAW_GATEWAY_TOKEN",
      HOME: tmpHome,
    };
    await stageSystemdService({
      env,
      stdout,
      description: "OpenClaw Gateway",
      programArguments,
      environment: baseEnv,
    });

    const unitPath = resolveSystemdUserUnitPath(env);
    const firstUnit = await fs.readFile(unitPath, "utf8");

    // Second install with the same ExecStart and same user env — main unit
    // should be untouched (not even a .bak should appear).
    await stageSystemdService({
      env,
      stdout,
      description: "OpenClaw Gateway",
      programArguments,
      environment: { ...baseEnv, OPENCLAW_GATEWAY_TOKEN: "rotated-token" },
    });

    const secondUnit = await fs.readFile(unitPath, "utf8");
    expect(secondUnit).toBe(firstUnit);
    await expect(fs.access(`${unitPath}.bak`)).rejects.toThrow();
  });
});
