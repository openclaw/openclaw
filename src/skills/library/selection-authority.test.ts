import assert from "node:assert/strict";
import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { sqliteFamilyHashes as familyHashes } from "../../../test/helpers/sqlite-family-hashes.js";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { declareAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import { enableNodeSqliteKyselyStatementCache } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync as closeDatabase,
  openOpenClawStateDatabase as openDatabase,
} from "../../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import {
  linkEmail,
  setAvatar,
  setUserProfileRole,
} from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { materializeSkill } from "../loading/skill-materializer.js";
import {
  materializeSkillResources,
  prepareSkillResourceDelivery as deliver,
} from "../runtime/resources.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type { SkillSnapshot } from "../types.js";
import {
  decodeSkillLibraryFile as decodeFile,
  prepareSkillLibraryBundle,
  skillLibraryRevisionDir,
} from "./bundle.js";
import * as bundles from "./bundle.js";
import { skillLibraryReadOperations } from "./read.kernel.js";
import * as selectionReads from "./selection-read.js";
import * as selection from "./selection.js";
import {
  assertPreparedSkillLibrarySelection as assertSelection,
  loadSkillLibrarySelection as loadSelection,
  prepareSkillLibrarySelection as prepareSelection,
  prepareSkillLibrarySession as prepareSession,
  readSelectedSkillLibraryFiles as readFiles,
} from "./selection.js";
import { saveSkillLibrary } from "./service.js";
import {
  content,
  draft,
  expectCode,
  expectSingleWinner,
  libraryPin,
  useSkillLibraryFixture,
  zipBytes,
} from "./service.test-support.js";
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

function role(
  scopes: GatewayOperatorRoleDefinition["scopes"],
  others: "none" | "view" = "none",
  agents: "*" | string[] = "*",
) {
  return { scopes, sessions: { others }, agents };
}

const roleConfig = (defaultRole: string, definitions: Record<string, ReturnType<typeof role>>) => ({
  gateway: { roles: { default: defaultRole, definitions } },
});
const writerConfig = roleConfig("writer", {
  writer: role(["operator.read", "operator.write"]),
  blocked: role([], "none", []),
});

