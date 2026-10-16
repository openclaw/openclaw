import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  inspectBunCliLauncher,
  installBunCliLauncher,
  resolveBunGlobalBinDir,
} from "../../scripts/lib/bun-cli-launcher.mjs";
import { noteBunCliLauncherIssues } from "./doctor-bun-cli-launcher.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { resolveDoctorRepairMode } from "./doctor-repair-mode.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("./onboard-helpers.js", () => ({ guardCancel: vi.fn() }));
vi.mock("../../scripts/lib/bun-cli-launcher.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/bun-cli-launcher.mjs")>()),
  inspectBunCliLauncher: vi.fn(),
  installBunCliLauncher: vi.fn(),
  resolveBunGlobalBinDir: vi.fn(),
}));

const fixtureRoot = path.resolve("/fixture");
const ownerInstall = path.join(fixtureRoot, "owner");
const globalProject = path.join(ownerInstall, "install", "global");
const packageRoot = (install: string) =>
  path.join(install, "install", "global", "node_modules", "openclaw");
const root = packageRoot(ownerInstall);
const bunPath = path.join(fixtureRoot, "runtime", "bun");
const binDir = path.join(fixtureRoot, "custom-bin");
const launcherPath = path.join(binDir, "openclaw");
const fileStat = fs.statSync(new URL(import.meta.url));
const inspect = vi.mocked(inspectBunCliLauncher);
const install = vi.mocked(installBunCliLauncher);
const resolveBin = vi.mocked(resolveBunGlobalBinDir);

function stubRuntime(bun = true, platform: NodeJS.Platform = "linux", executable = bunPath) {
  vi.stubGlobal(
    "process",
    Object.create(process, {
      versions: { value: { ...process.versions, bun: bun ? "1.4.3" : undefined } },
      platform: { value: platform },
      execPath: { value: executable },
    }),
  );
}

function prompter(approved = true) {
  return {
    confirmAutoFix: vi.fn(async () => approved),
    repairMode: resolveDoctorRepairMode({ nonInteractive: true }),
  };
}

function run(prompt = prompter(), packagePath = root) {
  return noteBunCliLauncherIssues({ root: packagePath, prompter: prompt });
}

function expectLastNote(message: unknown) {
  expect(note).toHaveBeenLastCalledWith(message, "Bun CLI launcher");
}

function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

describe("Bun-only Doctor CLI launcher repair", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubRuntime();
    vi.stubEnv("PATH", path.join(fixtureRoot, "empty-bin"));
    vi.stubEnv("BUN_INSTALL", path.join(fixtureRoot, "unrelated-bun"));
    vi.stubEnv("BUN_INSTALL_GLOBAL_DIR", path.join(fixtureRoot, "unrelated-global"));
    vi.stubEnv("BUN_INSTALL_BIN", binDir);
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    vi.spyOn(fs, "statSync").mockReturnValue(fileStat);
    vi.spyOn(fs, "realpathSync").mockImplementation((value) => String(value));
    resolveBin.mockReturnValue(binDir);
    inspect.mockReturnValue({ path: launcherPath, state: "missing" });
    install.mockReturnValue({ path: launcherPath, state: "current" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(["missing", "stale"] as const)(
    "repairs %s with consent and owning Bun",
    async (state) => {
      if (state === "missing") {
        vi.stubEnv("PATH", path.join(fixtureRoot, "bun-node-123-abcdef"));
        vi.mocked(fs.accessSync).mockReturnValue(undefined);
        vi.mocked(fs.realpathSync).mockImplementation((value) =>
          path.basename(String(value)) === "node" ? bunPath : String(value),
        );
      }
      inspect.mockReturnValue({ path: launcherPath, state });
      const prompt = prompter();

      await run(prompt);

      expect(resolveBin).toHaveBeenCalledExactlyOnceWith({
        bunPath,
        cwd: globalProject,
        env: expect.objectContaining({
          BUN_INSTALL: ownerInstall,
          BUN_INSTALL_GLOBAL_DIR: globalProject,
          BUN_INSTALL_BIN: binDir,
        }),
      });
      expect(prompt.confirmAutoFix).toHaveBeenCalledExactlyOnceWith({
        message: "Repair the openclaw command for this Bun installation?",
        initialValue: false,
      });
      expect(install).toHaveBeenCalledExactlyOnceWith({ packageRoot: root, bunPath, binDir });
      expectLastNote(`Repaired the Bun CLI launcher: ${launcherPath}`);
      expect(process.env.BUN_INSTALL).toBe(path.join(fixtureRoot, "unrelated-bun"));
    },
  );

  it.each(["declined", false, true] as const)("honors repair consent: %s", async (repair) => {
    const prompt =
      repair === "declined"
        ? prompter(false)
        : createDoctorPrompter({
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            options: { nonInteractive: true, repair },
          });
    await run(prompt);
    expect(install).toHaveBeenCalledTimes(repair === true ? 1 : 0);
    if (repair === "declined") {
      expect(note).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("launcher is missing"),
        "Bun CLI launcher",
      );
    }
  });

  it.each([
    ["\n", "a newline"],
    ["\r", "a carriage return"],
  ])("explains unsupported path character %j without offering repair", async (character, label) => {
    for (const field of ["install", "runtime"] as const) {
      const unsupportedRoot = packageRoot(path.join(fixtureRoot, `owner${character}path`));
      stubRuntime(
        true,
        "linux",
        field === "runtime" ? path.join(fixtureRoot, `bun${character}runtime`) : bunPath,
      );
      const prompt = prompter();
      await run(prompt, field === "install" ? unsupportedRoot : root);
      expectLastNote(
        expect.stringContaining(
          `${field === "install" ? "Install path" : "Bun executable path"} contains ${label}, which cannot be stored in a launcher data line`,
        ),
      );
      expect(vi.mocked(note).mock.calls.at(-1)?.[0]).toContain("openclaw.mjs");
      expect(vi.mocked(note).mock.calls.at(-1)?.[0]).toContain("instead");
      expectNoCalls(prompt.confirmAutoFix, install, resolveBin);
    }
  });

  it.each([
    ["Node runtime", () => stubRuntime(false)],
    ["Windows", () => stubRuntime(true, "win32")],
    ["persistent Node", () => vi.mocked(fs.accessSync).mockReturnValue(undefined)],
    ["update", () => vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1")],
    ["source checkout", () => path.join(fixtureRoot, "source", "openclaw")],
    ["current", () => inspect.mockReturnValue({ path: launcherPath, state: "current" })],
    ["conflict", () => inspect.mockReturnValue({ path: launcherPath, state: "conflict" })],
  ] as const)("leaves %s launchers untouched", async (kind, arrange) => {
    const arranged = arrange();
    const prompt = prompter();
    await run(prompt, typeof arranged === "string" ? arranged : root);
    if (kind !== "current" && kind !== "conflict") {
      expectNoCalls(resolveBin, inspect);
    }
    expectNoCalls(prompt.confirmAutoFix, install);
    if (kind === "conflict") {
      expect(note).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("belongs to another installation"),
        "Bun CLI launcher",
      );
    } else {
      expectNoCalls(note);
    }
  });

  it.each(["discovery", "inspection", "repair"] as const)(
    "reports %s failures without aborting Doctor",
    async (phase) => {
      const failing = { discovery: resolveBin, inspection: inspect, repair: install }[phase];
      failing.mockImplementation(() => {
        throw new Error("fixture permission denied");
      });
      await expect(run()).resolves.toBeUndefined();
      expectLastNote(
        expect.stringContaining("Could not repair the Bun CLI launcher: fixture permission denied"),
      );
    },
  );
});
