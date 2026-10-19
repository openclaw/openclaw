import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { enableNodeSqliteKyselyStatementCache } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase as openDatabase } from "../../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import {
  linkEmail,
  setAvatar,
  setUserProfileRole,
} from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { SkillLibraryError } from "../skill-library-error.js";
import { skillLibraryReadOperations } from "./read.kernel.js";
import {
  assertPreparedSkillLibrarySelection as assertSelection,
  changeSkillLibrarySelection as changeSelection,
  prepareSkillLibrarySelection as prepareSelection,
  prepareSkillLibrarySession as prepareSession,
  readSelectedSkillLibraryFiles as readFiles,
  seedSkillLibrarySelection as seed,
} from "./selection.js";
import {
  listSkillLibrary as list,
  mutateSkillLibrary as mutate,
  resolveSkillLibraryPresentation as presentation,
  saveSkillLibrary as save,
} from "./service.js";
import { draft, useSkillLibraryFixture } from "./service.test-support.js";
import { projectSkillLibraryList, type SkillLibraryAuthority } from "./store.js";

const { fixture, tempDirs } = useSkillLibraryFixture();

function withSql<T>(run: (sql: ReturnType<typeof observeHostDataSql>) => T): T {
  const sql = observeHostDataSql();
  try {
    return run(sql);
  } finally {
    sql.restore();
  }
}
const readLibrary = skillLibraryReadOperations["skillLibrary.read"];

const writerConfig: ReturnType<SkillLibraryAuthority["getConfig"]> = {
  gateway: {
    roles: {
      default: "writer",
      definitions: {
        writer: {
          sessions: { others: "none" },
          agents: "*",
          scopes: ["operator.read", "operator.write"],
        },
        blocked: { sessions: { others: "none" }, agents: [], scopes: [] },
      },
    },
  },
};

it("reuses library facts until a library or profile writer changes their inputs", async () => {
  const { options, alice, admin } = fixture();
  const saved = await save(alice, draft(), options);
  using reads = vi.spyOn(stateRead, "executeExistingOpenClawStateRead");
  const first = await seed(alice, options);
  expect(first).toHaveLength(1);
  const count = reads.mock.calls.length;
  first[0]!.name = "caller mutation";
  expect(await seed(alice, options)).toEqual([
    {
      skillId: saved.entry.skillId,
      revision: saved.entry.revision,
      name: saved.entry.name,
      ownerProfileId: saved.entry.ownerProfileId,
    },
  ]);
  expect(reads.mock.calls).toHaveLength(count);

  await mutate(
    alice,
    { action: "disable", skillId: saved.entry.skillId, expectedRevision: saved.entry.revision },
    options,
  );
  expect(await seed(alice, options)).toEqual([]);
  expect(await presentation(admin, options)).toMatchObject({
    multipleProfiles: false,
    defaultTarget: "workspace",
  });
  ensureProfileForEmail("new-person@example.test", options);
  expect(await presentation(admin, options)).toMatchObject({
    multipleProfiles: true,
    defaultTarget: "personal",
  });
});