it("projects shared-owner catalogs with bounded SQL and skips disabled seed rows", async () => {
  const { options, alice, lib } = fixture();
  const saved = await lib.save();
  const { db } = openDatabase(options);
  expect(setAvatar(alice.profileId!, Buffer.alloc(80 * 1024), "image/png", options).ok).toBe(true);
  const entry = db.prepare(`INSERT INTO skill_library_entries
      SELECT ?, owner_profile_id, author_profile_id, ?, current_revision, shared, enabled,
        removed, created_at, updated_at FROM skill_library_entries WHERE skill_id = ?`);
  const revision = db.prepare(`INSERT INTO skill_library_revisions
      SELECT ?, revision, description, files_json, created_at
      FROM skill_library_revisions WHERE skill_id = ?`);
  const ids = [saved.entry.skillId];
  db.exec("BEGIN");
  for (let index = 1; index < 100; index++) {
    const id = `catalog-${index}`;
    ids.push(id);
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
  const expectCost = (measured: ReturnType<typeof measure>, profiles: number) => {
    expect(measured.counts).toEqual({ entries: 1, profiles, other: 0 });
    expect(measured.blobs).toBe(0);
  };
  const listed = measure("list");
  assert.equal(listed.result.kind, "list");
  expect(listed.result.value.profileId).toBe(alice.profileId);
  expect(listed.result.value.entries.map((item) => item.skillId).toSorted()).toEqual(
    ids.toSorted(),
  );
  expectCost(listed, 3);
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
  expectCost(session, 1);
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
  expectCost(merged, 4);
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
  expectCost(cohorts, 5);
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
  expect(measure("list").entryRows).toBe(501);
  expectCost(seeded, 1);
});

it("keeps solo defaults, counts aliases once, and never creates library tables on discovery", async () => {
  const { options, admin, alice, actor, lib } = fixture();
  expect(await lib.list(admin)).toMatchObject({
    defaultTarget: "workspace",
    multipleProfiles: false,
    entries: [],
  });
  expect((await lib.list(actor(undefined, true))).defaultTarget).toBe("workspace");
  expect((await lib.list()).defaultTarget).toBe("personal");
  expect(await lib.seed()).toEqual([]);
  expect(tableExists(openDatabase(options).db, "skill_library_entries")).toBe(false);
  linkEmail("alice-alias@example.test", alice.profileId!, options);
  expect((await lib.list(admin)).multipleProfiles).toBe(false);
  ensureProfileForEmail("bob@example.test", options);
  expect(await lib.list(admin)).toMatchObject({
    defaultTarget: "personal",
    multipleProfiles: true,
  });
});

it("skips empty-session SQL and refreshes committed profile and library facts", async () => {
  const { options, alice, admin, lib } = fixture();
  admin.getConfig = () => ({
    gateway: {
      roles: {
        default: "administrator",
        definitions: {
          administrator: role(["operator.admin"], "view"),
          reader: role(["operator.read"], "view"),
        },
      },
    },
  });
  onTestFinished((await prepareUserProfileCatalog(options)).release);
  const { db } = openDatabase(options);
  using reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
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
  const saved = await lib.save();
  expect(() => empty.assertCurrent()).toThrow(SkillLibraryError);
  expect(() => assertSelection(empty.selections)).toThrow(SkillLibraryError);
  const after = await prepareSession(alice, options);
  expect(after.selections).toEqual([expect.objectContaining({ skillId: saved.entry.skillId })]);
  expect(after.presentation).toMatchObject({
    profileId: alice.profileId,
    defaultTarget: "personal",
  });
  const seed = await lib.seed();
  seed[0]!.name = "caller mutation";
  expect(() => assertSelection(seed)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  expect(await lib.seed()).toEqual([libraryPin(saved.entry)]);
  await lib.change(saved.entry, "disable");
  expect(await lib.seed()).toEqual([]);
});

it.each(["unshare", "disable", "remove", "role", "alias"] as const)(
  "revokes a prepared seed after %s while committed pins keep working",
  async (change) => {
    const { actor, options, lib } = fixture();
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
    const saved = await lib.save();
    await lib.change(saved.entry, "share");
    const prepared = await prepareSession(bob, options);
    const freshSeed = prepared.selections;
    expect(freshSeed).toHaveLength(1);
    const durablePins = structuredClone(freshSeed);
    if (change === "role") {
      setUserProfileRole(bob.profileId!, "blocked", options);
    } else if (change === "alias") {
      linkEmail("bob@example.test", mergeTarget!.id, options);
    } else {
      await lib.change(saved.entry, change);
    }
    expect(() => assertSelection(freshSeed)).toThrow(SkillLibraryError);
    expect(() => prepared.assertCurrent()).toThrow(SkillLibraryError);
    expect(() => assertSelection(durablePins)).not.toThrow();
    expect(await prepareSelection(durablePins, options, () => {})).toHaveLength(1);
    expect(await readFiles(durablePins[0]!, options)).toContainEqual(
      expect.objectContaining({ path: "SKILL.md" }),
    );
  },
);

it("preserves a prepared seed when worker commit admission rolls back the mutation", async () => {
  const { lib } = fixture();
  const saved = await lib.save();
  const pins = await lib.seed();
  await expect(lib.revise(saved.entry, content)).resolves.toMatchObject({ state: "unchanged" });
  expect(() => assertSelection(pins)).not.toThrow();
  const rollback = new Error("rollback library change");
  const refusal = probe.admission(workerAdmission, (request, grant, admit) => {
    admit(
      request,
      request.stage === "commit" && request.facts !== undefined
        ? () => {
            expect(() => assertSelection(pins)).toThrow(SkillLibraryError);
            throw rollback;
          }
        : grant,
    );
  });
  try {
    await expect(lib.change(saved.entry, "disable")).rejects.toThrow(rollback);
  } finally {
    refusal.mockRestore();
  }
  expect(() => assertSelection(pins)).not.toThrow();
  expect(await lib.seed()).toEqual(pins);
});

it("revokes a prepared seed after a lost worker receipt without replaying the mutation", async () => {
  const { options, lib } = fixture();
  const saved = await lib.save();
  const pins = await lib.seed();
  const failed = new SqliteWorkerError("native commit outcome unavailable", "outcome-unknown");
  const original = workerStore.runSqliteWorkerStoreOperation;
  let admission: workerAdmission.SqliteWorkerOperationAdmission | undefined;
  const lostReceipt = createDeferredCore();
  let receiptFault: { mockRestore(): void } | undefined;
  const delivery = vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation((target, operation, stateContext, assertCurrent, createAdmission) =>
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
                assert.ok(admission);
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
    await expect(lib.change(saved.entry, "disable")).rejects.toThrow(failed);
  } finally {
    lostReceipt.resolve();
    receiptFault?.mockRestore();
    delivery.mockRestore();
  }
  expect(() => assertSelection(pins)).toThrow();
  expect((await lib.list()).entries[0]?.enabled).toBe(false);
  expect(
    openDatabase(options)
      .db.prepare("SELECT COUNT(*) AS count FROM skill_library_events WHERE action = 'disable'")
      .get(),
  ).toMatchObject({ count: 1 });
});

it("rejects edited attached pins before admission", async () => {
  const { lib } = fixture();
  const saved = await lib.save();
  const pins = await lib.select([], {
    action: "attach",
    sessionKey: "session",
    skillId: saved.entry.skillId,
  });
  expect(pins).toHaveLength(1);
  pins[0]!.revision = "0".repeat(64);
  expect(() => assertSelection(pins)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
});

it("saves, mutates, and settles an upload without caller-thread SQL", async () => {
  const { options, lib } = fixture();
  await openDatabase(options).walMaintenance.stop();
  const sql = observeHostDataSql();
  onTestFinished(() => sql.restore());
  const { skillId, revision } = (await lib.save()).entry;
  await lib.change({ skillId, revision }, "disable");
  const bytes = await zipBytes();
  const upload = await lib.begin(bytes, "uploaded");
  const chunk = () => lib.chunk(upload.uploadId, bytes);
  const chunks = await Promise.allSettled([chunk(), chunk()]);
  expectSingleWinner(chunks, "CONFLICT");
  await lib.commit(upload.uploadId);
  expect(sql.queries).toEqual([]);
});

it("publishes immutable files before SQL and retains them when the transaction fails", async () => {
  const { options, lib } = fixture();
  const { skillId, revision } = (await lib.save()).entry;
  const nextContent = `${content}\nUncommitted revision`;
  const next = { ...draft(), content: nextContent, skillId, expectedRevision: revision };
  const bundle = prepareSkillLibraryBundle([
    { path: "SKILL.md", content: nextContent },
    ...draft().files,
  ]);
  const directory = skillLibraryRevisionDir(skillId, bundle.revision, options.env);
  openDatabase(options).db.exec(`CREATE TRIGGER reject_library_revision
    BEFORE INSERT ON skill_library_revisions
    BEGIN SELECT RAISE(ABORT, 'publication transaction refused'); END;`);
  await expect(lib.save(next)).rejects.toThrow("publication transaction refused");
  expect(await asyncFs.readFile(path.join(directory, "SKILL.md"), "utf8")).toBe(nextContent);
  expect(await asyncFs.readdir(path.dirname(directory))).not.toContainEqual(
    expect.stringMatching(/^\.staging-/),
  );
  expect(await lib.read(skillId)).toMatchObject({
    content,
    entry: { revision },
    revisions: [{ revision }],
  });
});

it.each(["role", "alias", "upload expiry"])("rechecks %s after publish", async (change) => {
  const { alice, options, lib } = fixture();
  const blocked = ensureProfileForEmail("blocked@example.test", options);
  setUserProfileRole(blocked.id, "blocked", options);
  const authority: SkillLibraryAuthority = {
    ...alice,
    getConfig: () => writerConfig,
  };
  const bytes = change === "upload expiry" ? await zipBytes() : undefined;
  const upload = bytes ? await lib.begin(bytes, "expiring") : undefined;
  if (upload && bytes) {
    await lib.chunk(upload.uploadId, bytes);
  }
  const rename = asyncFs.rename;
  let changed = false;
  const barrier = vi.spyOn(asyncFs, "rename").mockImplementation(async (source, destination) => {
    await rename(source, destination);
    if (String(source).includes(".staging-") && !changed) {
      changed = true;
      if (upload) {
        openDatabase(options)
          .db.prepare("UPDATE skill_library_uploads SET expires_at = 1 WHERE upload_id = ?")
          .run(upload.uploadId);
      } else if (change === "role") {
        setUserProfileRole(alice.profileId!, "blocked", options);
      } else {
        linkEmail("alice@example.test", blocked.id, options);
      }
    }
  });
  try {
    await expect(
      upload ? lib.commit(upload.uploadId) : lib.save(draft(), authority),
    ).rejects.toMatchObject({
      code: upload ? "NOT_FOUND" : expect.stringMatching(/^(AUTHORITY_EXPIRED|FORBIDDEN)$/),
    });
    expect(changed).toBe(true);
  } finally {
    barrier.mockRestore();
  }
  expect((await lib.list()).entries).toEqual([]);
});

const noop = () => {};
const inRoot = <T>(root: string, run: () => Promise<T>) =>
  withEnvAsync({ OPENCLAW_STATE_DIR: root }, run);
const resourceContent =
  "---\nname: guide\ndescription: Saved procedure\n---\n# Guide\nRead references/data.bin.\n";
function snapshotFor(...pins: NonNullable<SkillSnapshot["librarySelections"]>): SkillSnapshot {
  return { prompt: "", skills: pins.map(({ name }) => ({ name })), librarySelections: pins };
}
const syntheticPin = (name: string) => ({
  skillId: name,
  revision: "0".repeat(64),
  name,
  ownerProfileId: null,
});
const resourceActor = (profileId: string) => ({
  profileId,
  scopes: ["operator.read", "operator.write"],
  getConfig: () => ({}),
  assertCurrent: noop,
});

async function resourceFixture() {
  onTestFinished(() => void vi.restoreAllMocks());
  const { stateDir: root, options, alice: authority, lib } = fixture();
  const saved = await lib.save({ ...draft(), content: resourceContent });
  const pin = libraryPin(saved.entry);
  await closeDatabase();
  return { root, options, authority, pin, snapshot: snapshotFor(pin), databasePath: options.path };
}

it.each(["ordinary", "artifact-preserving", "disposable"] as const)(
  "delivers cold and warm immutable pins without parent SQL under %s reads",
  async (mode) => {
    const { root, snapshot, pin, databasePath } = await resourceFixture();
    const before = familyHashes(databasePath);
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    const run = () =>
      inRoot(root, async () => {
        const first = await deliver(snapshot, noop);
        expect(first?.skills).toHaveLength(1);
        const skill = first!.skills[0]!;
        expect(skill.modelVisible).toBe(false);
        const bytes = (name: string) => decodeFile(skill.files.find((file) => file.path === name)!);
        expect(skill.revision).toBe(pin.revision);
        expect(bytes("SKILL.md").toString("utf8")).toBe(resourceContent);
        expect(bytes("references/data.bin")).toEqual(Buffer.from([0, 255, 128]));
        // The synchronous caller must reuse the same cache key as async preparation.
        expect(loadSelection([pin])[0]?.skill.name).toBe(pin.name);
        expect(await deliver(structuredClone(snapshot), noop)).toEqual(first);
        if (mode === "ordinary") {
          const selectedSnapshot = {
            ...snapshot,
            resolvedSkills: loadSelection([pin]).map((entry) => entry.skill),
            version: 1,
          };
          const remoteWorkspace = path.join(root, "remote-workspace");
          declareAgentWorkspaceAccess(remoteWorkspace);
          const selectedDelivery = await deliver(selectedSnapshot, noop, [], remoteWorkspace);
          expect(selectedDelivery).toEqual({
            ...first,
            skills: [{ ...skill, modelVisible: true }],
          });
          const materialized = await materializeSkillResources(selectedDelivery!, noop);
          try {
            const local = materialized.snapshot.resolvedSkills![0]!;
            expect(await fs.promises.readFile(local.filePath, "utf8")).toBe(resourceContent);
            expect(
              await fs.promises.readFile(path.join(local.baseDir, "references/data.bin")),
            ).toEqual(Buffer.from([0, 255, 128]));
            expect(materialized.snapshot.prompt).toContain(local.filePath);
            expect(materialized.snapshot.prompt).not.toContain(
              path.dirname(selectedSnapshot.resolvedSkills[0]!.filePath),
            );
          } finally {
            await materialized.cleanup();
          }
        }
        await closeDatabase();
      });
    try {
      if (mode === "artifact-preserving") {
        await stateReads.withArtifactPreservingStateReads(run);
      } else if (mode === "disposable") {
        await stateReads.withArtifactPreservingStateReads(() =>
          stateReads.withDisposableOpenClawStateReads(databasePath, run),
        );
      } else {
        await run();
      }
      sql.expectIdle();
      if (mode === "artifact-preserving") {
        expect(familyHashes(databasePath)).toEqual(before);
      }
    } finally {
      sql.restore();
    }
  },
);

it("reads both phases from the active snapshot without fetching hidden manifests", async () => {
  const { root, options, authority, pin, snapshot } = await resourceFixture();
  const hidden = await saveSkillLibrary(
    authority,
    { slug: "hidden", content: resourceContent.replace("guide", "hidden"), expectedRevision: null },
    options,
  );
  snapshot.librarySelections!.push(libraryPin(hidden.entry));
  await closeDatabase();
  const execute = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  await inRoot(root, () =>
    stateReads.withOpenClawStateDatabaseReadSnapshot(async () => {
      const database = openDatabase(options);
      database.db
        .prepare(
          "UPDATE skill_library_revisions SET description = ?, files_json = ? WHERE skill_id = ?",
        )
        .run("Later live description", "invalid live manifest", pin.skillId);
      const delivery = await deliver(snapshot, noop);
      expect(delivery?.skills).toEqual([
        expect.objectContaining({ description: "Saved procedure", revision: pin.revision }),
      ]);
      const manifests = execute.mock.calls
        .map(([, command]) => command)
        .find((command) => command.type === "skills.library.manifests");
      expect(manifests?.input).toEqual([{ skillId: pin.skillId, revision: pin.revision }]);
    }, options),
  );
});

it.each(["root", "authority", "admission", "selection", "descriptions", "manifests"] as const)(
  "retains captured resource facts across a pending %s change",
  async (change) => {
    const { root, pin, snapshot } = await resourceFixture();
    const originalPin = { ...pin };
    const other = tempDirs.make("skill-library-other-root-");
    const entered = createDeferredCore();
    const gate = createDeferredCore();
    async function hold<T>(value: T) {
      entered.resolve();
      await gate.promise;
      return value;
    }
    if (change === "manifests") {
      const read = selectionReads.readSkillLibrarySelectionManifests;
      vi.spyOn(selectionReads, "readSkillLibrarySelectionManifests").mockImplementation(
        async (...args) => hold(await read(...args)),
      );
    } else {
      const read = selectionReads.readSkillLibrarySelectionDescriptions;
      vi.spyOn(selectionReads, "readSkillLibrarySelectionDescriptions").mockImplementation(
        async (...args) => hold(await read(...args)),
      );
    }
    const closed = new Error("Synthetic resource owner closed");
    let current = true;
    await inRoot(root, async () => {
      const pending =
        change === "selection"
          ? selection
              .prepareSkillLibrarySelection(snapshot.librarySelections!, {}, noop)
              .then((entries) => entries.map((entry) => entry.skill))
          : deliver(snapshot, () => {
              if (!current) {
                throw closed;
              }
            }).then((delivery) => delivery?.skills);
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await entered.promise;
        if (change === "root") {
          process.env.OPENCLAW_STATE_DIR = other;
        } else if (change === "authority") {
          current = false;
        } else if (change === "admission") {
          await closeDatabase();
        } else {
          Object.assign(pin, syntheticPin("changed"));
          snapshot.librarySelections!.push({ ...pin });
          snapshot.skills[0]!.name = "changed";
        }
        gate.resolve();
        const result = await outcome;
        if (change === "authority") {
          expect(result).toEqual({ error: closed });
        } else if (change === "admission") {
          expect(result).toHaveProperty("error");
        } else {
          expect(result).toMatchObject({
            value: [{ name: originalPin.name, description: "Saved procedure" }],
          });
          if (change === "root") {
            expect(fs.existsSync(path.join(other, "state", "openclaw.sqlite"))).toBe(false);
          } else {
            expect(loadSelection([originalPin])[0]?.skill.name).toBe(originalPin.name);
          }
        }
      } finally {
        gate.resolve();
        await outcome;
      }
    });
  },
);

it.each(["file", "table"] as const)("keeps missing %s storage absent", async (missing) => {
  const root = tempDirs.make("skill-library-missing-read-");
  const options = { env: { OPENCLAW_STATE_DIR: root } };
  if (missing === "table") {
    openDatabase(options);
    await closeDatabase();
  }
  const snapshot = snapshotFor(syntheticPin("missing"));
  const pins = await selection.seedSkillLibrarySelection(resourceActor("missing"), options);
  expect(pins).toEqual([]);
  expect(() => selection.assertPreparedSkillLibrarySelection(pins)).not.toThrow();
  await inRoot(root, () => expectCode(deliver(snapshot, noop), "NOT_FOUND"));
  if (missing === "file") {
    expect(fs.existsSync(path.join(root, "state", "openclaw.sqlite"))).toBe(false);
  } else {
    expect(tableExists(openDatabase(options).db, "skill_library_entries")).toBe(false);
  }
});

it.each(["workspace", "library"] as const)("preserves the first %s error", async (first) => {
  const root = tempDirs.make("skill-library-read-order-");
  onTestFinished(() => void vi.restoreAllMocks());
  const skills = ["workspace", "library"].map((name) =>
    materializeSkill({
      name,
      description: name,
      content: resourceContent,
      frontmatter: {},
      filePath: path.join(root, name, "SKILL.md"),
      baseDir: path.join(root, name),
      source: "openclaw-workspace",
      sourceOptions: { source: "openclaw-workspace" },
    }),
  );
  const [workspace, library] = skills;
  const snapshot: SkillSnapshot = {
    prompt: "",
    skills: skills.map(({ name }) => ({ name })),
    resolvedSkills: first === "workspace" ? skills : [library!, workspace!],
    librarySelections: [syntheticPin("library")],
  };
  const workspaceError = new Error("Synthetic workspace read failed");
  const libraryError = new Error("Synthetic database read failed");
  vi.spyOn(selection, "prepareSkillLibrarySelection").mockResolvedValue([]);
  const readWorkspace = vi.spyOn(bundles, "readSkillBundleTree").mockRejectedValue(workspaceError);
  const readManifests = vi
    .spyOn(selectionReads, "readSkillLibrarySelectionManifests")
    .mockRejectedValue(libraryError);
  await inRoot(root, async () => {
    await expect(deliver(snapshot, noop)).rejects.toMatchObject({
      code: "INVALID_BUNDLE",
      message: expect.stringContaining(`skill="${first}"`),
      cause: first === "workspace" ? workspaceError : libraryError,
    });
  });
  expect(readWorkspace).toHaveBeenCalledTimes(first === "workspace" ? 1 : 0);
  expect(readManifests).toHaveBeenCalledTimes(first === "library" ? 1 : 0);
});
