import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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

vi.mock("node:fs/promises", () => {
  const mocked = {
    lstat: vi.fn(async (target: string) => {
      if (!state.paths.has(target)) {
        throw Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
      }
      return {};
    }),
  };
  return { ...mocked, default: mocked };
});

const execFileUtf8 = vi.hoisted(() =>
  vi.fn(
    async (
      _command: string,
      args: string[],
      _options?: { timeout?: number; killSignal?: string; env?: NodeJS.ProcessEnv },
    ) => (args.includes("--property=UnitPath") ? state.managerUnitPath : state.systemctl),
  ),
);
vi.mock("./exec-file.js", () => ({ execFileUtf8 }));

import { readSystemdDefinitionMutationCapability } from "./systemd-definition-mutation.js";
import { assertNoSystemSystemdOwnership } from "./systemd-system.js";
const gatewayUnit = "openclaw-gateway.service";

beforeEach(() => {
  vi.clearAllMocks();
  state.systemctl = result("not-found\n");
  state.managerUnitPath = result(loadPaths);
  state.paths.clear();
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