it("projects shared-owner catalogs with bounded SQL and skips disabled seed rows", async () => {
  const { options, alice } = fixture();
  const saved = await save(alice, draft(), options);
  const { db } = openDatabase(options);
  expect(setAvatar(alice.profileId!, Buffer.alloc(80 * 1024), "image/png", options).ok).toBe(true);
  const entry = db.prepare(`INSERT INTO skill_library_entries
      SELECT ?, owner_profile_id, author_profile_id, ?, current_revision, shared, enabled,
        removed, created_at, updated_at FROM skill_library_entries WHERE skill_id = ?`);
  const revision = db.prepare(`INSERT INTO skill_library_revisions
      SELECT ?, revision, description, files_json, created_at
      FROM skill_library_revisions WHERE skill_id = ?`);
  db.exec("BEGIN");
  for (let index = 1; index < 100; index++) {
    const id = `catalog-${index}`;
    entry.run(id, id, saved.entry.skillId);
    revision.run(id, saved.entry.skillId);
  }
  db.exec("COMMIT");
  using reader = openNodeSqliteDatabase(options.path, { readOnly: true });
  enableNodeSqliteKyselyStatementCache(reader);
  admitSqliteSchema(reader);
  const measure = (
    kind: "list" | "seed" | "session",
    profileId = alice.profileId,
    config: ReturnType<SkillLibraryAuthority["getConfig"]> = {},
  ) => {
    const sql = trackSqliteStatementExecutions(reader, ["entries", "profiles", "other"], (query) =>
      /from "skill_library_entries"/i.test(query)
        ? "entries"
        : /from "user_profiles"/i.test(query)
          ? "profiles"
          : "other",
    );
    try {
      const result = readLibrary(
        {
          ...(kind === "list"
            ? { kind, params: {} }
            : kind === "session"
              ? {
                  kind,
                  params: undefined,
                  sessionFacts: {
                    profile: { id: alice.profileId!, role: null, githubLogin: null },
                    multipleProfiles: false,
                  },
                }
              : { kind, params: undefined }),
          authority: { profileId, scopes: alice.scopes, config },
        },
        reader,
      );
      return {
        result,
        counts: sql.counts,
        entryRows: sql.rowCounts.entries,
        blobs: sql.blobBytes.entries + sql.blobBytes.profiles + sql.blobBytes.other,
      };
    } finally {
      sql.restore();
    }
  };
  const listed = measure("list");
  assert.equal(listed.result.kind, "list");
  expect(listed.result.value.profileId).toBe(alice.profileId);
  expect(listed.result.value.entries.map((item) => item.skillId).toSorted()).toEqual(
    [
      saved.entry.skillId,
      ...Array.from({ length: 99 }, (_, index) => `catalog-${index + 1}`),
    ].toSorted(),
  );
  expect(listed.counts).toEqual({ entries: 1, profiles: 3, other: 0 });
  expect.soft(listed.blobs).toBe(0);
  const session = measure("session");
  expect(session.result).toMatchObject({
    kind: "session",
    value: {
      selections: expect.any(Array),
      presentation: { profileId: alice.profileId, defaultTarget: "personal" },
    },
  });
  assert.equal(session.result.kind, "session");
  expect(session.result.value.selections).toHaveLength(64);
  expect(session.counts).toEqual({ entries: 1, profiles: 1, other: 0 });
  expect(session.blobs).toBe(0);
  expect(listed.result.value.entries.find((item) => item.skillId === saved.entry.skillId)).toEqual(
    saved.entry,
  );
  const alias = ensureProfileForEmail("alias@example.test", options);
  linkEmail("alias@example.test", alice.profileId!, options);
  const merged = measure("list", alias.id, writerConfig);
  expect(merged.result).toMatchObject({
    kind: "list",
    value: { profileId: alice.profileId, entries: listed.result.value.entries },
  });
  // Together with the canonical read's three profile queries, this retains the seven-query bound.
  expect(merged.counts).toEqual({ entries: 1, profiles: 4, other: 0 });
  expect(merged.blobs).toBe(0);
  setUserProfileRole(alice.profileId!, "blocked", options);
  const blocked = measure("list", alias.id, writerConfig);
  expect(blocked.result).toMatchObject({ value: { profileId: alice.profileId, entries: [] } });
  expect(blocked.blobs).toBe(0);
  setUserProfileRole(alice.profileId!, null, options);
  const insertOwner =
    db.prepare(`INSERT INTO user_profiles (id, display_name, created_at, updated_at)
      VALUES (?, ?, 0, 0)`);
  const changeOwner = db.prepare(
    "UPDATE skill_library_entries SET owner_profile_id = ?, shared = 1 WHERE skill_id = ?",
  );
  db.exec("BEGIN");
  for (let index = 0; index < 501; index++) {
    const id = index === 0 ? saved.entry.skillId : `catalog-${index}`;
    if (index >= 100) {
      entry.run(id, id, saved.entry.skillId);
      revision.run(id, saved.entry.skillId);
    }
    insertOwner.run(`owner-${index}`, `Owner ${index}`);
    changeOwner.run(`owner-${index}`, id);
  }
  db.prepare("UPDATE user_profiles SET merged_into = ? WHERE id = 'owner-0'").run(alice.profileId!);
  db.exec(`UPDATE user_profiles SET merged_into = 'owner-2' WHERE id = 'owner-1';
      UPDATE user_profiles SET merged_into = 'owner-3' WHERE id = 'owner-2';
      UPDATE user_profiles SET merged_into = 'missing-target' WHERE id = 'owner-4';
      UPDATE skill_library_entries SET owner_profile_id = 'missing-owner' WHERE skill_id = 'catalog-5'`);
  db.exec("COMMIT");
  const cohorts = measure("list");
  expect(cohorts.counts).toEqual({ entries: 1, profiles: 5, other: 0 });
  expect(cohorts.blobs).toBe(0);
  assert.equal(cohorts.result.kind, "list");
  expect(cohorts.result.value.entries).toHaveLength(501);
  expect(cohorts.result.value.defaultSelectionNotice).toContain("detach");
  const mine = projectSkillLibraryList(cohorts.result.value, { scope: "mine" });
  expect(mine.entries).toEqual([
    expect.objectContaining({ skillId: saved.entry.skillId, ownerProfileId: alice.profileId }),
  ]);
  expect(mine.defaultSelectionNotice).toBeUndefined();
  for (const [id, expected] of [
    [saved.entry.skillId, { ownerProfileId: alice.profileId, canEdit: true }],
    ["catalog-1", { ownerProfileId: "owner-2", ownerLabel: "Owner 3", canEdit: false }],
    ["catalog-4", { ownerProfileId: "owner-4", ownerLabel: "Owner 4" }],
    ["catalog-5", { ownerProfileId: "missing-owner", ownerLabel: "missing-owner" }],
  ] as const) {
    expect(cohorts.result.value.entries.find((item) => item.skillId === id)).toMatchObject(
      expected,
    );
  }
  db.exec("UPDATE skill_library_entries SET enabled = 0");
  const seeded = measure("seed");
  expect(seeded.result).toMatchObject({ kind: "seed", value: [] });
  expect.soft(seeded.entryRows).toBe(0);
  expect.soft(seeded.blobs).toBe(0);
  expect(measure("list").entryRows).toBe(501);
  expect(seeded.counts).toEqual({ entries: 1, profiles: 1, other: 0 });
});

