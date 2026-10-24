import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const busctl = vi.hoisted(() => vi.fn());
vi.mock("./exec-file.js", () => ({ execFileUtf8: vi.fn() }));
vi.mock("./systemd-exec.js", async (original) => ({
  ...(await original<typeof import("./systemd-exec.js")>()),
  execBusctlUser: busctl,
  execBusctlSystem: (...args: unknown[]) => busctl(undefined, ...args),
  bindSystemdManagerOwner: vi.fn(),
}));

import { execFileUtf8 } from "./exec-file.js";
import { assertDaemonRuntimePinDefinition } from "./runtime-pin-state.js";
import {
  hasGatewayServiceEnvironmentOverride,
  hasGatewayServiceLauncherOverride,
} from "./service-types.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
} from "./service.test-helpers.js";
import { createSystemdCommandQuery } from "./systemd-command-query.js";
import { readSystemdServiceExecStart } from "./systemd-service-files.js";
import { buildSystemdUnit } from "./systemd-unit.js";
import {
  systemdManagerVersionProbe,
  systemdOperatorBusFixtures,
} from "./systemd-user-bus.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let queryEnv: { HOME: string; XDG_RUNTIME_DIR: string; DBUS_SESSION_BUS_ADDRESS: string };
const unitName = "openclaw-gateway.service";
const callArgs = ["call", "org.test", "/unitName", "org.test.Manager", "LoadUnit", "s", unitName];
const unavailable = () => new Error("inspection unavailable");
const reader = (options?: Parameters<typeof createSystemdCommandQuery>[2]) =>
  createSystemdCommandQuery(queryEnv, unitName, options, unavailable);
const query = async (options?: Parameters<typeof createSystemdCommandQuery>[2]) =>
  (await reader(options)).query(callArgs, ["o"]);
const success = (stdout: string) => ({ code: 0, termination: "exit" as const, stdout, stderr: "" });
const failure = (stderr: string) => ({ ...success(""), code: 1, stderr });
const unsupported = failure("busctl: unrecognized option '--json=short'");

