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
import { executeWebPushCommand } from "./push-web-store.worker.js";
import { runWithSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import { captureStateDatabaseCoordinatorRuntime } from "./state-database-coordinator.js";

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
        coordinatorRuntime: captureStateDatabaseCoordinatorRuntime(),
      },
      () =>
        executeWebPushCommand(
          {
            type: "webPush.deleteBoundWebPushSubscription",
            input: {
              endpointHash: "missing-endpoint",
              endpoint: "https://push.example.test/subscription",
              expectedDeviceId: "browser",
              expectedUserProfileId: bound,
              requestProfiles: { original, current },
            },
          },
          database,
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

    database.db
      .prepare(
        "INSERT INTO user_profiles(id, merged_into, created_at, updated_at) VALUES (?, ?, 1, 1)",
      )
      .run("person", null);
    database.db
      .prepare(
        "INSERT INTO user_profiles(id, merged_into, created_at, updated_at) VALUES (?, ?, 1, 1)",
      )
      .run("other", null);
    database.db
      .prepare(
        "INSERT INTO user_profiles(id, merged_into, created_at, updated_at) VALUES (?, ?, 1, 1)",
      )
      .run("alias", "person");
    const cases = [
      {
        original: "alias",
        current: "alias",
        bound: "alias",
        reads: 2,
        profileId: "person",
        bindingCurrent: true,
      },
      {
        original: "alias",
        current: "person",
        bound: "person",
        reads: 3,
        profileId: "person",
        bindingCurrent: true,
      },
      {
        original: "person",
        current: "alias",
        bound: "person",
        reads: 3,
        profileId: "person",
        bindingCurrent: true,
      },
      {
        original: "person",
        current: "person",
        bound: "other",
        reads: 2,
        profileId: "person",
        bindingCurrent: false,
      },
      {
        original: "person",
        current: "other",
        bound: "person",
        reads: 2,
        profileId: "other",
        bindingCurrent: false,
      },
      {
        original: "person",
        current: "other",
        bound: "alias",
        reads: 4,
        profileId: "other",
        bindingCurrent: false,
      },
      {
        original: null,
        current: null,
        bound: null,
        reads: 0,
        profileId: null,
        bindingCurrent: true,
      },
      {
        original: null,
        current: "person",
        bound: "person",
        reads: 1,
        profileId: "person",
        bindingCurrent: false,
      },
    ];
    for (const entry of cases) {
      const readsBefore = observe.counts.profiles;
      expect(execute(entry.original, entry.current, entry.bound)).toBe(false);
      expect(admission.request).toHaveBeenLastCalledWith({
        stage: "transaction",
        facts: { profileId: entry.profileId, bindingCurrent: entry.bindingCurrent },
      });
      expect(observe.counts.profiles - readsBefore).toBeLessThanOrEqual(entry.reads);
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
