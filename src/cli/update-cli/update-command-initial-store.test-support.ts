import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../../infra/state-database-coordinator.js";
import type { UpdateInitialStoreInvocation } from "../../infra/update-initial-store-invocation.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import * as leaseOwner from "../../infra/update-managed-service-handoff-lease.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { initializeAndRunUpdate } from "./update-command-initialization-run.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function directoryIdentity(directory: string) {
  expect(fs.realpathSync(directory)).toBe(directory);
  const stat = fs.lstatSync(directory, { bigint: true });
  expect(stat.isDirectory()).toBe(true);
  return { path: directory, identity: String(stat.dev) + ":" + String(stat.ino) };
}

export async function withInitialStoreFixture(
  operation: (fixture: {
    root: string;
    installation: string;
    env: NodeJS.ProcessEnv;
    input: UpdateInitialStoreInvocation;
    store: ReturnType<typeof leaseOwner.createManagedHandoffLeaseStore>;
    initialize: (env?: NodeJS.ProcessEnv) => Promise<void>;
    prepared: Parameters<typeof initializeAndRunUpdate>[1];
  }) => Promise<void>,
  fixtureOptions: { applicationState?: boolean } = {},
) {
  const root = fs.realpathSync(dirs.make("update-initialization-transport-"));
  const installation = path.join(root, "installation");
  const coordinator = path.join(root, "coordinator");
  const stateDir = path.join(root, "profile");
  const handoffDir = path.join(root, "handoff");
  for (const directory of [installation, coordinator, stateDir, handoffDir]) {
    fs.mkdirSync(directory, { mode: 0o700 });
    expect(fs.realpathSync(directory)).toBe(directory);
  }
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_UPDATE_RUN_ID: fixtureOptions.applicationState
      ? randomUUID()
      : "initialization-transport",
  };
  const handoffPath = path.join(handoffDir, "handoff.sqlite");
  const statePath = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  expect(fs.realpathSync(path.dirname(statePath))).toBe(path.dirname(statePath));
  const assertPrivate = (file: string) => {
    expect([handoffPath, statePath]).toContain(file);
    expect(fs.realpathSync(path.dirname(file))).toBe(path.dirname(file));
    expect(path.relative(root, file).startsWith("..")).toBe(false);
    if (fs.existsSync(file)) {
      expect(fs.realpathSync(file)).toBe(file);
      expect(fs.lstatSync(file).isFile()).toBe(true);
      expect(fs.lstatSync(file).nlink).toBe(1);
    }
  };
  // Bind all three physical stores before the first SQL open.
  await withStateDatabaseCoordinatorRuntimeDirectory(coordinator, () =>
    withOwnedManagedUpdateEnv(env, async () => {
      vi.spyOn(leaseOwner, "resolveManagedUpdateLeaseDatabasePath").mockImplementation(() => {
        assertPrivate(handoffPath);
        return handoffPath;
      });
      const openStore = leaseOwner.createManagedHandoffLeaseStore;
      vi.spyOn(leaseOwner, "createManagedHandoffLeaseStore").mockImplementation(
        (options, logger) => {
          expect(options?.databasePath).toBe(handoffPath);
          assertPrivate(handoffPath);
          return openStore(options, logger);
        },
      );
      assertPrivate(statePath);
      if (fixtureOptions.applicationState) {
        openOpenClawStateDatabase({ env });
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
      }
      const state = new DatabaseSync(statePath);
      try {
        state.exec(
          "CREATE TABLE transport_witness(value TEXT); INSERT INTO transport_witness VALUES ('preserved')",
        ); // sqlite-allow-raw -- Isolated physical selection fixture, not application storage.
      } finally {
        state.close();
      }
      fs.chmodSync(statePath, 0o600);
      const store = leaseOwner.createManagedHandoffLeaseStore({
        databasePath: handoffPath,
        serviceManagerEnv: resolveServiceManagerEnv(),
      });
      const seeded = store.acquire(installation, "fixture-seed", { kind: "update" });
      if (seeded.kind !== "acquired") {
        throw new Error("Private handoff fixture could not provision its own native store");
      }
      expect(store.release(seeded.lease)).toBe(true);
      expect(store.read(installation)).toEqual({ kind: "absent" });
      const input: UpdateInitialStoreInvocation = {
        version: 1,
        selection: {
          privateRoot: directoryIdentity(root),
          installation: directoryIdentity(installation),
          handoff: captureManagedUpdateLeaseDatabaseIdentity(handoffPath),
          state: captureManagedUpdateLeaseDatabaseIdentity(statePath),
        },
      };
      const prepared: Parameters<typeof initializeAndRunUpdate>[1] = {
        startedAt: Date.now(),
        postCoreUpdateResume: false,
        postCoreUpdateChannel: undefined,
        timeoutMs: 5000,
        shouldRestart: false,
        requestedChannel: null,
        devTarget: undefined,
        controlPlaneUpdateSentinelMeta: null,
        discoveredRoot: installation,
        installKind: "git",
        servicePlan: undefined,
        pkgOwnership: {
          assertUnowned: async () => {},
          assertEntryUnowned: async () => {},
        },
      };
      const continuation = vi.fn(async () => {});
      try {
        await operation({
          root,
          installation,
          env,
          input,
          store,
          prepared,
          initialize: (selectedEnv = env) =>
            initializeAndRunUpdate(
              { json: true },
              prepared,
              { triageTarget: { env: selectedEnv } },
              undefined,
              selectedEnv,
              continuation,
            ),
        });
        expect(continuation).not.toHaveBeenCalled();
        expect(store.read(installation)).toEqual({ kind: "absent" });
      } finally {
        if (fixtureOptions.applicationState) {
          await closeOpenClawStateDatabaseAsync();
          closeOpenClawStateDatabaseForTest();
        }
      }
    }),
  );
}
