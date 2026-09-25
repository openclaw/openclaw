import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  deferSqlitePostCommitPublication,
  withSqlitePostCommitPublications,
} from "../../infra/sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerCredentialRecord } from "./credential.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import { createWorkerEnvironmentCommitAdmission } from "./store-commit-authority.js";
import { publishWorkerEnvironmentNativeMutation } from "./store-native-publication.js";
import { workerEnvironmentProjections } from "./store-projection.js";
import type { WorkerEnvironmentFacts } from "./store-worker-contract.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const environment: WorkerEnvironmentRecord = {
  environmentId: "environment",
  providerId: "provider",
  profileId: "profile",
  profileSnapshot: { settings: {} },
  preparation: {
    purpose: "reserve",
    key: "preparation",
    demandAtMs: 1,
    expiresAtMs: 1_000,
    consumedAtMs: null,
  },
  provisionOperationId: "provision",
  nodeSetupId: "setup",
  nodeDeviceId: "node",
  sharedHost: false,
  desktop: null,
  bootstrapReceipt: { bundleHash: "a".repeat(64), openclawVersion: "test", protocolFeatures: [] },
  ownerEpoch: 1,
  teardownTerminalState: null,
  attachedSessionIds: [],
  lastError: null,
  createdAtMs: 1,
  updatedAtMs: 1,
  stateChangedAtMs: 1,
  lastActivatedAtMs: null,
  idleSinceAtMs: null,
  destroyRequestedAtMs: null,
  state: "ready",
  leaseId: "lease",
  sshEndpoint: null,
};
const credential: WorkerCredentialRecord = {
  environmentId: environment.environmentId,
  credentialHash: "b".repeat(43),
  bundleHash: "a".repeat(64),
  sessionId: null,
  rpcSetVersion: 1,
  ownerEpoch: 1,
  expiresAtMs: 1_000,
  deliveredAtMs: null,
};
function facts(
  row: WorkerEnvironmentRecord | undefined,
  withCredential = false,
): WorkerEnvironmentFacts {
  return {
    ids: [environment.environmentId],
    environments: row ? [row] : [],
    credentials: withCredential ? [credential] : [],
    attachments: [],
  };
}

function acquireProjection() {
  const identity = readDatabasePathIdentitySync(
    path.join(tempDirs.make("worker-inventory-projection-"), "state.sqlite"),
  );
  const owner = workerEnvironmentProjections.acquire(() => identity);
  onTestFinished(() => {
    owner.close();
    workerEnvironmentProjections.remove(owner);
  });
  return owner;
}

it("keeps exact node admission predicates after bootstrap setup binding", () => {
  const owner = acquireProjection();
  owner.install(
    facts({
      ...environment,
      state: "bootstrapping",
      nodeDeviceId: null,
      bootstrapReceipt: null,
      sshEndpoint: {
        host: "worker.example.test",
        port: 22,
        user: "openclaw",
        hostKey: "ssh-ed25519 AAAA",
        keyRef: { source: "file", provider: "worker-keys", id: "/test-key" },
      },
    }),
    owner.nextSequence(),
    false,
  );
  owner.publishPatch(
    environment.environmentId,
    { nodeDeviceId: "cloud-device-bound" },
    owner.nextSequence(),
  );
  expect(owner.hasPendingNodeEnrollmentSetup("setup", "cloud-device-bound")).toBe(true);
  expect(owner.hasNodeEnrollmentOwner("cloud-device-bound")).toBe(true);
  expect(owner.hasPendingNodeEnrollmentSetup("setup", "different-cloud-device")).toBe(false);
  expect(owner.hasPendingNodeEnrollmentSetup("missing-setup", "cloud-device-bound")).toBe(false);
  expect(() => owner.get(environment.environmentId)).toThrow("both SSH and node transports");
  expect(() => owner.list()).toThrow("both SSH and node transports");
});

