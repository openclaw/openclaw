// Profile access permissions are owned by extensions/browser/src/doctor-browser.permissions.test.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { maybeRepairOwnedChromeExtensionNativeHosts } from "../commands/doctor-browser.js";
import { useAutoCleanupTempDirTracker } from "../plugin-sdk/test-env.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import { runBrowserHealth } from "./doctor-health-contribution-runners.gateway.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { createDoctorHealthFlowContext } from "./doctor-health-contributions.test-support.js";
import { runDoctorHealthRepairs } from "./doctor-repair-flow.js";

const capture = vi.hoisted(() => ({ note: vi.fn(), load: vi.fn(), surface: {} }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: capture.note }));
vi.mock(import("../plugin-sdk/facade-loader.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  loadBundledPluginPublicSurfaceModuleSyncCore: capture.load,
}));
vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-utility-runtime")>();
  return {
    ...actual,
    get CONFIG_DIR() {
      return process.env.OPENCLAW_STATE_DIR ?? actual.CONFIG_DIR;
    },
  };
});
const browserDoctor = await loadBundledPluginFacade<typeof import("../commands/doctor-browser.js")>(
  { pluginId: "browser", artifactBasename: "browser-doctor.js" },
);
const dirs = useAutoCleanupTempDirTracker(afterEach);
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const noRepair = { changes: [], effects: [] };

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  capture.note.mockClear();
  capture.load.mockReset().mockImplementation(() => capture.surface);
  const home = dirs.make("doctor-browser-flow-");
  const configDir = path.join(home, ".openclaw");
  const extensionDir = path.join(configDir, "browser", "chrome-extension");
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(path.join(extensionDir, ".openclaw-owned.json"), '{"v":1}');
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", configDir);
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  capture.surface = browserDoctor;
  ctx = createDoctorHealthFlowContext({
    cfg: { browser: { extensionRelay: { allowLegacyAuth: false } } },
    configPath: path.join(configDir, "openclaw.json"),
    env: { HOME: home, OPENCLAW_STATE_DIR: configDir },
  });
});

let ctx: DoctorHealthFlowContext;
const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/browser")!;
function repairContext() {
  return { cfg: ctx.cfg, runtime: ctx.runtime, mode: "fix" as const, configPath: ctx.configPath };
}
function expectSkipNotes(text: string) {
  expect(text).toContain("profile discovery skipped");
  expect(text).toContain("native bootstrap was not inspected");
}

it("preserves full/facade/structured browser skip", async () => {
  await runBrowserHealth(ctx);
  expectSkipNotes(capture.note.mock.calls.map(([message]) => String(message)).join("\n"));
  const findings = await check.detect(repairContext());
  expectSkipNotes(
    findings.map((finding) => [finding.message, finding.fixHint].join("\n")).join("\n"),
  );
  const result = await check.repair?.(repairContext(), findings);
  expect(result).toMatchObject({ changes: [], status: "skipped" });
  expect(result?.warnings?.join("\n")).toContain("native-host repair skipped");
  expect(result?.reason).toContain("Doctor does not inspect personal browser profiles");
  await expect(maybeRepairOwnedChromeExtensionNativeHosts()).resolves.toEqual(result);
  const run = await runDoctorHealthRepairs(repairContext(), { checks: [check] });
  expect(run.remainingFindings).toEqual(run.findings);
  expect(run).toMatchObject(noRepair);
  expect(run.warnings).toEqual([
    ...result!.warnings!,
    `core/doctor/browser repair skipped: ${result!.reason}`,
  ]);
});

const skippedWarning = "native-host repair skipped: invalid registration";
const integrityFailure = "registration integrity failure";
it.each([
  [
    "warning-only failure, even with skipped text",
    { changes: [], warnings: [skippedWarning] },
    "failed",
    skippedWarning,
  ],
  [
    "explicit failure",
    { status: "failed", reason: integrityFailure, changes: [], warnings: [] },
    "failed",
    integrityFailure,
  ],
  ["completed repair", { changes: ["Repaired registration."], warnings: [] }, undefined, undefined],
] as const)(
  "preserves %s through the facade and adapter",
  async (_label, output, status, reason) => {
    capture.surface = {
      ...capture.surface,
      maybeRepairOwnedChromeExtensionNativeHosts: vi.fn().mockResolvedValue(output),
    };
    await expect(maybeRepairOwnedChromeExtensionNativeHosts()).resolves.toEqual(output);
    const result = await check.repair?.(repairContext(), []);
    expect(result).toMatchObject({ changes: output.changes, warnings: output.warnings });
    expect([result?.status, result?.reason]).toEqual([status, reason]);
  },
);

it.each(["loader", "repair hook"])("keeps %s errors as failures", async (source) => {
  const fail = () => {
    throw new Error("synthetic browser repair unavailable");
  };
  if (source === "loader") {
    capture.load.mockImplementation(fail);
  } else {
    capture.surface = { ...capture.surface, maybeRepairOwnedChromeExtensionNativeHosts: fail };
  }
  const result = await check.repair?.(repairContext(), []);
  expect(result).toMatchObject({ status: "failed", changes: [] });
  expect(result?.warnings?.join("\n")).toContain("synthetic browser repair unavailable");
});

it("does not load or invoke native-host repair in dry-run", async () => {
  const repair = vi.fn().mockRejectedValue(new Error("must not invoke repair"));
  capture.surface = { ...capture.surface, maybeRepairOwnedChromeExtensionNativeHosts: repair };
  const result = await check.repair?.({ ...repairContext(), dryRun: true }, []);
  expect(result).toEqual({
    status: "skipped",
    reason: "native-host repair requires filesystem writes",
    changes: [],
  });
  expect(capture.load).not.toHaveBeenCalled();
  expect(repair).not.toHaveBeenCalled();
});
