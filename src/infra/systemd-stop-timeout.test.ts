import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSystemdStopTimeout } from "./systemd-stop-timeout.js";

const { readFile, execUser, execSystem } = vi.hoisted(() => ({
  readFile: vi.fn(),
  execUser: vi.fn(),
  execSystem: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ default: { readFile } }));
vi.mock("../daemon/systemd-exec.js", () => ({
  execSystemctlUser: execUser,
  execSystemctl: execSystem,
}));
// Preserve the restart-owned unit-name resolver without loading unrelated runtime owners.
vi.mock("./restart.js", async (original) => {
  const actual = await original<typeof import("./restart.js")>();
  return { normalizeSystemdUnit: actual.normalizeSystemdUnit };
});
const loaded = (timeout: string, invocation = "own") => ({
  code: 0,
  stdout: `LoadState=loaded\nTimeoutStopUSec=${timeout}\nInvocationID=${invocation}`,
  stderr: "",
});

beforeEach(() => {
  readFile.mockReset().mockRejectedValue(new Error("unavailable"));
  execUser.mockReset().mockResolvedValue({ code: 1, stdout: "", stderr: "unavailable" });
  execSystem.mockReset().mockResolvedValue(loaded("1min 30s"));
});
afterEach(() => vi.restoreAllMocks());

describe("running systemd unit stop timeout", () => {
  it.each([
    { path: "/system.slice/custom-gateway.service", scope: "system" },
    {
      path: "/user.slice/user-1000.slice/user@1000.service/app.slice/custom-gateway.service",
      scope: "user",
    },
  ])("finds a custom $scope unit from invocation membership", async ({ path, scope }) => {
    readFile.mockResolvedValue(`0::${path}\n`);
    execUser.mockResolvedValue(loaded("1min 30s"));
    const result = await readSystemdStopTimeout({ INVOCATION_ID: "own" });
    expect(result).toEqual({
      timeoutMs: 90_000,
      source: `systemd ${scope} custom-gateway.service TimeoutStopUSec`,
    });
    const queried = scope === "user" ? execUser : execSystem;
    expect(queried.mock.calls.flat(2)).toContain("custom-gateway.service");
    expect(scope === "user" ? execSystem : execUser).not.toHaveBeenCalled();
  });

  it.each(["0::", "1:name=systemd:"])(
    "uses %s membership instead of resource-controller parents",
    async (hierarchy) => {
      readFile.mockResolvedValue(
        [
          "2:cpu,cpuacct:/user.slice/user-1000.slice/user@1000.service",
          `${hierarchy}/user.slice/user-1000.slice/user@1000.service/app.slice/custom-gateway.service`,
        ].join("\n"),
      );
      execUser.mockResolvedValue(loaded("5min 30s"));
      expect(await readSystemdStopTimeout({ INVOCATION_ID: "own" })).toEqual({
        timeoutMs: 330_000,
        source: "systemd user custom-gateway.service TimeoutStopUSec",
      });
      expect(execSystem).not.toHaveBeenCalled();
    },
  );

  it("rejects a same-named unit in the wrong manager", async () => {
    execUser.mockResolvedValue(loaded("10min", "other"));
    const result = await readSystemdStopTimeout({
      OPENCLAW_SYSTEMD_UNIT: "custom",
      INVOCATION_ID: "own",
    });
    expect(result).toEqual({
      timeoutMs: 90_000,
      source: "systemd system custom.service TimeoutStopUSec",
    });
  });

  it.each(["infinity", "0"])("accepts disabled stop timeouts (%s)", async (value) => {
    execUser.mockResolvedValue(loaded(value));
    expect(
      (await readSystemdStopTimeout({ OPENCLAW_PROFILE: "work", INVOCATION_ID: "own" }))?.timeoutMs,
    ).toBe(Infinity);
    expect(execUser.mock.calls.flat(2)).toContain("openclaw-gateway-work.service");
  });

  it("keeps startup available when the manager transport throws", async () => {
    execUser.mockRejectedValue(new Error("transport lookup failed"));
    execSystem.mockRejectedValue(new Error("systemctl unavailable"));
    expect((await readSystemdStopTimeout({ INVOCATION_ID: "own" }))?.timeoutMs).toBe(90_000);
  });

  it.each([
    { code: 1, stdout: "", stderr: "permission denied" },
    { code: 0, stdout: "LoadState=not-found\nTimeoutStopUSec=1h", stderr: "" },
    loaded("garbage"),
  ])("uses a visible conservative default when inspection fails", async (result) => {
    execSystem.mockResolvedValue(result);
    expect(await readSystemdStopTimeout({ OPENCLAW_SYSTEMD_UNIT: "custom" })).toEqual({
      timeoutMs: 90_000,
      source: "systemd custom.service timeout unavailable; default TimeoutStopUSec",
      warning: expect.stringContaining("system manager custom.service:"),
    });
  });
});
