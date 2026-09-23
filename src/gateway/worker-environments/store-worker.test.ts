import { symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { bindCloudWorkerSetupCompletion } from "../../infra/device-pairing-cloud-worker.js";
import * as sqlite from "../../infra/kysely-sync.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { createStateSchemaMigrationStep } from "../../infra/state-migrations.state-schema.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "../../state/openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { publishWorkerEnvironmentNativeMutation } from "./store-native-publication.js";
import { createWorkerEnvironmentStore } from "./store.js";

const delivery = vi.hoisted(() => ({
  afterTransition: undefined as (() => Promise<void>) | undefined,
  commands: [] as string[],
}));
vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      context: Parameters<typeof actual.runOpenClawStateWorkerOperation>[0],
      operation: Parameters<typeof actual.runOpenClawStateWorkerOperation>[1],
      options: Parameters<typeof actual.runOpenClawStateWorkerOperation>[2],
    ) =>
      actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              if (delivery.afterTransition) {
                delivery.commands.push(command.type);
              }
              const result = await scope.execute(command, executeOptions);
              if (command.type === "workerEnvironments.transition") {
                await delivery.afterTransition?.();
              }
              return result;
            },
          }),
        options,
      ),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  delivery.afterTransition = undefined;
  delivery.commands = [];
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

it.each(["automatic", "doctor-preparation"] as const)(
  "keeps live inventory usable after a current-schema %s check",
  async (mode) => {
    const stateDir = tempDirs.make("worker-inventory-schema-check-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawStateDatabase({ env });
    const store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
    const intent = await store.createIntent({
      environmentId: "schema-check-environment",
      providerId: "provider",
      profileId: "profile",
      profileSnapshot: { settings: {} },
      provisionOperationId: "schema-check-provision",
    });
    const result = await createStateSchemaMigrationStep({
      stateDir,
      env,
      mode,
      requiredness: "conditional",
    }).run();
    expect(result).toMatchObject({ changes: [], warnings: [] });
    expect(store.get(intent.environmentId)).toEqual(intent);
    await store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
    });
    expect(store.get(intent.environmentId)?.state).toBe("provisioning");
    await store.close();
  },
);

