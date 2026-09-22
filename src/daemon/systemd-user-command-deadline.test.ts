// Discovery and command dispatch share the caller's monotonic deadline and custody.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(1001);
  exec.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("systemd user routing deadline", () => {
  it.each([450, 500])("does not give fallback a new deadline after %s ms", async (spent) => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    exec.mockImplementation(async (_command, args) => {
      if (!args.includes("--machine")) {
        elapsed += spent;
        return unavailable;
      }
      return success(args.includes("Version") ? 's "252.39"' : "native result");
    });
    const result = await execBusctlUser(
      environment(`budget-${spent}`),
      ["--auto-start=no", "call", "org.freedesktop.systemd1"],
      500,
    );
    expect(exec.mock.calls[0]?.[2]?.timeout).toBe(166);
    if (spent === 450) {
      expect(exec).toHaveBeenCalledTimes(3);
      expect(exec.mock.calls[1]?.[1]).toContain("owned@");
      expect(exec.mock.calls[1]?.[2]?.timeout).toBe(25);
      expect(exec.mock.calls[2]?.[2]?.timeout).toBe(50);
      expect(result.code).toBe(0);
    } else {
      expect(exec).toHaveBeenCalledTimes(1);
      expect(result.termination).toBe("timeout");
      expect(result.code).not.toBe(0);
    }
  });
});

it("does not dispatch machine fallback after the original stop owner retires", async () => {
  let active = true;
  exec.mockImplementation(async () => {
    active = false;
    return unavailable;
  });
  await expect(
    execSystemctlUser(
      environment("retired-stop"),
      ["stop", "openclaw-gateway.service"],
      500,
      () => {
        if (!active) {
          throw new Error("original stop owner retired");
        }
      },
    ),
  ).rejects.toThrow("original stop owner retired");
  expect(exec).toHaveBeenCalledTimes(1);
});

it.each(["current", "retired", "guard-deadline"] as const)(
  "LoadUnit fallback retains the original %s authority and budget",
  async (mode) => {
    let active = true;
    let elapsed = 0;
    let firstProbeCompleted = false;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    exec.mockImplementation(async (_command, args) => {
      if (!args.includes("--machine")) {
        elapsed = 50;
        active = mode !== "retired";
        firstProbeCompleted = true;
        return unavailable;
      }
      return success(args.includes("Version") ? 's "252.39"' : "loaded unit");
    });
    const result = execBusctlUser(
      environment(`load-${mode}`),
      [
        "--auto-start=no",
        "call",
        ":1.42",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "LoadUnit",
        "s",
        "openclaw-gateway.service",
      ],
      500,
      () => {
        if (!active) {
          throw new Error("original load owner retired");
        }
        if (mode === "guard-deadline" && firstProbeCompleted) {
          elapsed = 500;
        }
      },
    );
    if (mode === "retired") {
      await expect(result).rejects.toThrow("original load owner retired");
    } else {
      expect((await result).termination).toBe(mode === "current" ? "exit" : "timeout");
    }
    expect(exec).toHaveBeenCalledTimes(mode === "current" ? 3 : 1);
    expect(exec.mock.calls.filter((call) => call[1].includes("LoadUnit"))).toHaveLength(
      mode === "current" ? 1 : 0,
    );
  },
);
