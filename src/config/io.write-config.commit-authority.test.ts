// Covers write-authority rechecks around the config health-baseline read.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as tmpDirOwner from "../infra/tmp-openclaw-dir.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resetConfigRuntimeState, writeConfigFile } from "./io.js";
import * as ioObserve from "./io.observe.js";
import { createConfigWriteHomeFixture } from "./io.write-config.test-support.js";
import type { OpenClawConfig } from "./types.openclaw.js";

// The moved cases need the same synthetic plugin inventory and prepare-write
// mock seam as io.write-config.test.ts; keep this setup identical to it.
const loadRegistry = vi.hoisted(() =>
  vi.fn((): PluginManifestRegistry => ({
    diagnostics: [],
    plugins: [],
  })),
);
const prepareWrite = vi.hoisted(() =>
  vi.fn<typeof import("./backup-rotation.js").prepareConfigFileWrite>(),
);

// mock-isolation: config writes use a synthetic plugin inventory, not installed plugins.
vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: loadRegistry,
}));

vi.mock("../plugins/discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/discovery.js")>();
  const discovery = { candidates: [], diagnostics: [] };
  return {
    ...actual,
    // The registry above owns this suite's synthetic plugin inventory.
    discoverOpenClawPlugins: () => discovery,
  };
});

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: loadRegistry,
  };
});

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorLegacyConfigRules: () => [],
    applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
  };
});

vi.mock("./backup-rotation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup-rotation.js")>();
  prepareWrite.mockImplementation(actual.prepareConfigFileWrite);
  return {
    ...actual,
    prepareConfigFileWrite: prepareWrite,
  };
});

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-io-" });
const withSuiteHome = createConfigWriteHomeFixture(suiteRootTracker.make);

beforeAll(async () => {
  await suiteRootTracker.setup();
  vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
    await suiteRootTracker.make("coordinator"),
  );
  loadRegistry.mockReturnValue({
    diagnostics: [],
    plugins: [],
  } satisfies PluginManifestRegistry);
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetConfigRuntimeState();
  loadRegistry.mockReturnValue({ diagnostics: [], plugins: [] });
  prepareWrite.mockReset();
  const actual =
    await vi.importActual<typeof import("./backup-rotation.js")>("./backup-rotation.js");
  prepareWrite.mockImplementation(actual.prepareConfigFileWrite);
});

afterAll(async () => {
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.mocked(tmpDirOwner.resolvePreferredOpenClawTmpDir).mockRestore();
  await suiteRootTracker.cleanup();
});

const homePath = (home: string, fileName = "openclaw.json") =>
  path.join(home, ".openclaw", fileName);
const readRaw = (file: string) => fs.readFile(file, "utf8");
const expectRaw = (file: string, raw: string) => expect(readRaw(file)).resolves.toBe(raw);

const formatConfig = (config: unknown) => `${JSON.stringify(config, null, 2)}\n`;
const gatewayAt = (port: number): OpenClawConfig => ({ gateway: { mode: "local", port } });

const seed = async (home: string, config: unknown) => {
  const configPath = homePath(home);
  const raw = formatConfig(config);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, raw, "utf-8");
  return { configPath, raw };
};

function itWithHome(name: string, testCase: (home: string) => Promise<void>) {
  it(name, () => withSuiteHome(testCase));
}

const withActiveConfig = <T>(
  configPath: string,
  run: () => Promise<T>,
  env: NodeJS.ProcessEnv = {},
) => withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, ...env }, run);

