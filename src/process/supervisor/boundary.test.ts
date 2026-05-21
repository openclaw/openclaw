import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInlineBoundary,
  createLaunchdJobBoundary,
  createSystemdScopeBoundary,
  isLaunchdAvailable,
  isSystemdUserScopeAvailable,
  resolveSupervisorBoundary,
  sanitizeLaunchdLabelFragment,
  sanitizeSystemdUnitFragment,
} from "./boundary.js";

const WORKER_ARGV = ["/usr/bin/node", "worker.js", "--flag"];

describe("supervisor boundary: systemd scope", () => {
  it("wraps the worker argv in a transient user scope and survives restart", () => {
    const plan = createSystemdScopeBoundary().plan({ argv: WORKER_ARGV, runId: "run-123" });

    expect(plan.kind).toBe("systemd-scope");
    expect(plan.command).toBe("systemd-run");
    expect(plan.unitId).toBe("openclaw-worker-run-123.scope");
    expect(plan.survivesSupervisorRestart).toBe(true);
    expect(plan.args).toEqual([
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--unit=openclaw-worker-run-123.scope",
      "--",
      ...WORKER_ARGV,
    ]);
  });

  it("stops the worker by stopping its scope unit, not by signalling a pid", () => {
    const plan = createSystemdScopeBoundary().plan({ argv: WORKER_ARGV, runId: "run-123" });
    expect(plan.stopCommand).toEqual({
      command: "systemctl",
      args: ["--user", "stop", "openclaw-worker-run-123.scope"],
    });
  });

  it("keeps the `--` separator immediately before the worker argv", () => {
    const plan = createSystemdScopeBoundary().plan({ argv: WORKER_ARGV, runId: "x" });
    const separatorIndex = plan.args.indexOf("--");
    expect(separatorIndex).toBeGreaterThanOrEqual(0);
    expect(plan.args.slice(separatorIndex + 1)).toEqual(WORKER_ARGV);
  });
});

describe("supervisor boundary: launchd job", () => {
  it("submits a transient per-user job that survives restart", () => {
    const plan = createLaunchdJobBoundary().plan({ argv: WORKER_ARGV, runId: "run-123" });

    expect(plan.kind).toBe("launchd-job");
    expect(plan.command).toBe("launchctl");
    expect(plan.unitId).toBe("ai.openclaw.worker.run-123");
    expect(plan.survivesSupervisorRestart).toBe(true);
    expect(plan.args).toEqual(["submit", "-l", "ai.openclaw.worker.run-123", "--", ...WORKER_ARGV]);
  });

  it("removes the worker by label", () => {
    const plan = createLaunchdJobBoundary().plan({ argv: WORKER_ARGV, runId: "run-123" });
    expect(plan.stopCommand).toEqual({
      command: "launchctl",
      args: ["remove", "ai.openclaw.worker.run-123"],
    });
  });
});

describe("supervisor boundary: inline", () => {
  it("spawns the worker directly with no survival guarantee", () => {
    const plan = createInlineBoundary().plan({ argv: WORKER_ARGV, runId: "run-123" });
    expect(plan.kind).toBe("inline");
    expect(plan.command).toBe("/usr/bin/node");
    expect(plan.args).toEqual(["worker.js", "--flag"]);
    expect(plan.survivesSupervisorRestart).toBe(false);
    expect(plan.stopCommand).toBeNull();
    expect(plan.unitId).toBeUndefined();
  });

  it("handles empty argv without throwing", () => {
    const plan = createInlineBoundary().plan({ argv: [], runId: "" });
    expect(plan.command).toBe("");
    expect(plan.args).toEqual([]);
  });
});

