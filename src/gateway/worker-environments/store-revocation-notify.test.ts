import { beforeEach, describe, expect, it } from "vitest";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { hashWorkerCredential } from "./credential.js";
import { createEnvironmentStoreFixture } from "./placement-test-fixtures.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

const CREDENTIAL = ["worker", "credential", "fixture"].join("-");

describe("worker environment store credential-revocation listeners", () => {
  const tempDirs = useStateDatabaseTempDirs();
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  const { seedBootstrapping, readyPatch } = createEnvironmentStoreFixture({
    getStore: () => store,
    getDatabase: () => database,
    now: () => 1_000,
  });

  beforeEach(async () => {
    const root = tempDirs.make("openclaw-worker-env-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
  });

  async function seedReady(environmentId: string) {
    await seedBootstrapping(environmentId, `lease:${environmentId}`);
    const patch = readyPatch();
    return store.transition({
      environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: {
        ...patch,
        credential: {
          ...patch.credential,
          credentialHash: hashWorkerCredential(`${CREDENTIAL}-${environmentId}`),
        },
      },
    });
  }

  it("notifies every revocation listener after commit despite an observer failure, only when transfers must fence", async () => {
    const rotating = await seedReady("worker-revoke-rotate");
    const permanent = await seedReady("worker-revoke-permanent");
    const notified: string[] = [];
    store.onCredentialRevoked(() => {
      throw new Error("synthetic credential observer failure");
    });
    store.onCredentialRevoked((environmentId) => {
      notified.push(environmentId);
    });
    await store.revokeEnvironmentCredential(rotating.environmentId);
    expect(notified).toEqual([]);
    await store.revokeEnvironmentCredential(permanent.environmentId, {
      fenceWorkspaceTransfers: true,
    });
    expect(notified).toEqual([permanent.environmentId]);
    expect(() => store.getCredential(permanent.environmentId)).toThrow("inventory has closed");
    expect(
      database.db
        .prepare(
          "SELECT environment_id FROM worker_environment_credentials WHERE environment_id = ?",
        )
        .get(permanent.environmentId),
    ).toBeUndefined();
  });
});
