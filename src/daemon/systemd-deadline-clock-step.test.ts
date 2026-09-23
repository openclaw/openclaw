// The shared systemd manager budgets are measured on a monotonic clock: a wall-clock step
// while a probe runs must neither drain the remaining budget to the 1 ms floor nor inflate it.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileUtf8 } from "./exec-file.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
} from "./service.test-helpers.js";
import { systemdManagerVersionProbe } from "./systemd-user-bus.test-support.js";

const assertNoSystemOwnership = vi.hoisted(() =>
  vi.fn<typeof import("./systemd-system.js").assertNoSystemSystemdOwnership>(),
);
const busctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlUser>());
const reloadUserManager = vi.hoisted(() =>
  vi.fn<typeof import("./systemd-exec.js").reloadSystemdUserManager>(),
);

vi.mock("./exec-file.js", () => ({ execFileUtf8: vi.fn() }));
vi.mock("./systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-system.js")>()),
  assertNoSystemSystemdOwnership: assertNoSystemOwnership,
}));
vi.mock("./systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-exec.js")>()),
  assertSystemdAvailable: async () => {},
  execBusctlUser: busctl,
  reloadSystemdUserManager: reloadUserManager,
}));

import { withSystemdDefinitionMutation } from "./systemd-definition-mutation.js";
import { refreshLegacySystemdServiceMetadata } from "./systemd-install.js";
import { readSystemdServiceExecStart } from "./systemd-service-files.js";

const BUDGET_MS = 5_000;
const STEPS = [60_000, -60_000] as const;

function unitNotFound(unit: string) {
  return {
    code: 1,
    termination: "exit" as const,
    stdout: "",
    stderr: `Call failed: Unit ${unit}.service not found.`,
  };
}

function expectBudgetShares(timeouts: Array<number | undefined>, minMs: number) {
  expect(timeouts.length).toBeGreaterThan(1);
  for (const timeout of timeouts) {
    expect(timeout).toBeGreaterThan(minMs);
    expect(timeout).toBeLessThanOrEqual(BUDGET_MS);
  }
}

describe.skipIf(process.platform === "win32")("systemd budgets across a wall-clock step", () => {
  let root: string;
  let env: Record<string, string>;
  let unitPath: string;
  const realNow = Date.now;
  let offset = 0;
  let monotonicNow = 0;

  beforeEach(async () => {
    offset = 0;
    monotonicNow = 0;
    vi.mocked(execFileUtf8).mockReset().mockImplementation(systemdManagerVersionProbe);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    // Filesystem scheduling must not consume this clock-contract fixture's budget.
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    assertNoSystemOwnership.mockReset().mockResolvedValue(undefined);
    reloadUserManager.mockReset().mockResolvedValue(undefined);
    busctl.mockReset();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clock-step-")));
    env = {
      HOME: path.join(root, "home"),
      XDG_RUNTIME_DIR: path.join(root, "runtime"),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/bus`,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
    };
    unitPath = path.join(env.HOME!, ".config/systemd/user/openclaw-owned.service");
    await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o700 });
    await fs.mkdir(env.OPENCLAW_STATE_DIR!, { mode: 0o700 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(STEPS)(
    "definition-mutation capability probes keep their budget through a %s ms step",
    async (stepMs) => {
      busctl.mockImplementation(async (serviceEnv) => {
        offset = stepMs;
        monotonicNow += 100;
        return unitNotFound(serviceEnv.OPENCLAW_SYSTEMD_UNIT ?? "openclaw-owned");
      });

      await withSystemdDefinitionMutation(env, env, async () => undefined, {
        timeoutMs: BUDGET_MS,
      });

      // The budget is split across the remaining manager calls (three at most).
      expectBudgetShares(
        busctl.mock.calls.map((call) => call[2]),
        BUDGET_MS / 3 - 100,
      );
      expect(busctl.mock.calls.map((call) => call[2])).toEqual([1_666, 1_633]);
    },
  );

  it.each(STEPS)(
    "effective-manager queries for a loaded unit keep their budget through a %s ms step",
    async (stepMs) => {
      const snapshot = {
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        fragmentPath: "/etc/systemd/user/openclaw-owned.service",
      };
      busctl.mockImplementation(async (_serviceEnv, args) => {
        offset = stepMs;
        monotonicNow += 100;
        const stdout = args.includes("LoadUnit")
          ? JSON.stringify({
              type: "o",
              data: ["/org/freedesktop/systemd1/unit/openclaw_2downed_2eservice"],
            })
          : args.includes("org.freedesktop.systemd1.Unit")
            ? buildSystemdUnitPropertyOutput(snapshot)
            : buildSystemdManagerPropertyOutput(snapshot);
        return { code: 0, termination: "exit" as const, stdout, stderr: "" };
      });

      await expect(
        readSystemdServiceExecStart(env, { requireEffective: true, timeoutMs: BUDGET_MS }),
      ).resolves.toMatchObject({ programArguments: snapshot.programArguments });

      expect(busctl).toHaveBeenCalledTimes(3);
      expectBudgetShares(
        busctl.mock.calls.map((call) => call[2]),
        BUDGET_MS / 3 - 100,
      );
      expect(busctl.mock.calls.map((call) => call[2])).toEqual([1_666, 2_450, 4_800]);
    },
  );

  it.each(STEPS)(
    "legacy metadata refresh keeps its operation budget through a %s ms step",
    async (stepMs) => {
      await fs.writeFile(
        unitPath,
        [
          "[Unit]",
          "Description=OpenClaw Gateway (v2026.7.1-2)",
          "",
          "[Service]",
          "ExecStart=/usr/bin/openclaw gateway run",
          "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
          "Environment=OPENCLAW_SERVICE_KIND=gateway",
          'Environment=OPENCLAW_SERVICE_VERSION=2026.7.1-2 "OTHER_SETTING=kept value"',
          "Environment=OPENCLAW_GATEWAY_PORT=18789",
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 },
      );
      busctl.mockImplementation(async (serviceEnv) =>
        unitNotFound(serviceEnv.OPENCLAW_SYSTEMD_UNIT ?? "openclaw-owned"),
      );
      assertNoSystemOwnership.mockImplementation(async () => {
        offset = stepMs;
        monotonicNow += 100;
      });

      await expect(refreshLegacySystemdServiceMetadata(env, BUDGET_MS)).resolves.toBe(true);

      // Three ownership checks plus the manager reload draw on one operation budget.
      const timeouts = [
        ...assertNoSystemOwnership.mock.calls.map((call) => call[1]),
        ...reloadUserManager.mock.calls.map((call) => call[1]),
      ];
      expect(assertNoSystemOwnership).toHaveBeenCalledTimes(3);
      expectBudgetShares(timeouts, BUDGET_MS - 1_000);
      expect(timeouts).toEqual([5_000, 4_900, 4_800, 4_700]);
    },
  );
});
