import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { ExecResult } from "./exec-file.js";

const { result, loadPaths } = vi.hoisted(() => ({
  result: (stdout: string, stderr = "", code = 0): ExecResult => ({
    stdout,
    stderr,
    code,
    termination: "exit",
  }),
  loadPaths:
    "/etc/systemd/system /run/systemd/system /usr/local/lib/systemd/system /usr/lib/systemd/system\n",
}));
const state = vi.hoisted(() => ({
  systemctl: result("not-found\n"),
  managerUnitPath: result(loadPaths),
  paths: new Set<string>(),
}));

const execFileUtf8 = vi.hoisted(() => vi.fn<typeof import("./exec-file.js").execFileUtf8>());
vi.mock("./exec-file.js", () => ({ execFileUtf8 }));

import { readSystemdDefinitionMutationCapability } from "./systemd-definition-mutation.js";
import {
  admitUserUnitActivationPastUnverifiableOwnership,
  isSystemdServiceAbsent,
} from "./systemd-scope.js";
import { assertNoSystemSystemdOwnership } from "./systemd-system.js";
const gatewayUnit = "openclaw-gateway.service";
const notFound = () => Object.assign(new Error("missing"), { code: "ENOENT" });
const existingStat = await fs.stat(new URL(import.meta.url));

beforeEach(() => {
  vi.clearAllMocks();
  state.systemctl = result("not-found\n");
  state.managerUnitPath = result(loadPaths);
  state.paths.clear();
  vi.spyOn(fs, "lstat").mockImplementation(async (target) => {
    if (!state.paths.has(String(target))) {
      throw notFound();
    }
    return existingStat;
  });
  execFileUtf8.mockReset();
  execFileUtf8.mockImplementation(async (_command: string, args: string[]) =>
    args.includes("--property=UnitPath") ? state.managerUnitPath : state.systemctl,
  );
  mockProcessPlatform("linux");
});
afterEach(() => vi.restoreAllMocks());

it.each([
  { ownership: "loaded", kind: "sealed" },
  { ownership: "unverifiable", kind: "unknown" },
])(
  "fails closed for $ownership system ownership before user inspection",
  async ({ ownership, kind }) => {
    const unitName = "openclaw-owned.service";
    state.systemctl = result(
      ownership === "loaded" ? "loaded" : "not-found",
      "manager-secret-canary",
      ownership === "unverifiable" ? 1 : 0,
    );

    const capability = await readSystemdDefinitionMutationCapability({
      HOME: "/home/openclaw-test",
      OPENCLAW_STATE_DIR: "/state/openclaw-test",
      OPENCLAW_SYSTEMD_UNIT: unitName,
      OPENCLAW_SERVICE_KIND: "node",
    });

    expect(capability).toEqual({
      kind,
      reason: kind === "sealed" ? "system-owned" : "system-ownership-unverified",
    });
    expect(JSON.stringify(capability)).not.toContain("manager-secret-canary");
    // Denial permits only system ownership probes, never user-manager or artifact reads.
    expect(execFileUtf8.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["systemctl", ["show", "--property=LoadState", "--value", unitName]],
    ]);
    expect(vi.mocked(fs.lstat).mock.calls).toEqual([]);
  },
);

it("shares one timeout budget across system-manager ownership probes", async () => {
  let now = 1_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  execFileUtf8.mockImplementation(async (_command, args) => {
    now += 20;
    return args.includes("--property=UnitPath") ? state.managerUnitPath : state.systemctl;
  });
  await expect(assertNoSystemSystemdOwnership(gatewayUnit, 50)).resolves.toBeUndefined();
  expect(
    execFileUtf8.mock.calls.map((call) => ({
      timeout: call[2]?.timeout,
      killSignal: call[2]?.killSignal,
    })),
  ).toEqual([
    { timeout: 50, killSignal: "SIGKILL" },
    { timeout: 30, killSignal: "SIGKILL" },
  ]);
  expect(execFileUtf8.mock.calls.every((call) => call[2]?.env === process.env)).toBe(true);
  expect(execFileUtf8.mock.calls.map(([command, args]) => [command, args])).toEqual([
    ["systemctl", ["show", "--property=LoadState", "--value", gatewayUnit]],
    ["systemctl", ["show", "--property=UnitPath", "--value"]],
  ]);
});

it.each(["exit", "timeout"] as const)(
  "accepts system-manager absence only after a completed query (%s)",
  async (termination) => {
    const detail = "Unit openclaw-gateway.service could not be found.";
    state.systemctl = { stdout: "", stderr: detail, code: 1, termination };

    const inspection = assertNoSystemSystemdOwnership(gatewayUnit);
    if (termination === "exit") {
      await expect(inspection).resolves.toBeUndefined();
    } else {
      await expect(inspection).rejects.toMatchObject({
        ownership: { status: "unverifiable", operation: "systemctl", detail },
      });
    }
  },
);

it("fails closed when manager unit load paths cannot be enumerated", async () => {
  state.managerUnitPath = result("", "manager UnitPath unavailable", 1);

  await expect(assertNoSystemSystemdOwnership(gatewayUnit)).rejects.toMatchObject({
    ownership: {
      status: "unverifiable",
      operation: "systemctl",
      detail: "manager UnitPath unavailable",
    },
  });
});