it.each([false, true])(
  "retains native changes across a delayed full receipt (existing row: %s)",
  (existing) => {
    const owner = acquireProjection();
    if (existing) {
      owner.install(facts(environment), owner.nextSequence(), false);
    }
    const workerRevision = owner.nextSequence();
    const token = {};
    owner.fence(
      [
        {
          environmentId: environment.environmentId,
          recordAuthority: "unknown",
          transferAuthority: "unknown",
          attachmentAuthority: "unknown",
        },
      ],
      token,
    );
    owner.publishPatch(
      environment.environmentId,
      {
        nodeDeviceId: "paired-node",
        updatedAtMs: 100,
        preparation: { ...environment.preparation!, consumedAtMs: 100 },
      },
      owner.nextSequence(),
    );
    owner.publishPatch(environment.environmentId, { lastActivatedAtMs: 200 }, owner.nextSequence());
    expect(() => owner.get(environment.environmentId)).toThrow("unsettled mutation");
    expect(() => owner.transferOwner(environment.environmentId)).toThrow("unsettled mutation");
    if (!existing) {
      expect(owner.list()).toEqual([]);
    }
    owner.install(
      facts({ ...environment, lastError: "worker receipt" }, true),
      workerRevision,
      false,
    );
    expect(() => owner.get(environment.environmentId)).toThrow("unsettled mutation");
    owner.release(token);
    expect(owner.get(environment.environmentId)).toMatchObject({
      nodeDeviceId: "paired-node",
      updatedAtMs: 100,
      preparation: { consumedAtMs: 100 },
      lastActivatedAtMs: 200,
      lastError: "worker receipt",
    });
    expect(owner.credential(environment.environmentId)).toEqual(credential);

    const fresh = { ...environment, nodeDeviceId: "fresh-node", updatedAtMs: 300 };
    owner.install(facts(fresh), owner.nextSequence(), false);
    expect(owner.get(environment.environmentId)).toEqual(fresh);
    owner.publishPatch(environment.environmentId, { updatedAtMs: 400 }, owner.nextSequence());
    owner.install(facts(undefined), owner.nextSequence(), false);
    owner.install(facts(environment), owner.nextSequence(), false);
    expect(owner.get(environment.environmentId)).toEqual(environment);
  },
);

it.each([
  "unchanged",
  "activity",
  "closed",
  "generation",
  "lifecycle",
  "session",
  "missing",
  "unknown",
] as const)(
  "preserves diagnostic record reads while fencing %s attachment and transport changes",
  (change) => {
    const owner = acquireProjection();
    const before = facts(environment, true);
    const attachment = {
      environmentId: environment.environmentId,
      sessionId: "session",
      sessionKey: "agent:main:session",
      agentId: "main",
      generation: 1,
      createdAtMs: 1,
      lastUsedAtMs: 1,
      closedAtMs: null,
    };
    before.attachments.push(attachment);
    owner.install(before, owner.nextSequence(), false);
    const after = facts({ ...environment, updatedAtMs: 2, lastError: "diagnostic" }, true);
    const nextAttachment = {
      ...attachment,
      ...(change === "activity" ? { lastUsedAtMs: 2 } : {}),
      ...(change === "closed" ? { closedAtMs: 2 } : {}),
      ...(change === "generation" ? { generation: 2 } : {}),
      ...(change === "lifecycle" ? { sessionLifecycleRevision: "replacement" } : {}),
      ...(change === "session" ? { sessionId: "replacement" } : {}),
    };
    if (change !== "missing") {
      after.attachments.push(nextAttachment);
    }
    const token = {};
    const admission = createWorkerEnvironmentCommitAdmission(after);
    if (change === "unknown") {
      admission[0]!.attachmentAuthority = "unknown";
    }
    owner.fence(admission, token);
    expect(owner.get(environment.environmentId)).toEqual(environment);
    expect(owner.credential(environment.environmentId)).toEqual(credential);
    expect(owner.credentialByHash(credential.credentialHash)).toEqual(credential);
    expect(owner.hasNodeEnrollmentOwner("node")).toBe(true);
    expect(owner.hasPendingNodeEnrollmentSetup("setup", "node")).toBe(true);
    if (change === "unchanged") {
      expect(owner.attachment("session")).toEqual(attachment);
    } else {
      expect(() => owner.attachment("session")).toThrow("unsettled mutation");
    }
    expect(owner.withAdmission(token, () => owner.attachment("session"))).toEqual(attachment);
    owner.install(after, owner.nextSequence(), false);
    owner.release(token);
    expect(owner.attachment(nextAttachment.sessionId)).toEqual(
      change === "missing" ? undefined : nextAttachment,
    );

    owner.fence(
      createWorkerEnvironmentCommitAdmission(
        facts({ ...environment, leaseId: "replacement" }, true),
      ),
      token,
    );
    expect(() => owner.get(environment.environmentId)).toThrow("unsettled mutation");
    expect(() => owner.credentialByHash(credential.credentialHash)).toThrow("unsettled mutation");
    expect(owner.withAdmission(token, () => owner.get(environment.environmentId))).toEqual(
      after.environments[0],
    );
  },
);

