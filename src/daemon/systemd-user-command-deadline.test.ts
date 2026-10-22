import { afterEach, beforeEach, expect, it, vi } from "vitest";
const exec = vi.hoisted(() => vi.fn<typeof import("./exec-file.js").execFileUtf8>());
vi.mock("./exec-file.js", () => ({ execFileUtf8: exec }));
import { execBusctlUser, execSystemctlUser } from "./systemd-exec.js";

const environment = (name: string) => ({
  USER: "owned",
  LOGNAME: "owned",
  HOME: "/test/owned",
  XDG_RUNTIME_DIR: `/runtime/${name}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/runtime/${name}/bus`,
});
const unavailable = {
  code: 1,
  termination: "exit" as const,
  stdout: "",
  stderr: "Failed to connect to bus: No medium found",
};
const success = (stdout: string) => ({ code: 0, termination: "exit" as const, stdout, stderr: "" });
function fallback(spent: number, onProbe = () => {}) {
  const clock = { elapsed: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.elapsed);
  exec.mockImplementation(async (_command, args) => {
    if (args.includes("--machine")) {
      return success(args.includes("Version") ? 's "252.39"' : "native result");
    }
    clock.elapsed += spent;
    onProbe();
    return unavailable;
  });
  return clock;
}
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(1001);
  exec.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it.each([450, 500])("does not give fallback a new deadline after %s ms", async (spent) => {
  fallback(spent);
  const result = await execBusctlUser(
    environment(`budget-${spent}`),
    ["--auto-start=no", "call", "org.freedesktop.systemd1"],
    500,
  );
  expect(exec.mock.calls[0]?.[2]?.timeout).toBe(166);
  if (spent === 450) {
    expect(exec.mock.calls[1]?.[1]).toContain("owned@");
    expect(exec.mock.calls.map((call) => call[2]?.timeout)).toEqual([166, 25, 50]);
    expect(result.code).toBe(0);
  } else {
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.termination).toBe("timeout");
    expect(result.code).not.toBe(0);
  }
});

it.each(["current", "retired", "slow-guard", "stop"] as const)(
  "%s fallback retains the original authority and budget",
  async (mode) => {
    let active = true;
    const retired = mode === "retired" || mode === "stop";
    const operation = mode === "stop" ? "stop" : "load";
    const clock = fallback(50, () => {
      active = !retired;
    });
    const run = mode === "stop" ? execSystemctlUser : execBusctlUser;
    const args =
      mode === "stop"
        ? ["stop", "openclaw-gateway.service"]
        : (
            "--auto-start=no call :1.42 /org/freedesktop/systemd1 " +
            "org.freedesktop.systemd1.Manager LoadUnit s openclaw-gateway.service"
          ).split(" ");
    const result = run(environment(`load-${mode}`), args, 500, () => {
      if (!active) {
        throw new Error(`original ${operation} owner retired`);
      }
      if (mode === "slow-guard" && clock.elapsed > 0) {
        clock.elapsed = 500;
      }
    });
    if (retired) {
      await expect(result).rejects.toThrow(`original ${operation} owner retired`);
    } else {
      const outcome = await result;
      expect([outcome.termination, outcome.inspectionReason]).toEqual(["exit", undefined]);
    }
    expect(exec).toHaveBeenCalledTimes(retired ? 1 : 3);
    expect(exec.mock.calls.filter((call) => call[1].includes("LoadUnit"))).toHaveLength(
      retired ? 0 : 1,
    );
  },
);
