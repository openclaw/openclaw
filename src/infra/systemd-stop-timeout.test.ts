import { beforeEach, expect, it, vi } from "vitest";
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
const own = { INVOCATION_ID: "own" };
const userParent = "/user.slice/user-1000.slice/user@1000.service";
const customUnit = "custom-gateway.service";
beforeEach(() => {
  readFile.mockReset().mockRejectedValue(new Error("unavailable"));
  execUser.mockReset().mockResolvedValue({ code: 1, stdout: "", stderr: "unavailable" });
  execSystem.mockReset().mockResolvedValue(loaded("1min 30s"));
});

type UnitCase = {
  name: string;
  scope: "user" | "system";
  membership: string;
  user: ReturnType<typeof loaded>;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  unit: string;
  exclusive: boolean;
};
it.each`
  name                          | scope       | membership                                                | user                        | env                                            | timeoutMs   | unit                               | exclusive
  ${"system cgroup v2"}         | ${"system"} | ${`0::/system.slice/${customUnit}`}                       | ${loaded("1min 30s")}       | ${own}                                         | ${90_000}   | ${customUnit}                      | ${true}
  ${"user cgroup v2"}           | ${"user"}   | ${`0::${userParent}/app.slice/${customUnit}`}             | ${loaded("5min 30s")}       | ${own}                                         | ${330_000}  | ${customUnit}                      | ${true}
  ${"user legacy hierarchy"}    | ${"user"}   | ${`1:name=systemd:${userParent}/app.slice/${customUnit}`} | ${loaded("5min 30s")}       | ${own}                                         | ${330_000}  | ${customUnit}                      | ${true}
  ${"wrong-manager invocation"} | ${"system"} | ${""}                                                     | ${loaded("10min", "other")} | ${{ ...own, OPENCLAW_SYSTEMD_UNIT: "custom" }} | ${90_000}   | ${"custom.service"}                | ${false}
  ${"disabled infinity"}        | ${"user"}   | ${""}                                                     | ${loaded("infinity")}       | ${{ ...own, OPENCLAW_PROFILE: "work" }}        | ${Infinity} | ${"openclaw-gateway-work.service"} | ${false}
  ${"disabled zero"}            | ${"user"}   | ${""}                                                     | ${loaded("0")}              | ${{ ...own, OPENCLAW_PROFILE: "work" }}        | ${Infinity} | ${"openclaw-gateway-work.service"} | ${false}
`(
  "reads the running unit timeout: $name",
  async ({ scope, membership, user, env, timeoutMs, unit, exclusive }: UnitCase) => {
    if (membership) {
      readFile.mockResolvedValue(`2:cpu,cpuacct:${userParent}\n${membership}`);
    }
    execUser.mockResolvedValue(user);
    expect(await readSystemdStopTimeout(env)).toEqual({
      timeoutMs,
      source: `systemd ${scope} ${unit} TimeoutStopUSec`,
    });
    expect((scope === "user" ? execUser : execSystem).mock.calls.flat(2)).toContain(unit);
    if (exclusive) {
      expect(scope === "user" ? execSystem : execUser).not.toHaveBeenCalled();
    }
  },
);

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
  const env = threw ? own : { OPENCLAW_SYSTEMD_UNIT: "custom" };
  const unit = threw ? "openclaw-gateway.service" : "custom.service";
  expect(await readSystemdStopTimeout(env)).toEqual({
    timeoutMs: 90_000,
    source: `systemd ${unit} timeout unavailable; default TimeoutStopUSec`,
    warning: expect.stringContaining(`system manager ${unit}:`),
  });
});