it("retires inventory after an admitted schema repair before reopening it", async () => {
  const stateDir = tempDirs.make("worker-inventory-schema-repair-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawStateDatabase({ env });
  const store = await createWorkerEnvironmentStore({ database });
  database.db.exec("DROP INDEX idx_audit_events_time");
  const result = await createStateSchemaMigrationStep({
    stateDir,
    env,
    mode: "doctor-preparation",
    requiredness: "conditional",
  }).run();
  expect(result.warnings).toEqual([]);
  expect(result.changes).toContain("Rebuilt canonical shared-state SQLite indexes (1)");
  expect(() => store.list()).toThrow("inventory has closed");
  const reopened = await createWorkerEnvironmentStore({ database });
  expect(reopened.list()).toEqual([]);
  await reopened.close();
});

it("joins explicit Doctor retirement when repair's native close fails after commit", async () => {
  const stateDir = tempDirs.make("worker-inventory-repair-close-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawStateDatabase({ env });
  const store = await createWorkerEnvironmentStore({ database });
  database.db.exec("DROP INDEX idx_audit_events_time");
  const failure = new Error("synthetic repair native close failed after commit");
  const open = nodeSqlite.openNodeSqliteDatabase;
  const opener = vi
    .spyOn(nodeSqlite, "openNodeSqliteDatabase")
    .mockImplementation((pathname, options) => {
      const native = open(pathname, options);
      if (pathname === database.path && options?.enableForeignKeyConstraints === false) {
        const close = native.close.bind(native);
        vi.spyOn(native, "close").mockImplementationOnce(() => {
          close();
          throw failure;
        });
      }
      return native;
    });
  try {
    await expect(
      createStateSchemaMigrationStep({
        stateDir,
        env,
        mode: "doctor",
        requiredness: "conditional",
      }).run(),
    ).rejects.toBe(failure);
    expect(database.db.isOpen).toBe(false);
    expect(() => store.list()).toThrow("inventory has closed");
    const reopened = openOpenClawStateDatabase({ env });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'idx_audit_events_time'")
        .get(),
    ).toEqual({ name: "idx_audit_events_time" });
  } finally {
    opener.mockRestore();
  }
});

it.each(["automatic", "doctor-preparation", "doctor"] as const)(
  "preserves live inventory when %s schema admission is refused",
  async (mode) => {
    const stateDir = tempDirs.make("worker-inventory-repair-refusal-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawStateDatabase({ env });
    const store = await createWorkerEnvironmentStore({ database });
    await expect(
      withExistingOpenClawStateSchema({ path: database.path }, () =>
        createStateSchemaMigrationStep({ stateDir, env, mode, requiredness: "conditional" }).run(),
      ),
    ).rejects.toThrow(/schema repair.*owned/i);
    expect(database.db.isOpen).toBe(true);
    expect(store.list()).toEqual([]);
    await store.close();
  },
);

it("shares committed inventory and native pairing publications across database aliases", async () => {
  const directory = tempDirs.make("worker-inventory-alias-");
  const stateDir = path.join(directory, "original");
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const aliasDir = path.join(directory, "alias");
  await symlink(stateDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
  const aliasPath = path.join(aliasDir, path.relative(stateDir, database.path));
  const aliasDatabase = openOpenClawStateDatabase({
    path: aliasPath,
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
  const store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
  const alias = await createWorkerEnvironmentStore({ database: aliasDatabase, now: () => 1_000 });
  const intent = await store.createIntent({
    environmentId: "alias-environment",
    providerId: "provider",
    profileId: "profile",
    profileSnapshot: { settings: {} },
    provisionOperationId: "alias-provision",
  });
  expect(alias.get(intent.environmentId)).toEqual(intent);
  await store.transition({
    environmentId: intent.environmentId,
    from: "requested",
    to: "provisioning",
  });
  const enrollment = await store.ensureNodeEnrollment(intent.environmentId);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { environmentId, ...patch } = bindCloudWorkerSetupCompletion({
        db,
        completion: {
          setupId: enrollment.nodeSetupId!,
          deviceId: "alias-device",
          completedAtMs: 2_000,
        },
      });
      publishWorkerEnvironmentNativeMutation(db, environmentId, patch);
    },
    { database: aliasDatabase },
  );
  expect(alias.get(intent.environmentId)).toEqual(store.get(intent.environmentId));
  expect(store.get(intent.environmentId)?.nodeDeviceId).toBe("alias-device");
  await alias.close();
  expect(() => alias.get(intent.environmentId)).toThrow("inventory has closed");
  expect(store.get(intent.environmentId)?.nodeDeviceId).toBe("alias-device");
  await closeOpenClawStateDatabaseByPathAsync(aliasPath);
  expect(() => store.get(intent.environmentId)).toThrow();
});

it("serves committed inventory and performs guarded mutations without host SQLite", async () => {
  const database = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("worker-inventory-owner-") },
  });
  const store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
  const intent = {
    environmentId: "worker-a",
    providerId: "provider-b",
    profileId: "profile",
    profileSnapshot: { settings: { region: "fixture" } },
    provisionOperationId: "operation-a",
  };
  await store.createIntent(intent);
  // Warm each query shape so cached native statements cannot hide synchronous reads.
  store.list();
  store.listForReconcile();
  store.get("worker-a");
  const queries = vi.spyOn(sqlite, "executeSqliteQuerySync");
  const firstRows = vi.spyOn(sqlite, "executeSqliteQueryTakeFirstSync");
  const prepare = vi.spyOn(database.db, "prepare");
  const workerReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  try {
    expect(await store.hasSessionAttachment("worker-a")).toBe(false);
    expect(store.list().map((row) => row.environmentId)).toEqual(["worker-a"]);
    expect(store.listForReconcile()).toEqual(store.list());
    const record = store.get("worker-a")!;
    const settings = record.profileSnapshot.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("Expected fixture settings");
    }
    settings.region = "caller mutation";
    expect(store.get("worker-a")!.profileSnapshot.settings).toEqual({ region: "fixture" });
    expect(queries).not.toHaveBeenCalled();
    expect(firstRows).not.toHaveBeenCalled();
    const changed = await store.transition({
      environmentId: "worker-a",
      from: "requested",
      to: "provisioning",
      assertCurrent() {
        expect(store.get("worker-a")!.state).toBe("requested");
      },
    });
    expect(changed.state).toBe("provisioning");
    expect(store.get("worker-a")).toEqual(changed);
    await expect(
      store.transition({ environmentId: "worker-a", from: "requested", to: "provisioning" }),
    ).rejects.toThrow("state conflict");
    await expect(
      store.requestDestroy({
        environmentId: "worker-a",
        state: "provisioning",
        assertCurrent() {
          throw new Error("requester revoked");
        },
      }),
    ).rejects.toThrow("requester revoked");
    expect(store.get("worker-a")!.destroyRequestedAtMs).toBeNull();
    await store.requestDestroy({ environmentId: "worker-a", state: "provisioning" });
    expect(store.get("worker-a")!.destroyRequestedAtMs).toBe(1_000);
    await store.createSessionAttachmentIntent(
      {
        ...intent,
        environmentId: "conversation-a",
        provisionOperationId: "conversation-operation-a",
        sessionId: "conversation-session-a",
        sessionKey: "agent:main:conversation-a",
        agentId: "main",
      },
      () => {},
    );
    expect(await store.hasSessionAttachment("conversation-a")).toBe(true);
    await store.closeSessionAttachment("conversation-session-a");
    expect(await store.hasSessionAttachment("conversation-a")).toBe(true);
    expect(workerReads).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(queries).not.toHaveBeenCalled();
    expect(firstRows).not.toHaveBeenCalled();
  } finally {
    workerReads.mockRestore();
    prepare.mockRestore();
    queries.mockRestore();
    firstRows.mockRestore();
  }
});

