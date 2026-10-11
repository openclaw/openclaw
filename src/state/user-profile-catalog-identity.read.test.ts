import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withOpenClawStateReadOnlyLocation } from "./openclaw-state-db-read-connection.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { readUserProfileCatalogIdentity } from "./user-profile-catalog-identity.read.js";
import { setCanonicalUserProfileDisplayName } from "./user-profile-writes.js";
import { syncGitHubIdentity } from "./user-profile-writes.worker.js";

afterEach(() => vi.restoreAllMocks());

it("preserves the first scalar error and retires a later corrupt reader without further SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    syncGitHubIdentity({
      identity: { accountId: 501, login: "person" },
      authenticationAlias: { kind: "email", email: "person@example.test" },
    });
    const pathname = openOpenClawStateDatabase().path;
    const first = new RangeError("first profile conversion");
    const terminal = Object.assign(new Error("database disk image is malformed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 11,
    });
    let selected = 0;
    let wasClosed = () => false;
    const result = withOpenClawStateReadOnlyLocation(
      ({ db }) => {
        wasClosed = () => !db.isOpen;
        const prepare = db.prepare.bind(db);
        vi.spyOn(db, "prepare").mockImplementation((sql) => {
          if (sql.includes('from "user_profiles"')) {
            selected++;
            throw selected < 3 ? first : terminal;
          }
          return prepare(sql);
        });
        return readUserProfileCatalogIdentity(db, {
          kind: "source",
          profileIds: ["first", "second", "third"],
        });
      },
      pathname,
      pathname,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(result.profiles.get("first")).toMatchObject({ ok: false, message: first.message });
    for (const id of ["second", "third"]) {
      expect(result.profiles.get(id)).toMatchObject({ ok: false, message: terminal.message });
    }
    expect(selected).toBe(3);
    expect(wasClosed()).toBe(true);
  });
});

it("invalidates retained cohorts after worker commits and rollback without freshness probes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = syncGitHubIdentity({
      identity: { accountId: 301, login: "person", name: "Original" },
      authenticationAlias: { kind: "email", email: "person@example.test" },
    });
    const database = openOpenClawStateDatabase();
    const input = { kind: "source", profileIds: [profile.id, "missing"] } as const;
    const read = () =>
      runSqliteReadOperationSync(database.db, () =>
        readUserProfileCatalogIdentity(database.db, input),
      );
    const counter = trackSqliteStatementExecutions(
      database.db,
      ["profiles", "identities", "freshness"],
      (sql) =>
        /data_version/iu.test(sql)
          ? "freshness"
          : /\bfrom\s+"?user_profile_identities\b/i.test(sql)
            ? "identities"
            : /\bfrom\s+"?user_profiles\b/i.test(sql)
              ? "profiles"
              : null,
    );
    try {
      expect(read().profiles.get(profile.id)).toMatchObject({
        ok: true,
        facts: { profile: { displayName: "Original" } },
      });
      expect(read().profiles.get("missing")).toMatchObject({
        ok: true,
        facts: { profileId: "missing", profile: undefined },
      });
      expect(counter.counts).toEqual({ profiles: 1, identities: 1, freshness: 0 });
      await setCanonicalUserProfileDisplayName(profile.id, "Worker update");
      expect(read().profiles.get(profile.id)).toMatchObject({
        ok: true,
        facts: { profile: { displayName: "Worker update" } },
      });
      expect(counter.counts).toEqual({ profiles: 2, identities: 2, freshness: 0 });
      database.db.exec("BEGIN");
      try {
        database.db
          .prepare("UPDATE user_profiles SET display_name = ? WHERE id = ?")
          .run("Pending", profile.id);
        expect(read().profiles.get(profile.id)).toMatchObject({
          ok: true,
          facts: { profile: { displayName: "Pending" } },
        });
      } finally {
        database.db.exec("ROLLBACK");
      }
      expect(read().profiles.get(profile.id)).toMatchObject({
        ok: true,
        facts: { profile: { displayName: "Worker update" } },
      });
    } finally {
      counter.restore();
    }
  });
});

it("does not replay terminal cohort corruption as scalar profile reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = syncGitHubIdentity({
      identity: { accountId: 401, login: "person" },
      authenticationAlias: { kind: "email", email: "person@example.test" },
    });
    const { db } = openOpenClawStateDatabase();
    const prepare = db.prepare.bind(db);
    const corruption = Object.assign(new Error("database disk image is malformed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 11,
    });
    const failure = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.includes('from "user_profiles"')) {
        throw corruption;
      }
      return prepare(sql);
    });
    expect(() =>
      runSqliteReadOperationSync(db, () =>
        readUserProfileCatalogIdentity(db, {
          kind: "source",
          profileIds: [profile.id, "missing"],
        }),
      ),
    ).toThrow(corruption);
    expect(failure.mock.calls.filter(([sql]) => sql.includes('from "user_profiles"'))).toHaveLength(
      1,
    );
  });
});
