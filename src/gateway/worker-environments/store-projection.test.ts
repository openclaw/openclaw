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
import { createWorkerEnvironmentReceipt, readWorkerEnvironmentReceipt } from "./store-receipt.js";
import type { WorkerEnvironmentFacts } from "./store.types.js";

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

type Projection = ReturnType<typeof acquireProjection>;
const id = environment.environmentId;
function install(owner: Projection, row?: WorkerEnvironmentRecord, withCredential = false) {
  owner.install(facts(row, withCredential), owner.nextSequence(), false);
}
function fence(owner: Projection, after: WorkerEnvironmentFacts, token = {}) {
  owner.fence(createWorkerEnvironmentCommitAdmission(after), token);
  return token;
}
function expectNodeAuthority(owner: Projection) {
  expect(owner.get(id)).toEqual(environment);
  expect(owner.hasNodeEnrollmentOwner("node")).toBe(true);
  expect(owner.hasPendingNodeEnrollmentSetup("setup", "node")).toBe(true);
}
function attachment(sessionId = "session", closedAtMs: number | null = null) {
  return {
    environmentId: id,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    agentId: "main",
    generation: 1,
    createdAtMs: 1,
    lastUsedAtMs: 1,
    closedAtMs,
  };
}

it("requires complete exact-key receipts before replacing environment authority", () => {
  const owner = acquireProjection();
  const source = { identity: "environment-store", incarnation: owner.incarnation };
  install(owner, environment, true);
  const deletion = createWorkerEnvironmentReceipt(source, facts(undefined));
  for (const invalid of [
    { ...deletion, facts: new Map() },
    { ...deletion, source: { ...source, identity: "another-store" } },
    { ...deletion, source: { ...source, incarnation: "retired-owner" } },
    { ...deletion, facts: new Map([[id, { kind: "unknown" }]]) },
    {
      ...deletion,
      facts: new Map([[id, { kind: "postimage", value: { environment: null } }]]),
    },
  ]) {
    expect(() =>
      owner.install(
        readWorkerEnvironmentReceipt(invalid, source, [id]),
        owner.nextSequence(),
        false,
      ),
    ).toThrow(/receipt/);
    expect(owner.get(id)).toEqual(environment);
    expect(owner.credential(id)).toEqual(credential);
  }
  owner.install(readWorkerEnvironmentReceipt(deletion, source, [id]), owner.nextSequence(), false);
  expect(owner.get(id)).toBeUndefined();
  expect(owner.credential(id)).toBeUndefined();
});

it("keeps exact node admission predicates after bootstrap setup binding", () => {
  const owner = acquireProjection();
  install(owner, {
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
  });
  owner.publishPatch(id, { nodeDeviceId: "cloud-device-bound" }, owner.nextSequence());
  expect(owner.hasPendingNodeEnrollmentSetup("setup", "cloud-device-bound")).toBe(true);
  expect(owner.hasNodeEnrollmentOwner("cloud-device-bound")).toBe(true);
  expect(owner.hasPendingNodeEnrollmentSetup("setup", "different-cloud-device")).toBe(false);
  expect(owner.hasPendingNodeEnrollmentSetup("missing-setup", "cloud-device-bound")).toBe(false);
});

it.each([false, true])(
  "retains native changes across a delayed full receipt (existing row: %s)",
  (existing) => {
    const owner = acquireProjection();
    if (existing) {
      install(owner, environment);
    }
    const workerRevision = owner.nextSequence();
    const token = {};
    owner.fence(
      [
        {
          environmentId: id,
          environmentAuthority: "unknown",
          credentialAuthority: "unknown",
          transferAuthority: "unknown",
          attachmentAuthority: "unknown",
        },
      ],
      token,
    );
    owner.publishPatch(
      id,
      {
        nodeDeviceId: "paired-node",
        updatedAtMs: 100,
        preparation: { ...environment.preparation!, consumedAtMs: 100 },
      },
      owner.nextSequence(),
    );
    owner.publishPatch(id, { lastActivatedAtMs: 200 }, owner.nextSequence());
    expect(() => owner.get(id)).toThrow("unsettled mutation");
    expect(() => owner.transferOwner(id)).toThrow("unsettled mutation");
    if (!existing) {
      expect(owner.list()).toEqual([]);
    }
    owner.install(
      facts({ ...environment, lastError: "worker receipt" }, true),
      workerRevision,
      false,
    );
    expect(() => owner.get(id)).toThrow("unsettled mutation");
    owner.release(token);
    expect(owner.get(id)).toMatchObject({
      nodeDeviceId: "paired-node",
      updatedAtMs: 100,
      preparation: { consumedAtMs: 100 },
      lastActivatedAtMs: 200,
      lastError: "worker receipt",
    });
    expect(owner.credential(id)).toEqual(credential);

    const fresh = { ...environment, nodeDeviceId: "fresh-node", updatedAtMs: 300 };
    install(owner, fresh);
    expect(owner.get(id)).toEqual(fresh);
    owner.publishPatch(id, { updatedAtMs: 400 }, owner.nextSequence());
    install(owner);
    install(owner, environment);
    expect(owner.get(id)).toEqual(environment);
  },
);