it.each(["create", "close"] as const)(
  "queues attachment %s behind an environment commit awaiting publication",
  async (method) => {
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: tempDirs.make("worker-attachment-fifo-") },
    });
    const store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
    const identity = { sessionId: "session-fifo", sessionKey: "agent:main:fifo", agentId: "main" };
    const intent = {
      ...identity,
      environmentId: "environment-before",
      providerId: "provider",
      profileId: "profile",
      profileSnapshot: { settings: {} },
      provisionOperationId: "operation-before",
    };
    await store.createSessionAttachmentIntent(intent, () => {});
    const committed = createDeferredCore();
    const publish = createDeferredCore();
    delivery.afterTransition = async () => {
      committed.resolve();
      await publish.promise;
    };
    const prior = store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "failed",
    });
    let queued: Promise<unknown> | undefined;
    let classification: Promise<boolean> | undefined;
    try {
      await committed.promise;
      expect(() => store.get(intent.environmentId)).toThrow("unsettled mutation");
      queued =
        method === "create"
          ? store.createSessionAttachmentIntent(
              {
                ...intent,
                environmentId: "environment-after",
                provisionOperationId: "operation-after",
              },
              () => {},
            )
          : store.closeSessionAttachment(identity.sessionId);
      let classified = false;
      classification = store.hasSessionAttachment(intent.environmentId).then((attached) => {
        classified = true;
        return attached;
      });
      await Promise.resolve();
      expect(classified).toBe(false);
      publish.resolve();
      await prior;
      const result = await queued;
      expect(await classification).toBe(method === "close");
      const attachment = store.getSessionAttachmentRecord(identity.sessionId);
      if (method === "create") {
        expect(result).toMatchObject({
          environment: { environmentId: "environment-after", state: "requested" },
        });
        expect(attachment).toMatchObject({
          environmentId: "environment-after",
          generation: 2,
          closedAtMs: null,
        });
      } else {
        expect(result).toEqual(attachment);
        expect(attachment).toMatchObject({
          environmentId: intent.environmentId,
          generation: 1,
          closedAtMs: 1_000,
        });
      }
      expect(delivery.commands).toEqual([
        "workerEnvironments.transition",
        method === "create"
          ? "workerEnvironments.createSessionAttachmentIntent"
          : "workerEnvironments.closeSessionAttachment",
      ]);
    } finally {
      publish.resolve();
      await Promise.allSettled([prior, queued, classification]);
      delivery.afterTransition = undefined;
      await store.close();
    }
  },
);

it("rejects queued cleanup before it can revoke a successor owner's credential", async () => {
  const database = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("worker-revocation-owner-") },
  });
  const store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
  const environmentId = "worker-revocation-owner";
  await store.createIntent({
    environmentId,
    providerId: "provider",
    profileId: "profile",
    profileSnapshot: { settings: {} },
    provisionOperationId: "provision-owner",
  });
  await store.transition({ environmentId, from: "requested", to: "provisioning" });
  const previous = await store.transition({
    environmentId,
    from: "provisioning",
    to: "ready",
    patch: {
      leaseId: "lease-owner",
      nodeDeviceId: "node-owner",
      sharedHost: false,
      bootstrapReceipt: {
        bundleHash: "a".repeat(64),
        openclawVersion: "test",
        protocolFeatures: [],
      },
      credential: {
        credentialHash: "b".repeat(43),
        sessionId: null,
        rpcSetVersion: 1,
        expiresAtMs: 2_000,
      },
    },
  });
  const revoked: string[] = [];
  store.onCredentialRevoked((id) => revoked.push(id));
  const replacement = store.transition({
    environmentId,
    from: "ready",
    to: "attached",
    expectedOwnerEpoch: previous.ownerEpoch,
    patch: {
      attachedSessionIds: ["successor-session"],
      credential: {
        credentialHash: "c".repeat(43),
        sessionId: "successor-session",
        rpcSetVersion: 1,
        expiresAtMs: 2_000,
      },
    },
  });
  const cleanup = store.revokeEnvironmentCredential(environmentId, {
    expectedOwnerEpoch: previous.ownerEpoch,
    fenceWorkspaceTransfers: true,
  });
  const results = await Promise.allSettled([replacement, cleanup]);
  expect(results[0].status).toBe("fulfilled");
  expect(results[1]).toMatchObject({
    status: "rejected",
    reason: { message: `Worker environment ${environmentId} owner epoch changed` },
  });
  expect(store.getCredential(environmentId)).toMatchObject({
    credentialHash: "c".repeat(43),
    sessionId: "successor-session",
    ownerEpoch: previous.ownerEpoch + 1,
  });
  expect(revoked).toEqual([]);
});
