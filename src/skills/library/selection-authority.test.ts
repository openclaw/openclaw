import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
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
      mutateSkillLibrary(
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
        mutateSkillLibrary(
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

  it("preserves a prepared seed when an outer native mutation rolls back", async () => {
    const { alice, options } = fixture();
    const saved = await saveSkillLibrary(alice, draft(), options);
    const pins = await seedSkillLibrarySelection(alice, options);
    const rollback = new Error("rollback library change");
    expect(() =>
      runOpenClawStateWriteTransaction((database) => {
        mutateSkillLibrary(
          alice,
          {
            action: "disable",
            skillId: saved.entry.skillId,
            expectedRevision: saved.entry.revision,
          },
          { ...options, database },
        );
        expect(() => assertPreparedSkillLibrarySelection(pins)).toThrow(SkillLibraryError);
        throw rollback;
      }, options),
    ).toThrow(rollback);
    expect(() => assertPreparedSkillLibrarySelection(pins)).not.toThrow();
    expect(await seedSkillLibrarySelection(alice, options)).toEqual(pins);
  });

  it("revokes a prepared seed after an uncertain native commit", async () => {
    const { alice, options } = fixture();
    const saved = await saveSkillLibrary(alice, draft(), options);
    const pins = await seedSkillLibrarySelection(alice, options);
    const { db } = openOpenClawStateDatabase(options);
    const execute = db.exec.bind(db);
    const failed = new Error("native commit outcome unavailable");
    const commit = vi.spyOn(db, "exec").mockImplementation((sql) => {
      execute(sql);
      if (sql === "COMMIT") {
        throw failed;
      }
    });
    try {
      expect(() =>
        mutateSkillLibrary(
          alice,
          {
            action: "disable",
            skillId: saved.entry.skillId,
            expectedRevision: saved.entry.revision,
          },
          options,
        ),
      ).toThrow(failed);
    } finally {
      commit.mockRestore();
    }
    expect(() => assertPreparedSkillLibrarySelection(pins)).toThrow();
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
