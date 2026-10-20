import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const dirs = useAutoCleanupTempDirTracker(afterEach);

const unitNotFound = {
  code: 1,
  termination: "exit" as const,
  stdout: "",
  stderr: "Call failed: Unit openclaw-owned.service not found.",
};

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

it.skipIf(process.platform === "win32").each(
  [
    { kind: "mutation", timeouts: [1_666, 1_633] },
    { kind: "loaded", timeouts: [1_666, 2_450, 4_800] },
    { kind: "metadata", timeouts: [5_000, 4_900, 4_800, 4_700] },
  ].flatMap(({ kind, timeouts }) =>
    [60_000, -60_000].map((stepMs) => ({ kind, timeouts, stepMs })),
  ),
)(
  "$kind retains its budget across $stepMs ms wall-clock step",
  async ({ kind, timeouts, stepMs }) => {
    const snapshot = {
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      fragmentPath: "/etc/systemd/user/openclaw-owned.service",
    };
    busctl.mockImplementation(async (_serviceEnv, args) => {
      if (kind !== "metadata") {
        stepClock(stepMs);
      }
      if (kind !== "loaded") {
        return unitNotFound;
      }
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
    if (kind === "metadata") {
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
      assertNoSystemOwnership.mockImplementation(async () => stepClock(stepMs));
      await expect(refreshLegacySystemdServiceMetadata(env, BUDGET_MS)).resolves.toBe(true);
      expect(assertNoSystemOwnership).toHaveBeenCalledTimes(3);
      expect([
        ...assertNoSystemOwnership.mock.calls.map((call) => call[1]),
        ...reloadUserManager.mock.calls.map((call) => call[1]),
      ]).toEqual(timeouts);
    } else {
      if (kind === "loaded") {
        await expect(
          readSystemdServiceExecStart(env, { requireEffective: true, timeoutMs: BUDGET_MS }),
        ).resolves.toMatchObject({ programArguments: snapshot.programArguments });
      } else {
        await withSystemdDefinitionMutation(env, env, async () => undefined, {
          timeoutMs: BUDGET_MS,
        });
      }
      expect(busctl.mock.calls.map((call) => call[2])).toEqual(timeouts);
    }
  },
);