it.each(["/etc", "/usr/lib"])("renders safe recovery for units in %s", async (prefix) => {
  const existingGeteuid = Object.getOwnPropertyDescriptor(process, "geteuid");
  Object.defineProperty(process, "geteuid", { configurable: true, value: () => 0 });
  onTestFinished(() => {
    if (existingGeteuid) {
      Object.defineProperty(process, "geteuid", existingGeteuid);
    } else {
      Reflect.deleteProperty(process, "geteuid");
    }
  });
  const unitPath = `${prefix}/systemd/system/${gatewayUnit}`;
  state.paths.add(unitPath);
  const error = await assertNoSystemSystemdOwnership(gatewayUnit).catch(
    (caught: unknown) => caught,
  );

  expect(error).toMatchObject({
    name: "SystemSystemdOwnershipError",
    code: "SYSTEM_SYSTEMD_OWNERSHIP",
    ownership: { status: "installed" },
  });
  expect(String(error)).toContain("--force does not override system ownership");
  if (prefix === "/etc") {
    expect(String(error)).toContain("systemctl disable --now openclaw-gateway.service");
    expect(String(error)).toContain(`rm ${unitPath}`);
  } else {
    expect(String(error)).toContain("uninstall or reconfigure the package, generator");
    expect(String(error)).not.toContain(`rm ${unitPath}`);
  }
});

describe("non-loading system-manager inspection", () => {
  const unit = "openclaw-owned.service";
  const owner = ":1.4";
  const home = "/openclaw-systemd-cleanup-proof";
  const env = { HOME: home, OPENCLAW_SYSTEMD_UNIT: unit };
  const success = (type: string, data: unknown) => result(JSON.stringify({ type, data }));
  const missing = () => result("", `Call failed: Unit ${unit} not loaded.`, 1);
  const absent = () => assertNoSystemSystemdOwnership(unit, 1000, { requireLoaded: true });
  function reply(args: readonly string[]): ExecResult {
    if (args.includes("GetNameOwner")) {
      return success("s", [owner]);
    }
    if (args.includes("GetUnit")) {
      return missing();
    }
    if (args.includes("UnitPath")) {
      return success("as", ["/etc/systemd/system", "/run/systemd/system"]);
    }
    throw new Error("Unexpected manager query");
  }
  beforeEach(() => execFileUtf8.mockImplementation(async (_command, args) => reply(args)));

  it.each(["absence", "system", "user", "loaded-user", "activation"])(
    "propagates %s cleanup errors",
    async (source) => {
      const error = new CommandProcessCleanupError();
      execFileUtf8.mockImplementation(async (_command, args) => {
        if (["absence", "system", "activation"].includes(source) || !args.includes("--system")) {
          throw error;
        }
        if (source === "loaded-user") {
          throw new Error("system manager unavailable");
        }
        return reply(args);
      });
      let probe: Promise<unknown>;
      if (source === "absence") {
        probe = isSystemdServiceAbsent(env, { strictCommandAbsent: true, timeoutMs: 1000 });
      } else if (source === "activation") {
        execFileUtf8.mockRejectedValueOnce(new Error("system manager unavailable"));
        const refusal: unknown = await absent().catch((cause: unknown) => cause);
        expect(refusal).toMatchObject({ ownership: { status: "unverifiable" } });
        probe = admitUserUnitActivationPastUnverifiableOwnership(env, refusal);
      } else {
        vi.spyOn(fs, "readFile").mockRejectedValue(notFound());
        probe = readSystemdDefinitionMutationCapability(
          {
            ...env,
            OPENCLAW_STATE_DIR: `${home}/state`,
            DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/${source}/bus`,
          },
          {
            requireLoaded: true,
            systemdReadTarget: { scope: "user", unitName: unit, unitPath: "/unused/unit" },
          },
        );
      }
      await expect(probe).rejects.toBe(error);
    },
  );
  it("proves absence using existing manager and load paths without activation", async () => {
    await expect(absent()).resolves.toBeUndefined();
    expect(execFileUtf8).toHaveBeenCalledTimes(3);
    for (const [command, args] of execFileUtf8.mock.calls) {
      expect(command).toBe("busctl");
      expect(args).toEqual(expect.arrayContaining(["--system", "--auto-start=no"]));
      expect(args).not.toContain("LoadUnit");
      if (!args.includes("GetNameOwner")) {
        expect(args).toContain(owner);
      }
    }
    expect(fs.lstat).toHaveBeenCalledWith(`/etc/systemd/system/${unit}`);
    expect(fs.lstat).toHaveBeenCalledWith(`/run/systemd/system/${unit}`);
  });
  it("refuses filesystem uncertainty", async () => {
    vi.spyOn(fs, "lstat").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(absent()).rejects.toMatchObject({
      ownership: { status: "unverifiable", operation: "filesystem" },
    });
  });
  it.each([
    { name: "invalid object path", result: success("o", ["/unexpected"]) },
    { name: "timed out missing", result: { ...missing(), termination: "timeout" as const } },
  ])("rejects $name rather than certifying absence", async ({ result: response }) => {
    execFileUtf8.mockImplementation(async (_command, args) =>
      args.includes("GetUnit") ? response : reply(args),
    );
    await expect(absent()).rejects.toMatchObject({ ownership: { status: "unverifiable" } });
  });
});