it("keeps solo defaults, counts aliases once, and never creates library tables on discovery", async () => {
  const { options, admin, alice, actor } = fixture();
  expect(await list(admin, {}, options)).toMatchObject({
    defaultTarget: "workspace",
    multipleProfiles: false,
    entries: [],
  });
  expect((await list(actor(undefined, true), {}, options)).defaultTarget).toBe("workspace");
  expect((await list(alice, {}, options)).defaultTarget).toBe("personal");
  expect(await seed(alice, options)).toEqual([]);
  expect(tableExists(openDatabase(options).db, "skill_library_entries")).toBe(false);
  linkEmail("alice-alias@example.test", alice.profileId!, options);
  expect((await list(admin, {}, options)).multipleProfiles).toBe(false);
  ensureProfileForEmail("bob@example.test", options);
  expect(await list(admin, {}, options)).toMatchObject({
    defaultTarget: "personal",
    multipleProfiles: true,
  });
});

it("seeds no skills without creating a missing shared store", async () => {
  const { alice } = fixture();
  const stateDir = tempDirs.make("skill-library-missing-");
  const options = {
    path: path.join(stateDir, "state", "openclaw.sqlite"),
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
  const pins = await seed(alice, options);
  expect(pins).toEqual([]);
  expect(() => assertSelection(pins)).not.toThrow();
  expect(fs.existsSync(options.path)).toBe(false);
});

it("skips empty-session SQL and refreshes committed profile and library facts", async () => {
  const { options, alice, admin } = fixture();
  admin.getConfig = () => ({
    gateway: {
      roles: {
        default: "administrator",
        definitions: {
          administrator: {
            scopes: ["operator.admin"],
            agents: "*",
            sessions: { others: "view" },
          },
          reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "view" } },
        },
      },
    },
  });
  onTestFinished((await prepareUserProfileCatalog(options)).release);
  const { db } = openDatabase(options);
  using reads = vi.spyOn(stateRead, "executeExistingOpenClawStateRead");
  const before = await prepareSession(admin, options);
  const request = reads.mock.calls.find(([, command]) => command.type === "skillLibrary.read")?.[1];
  reads.mockRestore();
  expect(before.selections).toEqual([]);
  expect(before.presentation).toMatchObject({
    profileId: alice.profileId,
    multipleProfiles: false,
    defaultTarget: "workspace",
    canManageWorkspace: true,
  });
  if (request?.type !== "skillLibrary.read") {
    throw new Error("Expected the cold session read");
  }
  withSql((sql) => {
    expect(readLibrary(request.input, db)).toMatchObject({
      kind: "session",
      value: { selections: [], presentation: before.presentation },
    });
    expect(
      readLibrary({ kind: "seed", params: undefined, authority: request.input.authority }, db),
    ).toMatchObject({ kind: "seed", value: [] });
    expect(sql.queries).toEqual([]);
  });
  ensureProfileForEmail("second@example.test", options);
  expect((await prepareSession(admin, options)).presentation).toMatchObject({
    multipleProfiles: true,
    defaultTarget: "personal",
    canManageWorkspace: true,
  });
  setUserProfileRole(alice.profileId!, "reader", options);
  expect(() => before.assertCurrent()).toThrow(SkillLibraryError);
  expect((await prepareSession(admin, options)).presentation).toMatchObject({
    defaultTarget: "personal",
    canManageWorkspace: false,
  });
  const empty = await prepareSession(alice, options);
  const saved = await save(alice, draft(), options);
  expect(() => empty.assertCurrent()).toThrow(SkillLibraryError);
  expect(() => assertSelection(empty.selections)).toThrow(SkillLibraryError);
  const after = await prepareSession(alice, options);
  expect(after.selections).toEqual([expect.objectContaining({ skillId: saved.entry.skillId })]);
  expect(after.presentation).toMatchObject({
    profileId: alice.profileId,
    defaultTarget: "personal",
  });
});

