import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRespawnedByLauncher } from "./gateway-shutdown-budget.js";
import { readLaunchdStopTimeout } from "./launchd-stop-timeout.js";

const { execLaunchctl } = vi.hoisted(() => ({ execLaunchctl: vi.fn() }));
vi.mock("../daemon/launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launchd-exec.js")>()),
  execLaunchctl,
}));

const RESPAWN_MARKERS = [
  "OPENCLAW_NODE_UPDATE_RESPAWNED",
  "OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED",
  "OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED",
] as const;
const LAUNCHD_ENV = { XPC_SERVICE_NAME: "ai.openclaw.gateway" };
const SERVICE_ENV = { ...LAUNCHD_ENV, OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" };
const RESPAWNED_SERVICE_ENV = { ...SERVICE_ENV, OPENCLAW_NODE_UPDATE_RESPAWNED: "1" };
const result = (stdout: string) => ({ code: 0, stdout, stderr: "", termination: "exit" });
const failed = (code: number, stderr: string) => ({ ...result(""), code, stderr });
// Nested coalition states must not mask the job's own state.
const printed = (state: string, fields: string) =>
  result(
    `system/ai.openclaw.gateway = {\n\tactive count = 1\n\ttype = LaunchDaemon\n\tstate = ${state}\n\n${fields}\tresource coalition = {\n\t\tID = 18110\n\t\tstate = active\n\t}\n\n\tjetsam coalition = {\n\t\tID = 18111\n\t\tstate = active\n\t}\n\n\tjob state = running\n}\n`,
  );
const stopping = (seconds: string | number, pid = 4242) =>
  printed("SIGTERMed", `\texit timeout = ${seconds}\n\tpid = ${pid}\n`);
const timeoutSource = "exit timeout";
const cappedSource = "exit timeout capped at the launcher's 19000ms stop timer";

beforeEach(() => {
  vi.stubGlobal("process", {
    ...process,
    platform: "darwin",
    pid: 4242,
    ppid: 4241,
    getuid: () => 501,
    argv: ["/usr/local/bin/node", "/usr/local/bin/openclaw", "gateway", "run"],
  });
  execLaunchctl.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("launchd stop timeout reads the job launchd is stopping", () => {
  it.each([
    [LAUNCHD_ENV, 4242, 5, 5_000, timeoutSource],
    [LAUNCHD_ENV, 4242, 0, Infinity, "unlimited exit timeout"],
    [RESPAWNED_SERVICE_ENV, 4241, 0, 19_000, `unlimited ${cappedSource}`],
    [LAUNCHD_ENV, 4241, 12, 12_000, timeoutSource],
    ...RESPAWN_MARKERS.map(
      (marker) => [{ ...SERVICE_ENV, [marker]: "1" }, 4241, 55, 19_000, cappedSource] as const,
    ),
    [SERVICE_ENV, 4241, 55, 55_000, timeoutSource],
    [{ ...LAUNCHD_ENV, OPENCLAW_NODE_UPDATE_RESPAWNED: "1" }, 4241, 55, 55_000, timeoutSource],
    [RESPAWNED_SERVICE_ENV, 4241, 5, 5_000, timeoutSource],
    [RESPAWNED_SERVICE_ENV, 4242, 55, 55_000, timeoutSource],
    [{ ...LAUNCHD_ENV, OPENCLAW_LAUNCHD_LABEL: "com.example.gw" }, 4242, 45, 45_000, timeoutSource],
  ] as const)(
    "resolves the deadline for %j, pid %i, timeout %i",
    async (env, pid, seconds, timeoutMs, source) => {
      execLaunchctl.mockResolvedValue(stopping(seconds, pid));
      const label =
        "OPENCLAW_LAUNCHD_LABEL" in env ? env.OPENCLAW_LAUNCHD_LABEL : "ai.openclaw.gateway";
      await expect(readLaunchdStopTimeout(env)).resolves.toEqual({
        stop: { timeoutMs, source: `launchd system/${label} ${source}` },
      });
      expect(execLaunchctl).toHaveBeenCalledExactlyOnceWith(["print", `system/${label}`], 2_000);
    },
  );

  it("accepts any signal launchd reports having delivered", async () => {
    execLaunchctl.mockResolvedValue(printed("SIGKILLed", "\texit timeout = 9\n\tpid = 4242\n"));
    await expect(readLaunchdStopTimeout(LAUNCHD_ENV)).resolves.toEqual({
      stop: { timeoutMs: 9_000, source: "launchd system/ai.openclaw.gateway exit timeout" },
    });
  });

  it.each([
    [LAUNCHD_ENV, 4242, "running"],
    [RESPAWNED_SERVICE_ENV, 4241, "running"],
    ...["SIGTERM", "sigtermed"].map((state) => [LAUNCHD_ENV, 4242, state] as const),
  ] as const)("keeps the drain policy for %j, pid %i, state %s", async (env, pid, state) => {
    execLaunchctl.mockResolvedValue(printed(state, `\texit timeout = 60\n\tpid = ${pid}\n`));
    await expect(readLaunchdStopTimeout(env)).resolves.toEqual({ stop: null });
    expect(execLaunchctl).toHaveBeenCalledTimes(1);
  });

  it.each([
    "system/ai.openclaw.gateway = {\n\tactive count = 1\n\ttype = LaunchDaemon\n\n\texit timeout = 47\n\tpid = 4242\n\tjob state = running\n}\n",
    printed("", "\texit timeout = 47\n\tpid = 4242\n").stdout,
  ])("warns when a deadline has no readable job state: %j", async (stdout) => {
    execLaunchctl.mockResolvedValue(result(stdout));
    const read = await readLaunchdStopTimeout(LAUNCHD_ENV);
    expect(read.stop).toBeNull();
    expect(read.warning).toBe(
      "launchd system/ai.openclaw.gateway printed an exit timeout but no job state, so it is treated as not stopping and the Gateway stop policy is kept. Check the running job with launchctl print.",
    );
  });

  it.each([
    ["gui/501", [failed(113, "Could not find service")], 20],
    [
      "user/501",
      [
        failed(113, "Could not find service"),
        failed(125, "Domain does not support specified action"),
      ],
      30,
    ],
  ] as const)("finds the owned job in %s", async (domain, failures, seconds) => {
    for (const failure of failures) {
      execLaunchctl.mockResolvedValueOnce(failure);
    }
    execLaunchctl.mockResolvedValueOnce(stopping(seconds));
    await expect(readLaunchdStopTimeout(LAUNCHD_ENV)).resolves.toEqual({
      stop: {
        timeoutMs: seconds * 1_000,
        source: `launchd ${domain}/ai.openclaw.gateway exit timeout`,
      },
    });
    expect(execLaunchctl).toHaveBeenCalledTimes(failures.length + 1);
  });

  it("refuses a same-named job in every other domain and says why", async () => {
    execLaunchctl.mockResolvedValue(stopping(300, 99));
    const read = await readLaunchdStopTimeout(LAUNCHD_ENV);
    expect(read.stop).toBeNull();
    for (const domain of ["system", "gui/501", "user/501"]) {
      expect(read.warning).toContain(
        `${domain}/ai.openclaw.gateway: pid 99 is neither this process nor its launcher`,
      );
    }
  });

  it.each(["\tpid = 4242\n", "\texit timeout = not-a-number\n\tpid = 4242\n"])(
    "defaults an unreadable deadline only when a stop is running: %j",
    async (fields) => {
      execLaunchctl.mockResolvedValue(printed("SIGTERMed", fields));
      const read = await readLaunchdStopTimeout(LAUNCHD_ENV);
      expect(read.stop?.timeoutMs).toBe(20_000);
      expect(read.stop?.source).toBe(
        "launchd system/ai.openclaw.gateway exit timeout unavailable; default ExitTimeOut",
      );
      expect(read.warning).toContain(
        "launchd is stopping system/ai.openclaw.gateway but its exit timeout is missing or invalid",
      );
    },
  );

  it.each([
    [false, "launchctl print exited 1: permission denied"],
    [true, "launchctl print threw"],
  ] as const)("reports no deadline when inspection fails (throws=%s)", async (throws, detail) => {
    if (throws) {
      execLaunchctl.mockRejectedValue(new Error("spawn ENOENT"));
    } else {
      execLaunchctl.mockResolvedValue(failed(1, "permission denied"));
    }
    const read = await readLaunchdStopTimeout(LAUNCHD_ENV);
    expect(read.stop).toBeNull();
    expect(read.warning).toContain(`system/ai.openclaw.gateway: ${detail}`);
    expect(read.warning).toContain("keeping the Gateway stop policy");
    expect(read.warning).toContain("Check the running job with launchctl print.");
  });

  it.each([
    [{ ...LAUNCHD_ENV, OPENCLAW_LAUNCHD_LABEL: "bad label/../etc" }, true],
    [{}, false],
  ] as const)(
    "does not inspect jobs without a valid launchd identity: %j",
    async (env, invalid) => {
      const read = await readLaunchdStopTimeout(env);
      if (invalid) {
        expect(read.stop).toBeNull();
        expect(read.warning).toContain("label could not be resolved");
      } else {
        expect(read).toEqual({ stop: null });
      }
      expect(execLaunchctl).not.toHaveBeenCalled();
    },
  );

  it("recognises no unrelated or disabled respawn markers", () => {
    for (const env of [
      {},
      { OPENCLAW_SUPERVISOR_MODE: "external" },
      { OPENCLAW_NODE_UPDATE_RESPAWNED: "0" },
      { OPENCLAW_NODE_UPDATE_RESPAWNED: "" },
    ]) {
      expect(isRespawnedByLauncher(env)).toBe(false);
    }
  });
});