itWithHome("rechecks write authority after the health-baseline await", async (home) => {
  const { configPath, raw } = await seed(home, gatewayAt(18789));
  let markBaselineReadStarted = () => {};
  let releaseBaselineRead = () => {};
  const baselineReadStarted = new Promise<void>((resolve) => {
    markBaselineReadStarted = resolve;
  });
  const baselineReadGate = new Promise<void>((resolve) => {
    releaseBaselineRead = resolve;
  });
  let active = true;
  let beforeCommitCalls = 0;
  let publishCalls = 0;
  const captureBaseline = ioObserve.captureConfigHealthBaselineForWrite;
  const captureSpy = vi
    .spyOn(ioObserve, "captureConfigHealthBaselineForWrite")
    .mockImplementation(async (...args) => {
      const pendingCapture = captureBaseline(...args).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      markBaselineReadStarted();
      await baselineReadGate;
      const result = await pendingCapture;
      if (result.status === "rejected") {
        throw result.error;
      }
      return result.value;
    });
  prepareWrite.mockImplementationOnce(async (params) => {
    const actual =
      await vi.importActual<typeof import("./backup-rotation.js")>("./backup-rotation.js");
    const prepared = await actual.prepareConfigFileWrite(params);
    return {
      ...prepared,
      publish: () => {
        publishCalls += 1;
        return prepared.publish();
      },
    };
  });
  try {
    const writing = withActiveConfig(configPath, () =>
      writeConfigFile(gatewayAt(19001), {
        beforeCommit: async () => {
          beforeCommitCalls += 1;
          if (!active) {
            throw new Error("approval expired");
          }
        },
      }),
    );
    // Attach both settlement handlers immediately. If the write rejects before the
    // baseline barrier, the test fails promptly without an unhandled rejection.
    const writeOutcome = writing.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const barrierOutcome = await Promise.race([
      baselineReadStarted.then(() => "baseline" as const),
      writeOutcome.then(() => "settled" as const),
    ]);
    expect(barrierOutcome).toBe("baseline");
    active = false;
    releaseBaselineRead();
    const outcome = await writeOutcome;
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") {
      throw new Error("config write unexpectedly resolved after authority revocation");
    }
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toBe("approval expired");
    expect(beforeCommitCalls).toBe(1);
    expect(publishCalls).toBe(0);
    await expectRaw(configPath, raw);
  } finally {
    releaseBaselineRead();
    captureSpy.mockRestore();
  }
});

for (const authorization of ["authorized", "revoked"] as const) {
  itWithHome(
    `skips the health-baseline read for databaseAccess:none writes (${authorization})`,
    async (home) => {
      const revoked = authorization === "revoked";
      const { configPath, raw } = await seed(home, gatewayAt(18789));
      const nextConfig: OpenClawConfig = {
        ...gatewayAt(19001),
        meta: {
          lastTouchedVersion: "p1c-test",
          migrations: {
            modelPolicyAllowlist: true,
            utilityModelSeparation: true,
          },
        },
      };
      const events: string[] = [];
      let publishCalls = 0;
      const captureSpy = vi.spyOn(ioObserve, "captureConfigHealthBaselineForWrite");
      prepareWrite.mockImplementationOnce(async (params) => {
        const actual =
          await vi.importActual<typeof import("./backup-rotation.js")>("./backup-rotation.js");
        const prepared = await actual.prepareConfigFileWrite(params);
        return {
          ...prepared,
          publish: () => {
            publishCalls += 1;
            events.push("publish");
            return prepared.publish();
          },
        };
      });
      const beforeCommit = vi.fn(async () => {
        events.push("beforeCommit");
        if (revoked) {
          throw new Error("approval expired");
        }
      });
      try {
        const writing = withActiveConfig(configPath, () =>
          writeConfigFile(nextConfig, {
            databaseAccess: "none",
            lastTouchedVersionOverride: "p1c-test",
            beforeCommit,
          }),
        );
        if (revoked) {
          await expect(writing).rejects.toThrow("approval expired");
        } else {
          await writing;
        }
        expect(captureSpy).not.toHaveBeenCalled();
        expect(beforeCommit).toHaveBeenCalledTimes(1);
        expect(events).toEqual(revoked ? ["beforeCommit"] : ["beforeCommit", "publish"]);
        expect(publishCalls).toBe(revoked ? 0 : 1);
        await expectRaw(configPath, revoked ? raw : formatConfig(nextConfig));
      } finally {
        captureSpy.mockRestore();
      }
    },
  );
}
