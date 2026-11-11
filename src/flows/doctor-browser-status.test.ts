import { beforeEach, expect, it, vi } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import { createDoctorHealthFlowContext } from "./doctor-health-context.test-support.js";
import { runBrowserHealth } from "./doctor-health-contribution-runners.gateway.js";
import { runDoctorHealthRepairs } from "./doctor-repair-flow.js";
import type { HealthFinding } from "./health-checks.js";

const capture = vi.hoisted(() => ({ note: vi.fn(), load: vi.fn(), repair: vi.fn() }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: capture.note }));
vi.mock(import("../plugin-sdk/facade-loader.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  loadBundledPluginPublicSurfaceModuleSyncCore: capture.load,
}));
const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/browser")!;
const finding: HealthFinding = {
  checkId: check.id,
  severity: "info",
  category: "recommended",
  message: "Browser setup advice",
  ocPath: "oc://openclaw.json/browser",
};
const context = () => ({
  mode: "fix" as const,
  cfg: {},
  runtime: { log() {}, error() {}, exit() {} },
});

beforeEach(() => {
  capture.note.mockClear();
  capture.repair.mockReset().mockResolvedValue({ changes: [], warnings: [] });
  capture.load.mockReset().mockReturnValue({
    collectBrowserReadinessFindings: async () => [finding],
    maybeRepairOwnedChromeExtensionNativeHosts: capture.repair,
  });
});

// Profile privacy, executable diagnosis and native-host skip behavior belong to
// extensions/browser/src/doctor-browser.test.ts; this suite owns core adaptation.
it.each(["info", "warning"] as const)(
  "filters %s advice only in interactive Doctor",
  async (severity) => {
    const expected = { ...finding, severity };
    capture.load.mockReturnValue({ collectBrowserReadinessFindings: async () => [expected] });
    const ctx = createDoctorHealthFlowContext();
    await runBrowserHealth(ctx);
    expect(ctx.healthFindings).toEqual(severity === "info" ? [] : [expected]);
    expect(capture.note).not.toHaveBeenCalled();
    expect(await check.detect(context())).toEqual([expected]);
  },
);

it("retains an actionable inspection gap when the bundled browser surface cannot load", async () => {
  capture.load.mockImplementation(() => {
    throw new Error("synthetic browser unavailable");
  });
  const ctx = createDoctorHealthFlowContext();
  await runBrowserHealth(ctx);
  expect(ctx.healthFindings).toEqual([
    expect.objectContaining({
      category: "fix-now",
      message: expect.stringContaining("synthetic browser unavailable"),
      fixHint: expect.stringContaining("bundled browser plugin"),
    }),
  ]);
  const run = await runDoctorHealthRepairs(context(), { checks: [check] });
  expect(run.remainingFindings).toEqual(ctx.healthFindings);
  expect(run.warnings.join("\n")).toContain("repair failed:");
});

const skippedWarning = "native-host repair skipped: invalid registration";
it.each([
  [{ changes: [], warnings: [skippedWarning] }, "failed", skippedWarning],
  [
    { status: "failed", reason: "registration integrity failure", changes: [], warnings: [] },
    "failed",
    "registration integrity failure",
  ],
  [{ changes: ["Repaired registration."], warnings: [] }, undefined, undefined],
] as const)("adapts repair output %j", async (output, status, reason) => {
  capture.repair.mockResolvedValue(output);
  const result = await check.repair?.(context(), []);
  expect(result).toEqual({ ...output, ...(status ? { status, reason } : {}) });
  const run = await runDoctorHealthRepairs(context(), { checks: [check] });
  expect(run.remainingFindings).toEqual(run.findings);
  expect(run.warnings.join("\n")).toContain(
    status === "failed" ? `repair failed: ${reason}` : "repair left",
  );
  if (!status) {
    expect(run.warnings).toEqual(["core/doctor/browser repair left 1 finding(s)"]);
  }
});

it("keeps repair-hook exceptions as failures", async () => {
  capture.repair.mockRejectedValue(new Error("synthetic browser repair unavailable"));
  const result = await check.repair?.(context(), []);
  expect(result).toMatchObject({ status: "failed", changes: [] });
  expect(result?.warnings?.join("\n")).toContain("synthetic browser repair unavailable");
  const run = await runDoctorHealthRepairs(context(), { checks: [check] });
  expect(run.remainingFindings).toEqual(run.findings);
  expect(run.warnings.join("\n")).toContain("repair failed:");
});

it("does not load or invoke native-host repair in dry-run", async () => {
  const result = await check.repair?.({ ...context(), dryRun: true }, []);
  expect(result).toEqual({
    status: "skipped",
    reason: "native-host repair requires filesystem writes",
    changes: [],
  });
  expect(capture.load).not.toHaveBeenCalled();
  const run = await runDoctorHealthRepairs(context(), { checks: [check], dryRun: true });
  expect(run).toMatchObject({
    changes: [],
    effects: [],
    warnings: [`core/doctor/browser repair skipped: ${result!.reason}`],
  });
  expect(run.remainingFindings).toEqual(run.findings);
  expect(capture.repair).not.toHaveBeenCalled();
});
