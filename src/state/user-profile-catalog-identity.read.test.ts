import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { readUserProfileCatalogIdentity } from "./user-profile-catalog-identity.read.js";
import { setCanonicalUserProfileDisplayName } from "./user-profile-writes.js";
import { syncGitHubIdentity } from "./user-profile-writes.worker.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const profile = syncGitHubIdentity({
    identity: { accountId: 301, login: "person", name: "Original" },
    authenticationAlias: { kind: "email", email: "person@example.test" },
  });
  const { db } = openOpenClawStateDatabase();
  const read = () =>
    runSqliteReadOperationSync(db, () =>
      readUserProfileCatalogIdentity(db, { kind: "source", profileIds: [profile.id, "missing"] }),
    );
  return { profile, db, read, sqlite: requireNativeSqliteDatabase(db) };
}

it("invalidates retained cohorts after worker commits and rollback without freshness probes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profile, db, read, sqlite } = fixture();
    const expectName = (displayName: string) =>
      expect(read().profiles.get(profile.id)).toMatchObject({
        ok: true,
        facts: { profile: { displayName } },
      });
    const queries = [
      ["freshness", /data_version/iu],
      ["identities", /\bfrom\s+"?user_profile_identities\b/i],
      ["profiles", /\bfrom\s+"?user_profiles\b/i],
    ] as const;
    const counter = trackSqliteStatementExecutions(
      sqlite,
      ["profiles", "identities", "freshness"],
      (sql) => queries.find(([, pattern]) => pattern.test(sql))?.[0] ?? null,
    );
    try {
      expectName("Original");
      expect(read().profiles.get("missing")).toMatchObject({
        ok: true,
        facts: { profileId: "missing", profile: undefined },
      });
      expect(counter.counts).toEqual({ profiles: 1, identities: 1, freshness: 0 });
      await setCanonicalUserProfileDisplayName(profile.id, "Worker update");
      expectName("Worker update");
      expect(counter.counts).toEqual({ profiles: 2, identities: 2, freshness: 0 });
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE user_profiles SET display_name = ? WHERE id = ?").run(
          "Pending",
          profile.id,
        );
        expectName("Pending");
      } finally {
        db.exec("ROLLBACK");
      }
      expectName("Worker update");
    } finally {
      counter.restore();
    }
  });
});

it("does not replay terminal cohort corruption as scalar profile reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { read, sqlite } = fixture();
    const prepare = sqlite.prepare.bind(sqlite);
    const corruption = Object.assign(new Error("database disk image is malformed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 11,
    });
    const failure = vi.spyOn(sqlite, "prepare").mockImplementation((sql) => {
      if (sql.includes('from "user_profiles"')) {
        throw corruption;
      }
      return prepare(sql);
    });
    expect(read).toThrow(corruption);
    expect(failure.mock.calls.filter(([sql]) => sql.includes('from "user_profiles"'))).toHaveLength(
      1,
    );
  });
});
