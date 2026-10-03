import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { linkEmail, setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { SkillLibraryError } from "../skill-library-error.js";
import { readSkillLibrarySelectionManifests } from "./selection-read.js";
import {
  assertPreparedSkillLibrarySelection,
  changeSkillLibrarySelection,
  prepareSkillLibrarySelection,
  readSelectedSkillLibraryFiles,
  seedSkillLibrarySelection,
} from "./selection.js";
import {
  listSkillLibrary,
  mutateSkillLibrary,
  readSkillLibrary,
  resolveSkillLibraryPresentation,
  saveSkillLibrary,
} from "./service.js";
import { content, draft, useSkillLibraryFixture } from "./service.test-support.js";
import type { SkillLibraryAuthority } from "./store.js";

const { fixture, tempDirs } = useSkillLibraryFixture();

describe("skill library worker reads and prepared selection authority", () => {
  it("keeps solo defaults, counts aliases once, and never creates library tables on discovery", async () => {
    const { options, admin, alice, actor } = fixture();
    expect(await listSkillLibrary(admin, {}, options)).toMatchObject({
      defaultTarget: "workspace",
      multipleProfiles: false,
      entries: [],
    });
    expect((await listSkillLibrary(actor(undefined, true), {}, options)).defaultTarget).toBe(
      "workspace",
    );
    expect((await listSkillLibrary(alice, {}, options)).defaultTarget).toBe("personal");
    expect(await seedSkillLibrarySelection(alice, options)).toEqual([]);
    expect(tableExists(openOpenClawStateDatabase(options).db, "skill_library_entries")).toBe(false);
    linkEmail("alice-alias@example.test", alice.profileId!, options);
    expect((await listSkillLibrary(admin, {}, options)).multipleProfiles).toBe(false);
    ensureProfileForEmail("bob@example.test", options);
    expect(await listSkillLibrary(admin, {}, options)).toMatchObject({
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
    const pins = await seedSkillLibrarySelection(alice, options);
    expect(pins).toEqual([]);
    expect(() => assertPreparedSkillLibrarySelection(pins)).not.toThrow();
    expect(fs.existsSync(options.path)).toBe(false);
  });

  it("reads library metadata, selections and manifests without caller-thread SQL", async () => {
    const { options, alice } = fixture();
    const saved = await saveSkillLibrary(alice, draft(), options);
    // Independent WAL checkpoints must not race the library SQL measurement.
    await openOpenClawStateDatabase(options).walMaintenance.stop();
    const sql = observeHostDataSql();
    try {
      expect(await resolveSkillLibraryPresentation(alice, options)).toMatchObject({
        profileId: alice.profileId,
        defaultTarget: "personal",
      });
      expect((await listSkillLibrary(alice, {}, options)).entries).toEqual([saved.entry]);
      expect((await readSkillLibrary(alice, saved.entry.skillId, undefined, options)).content).toBe(
        content,
      );
      const pins = await seedSkillLibrarySelection(alice, options);
      expect(pins).toHaveLength(1);
      const attached = await changeSkillLibrarySelection(
        alice,
        [],
        { sessionKey: "session", action: "attach", skillId: saved.entry.skillId },
        options,
      );
      expect(attached).toEqual(pins);
      assertPreparedSkillLibrarySelection(pins);
      assertPreparedSkillLibrarySelection(attached);
      const selected = await prepareSkillLibrarySelection(pins, options, () => {});
      expect(selected[0]?.skill.name).toBe(saved.entry.name);
      const manifests = await readSkillLibrarySelectionManifests(pins, options);
      expect(manifests?.[0]?.files_json).toContain("references/data.bin");
      expect(await readSelectedSkillLibraryFiles(pins[0]!, options)).toContainEqual(
        expect.objectContaining({ path: "SKILL.md" }),
      );
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it.each(["unshare", "disable", "remove", "role", "alias"] as const)(
    "revokes a prepared seed after %s while committed pins keep working",
    async (change) => {
      const { alice, actor, options } = fixture();
      const bob: SkillLibraryAuthority = {
        ...actor(ensureProfileForEmail("bob@example.test", options).id),
        getConfig: () => ({
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
        }),
      };
      const mergeTarget =
        change === "alias" ? ensureProfileForEmail("target@example.test", options) : undefined;
      if (mergeTarget) {
        setUserProfileRole(mergeTarget.id, "blocked", options);
      }
      const saved = await saveSkillLibrary(alice, draft(), options);
      await mutateSkillLibrary(
        alice,
        { action: "share", skillId: saved.entry.skillId, expectedRevision: saved.entry.revision },
        options,
      );
      const freshSeed = await seedSkillLibrarySelection(bob, options);
      expect(freshSeed).toHaveLength(1);
      const durablePins = structuredClone(freshSeed);
      if (change === "role") {
        setUserProfileRole(bob.profileId!, "blocked", options);
      } else if (change === "alias") {
        linkEmail("bob@example.test", mergeTarget!.id, options);
      } else {
        await mutateSkillLibrary(
          alice,
          { action: change, skillId: saved.entry.skillId, expectedRevision: saved.entry.revision },
          options,
        );
      }
      const sql = observeHostDataSql();
      try {
        expect(() => assertPreparedSkillLibrarySelection(freshSeed)).toThrow(SkillLibraryError);
        expect(() => assertPreparedSkillLibrarySelection(durablePins)).not.toThrow();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(await prepareSkillLibrarySelection(durablePins, options, () => {})).toHaveLength(1);
      expect(await readSelectedSkillLibraryFiles(durablePins[0]!, options)).toContainEqual(
        expect.objectContaining({ path: "SKILL.md" }),
      );
    },
  );

  it("preserves a prepared seed when worker commit admission rolls back the mutation", async () => {
    const { alice, options } = fixture();
    const saved = await saveSkillLibrary(alice, draft(), options);
    const pins = await seedSkillLibrarySelection(alice, options);
    await expect(
      saveSkillLibrary(
        alice,
        { ...draft(), skillId: saved.entry.skillId, expectedRevision: saved.entry.revision },
        options,
      ),
    ).resolves.toMatchObject({ state: "unchanged" });
    expect(() => assertPreparedSkillLibrarySelection(pins)).not.toThrow();
    const rollback = new Error("rollback library change");
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let checkedCommit = false;
    const refusal = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        createAdmission((request, grant) => {
          admit(
            request,
            request.stage === "commit" && request.facts !== undefined
              ? () => {
                  checkedCommit = true;
                  expect(() => assertPreparedSkillLibrarySelection(pins)).toThrow(
                    SkillLibraryError,
                  );
                  throw rollback;
                }
              : grant,
          );
        }, attachment),
      );
    try {
      await expect(
        mutateSkillLibrary(
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
    expect(() => assertPreparedSkillLibrarySelection(pins)).not.toThrow();
    expect(await seedSkillLibrarySelection(alice, options)).toEqual(pins);
  });

  it("revokes a prepared seed after a lost worker receipt without replaying the mutation", async () => {
    const { alice, options } = fixture();
    const saved = await saveSkillLibrary(alice, draft(), options);
    const pins = await seedSkillLibrarySelection(alice, options);
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
                    receiptFault = vi
                      .spyOn(admission, "committed", "get")
                      .mockReturnValue(undefined);
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
        mutateSkillLibrary(
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
    expect(() => assertPreparedSkillLibrarySelection(pins)).toThrow();
    expect((await listSkillLibrary(alice, {}, options)).entries[0]?.enabled).toBe(false);
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare("SELECT COUNT(*) AS count FROM skill_library_events WHERE action = 'disable'")
        .get(),
    ).toMatchObject({ count: 1 });
  });

  it.each(["seed", "attach"] as const)(
    "rejects edited %s pins before admission without caller-thread SQL",
    async (source) => {
      const { alice, options } = fixture();
      const saved = await saveSkillLibrary(alice, draft(), options);
      const pins =
        source === "seed"
          ? await seedSkillLibrarySelection(alice, options)
          : await changeSkillLibrarySelection(
              alice,
              [],
              { action: "attach", sessionKey: "session", skillId: saved.entry.skillId },
              options,
            );
      expect(pins).toHaveLength(1);
      pins[0]!.revision = "0".repeat(64);
      const sql = observeHostDataSql();
      try {
        expect(() => assertPreparedSkillLibrarySelection(pins)).toThrow(
          expect.objectContaining({ code: "CONFLICT" }),
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    },
  );
});