it.each(["unshare", "disable", "remove", "role", "alias"] as const)(
  "revokes a prepared seed after %s while committed pins keep working",
  async (change) => {
    const { alice, actor, options } = fixture();
    const bob: SkillLibraryAuthority = {
      ...actor(ensureProfileForEmail("bob@example.test", options).id),
      getConfig: () => writerConfig,
    };
    const mergeTarget =
      change === "alias" ? ensureProfileForEmail("target@example.test", options) : undefined;
    if (mergeTarget) {
      setUserProfileRole(mergeTarget.id, "blocked", options);
    }
    onTestFinished((await prepareUserProfileCatalog(options)).release);
    const saved = await save(alice, draft(), options);
    await mutate(
      alice,
      { action: "share", skillId: saved.entry.skillId, expectedRevision: saved.entry.revision },
      options,
    );
    const prepared = await prepareSession(bob, options);
    const freshSeed = prepared.selections;
    expect(freshSeed).toHaveLength(1);
    const durablePins = structuredClone(freshSeed);
    if (change === "role") {
      setUserProfileRole(bob.profileId!, "blocked", options);
    } else if (change === "alias") {
      linkEmail("bob@example.test", mergeTarget!.id, options);
    } else {
      await mutate(
        alice,
        { action: change, skillId: saved.entry.skillId, expectedRevision: saved.entry.revision },
        options,
      );
    }
    withSql((sql) => {
      expect(() => assertSelection(freshSeed)).toThrow(SkillLibraryError);
      expect(() => prepared.assertCurrent()).toThrow(SkillLibraryError);
      expect(() => assertSelection(durablePins)).not.toThrow();
      expect(sql.queries).toEqual([]);
    });
    expect(await prepareSelection(durablePins, options, () => {})).toHaveLength(1);
    expect(await readFiles(durablePins[0]!, options)).toContainEqual(
      expect.objectContaining({ path: "SKILL.md" }),
    );
  },
);

