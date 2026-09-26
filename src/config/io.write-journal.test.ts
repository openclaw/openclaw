import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startGatewayConfigReloader } from "../gateway/config-reload.js";
import { createWatcherMock } from "../gateway/config-reload.watcher.test-support.js";
import * as tmpDirOwner from "../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readLatestConfigSnapshotAuditRecord } from "./config-journal-snapshot.js";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";
import {
  createConfigIO,
  readConfigFileSnapshotForRuntimeTransaction,
  resetConfigRuntimeState,
} from "./io.js";
import { createConfigIoWorkerFixture } from "./io.worker.test-support.js";
import { createConfigWriteHomeFixture } from "./io.write-config.test-support.js";
import * as configFileSource from "./source-file.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.openclaw.js";

describe("config write and startup journal", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-write-journal-" });
  const workers = createConfigIoWorkerFixture();
  const withSuiteHome = createConfigWriteHomeFixture(suiteRootTracker.make);
  const log = { info: () => {}, warn: () => {}, error: () => {} };

  beforeAll(async () => {
    await suiteRootTracker.setup();
    vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      await suiteRootTracker.make("coordinator"),
    );
    // Startup reconciliation does not need external file events.
    vi.spyOn(configFileSource, "createConfigFileAdapter").mockImplementation((options) =>
      createWatcherMock().attach(options),
    );
    await workers.setup(await suiteRootTracker.make("workers"));
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetConfigRuntimeState();
  });

  afterAll(async () => {
    await workers.close();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    vi.restoreAllMocks();
    await suiteRootTracker.cleanup();
  });

  const withJournal = (
    run: (fixture: {
      home: string;
      configPath: string;
      io: ReturnType<typeof createConfigIO>;
    }) => Promise<void>,
  ) =>
    withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
          OPENCLAW_TEST_FAST: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
        () =>
          run({
            home,
            configPath,
            io: createConfigIO({
              configPath,
              env: process.env,
              homedir: () => home,
              observe: false,
              logger: log,
            }),
          }),
      );
    });

  async function reconcileStartup(snapshot: ConfigFileSnapshot) {
    const reloader = startGatewayConfigReloader({
      initialConfig: snapshot.config,
      initialCompareConfig: snapshot.sourceConfig,
      initialSnapshotRawHash: snapshot.hash ?? null,
      initialAuthoredConfig: snapshot.parsed,
      initialSnapshotValid: snapshot.valid,
      initialSnapshotIssues: snapshot.issues,
      readSnapshot: async () => snapshot,
      initialPluginInstallRecords: {},
      readPluginInstallRecords: async () => ({}),
      onNoopConfigCommit: async () => {},
      onHotReload: async () => "applied" as const,
      onRestart: async () => {},
      log,
      watchPath: snapshot.path,
    });
    try {
      await reloader.ready;
    } finally {
      await reloader.stop();
    }
  }

  it("shares raw snapshot hashes between config writes and gateway startup reconciliation", async () => {
    await withJournal(async ({ home, configPath, io }) => {
      const write = await io.writeConfigFile({ gateway: { port: 18789 } });
      const writtenSnapshot = await readConfigFileSnapshotForRuntimeTransaction({});
      const slot = readLatestConfigSnapshotAuditRecord({
        env: process.env,
        homedir: () => home,
      });
      expect(writtenSnapshot.valid).toBe(true);
      expect(slot).toMatchObject({ rawHash: write.persistedHash });
      expect(slot?.rawHash).toBe(writtenSnapshot.hash);

      await reconcileStartup(writtenSnapshot);
      expect(
        listConfigAuditRecordsForTests({ env: process.env, homedir: () => home }).filter(
          (record) => record.event === "config.external",
        ),
      ).toEqual([]);

      const handEditedAuthoredConfig = structuredClone(writtenSnapshot.parsed) as OpenClawConfig;
      handEditedAuthoredConfig.gateway = { ...handEditedAuthoredConfig.gateway, port: 18790 };
      await fs.writeFile(configPath, `${JSON.stringify(handEditedAuthoredConfig, null, 2)}\n`);
      const handEditedSnapshot = await readConfigFileSnapshotForRuntimeTransaction({});
      await reconcileStartup(handEditedSnapshot);

      const externalRecord = listConfigAuditRecordsForTests({
        env: process.env,
        homedir: () => home,
      }).findLast((record) => record.event === "config.external");
      expect(externalRecord).toMatchObject({
        event: "config.external",
        detectedBy: "startup",
        previousHash: write.persistedHash,
        nextHash: handEditedSnapshot.hash,
        changedPaths: ["gateway.port"],
        valid: true,
      });
    });
  });

  it("reseeds a shared state slot when the gateway starts for another config path", async () => {
    await withJournal(async ({ home, io }) => {
      const configPathB = path.join(home, ".openclaw", "config-b.json");
      await io.writeConfigFile({ gateway: { port: 18789 } });
      await fs.writeFile(configPathB, `${JSON.stringify({ gateway: { port: 18790 } }, null, 2)}\n`);

      await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPathB }, async () => {
        const snapshot = await readConfigFileSnapshotForRuntimeTransaction({});
        await reconcileStartup(snapshot);

        expect(
          listConfigAuditRecordsForTests({ env: process.env, homedir: () => home }).filter(
            (record) => record.event === "config.external",
          ),
        ).toEqual([]);
        expect(
          readLatestConfigSnapshotAuditRecord({
            env: process.env,
            homedir: () => home,
          }),
        ).toMatchObject({ configPath: configPathB, rawHash: snapshot.hash });
      });
    });
  });
});
