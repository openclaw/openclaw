import "../flows/doctor-health.test-support.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import { useDoctorHealthFixture } from "../flows/doctor-health.fixture.test-support.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as configFlow from "./doctor-config-flow.js";
import { doctorCommand } from "./doctor.js";

const actualConfigFlow = await vi.importActual<typeof configFlow>("./doctor-config-flow.js");
const { mocks } = await import("../flows/doctor-health.test-support.js");

const chmodFailure = vi.hoisted(() => {
  vi.resetModules();
  return {
    code: undefined as string | undefined,
    foreignPath: undefined as string | undefined,
    targets: [] as string[],
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isForeignPath = (target: unknown) =>
    chmodFailure.foreignPath !== undefined &&
    [chmodFailure.foreignPath, path.dirname(chmodFailure.foreignPath)].includes(String(target));
  const chmodSync: typeof actual.chmodSync = (...args) => {
    if (chmodFailure.code || isForeignPath(args[0])) {
      chmodFailure.targets.push(String(args[0]));
      throw Object.assign(new Error("fixture filesystem rejects chmod"), {
        code: chmodFailure.code ?? "EPERM",
      });
    }
    return actual.chmodSync(...args);
  };
  const statSync = vi.fn(actual.statSync).mockImplementation((...args) => {
    const stats = actual.statSync(...args);
    if (stats && isForeignPath(args[0])) {
      Object.defineProperty(stats, "uid", {
        value: typeof stats.uid === "bigint" ? stats.uid + 1n : stats.uid + 1,
      });
    }
    return stats;
  });
  return { ...actual, chmodSync, statSync, default: { ...actual, chmodSync, statSync } };
});

async function withDoctorStorage(
  run: (state: OpenClawTestState, databasePath: string) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    mocks.emulateNativeInstall = false;
    vi.spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig").mockImplementation(
      actualConfigFlow.loadAndMaybeMigrateDoctorConfig,
    );
    const database = openOpenClawStateDatabase({ env: state.env });
    const installPath = writeManagedNpmPlugin({
      stateDir: state.stateDir,
      packageName: "storage-fixture",
      pluginId: "storage-fixture",
      version: "1.0.0",
    });
    await state.writeConfig({ plugins: { enabled: false } });
    await seedInstalledPluginIndex(
      { "storage-fixture": { source: "path", sourcePath: installPath, installPath } },
      { env: state.env, config: { plugins: { enabled: false } } },
    );
    await closeOpenClawStateDatabaseByPathAsync(database.path);
    try {
      await run(state, database.path);
    } finally {
      chmodFailure.code = undefined;
      chmodFailure.foreignPath = undefined;
      chmodFailure.targets = [];
    }
  });
}

async function runDoctor() {
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  await runCommandWithRuntime(runtime, () => doctorCommand(runtime, { nonInteractive: true }));
  return runtime;
}

describe.skipIf(process.platform === "win32")("Doctor state storage diagnosis", () => {
  useDoctorHealthFixture();
  afterEach(() => vi.restoreAllMocks());

  it.skipIf(process.platform !== "darwin")(
    "diagnoses an immutable database at the command boundary",
    async () => {
      await withDoctorStorage(async (_state, databasePath) => {
        const before = fs.readFileSync(databasePath);
        execFileSync("chflags", ["uchg", databasePath]);
        try {
          const runtime = await runDoctor();
          const output = runtime.error.mock.calls.flat().join("\n");
          expect(output).toContain(databasePath);
          expect(output).toContain("not writable");
          expect(output).toContain("chflags nouchg");
          expect(output).not.toContain("failed to acquire plugin lifecycle lease");
          expect(runtime.exit).toHaveBeenCalledWith(1);
          expect(fs.readFileSync(databasePath)).toEqual(before);
        } finally {
          execFileSync("chflags", ["nouchg", databasePath]);
        }
      });
    },
  );

  it.each(["foreign-owned writable", "owned 0444", "chmod unsupported"])(
    "continues diagnostics with %s storage",
    async (layout) => {
      await withDoctorStorage(async (_state, databasePath) => {
        if (layout === "foreign-owned writable") {
          fs.chmodSync(databasePath, 0o660);
          fs.chmodSync(path.dirname(databasePath), 0o2775);
          chmodFailure.foreignPath = databasePath;
          expect(fs.statSync(databasePath).uid).not.toBe(process.getuid?.());
        } else if (layout === "owned 0444") {
          fs.chmodSync(databasePath, 0o444);
        } else {
          fs.chmodSync(databasePath, 0o666);
          fs.chmodSync(path.dirname(databasePath), 0o777);
          chmodFailure.code = "EPERM";
        }
        const runtime = await runDoctor();
        expect(runtime.error.mock.calls).toEqual([]);
        expect(runtime.exit).not.toHaveBeenCalledWith(1);
        expect(mocks.runContributions).toHaveBeenCalledOnce();
        if (layout === "owned 0444") {
          expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
        } else {
          expect(chmodFailure.targets).toContain(databasePath);
        }
      });
    },
  );

  it.skipIf(process.getuid?.() === 0).each(["directory", "inaccessible directory"])(
    "diagnoses an unwritable %s without changing its permissions",
    async (target) => {
      await withDoctorStorage(async (_state, databasePath) => {
        const targetPath = path.dirname(databasePath);
        const mode = target === "inaccessible directory" ? 0 : 0o500;
        fs.chmodSync(targetPath, mode);
        chmodFailure.code = "EPERM";
        try {
          const runtime = await runDoctor();
          const output = runtime.error.mock.calls.flat().join("\n");
          expect(output).toContain(targetPath);
          expect(output).toContain("sudo chown");
          expect(output).toContain("remount the volume writable");
          expect(output).not.toContain("failed to acquire plugin lifecycle lease");
          expect(runtime.exit).toHaveBeenCalledWith(1);
          expect(fs.statSync(targetPath).mode & 0o777).toBe(mode);
        } finally {
          chmodFailure.code = undefined;
          fs.chmodSync(targetPath, 0o700);
        }
      });
    },
  );
});
