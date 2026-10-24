// Real browser contribution, facade, and structured repair contract; synthetic profiles only.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { maybeRepairOwnedChromeExtensionNativeHosts } from "../commands/doctor-browser.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import { useAutoCleanupTempDirTracker } from "../plugin-sdk/test-env.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import { runBrowserHealth } from "./doctor-health-contribution-runners.gateway.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
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
// Load the real public artifact through the shared test loader, keeping plugin
// implementation types out of the core typecheck graph.
const browserDoctor = await loadBundledPluginFacade<typeof import("../commands/doctor-browser.js")>(
  { pluginId: "browser", artifactBasename: "browser-doctor.js" },
);
const dirs = useAutoCleanupTempDirTracker(afterEach);
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

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
    if (
      ["Local State", "Preferences", "Secure Preferences", "Cookies"].includes(
        path.basename(String(target)),
      )
    ) {
      accesses.push(String(target));
      throw Object.assign(new Error("synthetic permission denial"), { code: "EACCES" });
    }
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
  const cfg = { browser: { extensionRelay: { allowLegacyAuth: false } } };
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const options = { nonInteractive: true };
  ctx = {
    cfg,
    cfgForPersistence: cfg,
    runtime,
    options,
    prompter: createDoctorPrompter({ runtime, options }),
    configResult: { cfg },
    sourceConfigValid: true,
    configPath: path.join(configDir, "openclaw.json"),
    env: { HOME: home, OPENCLAW_STATE_DIR: configDir },
  };
});

let ctx: DoctorHealthFlowContext;
let accesses: string[];
const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/browser")!;
function repairContext() {
  return { cfg: ctx.cfg, runtime: ctx.runtime, mode: "fix" as const, configPath: ctx.configPath };
}

it.each([false, true])(
  "reports browser setup once without inspecting profiles or inventing failed repair (import %s)",
  async (allowSystemProfileImport) => {
    ctx.cfg = {
      browser: {
        ...ctx.cfg.browser,
        allowSystemProfileImport,
        ...(allowSystemProfileImport
          ? {
              profiles: {
                manual: { driver: "existing-session", userDataDir: "/synthetic/browser-profile" },
              },
            }
          : {}),
      },
    };
    await runBrowserHealth(ctx);
    expect(accesses).toEqual([]);
    expect(capture.note).not.toHaveBeenCalled();
    expect(ctx.healthFindings).toEqual([]);
    const findings = await check.detect(repairContext());
    expect(findings).toHaveLength(allowSystemProfileImport ? 2 : 1);
    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "info",
        category: "recommended",
        message: expect.stringContaining("native bootstrap was not inspected"),
        fixHint: expect.stringContaining("openclaw browser extension status --json"),
      }),
    );
    if (allowSystemProfileImport) {
      expect(findings).toContainEqual(
        expect.objectContaining({
          severity: "info",
          message: expect.stringContaining("explicit Chromium user data directory"),
          fixHint: expect.stringContaining("No action needed"),
        }),
      );
    }
    expect("repair" in check).toBe(true);
    const run = await runDoctorHealthRepairs(repairContext(), { checks: [check] });
    expect(run).toMatchObject({
      changes: [],
      effects: [],
      warnings: expect.arrayContaining([expect.stringContaining("repair skipped")]),
    });
    expect(run.remainingFindings).toEqual(run.findings);
    expect(accesses).toEqual([]);
  },
);

it("retains an actionable inspection gap when the bundled browser surface cannot load", async () => {
  capture.load.mockImplementation(() => {
    throw new Error("synthetic browser unavailable");
  });
  await runBrowserHealth(ctx);
  expect(ctx.healthFindings).toEqual([
    expect.objectContaining({
      category: "fix-now",
      message: expect.stringContaining("synthetic browser unavailable"),
      fixHint: expect.stringContaining("bundled browser plugin"),
    }),
  ]);
  const run = await runDoctorHealthRepairs(repairContext(), { checks: [check] });
  expect(run.remainingFindings).toEqual(ctx.healthFindings);
  expect(accesses).toEqual([]);
});

it("names a configured missing executable and gives its repair instead of a plugin-load failure", async () => {
  ctx.cfg = {
    browser: {
      headless: true,
      extensionRelay: { allowLegacyAuth: false },
      profiles: {
        work: { driver: "openclaw", cdpPort: 18877, executablePath: "/synthetic/missing-browser" },
      },
    },
  };
  await runBrowserHealth(ctx);
  expect(ctx.healthFindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        category: "fix-now",
        message: expect.stringContaining("/synthetic/missing-browser"),
        fixHint: expect.stringContaining("browser.profiles.work.executablePath"),
      }),
    ]),
  );
  expect(ctx.healthFindings?.map((finding) => finding.fixHint).join("\n")).not.toContain(
    "bundled browser plugin",
  );
  expect(ctx.healthFindings?.map((finding) => finding.message).join("\n")).toContain(
    "A configured browser executable could not be used",
  );
  expect(ctx.healthFindings?.map((finding) => finding.message).join("\n")).not.toContain(
    "No Chromium-based browser executable was found on this host",
  );
  expect(accesses).toEqual([]);
});

const noRepair = { changes: [], effects: [] };
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