describe("unit/label fragment sanitization", () => {
  it("maps systemd-disallowed characters to a single dash", () => {
    expect(sanitizeSystemdUnitFragment("a/b c@d")).toBe("a-b-c-d");
  });

  it("preserves systemd-allowed characters", () => {
    expect(sanitizeSystemdUnitFragment("Run_1:2.3-4")).toBe("Run_1:2.3-4");
  });

  it("falls back to anon for empty or all-invalid runIds", () => {
    expect(sanitizeSystemdUnitFragment("")).toBe("anon");
    expect(sanitizeSystemdUnitFragment("///")).toBe("anon");
    expect(sanitizeLaunchdLabelFragment("@@@")).toBe("anon");
  });

  it("strips leading/trailing dashes and caps very long ids", () => {
    expect(sanitizeSystemdUnitFragment("-x-")).toBe("x");
    expect(sanitizeSystemdUnitFragment("a".repeat(500)).length).toBe(180);
  });

  it("keeps launchd reverse-DNS dots but drops colons", () => {
    expect(sanitizeLaunchdLabelFragment("a:b.c")).toBe("a-b.c");
  });

  it("produces a valid full systemd scope name shorter than the systemd limit", () => {
    const plan = createSystemdScopeBoundary().plan({ argv: WORKER_ARGV, runId: "z".repeat(500) });
    expect(plan.unitId?.endsWith(".scope")).toBe(true);
    // systemd unit names must be < 256 bytes.
    expect((plan.unitId ?? "").length).toBeLessThan(256);
  });
});

describe("availability probes", () => {
  // A fixture PATH dir holding a fake `systemd-run` binary so the probe's
  // binary/bus branches are exercised deterministically, independent of host.
  let binDir = "";

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), "openclaw-boundary-bin-"));
    const fake = join(binDir, "systemd-run");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
  });

  afterAll(() => {
    if (binDir) {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("is unavailable when the systemd-run binary is missing from PATH", () => {
    const env = {
      PATH: join(tmpdir(), "openclaw-no-such-bin-dir"),
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    } satisfies NodeJS.ProcessEnv;
    expect(isSystemdUserScopeAvailable(env, "linux")).toBe(false);
  });

  it("is available when the binary exists and a user bus is reachable", () => {
    const env = {
      PATH: binDir,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    } satisfies NodeJS.ProcessEnv;
    expect(isSystemdUserScopeAvailable(env, "linux")).toBe(true);
  });

  it("is unavailable when the binary exists but no user bus is reachable", () => {
    const env = { PATH: binDir } satisfies NodeJS.ProcessEnv;
    expect(isSystemdUserScopeAvailable(env, "linux")).toBe(false);
  });

  it("systemd scope is never available off Linux", () => {
    expect(isSystemdUserScopeAvailable(process.env, "darwin")).toBe(false);
    expect(isSystemdUserScopeAvailable(process.env, "win32")).toBe(false);
  });

  it("launchd is never available off macOS", () => {
    expect(isLaunchdAvailable(process.env, "linux")).toBe(false);
    expect(isLaunchdAvailable(process.env, "win32")).toBe(false);
  });
});

describe("resolveSupervisorBoundary", () => {
  it("uses the systemd scope on Linux when available", () => {
    const boundary = resolveSupervisorBoundary({ platform: "linux", systemdAvailable: true });
    expect(boundary.kind).toBe("systemd-scope");
  });

  it("falls back to inline on Linux when systemd is unavailable", () => {
    const boundary = resolveSupervisorBoundary({ platform: "linux", systemdAvailable: false });
    expect(boundary.kind).toBe("inline");
  });

  it("uses the launchd job on macOS when available", () => {
    const boundary = resolveSupervisorBoundary({ platform: "darwin", launchdAvailable: true });
    expect(boundary.kind).toBe("launchd-job");
  });

  it("falls back to inline on macOS when launchd is unavailable", () => {
    const boundary = resolveSupervisorBoundary({ platform: "darwin", launchdAvailable: false });
    expect(boundary.kind).toBe("inline");
  });

  it("is inline on unsupported platforms", () => {
    const boundary = resolveSupervisorBoundary({ platform: "win32" });
    expect(boundary.kind).toBe("inline");
  });
});