it.each(["unchanged", "activity", "missing", "unknown"] as const)(
  "preserves diagnostic record reads while fencing %s attachment and transport changes",
  (change) => {
    const owner = acquireProjection();
    const before = facts(environment, true);
    const initialAttachment = attachment();
    before.attachments.push(initialAttachment);
    owner.install(before, owner.nextSequence(), false);
    const after = facts({ ...environment, updatedAtMs: 2, lastError: "diagnostic" }, true);
    const nextAttachment = {
      ...initialAttachment,
      ...(change === "activity" ? { lastUsedAtMs: 2 } : {}),
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
    expectNodeAuthority(owner);
    expect(owner.credential(id)).toEqual(credential);
    expect(owner.credentialByHash(credential.credentialHash)).toEqual(credential);
    if (change === "unchanged") {
      expect(owner.attachment("session")).toEqual(initialAttachment);
    } else {
      expect(() => owner.attachment("session")).toThrow("unsettled mutation");
    }
    expect(owner.withAdmission(token, () => owner.attachment("session"))).toEqual(
      initialAttachment,
    );
    owner.install(after, owner.nextSequence(), false);
    owner.release(token);
    expect(owner.attachment(nextAttachment.sessionId)).toEqual(
      change === "missing" ? undefined : nextAttachment,
    );

    fence(owner, facts({ ...environment, leaseId: "replacement" }, true), token);
    expect(() => owner.get(id)).toThrow("unsettled mutation");
    expect(() => owner.hasNodeEnrollmentOwner("node")).toThrow("unsettled mutation");
    expect(() => owner.hasPendingNodeEnrollmentSetup("setup", "node")).toThrow(
      "unsettled mutation",
    );
    expect(owner.credential(id)).toEqual(credential);
    expect(owner.credentialByHash(credential.credentialHash)).toEqual(credential);
    expect(owner.withAdmission(token, () => owner.get(id))).toEqual(after.environments[0]);
  },
);

it("keeps environment authority readable during credential revocation", () => {
  const owner = acquireProjection();
  install(owner, environment, true);
  const after = facts(environment);
  const token = fence(owner, after);
  expectNodeAuthority(owner);
  expect(() => owner.credential(id)).toThrow("unsettled mutation");
  expect(() => owner.credentialByHash(credential.credentialHash)).toThrow("unsettled mutation");
  expect(owner.withAdmission(token, () => owner.credential(id))).toEqual(credential);
  owner.install(after, owner.nextSequence(), false);
  owner.release(token);
  expect(owner.credential(id)).toEqual(after.credentials[0]);
});

it("fences both environments while a conversation attachment moves", () => {
  const owner = acquireProjection();
  const before = facts({ ...environment, state: "destroyed" });
  const movingAttachment = attachment("moving-session", 1);
  before.attachments.push(movingAttachment);
  owner.install(before, owner.nextSequence(), false);
  const destination = { ...environment, environmentId: "destination" };
  const after: WorkerEnvironmentFacts = {
    ids: [id, destination.environmentId],
    environments: [...before.environments, destination],
    credentials: [],
    attachments: [
      {
        ...movingAttachment,
        environmentId: destination.environmentId,
        generation: 2,
        closedAtMs: null,
      },
    ],
  };
  const token = fence(owner, after);
  expect(() => owner.attachment(movingAttachment.sessionId)).toThrow("unsettled mutation");
  for (const environmentId of after.ids) {
    expect(() => owner.hasSessionAttachment(environmentId)).toThrow("unsettled mutation");
  }
  owner.install(after, owner.nextSequence(), false);
  owner.release(token);
  fence(owner, after, token);
  expect(owner.hasSessionAttachment(id)).toBe(false);
  expect(owner.hasSessionAttachment(destination.environmentId)).toBe(true);
  expect(owner.attachment(movingAttachment.sessionId)).toEqual(after.attachments[0]);
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
  install(owner, environment);
  const observed: Array<string | null | undefined> = [];
  const unsubscribe = sessionChanges.subscribe(() => {
    observed.push(owner.get(id)?.nodeDeviceId);
  });
  const transaction = (operation: () => void) =>
    withSqlitePostCommitPublications(db, () => runSqliteImmediateTransactionSync(db, operation));
  try {
    expect(() =>
      transaction(() => {
        publishWorkerEnvironmentNativeMutation(db, id, { nodeDeviceId: "rolled-back" });
        expect(owner.get(id)).toEqual(environment);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(owner.get(id)).toEqual(environment);
    expect(observed).toEqual([]);

    transaction(() => {
      deferSqlitePostCommitPublication(db, () => {
        observed.push(owner.get(id)?.nodeDeviceId);
        transaction(() =>
          publishWorkerEnvironmentNativeMutation(db, id, { nodeDeviceId: "second" }),
        );
      });
      const prepare = vi.spyOn(db, "prepare").mockImplementation(() => {
        throw new Error("Native publication must not query SQLite");
      });
      try {
        publishWorkerEnvironmentNativeMutation(db, id, { nodeDeviceId: "first" });
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
      }
      expect(owner.get(id)).toEqual(environment);
    });
    expect(observed).toEqual(["first", "second", "second"]);
    expect(owner.get(id)?.nodeDeviceId).toBe("second");
  } finally {
    unsubscribe();
    owner.close();
    workerEnvironmentProjections.remove(owner);
    await closeOpenClawStateDatabaseByPathAsync(database.path);
  }
});
