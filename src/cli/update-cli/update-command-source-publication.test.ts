import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createVerifiedSqliteSnapshot } from "../../infra/sqlite-snapshot.js";
import { acquireStateDatabaseHandleExclusion } from "../../infra/state-database-coordinator.js";
import { inspectCheckpointFile } from "../../infra/update-checkpoint-files.js";
import {
  prepareUpdateCheckpointRestore,
  reopenUpdateCheckpointRestorePlan,
  restoreUpdateCheckpointResource,
} from "../../infra/update-checkpoint-restore.js";
import { captureUpdateCheckpoint, reopenUpdateCheckpoint } from "../../infra/update-checkpoint.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import {
  heldServiceLockCoordinate,
  seedRetainedBorrower,
} from "../../infra/update-retained-custody.test-support.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import {
  bindUpdateRecoveryCheckpoint,
  bindUpdateRecoveryAfterImage,
  recordUpdateRecoveryObservation,
  recordUpdateRecoveryRestoreProgress,
  prepareUpdateRecoveryCarryForward,
  assertExactUpdateRecoveryClaim,
  beginUpdateRecovery,
  claimUpdateRecovery,
  recordUpdateRecoveryFailure,
  recordUpdateRecoveryIntent,
} from "../../infra/update-run-recovery.js";
import {
  drainFileLockStateForTest,
  resetFileLockStateForTest,
} from "../../plugin-sdk/file-lock.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { captureUpdateCommandPreimages } from "./update-command-preimages.js";
import type { UpdateCommandRecovery } from "./update-command-recovery.js";
import { inspectUpdateCommandSealedReplay } from "./update-command-replay-inspection.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";

const identity = vi.hoisted(() => ({
  control: "",
  dead: false,
  native: vi.fn(() => {
    throw new Error("Native child APIs forbidden in source-claim tests");
  }),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: identity.native,
  spawnSync: identity.native,
  exec: identity.native,
  execSync: identity.native,
  execFile: identity.native,
  execFileSync: identity.native,
  fork: identity.native,
}));
vi.mock("../../shared/pid-alive.js", async (original) => ({
  ...(await original<typeof import("../../shared/pid-alive.js")>()),
  isPidDefinitelyDead: () => identity.dead,
  getFileLockProcessStartTime: () => 123,
}));
vi.mock("../../process/child-process-tree.js", () => ({ isChildProcessTreeAlive: () => false }));
vi.mock("../../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => identity.control,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  identity.dead = false;
  identity.native.mockClear();
  resetFileLockStateForTest();
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await drainFileLockStateForTest();
  expect(identity.native).not.toHaveBeenCalled();
});

type Context = {
  home: string;
  env: NodeJS.ProcessEnv;
  configPath: string;
  includePath: string;
  recovery: UpdateCommandRecovery;
  store: ReturnType<typeof createManagedHandoffLeaseStore>;
  rows: () => unknown;
  canonical: () => unknown;
  write: <T>(operation: () => T) => T;
};
async function fixture(operation: (f: Context) => Promise<void>) {
  const home = fs.realpathSync(dirs.make("source-sealed-callback-"));
  identity.control = path.join(home, "control");
  fs.mkdirSync(identity.control, { mode: 0o700 });
  const stateDir = path.join(home, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const includePath = path.join(stateDir, "includes", "gateway.json");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  const options = { env };
  const run = createUpdateRun({ trigger: "cli" }, options);
  fs.mkdirSync(path.dirname(includePath), { recursive: true });
  fs.writeFileSync(configPath, '{"gateway":{"$include":"./includes/gateway.json"}}\n');
  fs.writeFileSync(includePath, '{"mode":"local","port":18789}\n');
  const readRows = (file: string, sql: string) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  const rows = () =>
    readRows(
      path.join(identity.control, "managed-update-handoffs.sqlite"),
      "SELECT * FROM managed_update_handoffs ORDER BY install_root",
    );
  const canonical = () =>
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => ({
        records: db.prepare("SELECT * FROM config_machine_state ORDER BY state_key").all(),
        history: db.prepare("SELECT * FROM update_runs ORDER BY run_id").all(),
      }),
      options,
    );
  await withUpdateCommandExecutor(run.runId, async (executor) => {
    const fence = await executor.enter(home);
    const runtime = { root: home, nodePath: process.execPath, version: "1.0.0", buildId: null };
    let record = beginUpdateRecovery(
      { runId: run.runId, from: runtime, to: runtime },
      fence,
      options,
    );
    const recovery: UpdateCommandRecovery = {
      options,
      fence,
      getRecord: () => record,
      onRecord(next) {
        fence.assertCurrent();
        record = next;
      },
      assertReady() {
        throw new Error("No serving proof in pure source test");
      },
    };
    await captureUpdateCommandPreimages({ recovery, env });
    expect(record.preimages?.boundAtRevision).toBe(record.revision);
    closeOpenClawStateDatabaseForTest();
    const databaseOwner = acquireStateDatabaseHandleExclusion({
      databasePath: resolveOpenClawStateSqlitePath(env),
    });
    try {
      await databaseOwner.runWithSourceReads(async () =>
        operation({
          home,
          env,
          configPath,
          includePath,
          recovery,
          store: createManagedHandoffLeaseStore(),
          rows,
          canonical,
          write: (writeOperation) =>
            databaseOwner.runWithCanonicalWrites(fence.assertCurrent, writeOperation),
        }),
      );
    } finally {
      closeOpenClawStateDatabaseForTest();
      databaseOwner.release();
    }
  });
}

