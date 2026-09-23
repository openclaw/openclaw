import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../../config/sessions/session-transcript-reconcile.js";
import { isPathInside } from "../../infra/path-guards.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import {
  collectActiveSessionWorkAdmissions,
  getSessionWorkAdmissionRelease,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  listOpenClawRegisteredAgentDatabases,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../../state/openclaw-state-db.js";
import { gatewayFixtureLifetime } from "../gateway-fixture-lifetime.test-support.js";
import type { GatewayServerHarness } from "../server.e2e-ws-harness.js";
import { removeSessionFixtureDirectory } from "../session-fixture-directory.test-support.js";
import { testState } from "../test-helpers.runtime-state.js";
import { installGatewayTestHooks } from "../test-helpers.server.js";

const getGatewayServerHarnessModule = createLazyRuntimeModule(
  () => import("../server.e2e-ws-harness.js"),
);

/** Deselect before disposal so topology publication cannot reopen a fixture store. */
export async function releaseGatewaySessionStoreFixture(dir: string) {
  // Transcript observers outlive session admission; join before config changes can
  // reopen the store. This also runs in suite teardown, outside expect.poll's test context.
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount({ excludeCurrent: true })).toBe(0), {
    timeout: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  });
  const root = existsSync(dir) ? realpathSync(dir) : path.resolve(dir);
  const ownsPath = (candidate: string) =>
    isPathInside(root, candidate) || isPathInside(path.resolve(dir), candidate);
  // A recovery ACK can leave its admitted continuation writing after the test returns.
  while (true) {
    const releases = [...collectActiveSessionWorkAdmissions()]
      .filter(([scope]) => ownsPath(scope))
      .flatMap(
        ([scope, identities]) => getSessionWorkAdmissionRelease({ scope, identities }) ?? [],
      );
    if (releases.length === 0) {
      break;
    }
    await Promise.all(releases);
  }
  if (testState.sessionStorePath && ownsPath(testState.sessionStorePath)) {
    testState.sessionStorePath = undefined;
  }
  const cfg = getRuntimeConfigSnapshot();
  if (cfg?.session?.store && ownsPath(cfg.session.store)) {
    const session = { ...cfg.session };
    delete session.store;
    setRuntimeConfigSnapshot({ ...cfg, session });
  }
  await waitForSessionTranscriptIndexReconcilesInStateDir(root);
  for (const database of listOpenClawRegisteredAgentDatabases()) {
    if (isPathInside(root, database.path)) {
      unregisterOpenClawAgentDatabase(database);
    }
  }
  await closeOpenClawAgentDatabasesAsync(root);

  // Client identity fixtures use shared-state SQLite, even with legacy .json names.
  // The lifecycle subscription replays the owner's recorded open paths synchronously.
  const sharedDatabasePaths = new Set<string>();
  registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind === "opened" && ownsPath(event.database.path)) {
      sharedDatabasePaths.add(event.database.path);
    }
  })();
  for (const databasePath of sharedDatabasePaths) {
    await withTestTimeout(
      closeOpenClawStateDatabaseByPathAsync(databasePath),
      SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      `Timed out closing shared-state fixture database ${JSON.stringify(databasePath)} after ${SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS}ms; retaining fixture directory ${JSON.stringify(dir)}`,
    );
  }
}

export type GatewaySessionsSuiteSetup = (makeTempDir: (prefix: string) => string) => Promise<void>;

export function installGatewaySessionsTestResources(
  startServer: boolean,
  setup?: GatewaySessionsSuiteSetup,
) {
  const tempDirs = createTempDirTracker();
  let harness: GatewayServerHarness | undefined;
  let sharedSessionStoreDir: string | undefined;

  installGatewayTestHooks({
    scope: "suite",
    setup: async () => {
      const workspace = getRuntimeConfig().agents?.defaults?.workspace;
      if (!workspace) {
        throw new Error("Gateway sessions fixture requires a configured workspace");
      }
      await fs.mkdir(workspace, { recursive: true });
      if (startServer) {
        const { startGatewayServerHarness } = await getGatewayServerHarnessModule();
        harness = await startGatewayServerHarness();
      }
      sharedSessionStoreDir = await fs.realpath(tempDirs.make("openclaw-sessions-"));
      await setup?.((prefix) => tempDirs.make(prefix));
    },
    cleanup: () =>
      runQaGatewayFixture(
        async () => {
          await harness?.close();
        },
        async () => {
          if (harness && !gatewayFixtureLifetime.canReleaseState(harness.server)) {
            return;
          }
          for (const dir of tempDirs.dirs) {
            await releaseGatewaySessionStoreFixture(dir);
            closeOpenClawAgentDatabasesForTest(dir);
          }
          tempDirs.cleanup();
          sharedSessionStoreDir = undefined;
          harness = undefined;
        },
      ),
  });

  afterEach(async () => {
    if (!sharedSessionStoreDir) {
      return;
    }
    await releaseGatewaySessionStoreFixture(sharedSessionStoreDir);
    await removeSessionFixtureDirectory(sharedSessionStoreDir);
  });

  const requireHarness = () => {
    if (!harness) {
      throw new Error("Gateway sessions test harness was not started");
    }
    return harness;
  };
  const requireSharedSessionStoreDir = () => {
    if (!sharedSessionStoreDir) {
      throw new Error("Gateway sessions shared session store dir was not created");
    }
    return sharedSessionStoreDir;
  };
  return { requireHarness, requireSharedSessionStoreDir };
}
