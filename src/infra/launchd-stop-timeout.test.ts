import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRespawnedByLauncher } from "./gateway-shutdown-budget.js";
import { readLaunchdStopTimeout } from "./launchd-stop-timeout.js";

const { execLaunchctl } = vi.hoisted(() => ({ execLaunchctl: vi.fn() }));
vi.mock("../daemon/launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launchd-exec.js")>()),
  execLaunchctl,
}));

// The authoritative list is module-local beside the deadline it authorises in
// gateway-shutdown-budget.mjs, so it is restated here and tied back to the
// implementation by the recognition cases at the end of this file.
const RESPAWN_MARKERS = [
  "OPENCLAW_NODE_UPDATE_RESPAWNED",
  "OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED",
  "OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED",
] as const;
const LAUNCHD_ENV = { XPC_SERVICE_NAME: "ai.openclaw.gateway" };
// The service layout the recovery launcher bounds by the LaunchAgent exit timeout:
// launchd names the job in XPC_SERVICE_NAME and the handoff carries the label, which
// is the pair the launcher branches on and a respawned child inherits unchanged.
const SERVICE_ENV = { ...LAUNCHD_ENV, OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" };
// Adds one of the markers a respawning launcher stamps on its child, which is what
// separates a Gateway that launcher started from an unrelated parent.
const RESPAWNED_SERVICE_ENV = { ...SERVICE_ENV, OPENCLAW_NODE_UPDATE_RESPAWNED: "1" };
const result = (stdout: string) => ({ code: 0, stdout, stderr: "", termination: "exit" });

/**
 * Shaped like real `launchctl print` output rather than a bare field list: the
 * job's own `state` at one tab, then coalition blocks carrying their own
 * `state = active` at two tabs, then `job state`. A live Gateway LaunchDaemon
 * prints `state` three times in exactly this arrangement.
 */
const printed = (state: string, fields: string) =>
  result(
    `system/ai.openclaw.gateway = {\n\tactive count = 1\n\ttype = LaunchDaemon\n\tstate = ${state}\n\n${fields}\tresource coalition = {\n\t\tID = 18110\n\t\tstate = active\n\t}\n\n\tjetsam coalition = {\n\t\tID = 18111\n\t\tstate = active\n\t}\n\n\tjob state = running\n}\n`,
  );
const stopping = (fields: string) => printed("SIGTERMed", fields);

beforeEach(() => {
  vi.stubGlobal("process", {
    ...process,
    platform: "darwin",
    pid: 4242,
    ppid: 4241,
    getuid: () => 501,
    // The reader only runs inside a serving Gateway, and reconstructing an
    // undeclared launcher's timer replays the argv branch the launcher took.
    argv: ["/usr/local/bin/node", "/usr/local/bin/openclaw", "gateway", "run"],
  });
  execLaunchctl.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("launchd stop timeout reads the job launchd is stopping", () => {
  it("uses the operator job's effective exit timeout, not the template constant", async () => {
    execLaunchctl.mockResolvedValue(
      stopping("\tminimum runtime = 10\n\texit timeout = 5\n\tpid = 4242\n"),
    );
    await expect(readLaunchdStopTimeout(LAUNCHD_ENV)).resolves.toEqual({
      stop: { timeoutMs: 5_000, source: "launchd system/ai.openclaw.gateway exit timeout" },
    });
    expect(execLaunchctl).toHaveBeenCalledExactlyOnceWith(
      ["print", "system/ai.openclaw.gateway"],
      2_000,
    );
  });

  // The shared key-value parser keeps the LAST occurrence of a repeated key, and
  // `launchctl print` repeats `state` inside coalition blocks, so asking it for
  // `state` answers `active` and never sees the job at all. This case fails if
  // the reader ever goes back to that parser for the job's state.
  it("reads the job's own state, not a nested coalition's", async () => {
    execLaunchctl.mockResolvedValue(stopping("\texit timeout = 47\n\tpid = 4242\n"));
    await expect(readLaunchdStopTimeout(LAUNCHD_ENV)).resolves.toEqual({
      stop: { timeoutMs: 47_000, source: "launchd system/ai.openclaw.gateway exit timeout" },
    });
  });

  // Measured on macOS 27 with ExitTimeOut 47: a plain `kill -TERM` left the job
  // printing `state = running` while the process handled the signal, and it was
  // still alive 85 seconds later. launchd never started its clock, so its
  // deadline bounds nothing and the caller keeps the budget it already had.
  it("declines the deadline when launchd is not the one stopping the job", async () => {
    execLaunchctl.mockResolvedValue(printed("running", "\texit timeout = 5\n\tpid = 4242\n"));
    // No deadline and nothing to warn about: this is the ordinary shape of a stop
    // that some other sender delivered.
    await expect(readLaunchdStopTimeout(LAUNCHD_ENV)).resolves.toEqual({ stop: null });
    // Our job was found in the first domain, so there is nothing left to search.
    expect(execLaunchctl).toHaveBeenCalledTimes(1);
  });

  // An empty value is deliberately not in this table: there is no state to fail to
  // recognise, so it belongs with the missing-state warning below.
  it.each(["waiting", "exited", "not running", "SIGTERM", "sigtermed"])(
    "treats the unrecognised state %j as not stopping",
    async (state) => {
      execLaunchctl.mockResolvedValue(printed(state, "\texit timeout = 5\n\tpid = 4242\n"));
      await expect(readLaunchdStopTimeout(LAUNCHD_ENV)).resolves.toEqual({ stop: null });
    },
  );

  it("accepts any signal launchd reports having delivered", async () => {
    execLaunchctl.mockResolvedValue(printed("SIGKILLed", "\texit timeout = 9\n\tpid = 4242\n"));
    await expect(readLaunchdStopTimeout(LAUNCHD_ENV)).resolves.toEqual({
      stop: { timeoutMs: 9_000, source: "launchd system/ai.openclaw.gateway exit timeout" },
    });
  });

  // An absent `state` is indistinguishable from a job launchd is not stopping, so the
  // budget would silently revert to the platform-neutral policy on a macOS that printed
  // this block differently. The deadline parsed from the same block is what makes the
  // case reportable, and the warning is what keeps it from being silent. An empty value
  // reaches the same place as a missing line, because neither yields a state to read.
  it.each([
    [
      "no state line",
      `system/ai.openclaw.gateway = {\n\tactive count = 1\n\ttype = LaunchDaemon\n\n\texit timeout = 47\n\tpid = 4242\n\tjob state = running\n}\n`,
    ],
    ["an empty state value", printed("", "\texit timeout = 47\n\tpid = 4242\n").stdout],
  ])("warns when the job printed a deadline but %s", async (_label, stdout) => {
    execLaunchctl.mockResolvedValue(result(stdout));
    const read = await readLaunchdStopTimeout(LAUNCHD_ENV);
    expect(read.stop).toBeNull();
    expect(read.warning).toBe(
      "launchd system/ai.openclaw.gateway printed an exit timeout but no job state, so it is treated as not stopping and the Gateway stop policy is kept. Check the running job with launchctl print.",
    );
  });

  // A job with neither field is an ordinary not-stopping answer and must stay quiet,
  // otherwise every in-process restart of a launchd-owned Gateway would warn.
  it("stays silent when the job is simply not stopping", async () => {
    execLaunchctl.mockResolvedValue(printed("running", "\texit timeout = 47\n\tpid = 4242\n"));
    await expect(readLaunchdStopTimeout(LAUNCHD_ENV)).resolves.toEqual({ stop: null });
  });

  it("falls back to the gui domain when the job is not a LaunchDaemon", async () => {
    execLaunchctl
      .mockResolvedValueOnce({
        code: 113,
        stdout: "",
        stderr: "Could not find service",
        termination: "exit",
      })
      .mockResolvedValueOnce(stopping("\texit timeout = 20\n\tpid = 4242\n"));
    await expect(readLaunchdStopTimeout(LAUNCHD_ENV)).resolves.toEqual({
      stop: { timeoutMs: 20_000, source: "launchd gui/501/ai.openclaw.gateway exit timeout" },
    });
  });

  // A service account with no logged-in session has no gui domain: launchctl
  // answers 125 "Domain does not support specified action" for gui/<uid> while
  // user/<uid> prints normally. Verified on a headless macOS service account.
  it("reaches the user domain when the account has no gui session", async () => {
    execLaunchctl
      .mockResolvedValueOnce({
        code: 113,
        stdout: "",
        stderr: "Could not find service",
        termination: "exit",
      })
      .mockResolvedValueOnce({
        code: 125,
        stdout: "",
        stderr: "Domain does not support specified action",
        termination: "exit",
      })
      .mockResolvedValueOnce(stopping("\texit timeout = 30\n\tpid = 4242\n"));
    await expect(readLaunchdStopTimeout(LAUNCHD_ENV)).resolves.toEqual({
      stop: { timeoutMs: 30_000, source: "launchd user/501/ai.openclaw.gateway exit timeout" },
    });
    expect(execLaunchctl).toHaveBeenCalledTimes(3);
  });

  it("refuses a same-named job in every other domain and says why", async () => {
    execLaunchctl.mockResolvedValue(stopping("\texit timeout = 300\n\tpid = 99\n"));
    const read = await readLaunchdStopTimeout(LAUNCHD_ENV);
    // Nothing was established, so no deadline is reported at all and the caller
    // keeps the platform-neutral policy it already resolved.
    expect(read.stop).toBeNull();
    for (const target of [
      "system/ai.openclaw.gateway",
      "gui/501/ai.openclaw.gateway",
      "user/501/ai.openclaw.gateway",
    ]) {
      expect(read.warning).toContain(`${target}: pid 99 is neither this process nor its launcher`);
    }
  });

  // The installed service can keep a launcher parent while the serving Gateway
  // runs as its child, so the job prints the launcher's pid. Requiring
  // pid === process.pid there would reject the job that enforces the deadline.
  it("accepts the job when it is this process's launcher parent", async () => {
    execLaunchctl.mockResolvedValue(stopping("\texit timeout = 12\n\tpid = 4241\n"));
    await expect(readLaunchdStopTimeout(LAUNCHD_ENV)).resolves.toEqual({
      stop: { timeoutMs: 12_000, source: "launchd system/ai.openclaw.gateway exit timeout" },
    });
  });

  // The launcher declares nothing, so its reap timer is derived from the expression
  // the launcher itself arms from. A longer operator deadline cannot be spent under
  // it: the parent force-kills this process first. Deriving rather than being told is
  // what makes this hold when an already-running older launcher started this Gateway,
  // which is the only shape an upgrade can take.
  //
  // Every marker is covered because all three respawn call sites reach the same
  // launcher through the same function and arm the same timer. Gating on the
  // Node-recovery marker alone left the two compile-cache respawns uncapped, and the
  // packaged one can wrap a foreground `gateway run` on an installed service.
  it.each(RESPAWN_MARKERS)(
    "caps the job deadline at the launcher's derived reap timer for %s",
    async (marker) => {
      execLaunchctl.mockResolvedValue(stopping("\texit timeout = 55\n\tpid = 4241\n"));
      await expect(readLaunchdStopTimeout({ ...SERVICE_ENV, [marker]: "1" })).resolves.toEqual({
        stop: {
          timeoutMs: 19_000,
          source:
            "launchd system/ai.openclaw.gateway exit timeout capped at the launcher's 19000ms stop timer",
        },
      });
    },
  );

  // Holding the parent slot is not evidence of a reap timer. An operator wrapper can
  // keep the job's pid and start the Gateway itself while running none, and capping
  // its deadline would cut a drain nothing was going to interrupt.
  it("leaves a parent that did not respawn this process capping nothing", async () => {
    execLaunchctl.mockResolvedValue(stopping("\texit timeout = 55\n\tpid = 4241\n"));
    await expect(readLaunchdStopTimeout(SERVICE_ENV)).resolves.toEqual({
      stop: { timeoutMs: 55_000, source: "launchd system/ai.openclaw.gateway exit timeout" },
    });
  });

  // Outside the service layout the launcher bounds its child by the platform-neutral
  // stop policy, which outlasts any job deadline launchd will enforce, so nothing is
  // cut even though the marker says a launcher is there.
  it("derives the policy deadline when the respawning job is not the service", async () => {
    execLaunchctl.mockResolvedValue(stopping("\texit timeout = 55\n\tpid = 4241\n"));
    await expect(
      readLaunchdStopTimeout({ ...LAUNCHD_ENV, OPENCLAW_NODE_UPDATE_RESPAWNED: "1" }),
    ).resolves.toEqual({
      stop: { timeoutMs: 55_000, source: "launchd system/ai.openclaw.gateway exit timeout" },
    });
  });

  // launchd reaps the whole job first, so a shorter job deadline still wins.
  it("keeps a job deadline shorter than the launcher's reap timer", async () => {
    execLaunchctl.mockResolvedValue(stopping("\texit timeout = 5\n\tpid = 4241\n"));
    await expect(readLaunchdStopTimeout(RESPAWNED_SERVICE_ENV)).resolves.toEqual({
      stop: { timeoutMs: 5_000, source: "launchd system/ai.openclaw.gateway exit timeout" },
    });
  });

  // The launcher timer belongs to a parent, so a Gateway that is the job itself is
  // never shortened by one even while carrying an inherited respawn marker.
  it("ignores the launcher timer when this process is the job", async () => {
    execLaunchctl.mockResolvedValue(stopping("\texit timeout = 55\n\tpid = 4242\n"));
    await expect(readLaunchdStopTimeout(RESPAWNED_SERVICE_ENV)).resolves.toEqual({
      stop: { timeoutMs: 55_000, source: "launchd system/ai.openclaw.gateway exit timeout" },
    });
  });

  // launchd is stopping the job, so a deadline is running even though its value
  // is unreadable. Guess short here: guessing long is what lets the drain die.
  it.each(["\tpid = 4242\n", "\texit timeout = not-a-number\n\tpid = 4242\n"])(
    "uses the conservative default when a running stop has no readable deadline",
    async (fields) => {
      execLaunchctl.mockResolvedValue(stopping(fields));
      const read = await readLaunchdStopTimeout(LAUNCHD_ENV);
      // A deadline IS running here, so this one is a real native budget even
      // though its value had to be defaulted.
      expect(read.stop?.timeoutMs).toBe(20_000);
      expect(read.stop?.source).toBe(
        "launchd system/ai.openclaw.gateway exit timeout unavailable; default ExitTimeOut",
      );
      expect(read.warning).toContain(
        "launchd is stopping system/ai.openclaw.gateway but its exit timeout is missing or invalid",
      );
    },
  );

  // THE REGRESSION GUARD for the failed-inspection path. A probe that established
  // nothing must report no deadline: handing back the Gateway's own stop policy
  // here is what let the caller classify an unverified number as a native stop
  // budget, capping a longer requested restart drain and arming a forced exit.
  it("reports no deadline when the job cannot be inspected", async () => {
    execLaunchctl.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "permission denied",
      termination: "exit",
    });
    const read = await readLaunchdStopTimeout(LAUNCHD_ENV);
    expect(read.stop).toBeNull();
    expect(read.warning).toContain(
      "system/ai.openclaw.gateway: launchctl print exited 1: permission denied",
    );
    expect(read.warning).toContain("keeping the Gateway stop policy");
    expect(read.warning).toContain("Check the running job with launchctl print.");
  });

  it("survives launchctl throwing rather than exiting nonzero", async () => {
    execLaunchctl.mockRejectedValue(new Error("spawn ENOENT"));
    const read = await readLaunchdStopTimeout(LAUNCHD_ENV);
    expect(read.stop).toBeNull();
    expect(read.warning).toContain("launchctl print threw");
  });

  it("honours an explicit label override", async () => {
    execLaunchctl.mockResolvedValue(stopping("\texit timeout = 45\n\tpid = 4242\n"));
    await expect(
      readLaunchdStopTimeout({ ...LAUNCHD_ENV, OPENCLAW_LAUNCHD_LABEL: "com.example.gw" }),
    ).resolves.toEqual({
      stop: { timeoutMs: 45_000, source: "launchd system/com.example.gw exit timeout" },
    });
  });

  it("warns instead of throwing when the configured label is invalid", async () => {
    const read = await readLaunchdStopTimeout({
      ...LAUNCHD_ENV,
      OPENCLAW_LAUNCHD_LABEL: "bad label/../etc",
    });
    expect(read.stop).toBeNull();
    expect(read.warning).toContain("label could not be resolved");
    expect(execLaunchctl).not.toHaveBeenCalled();
  });

  it("stays out of the way when this process is not a launchd job", async () => {
    await expect(readLaunchdStopTimeout({})).resolves.toEqual({ stop: null });
    expect(execLaunchctl).not.toHaveBeenCalled();
  });
});

// Ties the names this file caps on back to the implementation's own list. Without
// this, dropping a marker from that list would leave the cap cases above still
// passing against the two that remained.
describe("launcher respawn markers", () => {
  it.each(RESPAWN_MARKERS)("recognises %s as a respawning launcher", (marker) => {
    expect(isRespawnedByLauncher({ [marker]: "1" })).toBe(true);
  });

  it("recognises nothing else", () => {
    expect(isRespawnedByLauncher({})).toBe(false);
    expect(isRespawnedByLauncher({ OPENCLAW_SUPERVISOR_MODE: "external" })).toBe(false);
    // Only the set value counts, so an emptied or disabled marker caps nothing.
    expect(isRespawnedByLauncher({ OPENCLAW_NODE_UPDATE_RESPAWNED: "0" })).toBe(false);
    expect(isRespawnedByLauncher({ OPENCLAW_NODE_UPDATE_RESPAWNED: "" })).toBe(false);
  });
});