type Mode = "replay" | "restored";

// The shared replay fixture stops at the durable seal-intent commit BEFORE the
// external previous-runtime reader. It does not claim physical publication.
// The restored fixture publishes real file-only resources; its canonical DB is
// not one of those resources. Both exercise the real source wrapper, not the CLI.
async function publication(f: Context, mode: Mode) {
  const { recovery } = f;
  const initial = recovery.getRecord();
  const early = initial.preimages;
  if (!early) {
    throw new Error("missing early files");
  }
  const binding = early.binding;
  const artifactRoot = path.dirname(path.dirname(early.ref.manifestPath));
  const databasePath = resolveOpenClawStateSqlitePath(f.env);
  const files = [f.configPath, f.includePath];
  const update = (next: ReturnType<typeof recovery.getRecord>) => recovery.onRecord(next);
  const capture = async (preimage: boolean) => {
    closeOpenClawStateDatabaseForTest();
    return await (async () => {
      const assertDatabase = recovery.fence.assertCurrent;
      const assertQuiescent = () => {
        recovery.fence.assertCurrent();
        assertDatabase();
      };
      const outputs = await Promise.all(
        files.map(async (sourcePath) => ({
          sourcePath,
          state: await inspectCheckpointFile(sourcePath),
        })),
      );
      const ref = await captureUpdateCheckpoint({
        artifactRoot,
        binding,
        assertQuiescent,
        exclusions: [],
        resources: [
          ...files.map((sourcePath) => ({
            sourcePath,
            kind: "config" as const,
            restore: "replace" as const,
          })),
          ...(mode === "replay"
            ? [{ sourcePath: databasePath, kind: "sqlite" as const, restore: "replace" as const }]
            : []),
        ],
        ...(preimage
          ? { preimages: { checkpointRef: early.ref, postMutationSources: outputs } }
          : { expectedSources: outputs }),
      });
      const opened = await reopenUpdateCheckpoint(ref, { artifactRoot, binding });
      return {
        ref,
        binding: opened.manifest.binding,
        ...(opened.manifest.preimageRef ? { preimageRef: opened.manifest.preimageRef } : {}),
      };
    })();
  };
  const checkpoint = await capture(true);
  update(
    f.write(() =>
      bindUpdateRecoveryCheckpoint(
        recovery.getRecord(),
        checkpoint,
        recovery.fence,
        recovery.options,
      ),
    ),
  );
  // A real fixture-owned file mutation, with observations captured at its boundary.
  const effectId = randomUUID();
  update(
    f.write(() =>
      recordUpdateRecoveryIntent(
        recovery.getRecord(),
        {
          effectId,
          kind: "package-activation",
          resourceId: "synthetic-file-generation",
          runtime: "candidate",
        },
        recovery.fence,
        recovery.options,
      ),
    ),
  );
  fs.writeFileSync(f.includePath, '{"mode":"local","port":18790}\n');
  const mutated = await inspectCheckpointFile(f.includePath);
  if (!mutated) {
    throw new Error("missing mutation output");
  }
  update(
    f.write(() =>
      recordUpdateRecoveryObservation(
        recovery.getRecord(),
        {
          effectId,
          observedIdentity: mutated.sha256,
        },
        recovery.fence,
        recovery.options,
      ),
    ),
  );
  const afterUpdate = await capture(false);
  update(
    f.write(() =>
      bindUpdateRecoveryAfterImage(
        recovery.getRecord(),
        {
          checkpointRef: checkpoint.ref,
          afterUpdate,
          effectIds: [effectId],
        },
        recovery.fence,
        recovery.options,
      ),
    ),
  );
  update(
    f.write(() =>
      recordUpdateRecoveryFailure(
        recovery.getRecord(),
        { code: "synthetic-failure", effectId },
        recovery.fence,
        recovery.options,
      ),
    ),
  );
  const restoreEffectId = randomUUID();
  update(
    f.write(() =>
      recordUpdateRecoveryIntent(
        recovery.getRecord(),
        {
          effectId: restoreEffectId,
          kind: "checkpoint-restore",
          resourceId: checkpoint.ref.checkpointId,
          runtime: "previous",
        },
        recovery.fence,
        recovery.options,
      ),
    ),
  );
  closeOpenClawStateDatabaseForTest();
  const assertDatabase = recovery.fence.assertCurrent;
  const prepared = await prepareUpdateCheckpointRestore({
    artifactRoot,
    binding,
    checkpointRef: checkpoint.ref,
    afterUpdateRef: afterUpdate.ref,
    assertQuiescent() {
      recovery.fence.assertCurrent();
      assertDatabase();
    },
    prepareSharedDatabase({ sourceDb, stagedDb, planIdentity }) {
      const carried = prepareUpdateRecoveryCarryForward({
        sourceDb,
        stagedDb,
        expected: recovery.getRecord(),
        nextProgress: { ...planIdentity, planSha256: null, resourceCursor: 0, phase: "preparing" },
        fence: recovery.fence,
        validateStagedDatabase(db) {
          expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        },
      });
      update(carried.record);
      return carried;
    },
  });
  if (prepared.status !== "ready") {
    throw new Error("fixture restore unavailable");
  }
  const planRef = prepared.planRef;
  const reopened = await reopenUpdateCheckpointRestorePlan(planRef, { artifactRoot, binding });
  const first = reopened.plan.resources[0];
  if (!first) {
    throw new Error("empty plan");
  }

  // The supported dual-database CAS writes an intent commitment, not a runtime
  // validation result. This is exactly the recoverable state before reader dispatch.
  closeOpenClawStateDatabaseForTest();
  const stagePath =
    mode === "replay"
      ? path.join(first.stageDirectory, "replacement")
      : path.join(f.home, "carry-forward.sqlite");
  if (mode === "restored") {
    await createVerifiedSqliteSnapshot({
      sourcePath: databasePath,
      targetPath: stagePath,
      preserveRowIds: true,
    });
  }
  const sourceDb = new DatabaseSync(databasePath);
  const stagedDb = new DatabaseSync(stagePath);
  try {
    update(
      prepareUpdateRecoveryCarryForward({
        sourceDb,
        stagedDb,
        expected: recovery.getRecord(),
        nextProgress: { ...planRef, resourceCursor: 0, phase: "intent" },
        fence: recovery.fence,
        validateStagedDatabase(db) {
          expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        },
      }).record,
    );
  } finally {
    sourceDb.close();
    stagedDb.close();
  }
  if (mode === "restored") {
    for (
      let resourceCursor = 0;
      resourceCursor < reopened.plan.resources.length;
      resourceCursor++
    ) {
      if (resourceCursor > 0) {
        update(
          f.write(() =>
            recordUpdateRecoveryRestoreProgress(
              recovery.getRecord(),
              {
                ...planRef,
                resourceCursor,
                phase: "intent",
              },
              recovery.fence,
              recovery.options,
            ),
          ),
        );
      }
      const applied = await restoreUpdateCheckpointResource({
        artifactRoot,
        binding,
        planRef,
        resourceCursor,
        assertQuiescent: recovery.fence.assertCurrent,
      });
      expect(applied.observed).toBe("after");
      update(
        f.write(() =>
          recordUpdateRecoveryRestoreProgress(
            recovery.getRecord(),
            {
              ...planRef,
              resourceCursor,
              phase: "observed",
            },
            recovery.fence,
            recovery.options,
          ),
        ),
      );
    }
    update(
      f.write(() =>
        recordUpdateRecoveryObservation(
          recovery.getRecord(),
          {
            effectId: restoreEffectId,
            observedIdentity: planRef.planSha256,
          },
          recovery.fence,
          recovery.options,
        ),
      ),
    );
    expect(fs.readFileSync(f.includePath, "utf8")).toContain("18789");
  }
  expect(identity.native).not.toHaveBeenCalled();
  return { planRef, reopened, stagePath };
}