beforeEach(() => {
  busctl.mockReset();
  const home = dirs.make("openclaw-command-query-");
  queryEnv = {
    HOME: home,
    XDG_RUNTIME_DIR: path.join(home, "runtime"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/bus`,
  };
  vi.mocked(execFileUtf8).mockReset().mockImplementation(systemdManagerVersionProbe);
});
afterEach(() => vi.restoreAllMocks());

it.each(["before query", "during query"])(
  "names the expired effective-command probe: %s",
  async (phase) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const commandReader = await createSystemdCommandQuery(
      queryEnv,
      unitName,
      {
        timeoutMs: 100,
        systemdReadTarget: {
          scope: "system",
          unitName,
          unitPath: `/etc/systemd/system/${unitName}`,
        },
      },
      unavailable,
    );
    busctl.mockImplementation(async () => {
      now = 101;
      return success('o "/unit"');
    });
    if (phase === "before query") {
      now = 101;
    }
    await expect(commandReader.query(callArgs, ["o"])).rejects.toThrow(
      /Stalled check: (?:effective command LoadUnit|busctl call .* LoadUnit)\./,
    );
  },
);

it("does not infer ownership from expanded specifiers or normalized working directories", async () => {
  const home = queryEnv.HOME;
  const unit = path.join(home, ".config/systemd/user", unitName);
  const workingDirectory = `${home}/Open Claw`;
  await fs.mkdir(path.dirname(unit), { recursive: true });
  await fs.writeFile(
    unit,
    [
      "[Service]",
      "ExecStart=%h/bin/openclaw gateway --unit %n",
      "WorkingDirectory=-%h/Open Claw",
      "Environment=OPENCLAW_HOME=%h/openclaw UNIT_NAME=%n",
    ].join("\n"),
  );
  busctl.mockImplementation(async (_env, args: string[]) =>
    success(
      args.includes("LoadUnit")
        ? JSON.stringify({ type: "o", data: ["/unit"] })
        : args.includes("org.freedesktop.systemd1.Unit")
          ? buildSystemdUnitPropertyOutput({ fragmentPath: unit })
          : buildSystemdManagerPropertyOutput({
              programArguments: [`${home}/bin/openclaw`, "gateway", "--unit", unitName],
              workingDirectory: `!${workingDirectory}`,
              environment: [`OPENCLAW_HOME=${home}/openclaw`, `UNIT_NAME=${unitName}`],
            }),
    ),
  );

  const command = await readSystemdServiceExecStart(queryEnv);
  expect(command).toEqual({
    programArguments: [`${home}/bin/openclaw`, "gateway", "--unit", unitName],
    workingDirectory,
    environment: { OPENCLAW_HOME: `${home}/openclaw`, UNIT_NAME: unitName },
    environmentValueSources: { OPENCLAW_HOME: "inline", UNIT_NAME: "inline" },
    managedDefinition: {
      programArguments: [`${home}/bin/openclaw`, "gateway", "--unit", "%n"],
      workingDirectory,
      environment: { OPENCLAW_HOME: `${home}/openclaw`, UNIT_NAME: "%n" },
      environmentValueSources: { OPENCLAW_HOME: "inline", UNIT_NAME: "inline" },
    },
    managedOverrides: {},
    sourcePath: unit,
    definitionPaths: [unit],
  });
  expect(hasGatewayServiceLauncherOverride(command)).toBe(false);
  expect(hasGatewayServiceEnvironmentOverride(command, ["UNIT_NAME"])).toBe(false);
});

describe("systemd command query legacy compatibility", () => {
  it("distinguishes the operator's manager exit transcript from an absent unit", async () => {
    const args = [...callArgs];
    args[4] = "GetUnitFileState";
    busctl.mockResolvedValue(failure(systemdOperatorBusFixtures.stale.getUnitFileState));
    await expect((await reader()).query(args, ["s"])).rejects.toMatchObject({
      reason: "systemd-user-bus-unavailable",
    });
    busctl.mockResolvedValue(failure(systemdOperatorBusFixtures.runtime.getUnitFileState));
    await expect((await reader()).query(args, ["s"])).resolves.toBeNull();
  });

  it("rejects a timed-out legacy reply even when its output is valid", async () => {
    busctl
      .mockResolvedValueOnce(unsupported)
      .mockResolvedValue({ ...success('o "/unitName"'), termination: "timeout" });
    await expect(query()).rejects.toThrow();
    expect(busctl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { first: 1000, retry: 0, budgets: [1000] },
    { first: 0, retry: 1000, budgets: [1000, 1000] },
  ])("shares the original call deadline: %j", async ({ first, retry, budgets }) => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    busctl
      .mockImplementationOnce(async () => {
        now += first;
        return unsupported;
      })
      .mockImplementationOnce(async () => {
        now += retry;
        return success('o "/unitName"');
      });
    await expect(query({ timeoutMs: 3000 })).rejects.toThrow();
    expect(busctl.mock.calls.map((call) => call[2])).toEqual(budgets);
  });

  it("preserves non-activating reads and rejects revoked inspection before retry", async () => {
    let current = true;
    const assertCurrent = vi.fn(() => {
      if (!current) {
        throw unavailable();
      }
    });
    const options = { requireLoaded: true, loadForInspection: { managerUid: 1234, assertCurrent } };
    const inspected = await reader(options);
    busctl.mockImplementationOnce(async () => {
      current = false;
      return unsupported;
    });
    await expect(inspected.query(callArgs, ["o"])).rejects.toThrow();
    expect(busctl).toHaveBeenCalledTimes(1);
    expect(busctl.mock.calls[0]?.[1]).toEqual(["--json=short", "--auto-start=no", ...callArgs]);
    expect(busctl.mock.calls[0]?.[3]).toBe(assertCurrent);
  });
});

it("matches a legacy runtime pin with default user cwd and resource-only drop-ins", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const env = {
    ...queryEnv,
    HOME: await fs.realpath(queryEnv.HOME),
    OPENCLAW_SYSTEMD_UNIT: "openclaw-legacy",
  };
  const unit = path.join(env.HOME, ".config/systemd/user/openclaw-legacy.service");
  const dropIn = unit + ".d/override.conf";
  const planned = { programArguments: ["/usr/bin/node", "gateway"] };
  await fs.mkdir(path.dirname(dropIn), { recursive: true });
  await fs.writeFile(unit, buildSystemdUnit(planned));
  await fs.writeFile(dropIn, "[Service]\nMemoryMax=1G\n");
  busctl.mockImplementation(async (_env, args: string[]) => {
    if (args.includes("--json=short")) {
      return unsupported;
    }
    if (args.includes("LoadUnit")) {
      return success('o "/org/freedesktop/systemd1/unit/openclaw_2dlegacy_2eservice"\n');
    }
    if (args.includes("org.freedesktop.systemd1.Unit")) {
      return success(
        `s ${JSON.stringify(unit)}\nas 1 ${JSON.stringify(dropIn)}\nb false\ns "loaded"\ns "enabled"\ns "active"\nb true\nb false\n`,
      );
    }
    return success(
      [
        'a(sasbttttuii) 1 "/usr/bin/node" 2 "/usr/bin/node" "gateway" false 0 0 0 0 0 0 0',
        `s ${JSON.stringify(env.HOME)}`,
        "as 0",
        "a(sb) 0",
        "as 0",
      ].join("\n"),
    );
  });
  const actual = await readSystemdServiceExecStart(env, { requireEffective: true });
  expect(actual?.workingDirectory).toBe(env.HOME);
  expect(() => assertDaemonRuntimePinDefinition(planned, actual)).not.toThrow();
  expect(hasGatewayServiceLauncherOverride(actual)).toBe(false);
});
