import fs from "node:fs";
import path from "node:path";
import { afterEach, aroundEach, beforeAll, beforeEach, vi } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { seedOpenClawAgentSchemaV21 } from "../state/openclaw-agent-schema-v21.test-support.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { mocks } from "./doctor-health.test-support.js";

export function useDoctorHealthFixture() {
  let sharedStateTemplate: Buffer;

  function materializeSharedStateDatabase(env: NodeJS.ProcessEnv) {
    const databasePath = resolveOpenClawStateSqlitePath(env);
    if (!fs.existsSync(databasePath)) {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.writeFileSync(databasePath, sharedStateTemplate, { flag: "wx" });
    }
  }

  function openHistoricalAgentDatabase(options: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    path?: string;
  }) {
    materializeSharedStateDatabase(options.env);
    openOpenClawStateDatabase({ env: options.env });
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = openNodeSqliteDatabase(databasePath);
    seedOpenClawAgentSchemaV21(db, options.agentId);
    removeCanonicalValidationFromHistoricalAgentFixture(db);
    db.exec(
      "DROP TABLE session_participants; PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;",
    );
    return { db, path: databasePath };
  }

  aroundEach((runTest) => withSqliteReadOnlyWorkerScope(runTest));
  afterEach(() => vi.unstubAllEnvs());

  beforeAll(async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      mocks.runtimeTmpDir.mockReturnValue(state.path("runtime"));
      const database = openOpenClawStateDatabase({ env: state.env });
      await closeOpenClawStateDatabaseByPathAsync(database.path);
      sharedStateTemplate = fs.readFileSync(database.path);
    });
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", undefined);
    mocks.config.mockReturnValue({});
    mocks.packageRoot.mockReturnValue(undefined);
    mocks.service.mockReset();
    mocks.probePortUsage.mockReset().mockResolvedValue("free");
    mocks.restartedHealthy = true;
    mocks.emulateNativeInstall = true;
    mocks.servicePlatform = undefined;
    mocks.taskDefinitelyStopped.mockReset().mockReturnValue(true);
    mocks.startupFallbackRuntime.mockReset().mockResolvedValue(null);
    mocks.outro.mockClear();
    mocks.runContributions.mockReset().mockResolvedValue(undefined);
    mocks.writeUpdatePostInstallDoctorResult.mockClear();
  });

  return { materializeSharedStateDatabase, openHistoricalAgentDatabase };
}
