import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { ensureUserProfilesSchema } from "../state/user-profiles-schema.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  hashWebPushEndpoint,
  setWebPushSubscriptionPreferences,
  upsertWebPushSubscription,
  type WebPushMutationGuard,
} from "./push-web-store.js";
import { webPushOperations } from "./push-web-store.worker.js";
import {
  runWithSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from "./sqlite-worker-state-context.js";

const admission = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./sqlite-worker-operation-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sqlite-worker-operation-admission.js")>()),
  requestSqliteWorkerOperationAdmission: admission.request,
}));

const restorers: Array<() => void> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    restorers.splice(0).forEach((restore) => restore());
    vi.restoreAllMocks();
    admission.request.mockReset();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

let database: OpenClawStateDatabase;
let stateDir: string;
let env: SqliteWorkerStateContext["environment"];
const runtime = { open: () => database, stateOptions: () => ({ path: database.path, env }) };
beforeEach(() => {
  stateDir = tempDirs.make("web-push-profile-reads-");
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  database = openOpenClawStateDatabase({ env });
});
function addProfile() {
  ensureUserProfilesSchema({ env, database });
  database.db
    .prepare("INSERT INTO user_profiles(id, created_at, updated_at) VALUES (?, 1, 1)")
    .run("person");
  env = { OPENCLAW_STATE_DIR: stateDir };
}
function observe(match: (sql: string) => boolean = () => true) {
  const counter = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["reads"],
    (sql) => (match(sql) ? "reads" : null),
  );
  restorers.push(counter.restore);
  return counter;
}
const expectAdmission = (profileId: string | null, bindingCurrent: boolean) =>
  expect(admission.request).toHaveBeenLastCalledWith({
    stage: "transaction",
    facts: { profileId, bindingCurrent },
  });

it("reuses admitted Web Push columns without another schema transaction", () => {
  const statements = observe();
  const subscriptions = runWithSqliteWorkerStateContext({ environment: env }, () =>
    webPushOperations["webPush.listWebPushSubscriptions"](undefined, runtime),
  );
  expect(subscriptions).toEqual([]);
  expect(statements.counts.reads).toBe(1);
});

it("resolves repeated Web Push profile references once per mutation and rereads the next mutation", () => {
  addProfile();
  const counter = observe((sql) => /\bfrom\s+"user_profiles"/i.test(sql));
  admission.request.mockImplementation(() => expect(database.db.isTransaction).toBe(true));
  const execute = (
    original: string | null = "person",
    current: string | null = "person",
    bound: string | null = "person",
  ) =>
    runWithSqliteWorkerStateContext({ environment: env }, () =>
      webPushOperations["webPush.deleteBoundWebPushSubscription"](
        {
          endpointHash: "missing-endpoint",
          endpoint: "https://push.example.test/subscription",
          expectedDeviceId: "browser",
          expectedUserProfileId: bound,
          requestProfiles: { original, current },
        },
        runtime,
      ),
    );
  expect(execute()).toBe(false);
  expectAdmission("person", true);
  expect(counter.counts.reads).toBeLessThanOrEqual(1);
  expect(counter.rowCounts.reads).toBeGreaterThan(0);
  database.db.prepare("DELETE FROM user_profiles WHERE id = ?").run("person");
  expect(execute()).toBe(false);
  expectAdmission(null, false);
  expect(counter.counts.reads).toBeLessThanOrEqual(2);

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
    const readsBefore = counter.counts.reads;
    expect(execute(original, current, bound)).toBe(false);
    expectAdmission(profileId, bindingCurrent);
    expect(counter.counts.reads - readsBefore).toBeLessThanOrEqual(reads);
  }
  admission.request.mockClear();
  database.db
    .prepare("UPDATE user_profiles SET updated_at = ? WHERE id = ?")
    .run(9_007_199_254_740_993n, "person");
  expect(() => execute()).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
  expect(admission.request).not.toHaveBeenCalled();
});

it("refuses a worker preference update after the previously admitted profile is removed", async () => {
  addProfile();
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