async function published(
  f: Context,
  mode: Mode,
  operation: (plan: Awaited<ReturnType<typeof publication>>) => Promise<void>,
) {
  const plan = await publication(f, mode);
  if (mode === "restored") {
    return operation(plan);
  }
  const stagedOwner = acquireStateDatabaseHandleExclusion({ databasePath: plan.stagePath });
  try {
    await stagedOwner.runWithSourceReads(async () => {
      expect(
        (await inspectUpdateCommandSealedReplay(f.recovery.getRecord(), f.env)).planRef,
      ).toEqual(plan.planRef);
      await operation(plan);
    });
  } finally {
    stagedOwner.release();
  }
}

describe.each(["replay", "restored"] as const)(
  "valid %s source callback (pure synthetic publication)",
  (mode) => {
    // Match the production replay and previous-runtime restoration callers.
    const modeFlags =
      mode === "restored"
        ? { restored: true as const, mutation: true as const }
        : { replay: true as const };
    it("enters the callback without changing source custody", async () => {
      await fixture(async (f) =>
        published(f, mode, async ({ planRef }) => {
          const canonical = f.canonical(),
            rows = f.rows();
          let entered = false;
          await withUpdateCommandSourceOwnership(
            { recovery: f.recovery, env: f.env, ...modeFlags },
            async (source) => {
              entered = true;
              source.assertCurrent();
              await source.verifySources();
              assertExactUpdateRecoveryClaim(
                f.recovery.getRecord(),
                f.recovery.fence,
                f.recovery.options,
              );
              expect(source.current.ref.checkpointId).toBe(planRef.checkpointId);
              for (const key of [
                heldServiceLockCoordinate(identity.control),
                f.configPath,
                f.includePath,
              ]) {
                expect(fs.existsSync(key + ".lock")).toBe(true);
              }
            },
          );
          expect(entered).toBe(true);
          expect(f.canonical()).toEqual(canonical);
          expect(f.rows()).toEqual(rows);
        }),
      );
    });
    it.each(["claimId", "transactionId", "revision"] as const)(
      "refuses mismatched %s before callback admission on an otherwise valid plan",
      async (field) => {
        await fixture((f) =>
          published(f, mode, async () => {
            const record = f.recovery.getRecord();
            const wrong = {
              ...record,
              [field]: field === "revision" ? record.revision + 1 : randomUUID(),
            };
            const before = f.canonical(),
              rows = f.rows();
            const operation = vi.fn(async () => undefined);
            await expect(
              withUpdateCommandSourceOwnership(
                {
                  recovery: { ...f.recovery, getRecord: () => wrong },
                  env: f.env,
                  ...modeFlags,
                },
                operation,
              ),
            ).rejects.toThrow(/claim|evidence|changed|conflict|commitment/i);
            expect(operation).not.toHaveBeenCalled();
            expect(f.canonical()).toEqual(before);
            expect(f.rows()).toEqual(rows);
          }),
        );
      },
    );

    it("refuses a revoked canonical claim after genuine callback entry", async () => {
      await fixture((f) =>
        published(f, mode, async () => {
          let entered = false;
          await withUpdateCommandSourceOwnership(
            { recovery: f.recovery, env: f.env, ...modeFlags },
            async (source) => {
              entered = true;
              const original = f.recovery.getRecord();
              f.write(() => claimUpdateRecovery(original, f.recovery.fence, f.recovery.options));
              closeOpenClawStateDatabaseForTest();
              const before = f.canonical(),
                rows = f.rows();
              // The real restored caller pairs file verification with this exact claim
              // assertion; replay's verifySources re-inspects the committed record itself.
              if (mode === "replay") {
                await expect(source.verifySources()).rejects.toThrow(/evidence changed/);
              }
              expect(() =>
                assertExactUpdateRecoveryClaim(
                  original,
                  { assertCurrent: source.assertCurrent },
                  f.recovery.options,
                ),
              ).toThrow(/claim|changed|conflict/i);
              expect(f.canonical()).toEqual(before);
              expect(f.rows()).toEqual(rows);
            },
          );
          expect(entered).toBe(true);
        }),
      );
    });

    it("refuses changed source bytes after genuine callback entry", async () => {
      await fixture((f) =>
        published(f, mode, async () => {
          let entered = false;
          await withUpdateCommandSourceOwnership(
            { recovery: f.recovery, env: f.env, ...modeFlags },
            async (source) => {
              entered = true;
              fs.writeFileSync(f.includePath, "foreign operator edit");
              const before = f.canonical(),
                rows = f.rows();
              await expect(source.verifySources()).rejects.toThrow(
                /Original source changed|immutable resource evidence/,
              );
              expect(f.canonical()).toEqual(before);
              expect(f.rows()).toEqual(rows);
            },
          );
          expect(entered).toBe(true);
        }),
      );
    });

    it("lost executor expires the admitted source callback without advancing either store", async () => {
      let entered = false;
      await expect(
        fixture((f) =>
          published(f, mode, async () => {
            await withUpdateCommandSourceOwnership(
              { recovery: f.recovery, env: f.env, ...modeFlags },
              async (source) => {
                entered = true;
                const before = f.canonical(),
                  rows = f.rows();
                identity.dead = true;
                expect(source.assertCurrent).toThrow(/executor ownership/);
                expect(f.canonical()).toEqual(before);
                expect(f.rows()).toEqual(rows);
              },
            );
          }),
        ),
      ).rejects.toThrow(/executor|release/);
      expect(entered).toBe(true);
    });

    it.each(["reserved", "admitted"] as const)(
      "retains modeled lower-layer %s custody on source release",
      async (phase) => {
        let entered = false;
        let verifyHeld: (() => void) | undefined;
        await expect(
          fixture((f) =>
            published(f, mode, async () => {
              await withUpdateCommandSourceOwnership(
                { recovery: f.recovery, env: f.env, ...modeFlags },
                async (source) => {
                  entered = true;
                  const record = f.recovery.getRecord();
                  const before = f.canonical();
                  const keys = [
                    heldServiceLockCoordinate(identity.control),
                    f.configPath,
                    f.includePath,
                  ];
                  const sidecars = keys.map((key) => {
                    const stat = fs.statSync(key + ".lock");
                    return { bytes: fs.readFileSync(key + ".lock"), dev: stat.dev, ino: stat.ino };
                  });
                  // Ordinary replay/restored fences cannot mint source authority either.
                  const sourceDescription = {
                    runId: record.runId,
                    transactionId: record.transactionId,
                    claimId: record.claimId,
                    revision: record.revision,
                    recordSha256: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
                    lifetimeId: randomUUID(),
                    serviceKey: keys[0]!,
                    configPaths: [f.configPath, f.includePath].toSorted(),
                  };
                  // Model a retained record written by an older producer.
                  const parent = f.store.read(f.home);
                  if (parent.kind !== "current") {
                    throw new Error("fixture parent missing");
                  }
                  seedRetainedBorrower(
                    path.join(identity.control, "managed-update-handoffs.sqlite"),
                    parent.lease,
                    sourceDescription,
                    phase,
                  );
                  const rows = f.rows();
                  expect(source.assertCurrent).toThrow(/native custody/);
                  expect(f.canonical()).toEqual(before);
                  verifyHeld = () => {
                    expect(f.rows()).toEqual(rows);
                    expect(
                      keys.map((key) => {
                        const stat = fs.statSync(key + ".lock");
                        return {
                          bytes: fs.readFileSync(key + ".lock"),
                          dev: stat.dev,
                          ino: stat.ino,
                        };
                      }),
                    ).toEqual(sidecars);
                  };
                  verifyHeld();
                },
              );
            }),
          ),
        ).rejects.toThrow(/release remains pending/);
        expect(entered).toBe(true);
        if (!verifyHeld) {
          throw new Error("unresolved fixture not reached");
        }
        verifyHeld();
      },
    );
  },
);