it("preserves a prepared seed when worker commit admission rolls back the mutation", async () => {
  const { alice, options } = fixture();
  const saved = await save(alice, draft(), options);
  const pins = await seed(alice, options);
  await expect(
    save(
      alice,
      { ...draft(), skillId: saved.entry.skillId, expectedRevision: saved.entry.revision },
      options,
    ),
  ).resolves.toMatchObject({ state: "unchanged" });
  expect(() => assertSelection(pins)).not.toThrow();
  const rollback = new Error("rollback library change");
  let checkedCommit = false;
  const refusal = probe.admission(workerAdmission, (request, grant, admit) => {
    admit(
      request,
      request.stage === "commit" && request.facts !== undefined
        ? () => {
            checkedCommit = true;
            expect(() => assertSelection(pins)).toThrow(SkillLibraryError);
            throw rollback;
          }
        : grant,
    );
  });
  try {
    await expect(
      mutate(
        alice,
        {
          action: "disable",
          skillId: saved.entry.skillId,
          expectedRevision: saved.entry.revision,
        },
        options,
      ),
    ).rejects.toThrow(rollback);
  } finally {
    refusal.mockRestore();
  }
  expect(checkedCommit).toBe(true);
  expect(() => assertSelection(pins)).not.toThrow();
  expect(await seed(alice, options)).toEqual(pins);
});

it("revokes a prepared seed after a lost worker receipt without replaying the mutation", async () => {
  const { alice, options } = fixture();
  const saved = await save(alice, draft(), options);
  const pins = await seed(alice, options);
  const failed = new SqliteWorkerError("native commit outcome unavailable", "outcome-unknown");
  const original = workerStore.runSqliteWorkerStoreOperation;
  let executed = 0;
  let admission: workerAdmission.SqliteWorkerOperationAdmission | undefined;
  const lostReceipt = createDeferredCore();
  let receiptFault: { mockRestore(): void } | undefined;
  const delivery = vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        target: SqliteWorkerStore<Operations>,
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof original>[2],
        assertCurrent?: Parameters<typeof original>[3],
        createAdmission?: Parameters<typeof original>[4],
      ) =>
        original(
          target,
          (worker) =>
            operation({
              execute: async (command, operationOptions) => {
                if (command.type !== "skillLibrary.mutate") {
                  return worker.execute(command, operationOptions);
                }
                try {
                  await worker.execute(command, operationOptions);
                  executed++;
                  expect(admission?.committed).toMatchObject({
                    facts: { entry: { enabled: false } },
                  });
                  if (!admission) {
                    throw new Error("Expected worker mutation admission");
                  }
                  receiptFault = vi.spyOn(admission, "committed", "get").mockReturnValue(undefined);
                  throw failed;
                } finally {
                  lostReceipt.resolve();
                }
              },
            }),
          stateContext,
          assertCurrent,
          createAdmission &&
            ((retained) => {
              const admitted = createAdmission({
                settled: retained.settled.then(async () => {
                  await lostReceipt.promise;
                  return { kind: "unknown" as const, error: failed };
                }),
              });
              admission = admitted.admission;
              return admitted;
            }),
        ),
    );
  try {
    await expect(
      mutate(
        alice,
        {
          action: "disable",
          skillId: saved.entry.skillId,
          expectedRevision: saved.entry.revision,
        },
        options,
      ),
    ).rejects.toThrow(failed);
  } finally {
    lostReceipt.resolve();
    receiptFault?.mockRestore();
    delivery.mockRestore();
  }
  expect(executed).toBe(1);
  expect(() => assertSelection(pins)).toThrow();
  expect((await list(alice, {}, options)).entries[0]?.enabled).toBe(false);
  expect(
    openDatabase(options)
      .db.prepare("SELECT COUNT(*) AS count FROM skill_library_events WHERE action = 'disable'")
      .get(),
  ).toMatchObject({ count: 1 });
});

it.each(["seed", "attach"] as const)(
  "rejects edited %s pins before admission without caller-thread SQL",
  async (source) => {
    const { alice, options } = fixture();
    const saved = await save(alice, draft(), options);
    const pins =
      source === "seed"
        ? await seed(alice, options)
        : await changeSelection(
            alice,
            [],
            { action: "attach", sessionKey: "session", skillId: saved.entry.skillId },
            options,
          );
    expect(pins).toHaveLength(1);
    pins[0]!.revision = "0".repeat(64);
    withSql((sql) => {
      expect(() => assertSelection(pins)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(sql.queries).toEqual([]);
    });
  },
);
