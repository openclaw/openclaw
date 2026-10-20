// Real browser contribution, facade, and structured repair contract; synthetic profiles only.
import fs from "node:fs";
import fsp from "node:fs/promises";
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
const privateFiles = new Set(["Local State", "Preferences", "Secure Preferences", "Cookies"]);
const noRepair = { changes: [], effects: [] };

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(accesses).toEqual([]);
});

beforeEach(() => {
  capture.note.mockClear();
  capture.load.mockReset().mockImplementation(() => capture.surface);
  const home = dirs.make("doctor-browser-flow-");
  const configDir = path.join(home, ".openclaw");
  const extensionDir = path.join(configDir, "browser", "chrome-extension");
  const profileRoot = path.join(home, "Library", "Application Support", "Google", "Chrome");
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(path.join(extensionDir, ".openclaw-owned.json"), '{"v":1}');
  fs.mkdirSync(path.join(profileRoot, "Default"), { recursive: true });
  for (const name of ["Preferences", "Secure Preferences"]) {
    fs.writeFileSync(path.join(profileRoot, "Default", name), "{}");
  }
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", configDir);
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  accesses = [];
  const deny = (target: unknown) => {
    if (!privateFiles.has(path.basename(String(target)))) {
      return;
    }
    accesses.push(String(target));
    throw Object.assign(new Error("synthetic permission denial"), { code: "EACCES" });
  };
  const syncRead = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
    deny(args[0]);
    return syncRead(...args);
  });
  const asyncRead = fsp.readFile;
  vi.spyOn(fsp, "readFile").mockImplementation(async (...args) => {
    deny(args[0]);
    return await asyncRead(...args);
  });
  capture.surface = browserDoctor;
  const readdir = fsp.readdir;
  vi.spyOn(fsp, "readdir").mockImplementation(async (...args) => {
    if (String(args[0]) === profileRoot) {
      accesses.push(String(args[0]));
    }
    return await readdir(...args);
  });
  ctx = createDoctorHealthFlowContext({
    cfg: { browser: { extensionRelay: { allowLegacyAuth: false } } },
    configPath: path.join(configDir, "openclaw.json"),
    env: { HOME: home, OPENCLAW_STATE_DIR: configDir },
  });
});

let ctx: DoctorHealthFlowContext;
let accesses: string[];
const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/browser")!;
function repairContext() {
  return { cfg: ctx.cfg, runtime: ctx.runtime, mode: "fix" as const, configPath: ctx.configPath };
}

it.each([false, true])(
  "preserves full/facade/structured browser skip (import %s)",
  async (allowSystemProfileImport) => {
    ctx.cfg = { browser: { ...ctx.cfg.browser, allowSystemProfileImport } };
    await runBrowserHealth(ctx);
    expect(accesses).toEqual([]);
    const notes = capture.note.mock.calls.map(([message]) => String(message)).join("\n");
    expect(notes).toContain("profile discovery skipped");
    expect(notes).toContain("native bootstrap was not inspected");
    const findings = await check.detect(repairContext());
    const findingText = findings
      .map((finding) => [finding.message, finding.fixHint].join("\n"))
      .join("\n");
    expect(findingText).toContain("profile discovery skipped");
    expect(findingText).toContain("native bootstrap was not inspected");
    const result = await check.repair?.(repairContext(), findings);
    expect(result).toMatchObject({ changes: [], status: "skipped" });
    expect(result?.warnings?.join("\n")).toContain("native-host repair skipped");
    expect(result?.reason).toContain("Doctor does not inspect personal browser profiles");
    await expect(maybeRepairOwnedChromeExtensionNativeHosts()).resolves.toEqual(result);
    const run = await runDoctorHealthRepairs(repairContext(), { checks: [check] });
    expect(run).toMatchObject(noRepair);
    expect(run.remainingFindings).toEqual(run.findings);
    expect(run.warnings).toEqual([
      ...result!.warnings!,
      `core/doctor/browser repair skipped: ${result!.reason}`,
    ]);
  },
);

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
    const run = await runDoctorHealthRepairs(repairContext(), { checks: [check] });
    expect(run.remainingFindings).toEqual(run.findings);
    expect(run.warnings.join("\n")).toContain(
      status === "failed" ? `repair failed: ${reason}` : "repair left",
    );
    expect(accesses).toEqual([]);
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
  const run = await runDoctorHealthRepairs(repairContext(), { checks: [check] });
  expect(run.remainingFindings).toEqual(run.findings);
  expect(run.warnings.join("\n")).toContain("repair failed:");
  expect(accesses).toEqual([]);
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
  const run = await runDoctorHealthRepairs(repairContext(), { checks: [check], dryRun: true });
  expect(run).toMatchObject(noRepair);
  expect(run.remainingFindings).toEqual(run.findings);
  expect(run.warnings).toEqual([`core/doctor/browser repair skipped: ${result!.reason}`]);
  expect(repair).not.toHaveBeenCalled();
  expect(accesses).toEqual([]);
});
