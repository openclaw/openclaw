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
    { scope: "system", hierarchy: "0::", timeout: "1min 30s", timeoutMs: 90_000 },
    { scope: "user", hierarchy: "0::", timeout: "5min 30s", timeoutMs: 330_000 },
    { scope: "user", hierarchy: "1:name=systemd:", timeout: "5min 30s", timeoutMs: 330_000 },
  ])(
    "finds the custom $scope unit from $hierarchy membership, ignoring resource parents",
    async ({ scope, hierarchy, timeout, timeoutMs }) => {
      const path =
        scope === "user"
          ? "/user.slice/user-1000.slice/user@1000.service/app.slice/custom-gateway.service"
          : "/system.slice/custom-gateway.service";
      readFile.mockResolvedValue(
        ["2:cpu,cpuacct:/user.slice/user-1000.slice/user@1000.service", `${hierarchy}${path}`].join(
          "\n",
        ),
      );
      execUser.mockResolvedValue(loaded(timeout));
      expect(await readSystemdStopTimeout({ INVOCATION_ID: "own" })).toEqual({
        timeoutMs,
        source: `systemd ${scope} custom-gateway.service TimeoutStopUSec`,
      });
      const queried = scope === "user" ? execUser : execSystem;
      expect(queried.mock.calls.flat(2)).toContain("custom-gateway.service");
      expect(scope === "user" ? execSystem : execUser).not.toHaveBeenCalled();
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

  it.each([
    { code: 1, stdout: "", stderr: "permission denied" },
    { code: 0, stdout: "LoadState=not-found\nTimeoutStopUSec=1h", stderr: "" },
    loaded("garbage"),
    new Error("systemctl unavailable"),
  ])("uses a visible conservative default when inspection fails", async (result) => {
    const threw = result instanceof Error;
    if (threw) {
      execUser.mockRejectedValue(new Error("transport lookup failed"));
      execSystem.mockRejectedValue(result);
    } else {
      execSystem.mockResolvedValue(result);
    }
    const env = threw ? { INVOCATION_ID: "own" } : { OPENCLAW_SYSTEMD_UNIT: "custom" };
    const unit = threw ? "openclaw-gateway.service" : "custom.service";
    expect(await readSystemdStopTimeout(env)).toEqual({
      timeoutMs: 90_000,
      source: `systemd ${unit} timeout unavailable; default TimeoutStopUSec`,
      warning: expect.stringContaining(`system manager ${unit}:`),
    });
  });
});
