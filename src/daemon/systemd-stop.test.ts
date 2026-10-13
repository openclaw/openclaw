import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { execFileUtf8 } from "./exec-file.js";
import { ServiceOwnershipRefusalError } from "./service-inspection-error.js";
import { withGatewayServiceUpdateAuthority } from "./service-update-authority.js";
import { stopSystemdService } from "./systemd-lifecycle.js";
import { resolveSystemdUserTransport } from "./systemd-user-transport.js";

// mock-isolation: Model Linux manager latency without starting or stopping host services.
vi.mock("./exec-file.js", () => ({ execFileUtf8: vi.fn() }));
const dirs = useAutoCleanupTempDirTracker(afterEach);
const success = (stdout = "") => ({ code: 0, termination: "exit" as const, stdout, stderr: "" });

beforeEach(() => {
  vi.resetAllMocks();
  mockProcessPlatform("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(1000);
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const home = dirs.make("openclaw-systemd-stop-");
  const unit = path.join(home, ".config/systemd/user/openclaw-gateway.service");
  await fs.mkdir(path.dirname(unit), { recursive: true });
  await fs.writeFile(unit, "[Service]\nExecStart=/usr/bin/openclaw gateway\n");
  const env = {
    HOME: home,
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    USER: "service",
    LOGNAME: "service",
    SUDO_USER: undefined,
    XDG_RUNTIME_DIR: home,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/bus`,
  };
  let now = 0;
  let running = true;
  let probes = 0;
  const commands: string[] = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const manager = (latency: number, failedAttempts = 0) => {
    let remainingFailures = failedAttempts;
    vi.mocked(execFileUtf8).mockImplementation(async (_command, args, options) => {
      if (args.includes("Version")) {
        probes++;
        const timeout = options?.timeout ?? Number.POSITIVE_INFINITY;
        if (args.includes("--machine") || remainingFailures > 0 || latency > timeout) {
          if (!args.includes("--machine")) {
            remainingFailures--;
          }
          now += timeout;
          return { ...success(), code: 1, termination: "timeout", stderr: "probe timed out" };
        }
        now += latency;
        return success('s "252.39"');
      }
      commands.push(args[1] ?? "");
      if (args.includes("stop")) {
        running = false;
      }
      return success();
    });
  };
  const guard = vi.fn(() => {
    // A custody read can legitimately spend the lease database's five-second busy wait.
    now += 6000;
  });
  const warn = vi.fn();
  return {
    env,
    manager,
    guard,
    warn,
    commands,
    running: () => running,
    probes: () => probes,
    elapsed: () => now,
    stop: (mode: "standalone" | "update" = "update", custodyMs = 0) => {
      const stop = () =>
        stopSystemdService({
          env,
          stdout: new PassThrough(),
          assertCurrent: mode === "update" ? guard : undefined,
          warn,
        });
      return mode === "standalone"
        ? stop()
        : withGatewayServiceUpdateAuthority(() => {
            now += custodyMs;
          }, stop);
    },
  };
}

it.each(["standalone", "update"] as const)(
  "stops with a slow manager and slow custody checks (%s)",
  async (mode) => {
    const f = await fixture();
    f.manager(6000);
    await f.stop(mode, 6000);
    expect(f.running()).toBe(false);
    expect(f.commands).toEqual(["stop"]);
    expect(f.guard).toHaveBeenCalledTimes(mode === "update" ? 1 : 0);
  },
);

it("does not spend a cached manager's inspection budget on repeated update custody checks", async () => {
  const f = await fixture();
  f.manager(0);
  await resolveSystemdUserTransport(f.env);
  await f.stop();
  expect(f.running()).toBe(false);
  expect(f.probes()).toBe(1);
  expect(f.guard).toHaveBeenCalledOnce();
});

it("retries one transient inspection timeout before stopping", async () => {
  const f = await fixture();
  f.manager(0, 1);
  await f.stop();
  expect(f.running()).toBe(false);
  expect(f.warn).toHaveBeenCalledOnce();
  expect(f.warn).toHaveBeenCalledWith(expect.stringMatching(/inspection.*retry/i));
  expect(f.commands.filter((command) => command === "stop")).toHaveLength(1);
});

it("keeps the original Gateway serving when both bounded manager inspections time out", async () => {
  const f = await fixture();
  f.manager(Number.POSITIVE_INFINITY);
  await expect(f.stop()).rejects.toThrow(/inspection.*Version/i);
  expect(f.running()).toBe(true);
  expect(f.commands).not.toContain("stop");
  expect(f.warn).toHaveBeenCalledOnce();
  expect(f.elapsed()).toBeLessThanOrEqual(126_000);
});

it("refuses to stop when custody retires during manager inspection", async () => {
  const f = await fixture();
  f.manager(0);
  f.guard.mockImplementation(() => {
    throw new Error("update custody retired");
  });
  await expect(f.stop()).rejects.toThrow("update custody retired");
  expect(f.running()).toBe(true);
  expect(f.commands).not.toContain("stop");
  expect(f.warn).not.toHaveBeenCalled();
});

it.each([
  { scenario: "ownership refusal", retired: false },
  { scenario: "ownership refusal", retired: true },
  { scenario: "unsettled probe", retired: false },
  { scenario: "unsettled probe", retired: true },
])(
  "preserves $scenario at the inspection deadline (custody retired=$retired)",
  async ({ scenario, retired }) => {
    const f = await fixture();
    f.manager(0);
    const failure =
      scenario === "ownership refusal"
        ? new ServiceOwnershipRefusalError("systemd-manager-changed")
        : new CommandProcessCleanupError();
    vi.mocked(execFileUtf8).mockImplementationOnce(async () => {
      vi.spyOn(performance, "now").mockReturnValue(60_000);
      if (retired) {
        f.guard.mockImplementation(() => {
          throw new Error("update custody retired");
        });
      }
      throw failure;
    });
    await expect(f.stop()).rejects.toBe(failure);
    expect(f.running()).toBe(true);
    expect(execFileUtf8).toHaveBeenCalledOnce();
    expect(f.warn).not.toHaveBeenCalled();
  },
);
