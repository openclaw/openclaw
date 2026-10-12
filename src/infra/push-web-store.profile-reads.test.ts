import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { ensureUserProfilesSchema } from "../state/user-profiles-schema.js";
import {
  hashWebPushEndpoint,
  setWebPushSubscriptionPreferences,
  upsertWebPushSubscription,
  type WebPushMutationGuard,
} from "./push-web-store.js";
import { webPushOperations } from "./push-web-store.worker.js";
import { runWithSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

const admission = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./sqlite-worker-operation-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sqlite-worker-operation-admission.js")>()),
  requestSqliteWorkerOperationAdmission: admission.request,
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    admission.request.mockReset();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function createProfileDatabase() {
  const stateDir = tempDirs.make("web-push-profile-reads-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawStateDatabase({ env });
  ensureUserProfilesSchema({ env, database });
  database.db
    .prepare("INSERT INTO user_profiles(id, created_at, updated_at) VALUES (?, 1, 1)")
    .run("person");
  return { stateDir, database };
}

it("reuses admitted Web Push columns without another schema transaction", () => {
  const stateDir = tempDirs.make("web-push-schema-admission-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawStateDatabase({ env });
  const statements = trackSqliteStatementExecutions(database.db, ["statement"], () => "statement");
  try {
    const subscriptions = runWithSqliteWorkerStateContext({ environment: env }, () =>
      webPushOperations["webPush.listWebPushSubscriptions"](undefined, {
        open: () => database,
        stateOptions: () => ({ path: database.path, env }),
      }),
    );
    expect(subscriptions).toEqual([]);
    expect(statements.counts.statement).toBe(1);
  } finally {
    statements.restore();
  }
});

it("resolves repeated Web Push profile references once per mutation and rereads the next mutation", () => {
  const { stateDir, database } = createProfileDatabase();

  const observe = trackSqliteStatementExecutions(database.db, ["profiles"], (sql) =>
    /\bfrom\s+"user_profiles"/i.test(sql) ? "profiles" : null,
  );
  admission.request.mockImplementation(() => expect(database.db.isTransaction).toBe(true));
  const execute = (
    original: string | null = "person",
    current: string | null = "person",
    bound: string | null = "person",
  ) =>
    runWithSqliteWorkerStateContext(
      {
        environment: { OPENCLAW_STATE_DIR: stateDir },
      },
      () =>
        webPushOperations["webPush.deleteBoundWebPushSubscription"](
          {
            endpointHash: "missing-endpoint",
            endpoint: "https://push.example.test/subscription",
            expectedDeviceId: "browser",
            expectedUserProfileId: bound,
            requestProfiles: { original, current },
          },
          {
            open: () => database,
            stateOptions: () => ({ path: database.path, env: { OPENCLAW_STATE_DIR: stateDir } }),
          },
        ),
    );
  try {
    expect(execute()).toBe(false);
    expect(admission.request).toHaveBeenLastCalledWith({
      stage: "transaction",
      facts: { profileId: "person", bindingCurrent: true },
    });
    expect(observe.counts.profiles).toBeLessThanOrEqual(1);
    expect(observe.rowCounts.profiles).toBeGreaterThan(0);
    database.db.prepare("DELETE FROM user_profiles WHERE id = ?").run("person");
    expect(execute()).toBe(false);
    expect(admission.request).toHaveBeenLastCalledWith({
      stage: "transaction",
      facts: { profileId: null, bindingCurrent: false },
    });
    expect(observe.counts.profiles).toBeLessThanOrEqual(2);

    const insertProfile = database.db.prepare(
      "INSERT INTO user_profiles(id, merged_into, created_at, updated_at) VALUES (?, ?, 1, 1)",
    );
    insertProfile.run("person", null);
    insertProfile.run("other", null);
    insertProfile.run("alias", "person");
    const cases = [
      // original, current, bound, reads, profileId, bindingCurrent
      ["alias", "alias", "alias", 2, "person", true],
      ["alias", "person", "person", 3, "person", true],
      ["person", "alias", "person", 3, "person", true],
      ["person", "person", "other", 2, "person", false],
      ["person", "other", "person", 2, "other", false],
      ["person", "other", "alias", 4, "other", false],
      [null, null, null, 0, null, true],
      [null, "person", "person", 1, "person", false],
    ] as const;
    for (const [original, current, bound, reads, profileId, bindingCurrent] of cases) {
      const readsBefore = observe.counts.profiles;
      expect(execute(original, current, bound)).toBe(false);
      expect(admission.request).toHaveBeenLastCalledWith({
        stage: "transaction",
        facts: { profileId, bindingCurrent },
      });
      expect(observe.counts.profiles - readsBefore).toBeLessThanOrEqual(reads);
    }
    admission.request.mockClear();
    database.db
      .prepare("UPDATE user_profiles SET updated_at = ? WHERE id = ?")
      .run(9_007_199_254_740_993n, "person");
    expect(() => execute()).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(admission.request).not.toHaveBeenCalled();
  } finally {
    observe.restore();
  }
});

it("refuses a worker preference update after the previously admitted profile is removed", async () => {
  const { stateDir, database } = createProfileDatabase();
  const endpoint = "https://push.example.test/profile-lifecycle";
  const guard: WebPushMutationGuard = {
    family: "worker",
    profiles: { original: "person", current: "person" },
    assertCurrent: () => {},
    assertProfiles: (facts) => {
      if (!facts.bindingCurrent || facts.profileId !== "person") {
        throw new Error("profile binding changed");
      }
    },
  };
  await upsertWebPushSubscription({
    endpointHash: hashWebPushEndpoint(endpoint),
    endpoint,
    keys: { p256dh: "synthetic-key", auth: "synthetic-auth" },
    binding: { deviceId: "browser", userProfileId: "person" },
    candidateSubscriptionId: "subscription",
    nowMs: 1,
    stateDir,
    guard,
  });
  database.db.prepare("DELETE FROM user_profiles WHERE id = ?").run("person");
  await expect(
    setWebPushSubscriptionPreferences({
      endpoint,
      preferences: { enabled: false, label: "New label" },
      expectedDeviceId: "browser",
      expectedUserProfileId: "person",
      stateDir,
      guard,
    }),
  ).rejects.toThrow("profile binding changed");
  expect(
    database.db
      .prepare(
        "SELECT preferences_json, updated_at_ms FROM web_push_subscriptions WHERE subscription_id = ?",
      )
      .get("subscription"),
  ).toEqual({ preferences_json: null, updated_at_ms: 1 });
  expect(admission.request).not.toHaveBeenCalled();
});