it("fences both environments while a conversation attachment moves", () => {
  const owner = acquireProjection();
  const before = facts({ ...environment, state: "destroyed" });
  const attachment = {
    environmentId: environment.environmentId,
    sessionId: "moving-session",
    sessionKey: "agent:main:moving-session",
    agentId: "main",
    generation: 1,
    createdAtMs: 1,
    lastUsedAtMs: 1,
    closedAtMs: 1,
  };
  before.attachments.push(attachment);
  owner.install(before, owner.nextSequence(), false);
  const destination = { ...environment, environmentId: "destination" };
  const after: WorkerEnvironmentFacts = {
    ids: [environment.environmentId, destination.environmentId],
    environments: [...before.environments, destination],
    credentials: [],
    attachments: [
      { ...attachment, environmentId: destination.environmentId, generation: 2, closedAtMs: null },
    ],
  };
  const token = {};
  owner.fence(createWorkerEnvironmentCommitAdmission(after), token);
  expect(() => owner.attachment(attachment.sessionId)).toThrow("unsettled mutation");
  for (const id of after.ids) {
    expect(() => owner.hasSessionAttachment(id)).toThrow("unsettled mutation");
  }
  owner.install(after, owner.nextSequence(), false);
  owner.release(token);
  owner.fence(createWorkerEnvironmentCommitAdmission(after), token);
  expect(owner.hasSessionAttachment(environment.environmentId)).toBe(false);
  expect(owner.hasSessionAttachment(destination.environmentId)).toBe(true);
  expect(owner.attachment(attachment.sessionId)).toEqual(after.attachments[0]);
  owner.release(token);
});

it("publishes native fields only after commit and before reentrant observers without host reads", async () => {
  const database = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("worker-inventory-patches-") },
  });
  const { db } = database;
  const owner = workerEnvironmentProjections.acquire(() =>
    requireOpenClawStateDatabaseIdentity(database),
  );
  owner.install(facts(environment), owner.nextSequence(), false);
  const observed: Array<string | null | undefined> = [];
  const unsubscribe = sessionChanges.subscribe(() => {
    observed.push(owner.get(environment.environmentId)?.nodeDeviceId);
  });
  const transaction = (operation: () => void) =>
    withSqlitePostCommitPublications(db, () => runSqliteImmediateTransactionSync(db, operation));
  try {
    expect(() =>
      transaction(() => {
        publishWorkerEnvironmentNativeMutation(db, environment.environmentId, {
          nodeDeviceId: "rolled-back",
        });
        expect(owner.get(environment.environmentId)).toEqual(environment);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(owner.get(environment.environmentId)).toEqual(environment);
    expect(observed).toEqual([]);

    transaction(() => {
      deferSqlitePostCommitPublication(db, () => {
        observed.push(owner.get(environment.environmentId)?.nodeDeviceId);
        transaction(() =>
          publishWorkerEnvironmentNativeMutation(db, environment.environmentId, {
            nodeDeviceId: "second",
          }),
        );
      });
      const prepare = vi.spyOn(db, "prepare").mockImplementation(() => {
        throw new Error("Native publication must not query SQLite");
      });
      try {
        publishWorkerEnvironmentNativeMutation(db, environment.environmentId, {
          nodeDeviceId: "first",
        });
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
      }
      expect(owner.get(environment.environmentId)).toEqual(environment);
    });
    expect(observed).toEqual(["first", "second", "second"]);
    expect(owner.get(environment.environmentId)?.nodeDeviceId).toBe("second");
  } finally {
    unsubscribe();
    owner.close();
    workerEnvironmentProjections.remove(owner);
    await closeOpenClawStateDatabaseByPathAsync(database.path);
  }
});
