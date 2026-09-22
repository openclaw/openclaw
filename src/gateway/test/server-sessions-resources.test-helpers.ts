import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  collectActiveSessionWorkAdmissions,
  getSessionWorkAdmissionRelease,
} from "../../sessions/session-lifecycle-admission.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  listOpenClawRegisteredAgentDatabases,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { gatewayFixtureLifetime } from "../gateway-fixture-lifetime.test-support.js";
import type { GatewayServerHarness } from "../server.e2e-ws-harness.js";
import { testState } from "../test-helpers.runtime-state.js";
import { installGatewayTestHooks } from "../test-helpers.server.js";

const getGatewayServerHarnessModule = createLazyRuntimeModule(
  () => import("../server.e2e-ws-harness.js"),
);

/** Deselect before disposal so topology publication cannot reopen a fixture store. */
export async function releaseGatewaySessionStoreFixture(dir: string) {
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
  for (const database of listOpenClawRegisteredAgentDatabases()) {
    if (isPathInside(root, database.path)) {
      unregisterOpenClawAgentDatabase(database);
    }
  }
  await closeOpenClawAgentDatabasesAsync(root);
}

export type GatewaySessionsSuiteSetup = (makeTempDir: (prefix: string) => string) => Promise<void>;

export function installGatewaySessionsTestResources(
  startServer: boolean,
  setup?: GatewaySessionsSuiteSetup,
) {
  const tempDirs = createTempDirTracker();
  const defaultAgentWorkspace = path.join(os.tmpdir(), "openclaw-gateway-test");
  let harness: GatewayServerHarness | undefined;
  let sharedSessionStoreDir: string | undefined;

  installGatewayTestHooks({
    scope: "suite",
    setup: async () => {
      await fs.mkdir(defaultAgentWorkspace, { recursive: true });
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
            await closeOpenClawAgentDatabasesAsync(dir);
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
    await fs.rm(sharedSessionStoreDir, { recursive: true, force: true });
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
  return { defaultAgentWorkspace, requireHarness, requireSharedSessionStoreDir };
}
