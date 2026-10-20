import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
const dirs = useAutoCleanupTempDirTracker(afterEach);

function unitNotFound(unit: string) {
  return {
    code: 1,
    termination: "exit" as const,
    stdout: "",
    stderr: `Call failed: Unit ${unit}.service not found.`,
  };
}

describe.skipIf(process.platform === "win32")("systemd budgets across a wall-clock step", () => {
  let env: Record<string, string>;
  let unitPath: string;
  const realNow = Date.now;
  let offset = 0;
  let monotonicNow = 0;
  const stepClock = (stepMs: number) => {
    offset = stepMs;
    monotonicNow += 100;
  };

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
    const root = await fs.realpath(dirs.make("openclaw-clock-step-"));
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

  afterEach(() => vi.restoreAllMocks());

  it.each(STEPS)("mutation probes retain budget across %s ms wall-clock step", async (stepMs) => {
    busctl.mockImplementation(async (serviceEnv) => {
      stepClock(stepMs);
      return unitNotFound(serviceEnv.OPENCLAW_SYSTEMD_UNIT ?? "openclaw-owned");
    });

    await withSystemdDefinitionMutation(env, env, async () => undefined, {
      timeoutMs: BUDGET_MS,
    });

    // Exact shares prove both the split and the remaining monotonic budget.
    expect(busctl.mock.calls.map((call) => call[2])).toEqual([1_666, 1_633]);
  });

  it.each(STEPS)("loaded queries survive %s ms clock step", async (stepMs) => {
    const snapshot = {
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      fragmentPath: "/etc/systemd/user/openclaw-owned.service",
    };
    busctl.mockImplementation(async (_serviceEnv, args) => {
      stepClock(stepMs);
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

    expect(busctl.mock.calls.map((call) => call[2])).toEqual([1_666, 2_450, 4_800]);
  });

  it.each(STEPS)("metadata refresh retains budget across %s ms wall-clock step", async (stepMs) => {
    await fs.writeFile(
      unitPath,
      `[Unit]
Description=OpenClaw Gateway (v2026.7.1-2)
[Service]
ExecStart=/usr/bin/openclaw gateway run
Environment=OPENCLAW_SERVICE_MARKER=openclaw OPENCLAW_SERVICE_KIND=gateway OPENCLAW_SERVICE_VERSION=2026.7.1-2
`,
      { encoding: "utf8", mode: 0o600 },
    );
    busctl.mockImplementation(async (serviceEnv) =>
      unitNotFound(serviceEnv.OPENCLAW_SYSTEMD_UNIT ?? "openclaw-owned"),
    );
    assertNoSystemOwnership.mockImplementation(async () => stepClock(stepMs));

    await expect(refreshLegacySystemdServiceMetadata(env, BUDGET_MS)).resolves.toBe(true);

    // Three ownership checks plus the manager reload draw on one operation budget.
    const timeouts = [
      ...assertNoSystemOwnership.mock.calls.map((call) => call[1]),
      ...reloadUserManager.mock.calls.map((call) => call[1]),
    ];
    expect(assertNoSystemOwnership).toHaveBeenCalledTimes(3);
    expect(timeouts).toEqual([5_000, 4_900, 4_800, 4_700]);
  });
});
