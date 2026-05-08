import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupStaleLaunchdUpdateJobs,
  ensureGatewayLaunchAgentEnabled,
} from "./launchd-stale-update.js";

const state = vi.hoisted(() => ({
  launchctlCalls: [] as string[][],
  listOutput: "",
  listCode: 0,
  listError: "",
  bootoutOverrides: new Map<string, { stderr: string; code: number }>(),
  enableOverrides: new Map<string, { stderr: string; code: number }>(),
}));

function normalizeLaunchctlArgs(file: string, args: string[]): string[] {
  if (file === "launchctl") {
    return args;
  }
  const idx = args.indexOf("launchctl");
  if (idx >= 0) {
    return args.slice(idx + 1);
  }
  return args;
}

vi.mock("./exec-file.js", () => ({
  execFileUtf8: vi.fn(async (file: string, args: string[]) => {
    const call = normalizeLaunchctlArgs(file, args);
    state.launchctlCalls.push(call);
    if (call[0] === "list") {
      if (state.listCode !== 0) {
        return { stdout: "", stderr: state.listError, code: state.listCode };
      }
      return { stdout: state.listOutput, stderr: "", code: 0 };
    }
    if (call[0] === "bootout") {
      const target = call[1] ?? "";
      const override = state.bootoutOverrides.get(target);
      if (override) {
        return { stdout: "", stderr: override.stderr, code: override.code };
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    if (call[0] === "enable") {
      const target = call[1] ?? "";
      const override = state.enableOverrides.get(target);
      if (override) {
        return { stdout: "", stderr: override.stderr, code: override.code };
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  }),
}));

const originalPlatform = process.platform;
const originalGetUid = process.getuid;

beforeEach(() => {
  state.launchctlCalls.length = 0;
  state.listOutput = "";
  state.listCode = 0;
  state.listError = "";
  state.bootoutOverrides.clear();
  state.enableOverrides.clear();
  Object.defineProperty(process, "platform", { value: "darwin" });
  process.getuid = () => 501;
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  process.getuid = originalGetUid;
});

describe("cleanupStaleLaunchdUpdateJobs", () => {
  it("returns no-op result on non-darwin platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const result = await cleanupStaleLaunchdUpdateJobs({ env: {} });
    expect(result).toEqual({
      attempted: false,
      bootedOutLabels: [],
      ignoredLabels: [],
      warnings: [],
    });
    expect(state.launchctlCalls).toEqual([]);
  });

  it("boots out a stale .openclaw.update. label", async () => {
    state.listOutput = [
      "PID\tStatus\tLabel",
      "-\t0\tcom.apple.something",
      "-\t0\tcom.example.openclaw.update.20260507-233128",
      "1234\t0\tai.openclaw.gateway",
    ].join("\n");

    const result = await cleanupStaleLaunchdUpdateJobs({ env: { OPENCLAW_PROFILE: "default" } });

    expect(result.attempted).toBe(true);
    expect(result.bootedOutLabels).toEqual(["com.example.openclaw.update.20260507-233128"]);
    expect(result.warnings).toEqual([]);

    const bootoutCalls = state.launchctlCalls.filter((c) => c[0] === "bootout");
    expect(bootoutCalls).toEqual([
      ["bootout", "gui/501/com.example.openclaw.update.20260507-233128"],
    ]);
  });

  it("ignores non-OpenClaw labels", async () => {
    state.listOutput = [
      "-\t0\tcom.apple.update.daemon",
      "-\t0\tcom.example.update.helper",
      "-\t0\tai.openclaw.gateway",
    ].join("\n");

    const result = await cleanupStaleLaunchdUpdateJobs({ env: {} });

    expect(result.bootedOutLabels).toEqual([]);
    expect(state.launchctlCalls.filter((c) => c[0] === "bootout")).toEqual([]);
  });

  it("ignores non-timestamped .openclaw.update. labels", async () => {
    // Only transient handoff labels (suffixed with `<YYYYMMDD>-<HHMMSS>`) are
    // stale; persistent vendor labels like `com.vendor.openclaw.update.checker`
    // must be left alone.
    state.listOutput = [
      "-\t0\tcom.vendor.openclaw.update.checker",
      "-\t0\tai.openclaw.update.legacy",
      "-\t0\tcom.foo.openclaw.update.20260507",
    ].join("\n");

    const result = await cleanupStaleLaunchdUpdateJobs({ env: {} });

    expect(result.bootedOutLabels).toEqual([]);
    expect(state.launchctlCalls.filter((c) => c[0] === "bootout")).toEqual([]);
  });

  it("never boots out the canonical gateway label even if the override matches the stale pattern", async () => {
    // OPENCLAW_LAUNCHD_LABEL points at a label that itself matches the
    // transient-update timestamp pattern. The cleanup must still skip it.
    state.listOutput = [
      "-\t0\tcom.custom.openclaw.update.20260507-000000",
      "-\t0\tcom.example.openclaw.update.20260507-233128",
    ].join("\n");

    const result = await cleanupStaleLaunchdUpdateJobs({
      env: { OPENCLAW_LAUNCHD_LABEL: "com.custom.openclaw.update.20260507-000000" },
    });

    expect(result.bootedOutLabels).toEqual(["com.example.openclaw.update.20260507-233128"]);
    const bootoutTargets = state.launchctlCalls.filter((c) => c[0] === "bootout").map((c) => c[1]);
    expect(bootoutTargets).not.toContain("gui/501/com.custom.openclaw.update.20260507-000000");
  });

  it("respects OPENCLAW_PROFILE when computing the canonical label to skip", async () => {
    state.listOutput = [
      "-\t0\tai.openclaw.staging",
      "-\t0\tcom.foo.openclaw.update.20260507-000000",
    ].join("\n");

    const result = await cleanupStaleLaunchdUpdateJobs({ env: { OPENCLAW_PROFILE: "staging" } });

    expect(result.bootedOutLabels).toEqual(["com.foo.openclaw.update.20260507-000000"]);
    const bootoutTargets = state.launchctlCalls.filter((c) => c[0] === "bootout").map((c) => c[1]);
    expect(bootoutTargets).not.toContain("gui/501/ai.openclaw.staging");
  });

  it("skips labels with unsafe characters even when they match the timestamp pattern", async () => {
    state.listOutput = [
      "-\t0\tcom.evil$(rm).openclaw.update.20260507-233128",
      "-\t0\tcom.example.openclaw.update.20260507-233128",
    ].join("\n");

    const result = await cleanupStaleLaunchdUpdateJobs({ env: {} });

    expect(result.bootedOutLabels).toEqual(["com.example.openclaw.update.20260507-233128"]);
    expect(result.ignoredLabels).toEqual(["com.evil$(rm).openclaw.update.20260507-233128"]);
  });

  it("falls back to the default canonical label and warns when OPENCLAW_LAUNCHD_LABEL is unsafe", async () => {
    state.listOutput = [
      "-\t0\tai.openclaw.gateway",
      "-\t0\tcom.example.openclaw.update.20260507-233128",
    ].join("\n");

    const result = await cleanupStaleLaunchdUpdateJobs({
      env: { OPENCLAW_LAUNCHD_LABEL: "ai.$(echo injected)" },
    });

    expect(result.bootedOutLabels).toEqual(["com.example.openclaw.update.20260507-233128"]);
    expect(result.warnings.some((w) => w.includes("OPENCLAW_LAUNCHD_LABEL"))).toBe(true);
  });

  it("warns when the resolved canonical label is unsafe but still cleans up stale jobs", async () => {
    state.listOutput = "-\t0\tcom.example.openclaw.update.20260507-233128\n";

    const result = await cleanupStaleLaunchdUpdateJobs({
      env: { OPENCLAW_PROFILE: "it's-bad" },
    });

    expect(result.bootedOutLabels).toEqual(["com.example.openclaw.update.20260507-233128"]);
    expect(result.warnings.some((w) => w.includes("not a valid launchd label"))).toBe(true);
  });

  it("records a warning when bootout fails but does not throw", async () => {
    state.listOutput = "-\t0\tcom.example.openclaw.update.20260507-233128\n";
    state.bootoutOverrides.set("gui/501/com.example.openclaw.update.20260507-233128", {
      stderr: "Operation not permitted",
      code: 1,
    });

    const result = await cleanupStaleLaunchdUpdateJobs({ env: {} });

    expect(result.bootedOutLabels).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("com.example.openclaw.update.20260507-233128");
    expect(result.warnings[0]).toContain("Operation not permitted");
  });

  it("treats bootout 'no such service' result as success-equivalent", async () => {
    state.listOutput = "-\t0\tcom.example.openclaw.update.20260507-233128\n";
    state.bootoutOverrides.set("gui/501/com.example.openclaw.update.20260507-233128", {
      stderr: "Could not find service",
      code: 113,
    });

    const result = await cleanupStaleLaunchdUpdateJobs({ env: {} });

    expect(result.bootedOutLabels).toEqual(["com.example.openclaw.update.20260507-233128"]);
    expect(result.warnings).toEqual([]);
  });

  it("records a warning and returns when launchctl list fails", async () => {
    state.listCode = 1;
    state.listError = "launchctl: list: Operation not permitted";

    const result = await cleanupStaleLaunchdUpdateJobs({ env: {} });

    expect(result.attempted).toBe(true);
    expect(result.bootedOutLabels).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("launchctl list");
    expect(state.launchctlCalls.filter((c) => c[0] === "bootout")).toEqual([]);
  });
});

describe("ensureGatewayLaunchAgentEnabled", () => {
  it("returns no-op result on non-darwin platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const result = await ensureGatewayLaunchAgentEnabled({ env: {} });
    expect(result).toEqual({ attempted: false, enabled: false, warnings: [] });
    expect(state.launchctlCalls).toEqual([]);
  });

  it("calls launchctl enable for the canonical gateway service target", async () => {
    const result = await ensureGatewayLaunchAgentEnabled({
      env: { OPENCLAW_PROFILE: "default" },
    });
    expect(result).toEqual({ attempted: true, enabled: true, warnings: [] });
    expect(state.launchctlCalls).toContainEqual(["enable", "gui/501/ai.openclaw.gateway"]);
  });

  it("uses OPENCLAW_PROFILE when computing the canonical label", async () => {
    const result = await ensureGatewayLaunchAgentEnabled({
      env: { OPENCLAW_PROFILE: "staging" },
    });
    expect(result.enabled).toBe(true);
    expect(state.launchctlCalls).toContainEqual(["enable", "gui/501/ai.openclaw.staging"]);
  });

  it("records a warning when launchctl enable fails", async () => {
    state.enableOverrides.set("gui/501/ai.openclaw.gateway", {
      stderr: "Operation not permitted",
      code: 1,
    });

    const result = await ensureGatewayLaunchAgentEnabled({
      env: { OPENCLAW_PROFILE: "default" },
    });

    expect(result.attempted).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("ai.openclaw.gateway");
    expect(result.warnings[0]).toContain("Operation not permitted");
  });

  it("falls back to the default canonical label when OPENCLAW_LAUNCHD_LABEL is unsafe", async () => {
    const result = await ensureGatewayLaunchAgentEnabled({
      env: { OPENCLAW_LAUNCHD_LABEL: "ai.$(echo injected)" },
    });

    expect(result.attempted).toBe(true);
    expect(result.enabled).toBe(true);
    expect(state.launchctlCalls).toContainEqual(["enable", "gui/501/ai.openclaw.gateway"]);
    expect(result.warnings.some((w) => w.includes("OPENCLAW_LAUNCHD_LABEL"))).toBe(true);
  });

  it("skips launchctl enable and warns when the resolved canonical label is unsafe", async () => {
    // OPENCLAW_PROFILE produces a profile-suffixed label
    // (`ai.openclaw.<profile>`); a profile containing shell-unsafe characters
    // yields an invalid resolved label. The helper must not feed that into
    // launchctl.
    const result = await ensureGatewayLaunchAgentEnabled({
      env: { OPENCLAW_PROFILE: "it's-bad" },
    });

    expect(result.attempted).toBe(true);
    expect(result.enabled).toBe(false);
    expect(state.launchctlCalls.filter((c) => c[0] === "enable")).toEqual([]);
    expect(result.warnings.some((w) => w.includes("not a valid launchd label"))).toBe(true);
  });
});
