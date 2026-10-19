import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { SKILL_LIBRARY_MAX_FILE_BYTES } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { declareAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { tableHasColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  linkEmail,
  setAvatar,
  setDisplayName,
  setUserProfileRole,
} from "../../state/user-profile-writes.worker.js";
import { getProfileAvatar } from "../../state/user-profiles-avatar.test-support.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { materializeSkillResources, prepareSkillResourceDelivery } from "../runtime/resources.js";
import { SkillLibraryError } from "../skill-library-error.js";
import { prepareSkillLibraryBundle, skillLibraryRevisionDir } from "./bundle.js";
import { uploadSkillLibrary } from "./import.js";
import {
  changeSkillLibrarySelection,
  loadSkillLibrarySelection,
  seedSkillLibrarySelection,
} from "./selection.js";
import {
  listSkillLibrary,
  mutateSkillLibrary,
  readSkillLibrary,
  saveSkillLibrary,
} from "./service.js";
import { beginZipUpload, content, draft, useSkillLibraryFixture } from "./service.test-support.js";

const { fixture: baseFixture, tempDirs } = useSkillLibraryFixture();
const contentHash = createHash("sha256").update(content).digest("hex");
const revisionDirectory = (pin: { skillId: string; revision: string }, env: NodeJS.ProcessEnv) =>
  skillLibraryRevisionDir(pin.skillId, pin.revision, env);

function fixture() {
  const base = baseFixture();
  const { alice, options } = base;
  type Authority = typeof alice;
  return {
    ...base,
    lib: {
      save: (params: Parameters<typeof saveSkillLibrary>[1] = draft(), who: Authority = alice) =>
        saveSkillLibrary(who, params, options),
      read: (id: string, who: Authority = alice, revision?: string) =>
        readSkillLibrary(who, id, revision, options),
      list: (who: Authority = alice, params: Parameters<typeof listSkillLibrary>[1] = {}) =>
        listSkillLibrary(who, params, options),
      mutate: (params: Parameters<typeof mutateSkillLibrary>[1], who: Authority = alice) =>
        mutateSkillLibrary(who, params, options),
      change: (
        { skillId, revision }: { skillId: string; revision: string },
        action: Parameters<typeof mutateSkillLibrary>[1]["action"],
        who: Authority = alice,
      ) => mutateSkillLibrary(who, { skillId, expectedRevision: revision, action }, options),
      seed: (who: Authority = alice) => seedSkillLibrarySelection(who, options),
      select: (
        pins: Parameters<typeof changeSkillLibrarySelection>[1],
        params: Parameters<typeof changeSkillLibrarySelection>[2],
        who: Authority = alice,
      ) => changeSkillLibrarySelection(who, pins, params, options),
      chunk: (uploadId: string, bytes: Buffer, who: Authority = alice) =>
        uploadSkillLibrary(
          who,
          { action: "chunk", uploadId, offset: 0, data: bytes.toString("base64") },
          options,
        ),
      commit: (uploadId: string, who: Authority = alice) =>
        uploadSkillLibrary(who, { action: "commit", uploadId }, options),
      begin: (bytes: Buffer, slug: string, who: Authority = alice) =>
        beginZipUpload(who, bytes, slug, options),
    },
  };
}

async function selectedFixture() {
  const context = fixture();
  const saved = await context.lib.save();
  return { ...context, saved, pins: await context.lib.seed() };
}

async function zipBytes(oversized = false) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip().file(oversized ? "wrapped/SKILL.md" : "SKILL.md", content);
  if (oversized) {
    zip.file("wrapped/oversized.bin", Buffer.alloc(SKILL_LIBRARY_MAX_FILE_BYTES + 1, 97));
  }
  return zip.generateAsync({ type: "nodebuffer", compression: oversized ? "DEFLATE" : "STORE" });
}

it.each([
  ["heading", "# Friendly Title", "Friendly Title"],
  ["metadata fallback", "Plain introduction", "Guide"],
])(
  "keeps the %s separate from the selected command identity",
  async (_label, heading, displayName) => {
    const { options, stateDir, lib } = fixture();
    await lib.save({
      ...draft("long---skill---name"),
      content: content.replace("# Guide", heading),
    });
    const pins = await lib.seed();
    const entries = loadSkillLibrarySelection(pins, options);
    const { buildSkillSnapshot } = await import("../loading/workspace-skill-prompt.js");
    const { buildWorkspaceSkillCommandSpecs } = await import("../discovery/command-specs.js");
    const snapshot = await buildSkillSnapshot(stateDir, { entries });
    const commands = buildWorkspaceSkillCommandSpecs(stateDir, { entries });
    expect(pins[0]!.name).toMatch(/^s_long_skil_[a-f0-9]{20}$/);
    expect(commands[0]).toMatchObject({
      name: pins[0]!.name,
      skillName: pins[0]!.name,
      displayName,
    });
    expect(snapshot.prompt).toContain(`<name>${pins[0]!.name}</name>`);
    const copied = {
      ...entries[0]!,
      skill: { ...entries[0]!.skill, source: "openclaw-workspace" },
    };
    await expect(buildSkillSnapshot(stateDir, { entries: [copied, ...entries] })).rejects.toThrow(
      "ambiguous",
    );
    expect(() =>
      buildWorkspaceSkillCommandSpecs(stateDir, { entries: [copied, ...entries] }),
    ).toThrow("ambiguous");
  },
);
it("discovers pinned commands through the loader without leaking them into workspace state", async () => {
  const { options, stateDir, lib, saved, pins } = await selectedFixture();
  const updated = await lib.save({
    ...draft(),
    skillId: saved.entry.skillId,
    expectedRevision: saved.entry.revision,
    content: `${content}\nUpdated`,
  });
  const originalPin = expectDefined(pins[0], "original selected revision");
  const mixedRevisions = [
    { ...originalPin, revision: updated.entry.revision },
    originalPin,
    originalPin,
  ];
  expect(
    loadSkillLibrarySelection(mixedRevisions, options).map((entry) => entry.skill.filePath),
  ).toEqual(
    mixedRevisions.map((pin) => path.join(revisionDirectory(pin, options.env), "SKILL.md")),
  );
  expect(() =>
    loadSkillLibrarySelection([originalPin, { ...originalPin, revision: "0".repeat(64) }], options),
  ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  const {
    listSkillCommandsForWorkspace,
    listSkillCommandsForAgents,
    prepareSkillCommandsForAgents,
  } = await import("../discovery/chat-commands.js");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const cfg = { agents: { defaults: { skills: [] } } };
    const discover = (
      overrides: Partial<Parameters<typeof listSkillCommandsForWorkspace>[0]> = {},
    ) =>
      listSkillCommandsForWorkspace({
        workspaceDir: stateDir,
        cfg,
        agentId: "main",
        sessionEntry: { skillLibrarySelections: pins },
        ...overrides,
      });
    const commands = discover({ skillFilter: [saved.entry.name] });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: saved.entry.name,
      skillFile: expect.stringContaining(saved.entry.revision),
    });
    expect(discover()).toEqual([]);
    expect(discover({ includeAllowlistHidden: true })).toContainEqual(commands[0]);
    expect(
      discover({
        includeAllowlistHidden: true,
        cfg: { ...cfg, skills: { entries: { [saved.entry.name]: { enabled: false } } } },
      }).map((entry) => entry.name),
    ).not.toContain(saved.entry.name);
    expect(discover({ sessionEntry: undefined, skillFilter: [saved.entry.name] })).toEqual([]);
    const agentParams = {
      cfg: {
        agents: {
          defaults: { skills: [saved.entry.name] },
          entries: { main: { workspace: stateDir } },
        },
      },
      agentIds: ["main"],
      sessionEntry: { skillLibrarySelections: pins },
    };
    expect(listSkillCommandsForAgents(agentParams)).toEqual(commands);
    expect(await prepareSkillCommandsForAgents(agentParams)).toEqual(commands);
    expect(
      await prepareSkillCommandsForAgents({ ...agentParams, sessionEntry: undefined }),
    ).toEqual([]);
  });
});

it.each(["oversized", "hardlinked", ...(process.platform === "win32" ? [] : ["symlink"])])(
  "rejects %s instructions before caching a selected revision",
  async (replacement) => {
    const { options, stateDir, saved, pins } = await selectedFixture();
    const alias = path.join(tempDirs.make("skill-library-alias-"), "state");
    if (replacement === "symlink") {
      await fs.symlink(stateDir, alias, "dir");
    }
    const readOptions =
      replacement === "symlink"
        ? { ...options, env: { ...options.env, OPENCLAW_STATE_DIR: alias } }
        : options;
    const directory = revisionDirectory(saved.entry, readOptions.env);
    const filePath = path.join(directory, "SKILL.md");
    const target = path.join(directory, "instructions.md");
    if (replacement === "oversized") {
      await fs.chmod(filePath, 0o600);
      await fs.appendFile(filePath, "a".repeat(SKILL_LIBRARY_MAX_FILE_BYTES));
    } else if (replacement === "hardlinked") {
      await fs.link(filePath, path.join(directory, "linked.md"));
    } else {
      await fs.rename(filePath, target);
      await fs.symlink("instructions.md", filePath);
    }
    expect(() => loadSkillLibrarySelection(pins, readOptions)).toThrow(
      "Pinned skill instructions could not be read",
    );
    await fs.unlink(filePath);
    if (replacement === "symlink") {
      await fs.rename(target, filePath);
    } else {
      await fs.writeFile(filePath, content);
    }
    expect(loadSkillLibrarySelection(pins, readOptions)[0]?.skill).toMatchObject({
      filePath,
      contentHash,
    });
  },
);

it("retains selected content hashes after disk changes without loading revision manifests", async () => {
  const { options, lib } = fixture();
  await lib.save();
  const pins = await lib.seed();
  const db = requireNativeSqliteDatabase(openOpenClawStateDatabase(options).db);
  db.setAuthorizer((action, table, column) =>
    action === constants.SQLITE_READ &&
    table === "skill_library_revisions" &&
    column === "files_json"
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  try {
    const [selected] = loadSkillLibrarySelection(pins, options);
    expect(selected?.skill.contentHash).toBe(contentHash);
    const filePath = expectDefined(selected, "selected revision").skill.filePath;
    await fs.chmod(filePath, 0o600);
    await fs.writeFile(filePath, `${content}\nChanged after selection`);
    expect(loadSkillLibrarySelection(pins, options)[0]?.skill.contentHash).toBe(contentHash);
  } finally {
    db.setAuthorizer(null);
  }
});

it("enforces independent read/write/transfer checks and preserves a removed session pin", async () => {
  const { options, alice, admin, actor, lib } = fixture();
  const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
  const created = await lib.save();
  const { skillId, revision } = created.entry;
  const selection = await lib.seed();
  const anonymousAdmin = actor(undefined, true);
  const expectAnonymousReadOnly = async () => {
    const read = await lib.read(skillId, anonymousAdmin);
    expect(read).toMatchObject({ content, entry: { canEdit: false } });
    expect(await lib.list(anonymousAdmin)).toMatchObject({
      defaultTarget: "workspace",
      canManageWorkspace: true,
      entries: [expect.objectContaining({ skillId, canEdit: false })],
    });
    await expect(
      lib.save({ ...draft(), skillId, expectedRevision: revision }, anonymousAdmin),
    ).rejects.toMatchObject({ code: "IDENTITY_REQUIRED" });
    await expect(lib.change({ skillId, revision }, "remove", anonymousAdmin)).rejects.toMatchObject(
      { code: "IDENTITY_REQUIRED" },
    );
  };
  await expectAnonymousReadOnly();
  const privateRead = lib.read(skillId, bob);
  await expect(privateRead).rejects.toBeInstanceOf(SkillLibraryError);
  await expect(privateRead).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(lib.save(draft(), actor())).rejects.toMatchObject({ code: "IDENTITY_REQUIRED" });
  await lib.change({ skillId, revision }, "share");
  expect((await lib.read(skillId, bob)).content).toBe(content);
  await expect(lib.change({ skillId, revision }, "remove", bob)).rejects.toThrow(
    "Only the skill's owner",
  );
  await expect(lib.change({ skillId, revision }, "transfer")).rejects.toThrow("administrator");
  const transferred = await lib.change({ skillId, revision }, "transfer", admin);
  expect(transferred.entry).toMatchObject({
    skillId,
    revision,
    ownerProfileId: null,
    ownerLabel: "Team",
    authorProfileId: alice.profileId,
    shared: true,
    canEdit: true,
  });
  await expectAnonymousReadOnly();
  expect((await lib.list(actor(undefined, true), { scope: "mine" })).entries).toEqual([]);
  const removed = await lib.change({ skillId, revision }, "remove", admin);
  expect(removed).toMatchObject({ state: "removed", entry: { removed: true } });
  expect((await lib.read(skillId, admin)).entry).toEqual(removed.entry);
  expect((await lib.list(bob)).entries).toEqual([]);
  expect(loadSkillLibrarySelection(selection, options)[0]?.skill.filePath).toContain(revision);
  await expect(
    lib.select([], { action: "attach", sessionKey: "session", skillId }, bob),
  ).rejects.toThrow("Removed skill");
  const bytes = await fs.readFile(
    path.join(skillLibraryRevisionDir(skillId, revision, options.env), "references/data.bin"),
  );
  expect(bytes).toEqual(Buffer.from([0, 255, 128]));
});

it("returns committed flags and relinquishes personal edit access on transfer", async () => {
  const { admin, lib } = fixture();
  const created = await lib.save();
  const { skillId, revision } = created.entry;
  for (const [action, shared, enabled] of [
    ["disable", false, false],
    ["share", true, false],
    ["enable", true, true],
    ["unshare", false, true],
  ] as const) {
    const receipt = await lib.change({ skillId, revision }, action);
    expect(receipt.entry).toEqual({
      ...created.entry,
      shared,
      enabled,
      updatedAt: expect.any(Number),
    });
    expect((await lib.read(skillId)).entry).toEqual(receipt.entry);
  }
  const personalAdmin = { ...admin, namespace: "personal" as const };
  const transferred = await lib.change({ skillId, revision }, "transfer", personalAdmin);
  expect(transferred.entry).toEqual({
    ...created.entry,
    ownerProfileId: null,
    ownerLabel: "Team",
    shared: true,
    canEdit: false,
    updatedAt: expect.any(Number),
  });
  expect((await lib.read(skillId, personalAdmin)).entry).toEqual(transferred.entry);
});

it("makes identical saves a no-op, rejects racing writers, and leaves existing pins on the old bytes", async () => {
  const { alice, lib } = fixture();
  const created = await lib.save();
  const { skillId, revision } = created.entry;
  const pins = await lib.seed();
  expect((await lib.save({ ...draft(), skillId, expectedRevision: revision })).state).toBe(
    "unchanged",
  );
  const edits = await Promise.allSettled(
    ["first", "second"].map((body) =>
      lib.save({
        ...draft(),
        skillId,
        expectedRevision: revision,
        content: content.replace("A reusable test procedure", `${body} revision`),
      }),
    ),
  );
  expect(edits.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(edits.find((result) => result.status === "rejected")).toMatchObject({
    reason: expect.any(SkillLibraryError),
  });
  expect((await lib.read(skillId, alice, pins[0]!.revision)).content).toBe(content);
  const current = (await lib.read(skillId)).entry;
  expect(edits.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "CONFLICT" },
  });
  expect(current.revision).not.toBe(revision);
  expect(current.description).not.toBe(created.entry.description);
  const staleMutation = lib.change({ skillId, revision }, "disable");
  await expect(staleMutation).rejects.toBeInstanceOf(SkillLibraryError);
  await expect(staleMutation).rejects.toMatchObject({
    code: "CONFLICT",
    currentRevision: current.revision,
  });
  const refreshed = await lib.select(pins, { action: "refresh", sessionKey: "session" });
  expect(refreshed[0]?.revision).toBe(current.revision);
  const rolledBack = await lib.mutate({
    skillId,
    expectedRevision: current.revision,
    action: "rollback",
    revision,
  });
  expect(rolledBack.entry).toMatchObject({ revision, description: created.entry.description });
  expect(await lib.read(skillId)).toMatchObject({ content, entry: rolledBack.entry });
});

it("rejects lost authority after asynchronous publication work without publishing a pointer", async () => {
  const { alice, lib } = fixture();
  let live = true;
  const authority = {
    ...alice,
    assertCurrent: () => {
      if (!live) {
        throw new Error("retired run");
      }
    },
  };
  const saving = lib.save(draft(), authority);
  live = false;
  await expect(saving).rejects.toThrow("retired run");
  expect((await lib.list()).entries).toEqual([]);
});

it.each(["canonical", "merged"] as const)(
  "retains same-name skills and permissions for a %s actor after profile merge",
  async (actorKind) => {
    const { options, alice, actor, lib } = fixture();
    const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
    const a = await lib.save();
    const b = await lib.save(draft(), bob);
    const avatar = Buffer.alloc(128 * 1024, 97);
    for (const profileId of [alice.profileId!, bob.profileId!]) {
      expect(setAvatar(profileId, avatar, "image/png", options).ok).toBe(true);
    }
    setDisplayName(alice.profileId!, "Alice 雪 · 🦞", options);
    await expect(lib.save()).rejects.toMatchObject({ code: "NAME_CONFLICT" });
    linkEmail("bob@example.test", alice.profileId!, options);
    const authority = actorKind === "canonical" ? alice : bob;
    const entries = (await lib.list(authority, { scope: "mine" })).entries;
    expect(entries.map((entry) => entry.skillId).toSorted()).toEqual(
      [a.entry.skillId, b.entry.skillId].toSorted(),
    );
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(2);
    expect(entries.every((entry) => entry.ownerLabel === "Alice 雪 · 🦞")).toBe(true);
    expect(entries.every((entry) => entry.canEdit)).toBe(true);
    expect((await lib.read(b.entry.skillId)).entry.ownerProfileId).toBe(alice.profileId);
    expect(
      Buffer.from(
        expectDefined(getProfileAvatar(alice.profileId!, options), "stored avatar").bytes,
      ),
    ).toEqual(avatar);
    setUserProfileRole(alice.profileId!, "viewer", options);
    const viewerEntries = (
      await lib.list({
        ...authority,
        getConfig: () => ({
          gateway: {
            roles: {
              definitions: {
                viewer: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
              },
            },
          },
        }),
      })
    ).entries;
    expect(viewerEntries.map((entry) => entry.skillId)).toEqual(
      entries.map((entry) => entry.skillId),
    );
    expect(viewerEntries.every((entry) => !entry.canEdit)).toBe(true);
  },
);

it.each(["current", "legacy"] as const)(
  "reads a skill through a cold %s profile handle",
  async (schema) => {
    const { options, alice, lib } = fixture();
    const saved = await lib.save();
    if (schema === "legacy") {
      openOpenClawStateDatabase(options).db.exec("ALTER TABLE user_profiles DROP COLUMN role");
    }
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const database = openOpenClawStateDatabase(options);
    const read = await readSkillLibrary(alice, saved.entry.skillId, undefined, {
      ...options,
      database,
    });
    expect(read).toMatchObject({ content, entry: saved.entry });
    expect(tableHasColumn(database.db, "user_profiles", "role")).toBe(schema === "current");
  },
);

it.each(["created_at", "updated_at", "avatar"] as const)(
  "preserves native %s errors on either actor merge row",
  async (column) => {
    const { options, alice, actor, lib } = fixture();
    const source = actor(ensureProfileForEmail("source@example.test", options).id);
    await lib.save();
    linkEmail("source@example.test", alice.profileId!, options);
    const { db } = openOpenClawStateDatabase(options);
    if (column === "avatar") {
      // A non-STRICT fixture can hold a damaged avatar value that native row conversion rejects.
      db.exec(`
        CREATE TABLE untyped_profiles AS SELECT * FROM user_profiles;
        DROP TABLE user_profiles;
        ALTER TABLE untyped_profiles RENAME TO user_profiles;
      `);
    }
    for (const profileId of [source.profileId!, alice.profileId!]) {
      db.prepare(`UPDATE user_profiles SET ${column} = ? WHERE id = ?`).run(
        9223372036854775807n,
        profileId,
      );
      let nativeError: unknown;
      try {
        db.prepare("SELECT * FROM user_profiles WHERE id = ?").get(profileId);
      } catch (error) {
        nativeError = error;
      }
      if (!(nativeError instanceof Error)) {
        throw new Error("Expected native SQLite INTEGER conversion failure");
      }
      await expect(lib.list(source)).rejects.toThrow(
        expect.objectContaining({
          name: nativeError.name,
          message: nativeError.message,
          ...("code" in nativeError ? { code: nativeError.code } : {}),
        }),
      );
      db.prepare(`UPDATE user_profiles SET ${column} = 1 WHERE id = ?`).run(profileId);
    }
  },
);

it("delivers complete immutable supporting files into a worker-owned directory", async () => {
  const { options, stateDir, lib } = fixture();
  await lib.save();
  const selections = await lib.seed();
  const skills = loadSkillLibrarySelection(selections, options).map((entry) => entry.skill);
  const snapshot = {
    prompt: "",
    skills: skills.map((skill) => ({ name: skill.name })),
    resolvedSkills: skills,
    librarySelections: selections,
    version: 1,
  };
  const delivery = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
    prepareSkillResourceDelivery(snapshot, () => {}),
  );
  // Library bytes belong to Gateway even when the workspace host is offline.
  const remoteWorkspace = path.join(stateDir, "remote-workspace");
  declareAgentWorkspaceAccess(remoteWorkspace);
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    await expect(
      prepareSkillResourceDelivery(snapshot, () => {}, [], remoteWorkspace),
    ).resolves.toEqual(delivery);
  });
  expect(delivery).toBeDefined();
  const materialized = await materializeSkillResources(delivery!, () => {});
  try {
    const skill = materialized.snapshot.resolvedSkills![0]!;
    expect(await fs.readFile(skill.filePath, "utf8")).toBe(content);
    expect(await fs.readFile(path.join(skill.baseDir, "references/data.bin"))).toEqual(
      Buffer.from([0, 255, 128]),
    );
    expect(materialized.snapshot.prompt).toContain(skill.filePath);
    expect(materialized.snapshot.prompt).not.toContain(
      revisionDirectory(selections[0]!, options.env),
    );
  } finally {
    await materialized.cleanup();
  }
  expect(prepareSkillLibraryBundle(delivery!.skills[0]!.files).revision).toBe(
    delivery!.skills[0]!.revision,
  );
});

it("reads published executable metadata from the manifest and detects changed resource bytes", async () => {
  const { options, lib } = fixture();
  const saved = await lib.save();
  const directory = revisionDirectory(saved.entry, options.env);
  const script = path.join(directory, "scripts/task.sh");
  await fs.chmod(script, 0o400);
  const read = await lib.read(saved.entry.skillId);
  expect(read.files.find((file) => file.path === "scripts/task.sh")?.executable).toBe(true);
  expect(read.entry.revision).toBe(saved.entry.revision);
  await fs.chmod(script, 0o600);
  await fs.writeFile(script, "changed");
  await expect(lib.read(saved.entry.skillId)).rejects.toThrow("integrity verification");
});
it("delivers the pinned hidden revision on explicit selection after the library default changes", async () => {
  const { options, stateDir, lib } = fixture();
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const hiddenContent = content.replace(
      "---\n# Guide",
      "disable-model-invocation: true\n---\n# Guide",
    );
    const saved = await lib.save({ ...draft(), content: hiddenContent });
    const pins = await lib.seed();
    const entries = loadSkillLibrarySelection(pins, options);
    const { buildSkillSnapshot } = await import("../loading/workspace-skill-prompt.js");
    const snapshot = {
      ...(await buildSkillSnapshot(stateDir, { entries })),
      librarySelections: pins,
    };
    expect(snapshot.resolvedSkills).toEqual([]);
    await lib.save({
      ...draft(),
      skillId: saved.entry.skillId,
      expectedRevision: saved.entry.revision,
      content: `${hiddenContent}\nChanged default`,
    });
    const ordinary = await prepareSkillResourceDelivery(snapshot, () => {});
    const explicit = await prepareSkillResourceDelivery(snapshot, () => {}, [
      { name: pins[0]!.name, path: entries[0]!.skill.filePath },
    ]);
    expect(ordinary?.skills[0]).toMatchObject({
      revision: saved.entry.revision,
      modelVisible: false,
    });
    expect(explicit?.skills[0]).toMatchObject({
      name: pins[0]!.name,
      revision: saved.entry.revision,
      modelVisible: true,
    });
    expect(explicit?.skills[0]?.files).toEqual(ordinary?.skills[0]?.files);
    const markdown = explicit!.skills[0]!.files.find((file) => file.path === "SKILL.md")!;
    expect(Buffer.from(markdown.content, "base64").toString("utf8")).toBe(hiddenContent);
    expect(snapshot.librarySelections).toEqual(pins);
  });
});

it("checks prerequisites without borrowing another skill's config key", async () => {
  const { options, stateDir, lib } = fixture();
  const saved = await lib.save({
    slug: "prerequisite",
    expectedRevision: null,
    content:
      '---\nname: prerequisite\ndescription: Requires explicitly configured inputs\nmetadata: {"openclaw":{"skillKey":"someone-elses-key","requires":{"env":["OPENCLAW_SKILL_LIBRARY_FIXTURE_REQUIRED"],"config":["channels.fixture.enabled"]}}}\n---\n# Prerequisite\n',
  });
  const selected = loadSkillLibrarySelection(await lib.seed(), options);
  expect(selected[0]?.metadata?.skillKey).toBe(saved.entry.name);
  expect(selected[0]?.metadata?.requires).toMatchObject({
    env: ["OPENCLAW_SKILL_LIBRARY_FIXTURE_REQUIRED"],
    config: ["channels.fixture.enabled"],
  });
  const { buildSkillSnapshot } = await import("../loading/workspace-skill-prompt.js");
  const snapshot = await buildSkillSnapshot(stateDir, {
    entries: selected,
    config: {
      skills: {
        entries: {
          "someone-elses-key": {
            env: { OPENCLAW_SKILL_LIBRARY_FIXTURE_REQUIRED: "fixture-value" },
          },
        },
      },
    },
  });
  expect(snapshot.skills).toEqual([]);
});
it("binds ZIP uploads to the owner and ignores archive order and timestamps for revision identity", async () => {
  const { actor, options, lib } = fixture();
  const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
  const { default: JSZip } = await import("jszip");
  const revisions: string[] = [];
  const script = "#!/bin/sh\nprintf ready";
  const resourcePath = `${"nested/".repeat(15)}data.bin`;
  for (const index of [0, 1]) {
    const zip = new JSZip();
    const files: Array<[string, string | Buffer]> = [
      ["SKILL.md", content],
      [resourcePath, Buffer.from([0, 255, 128])],
      ["scripts/task.sh", script],
    ];
    for (const [file, bytes] of index ? files.toReversed() : files) {
      zip.file(`wrapped/${file}`, bytes, {
        date: new Date(2020 + index, 0, 1),
        unixPermissions: file.endsWith(".sh") ? 0o100755 : 0o100644,
      });
    }
    const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
    const begun = await lib.begin(bytes, `zip-${index}`);
    await expect(lib.chunk(begun.uploadId, bytes, bob)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(lib.chunk(begun.uploadId, bytes)).resolves.toEqual({
      ...begun,
      offset: bytes.length,
    });
    await expect(lib.commit(begun.uploadId, bob)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const saved = await lib.commit(begun.uploadId);
    if (!("entry" in saved)) {
      throw new Error("Expected publication receipt");
    }
    revisions.push(saved.entry.revision);
    const read = await lib.read(saved.entry.skillId);
    expect(read.content).toBe(content);
    expect(read.files).toEqual([
      { path: resourcePath, content: "AP+A", encoding: "base64", executable: false },
      {
        path: "scripts/task.sh",
        content: Buffer.from(script).toString("base64"),
        encoding: "base64",
        executable: true,
      },
    ]);
    expect(await lib.commit(begun.uploadId)).toMatchObject({
      state: "unchanged",
      entry: { skillId: saved.entry.skillId },
    });
  }
  expect(revisions[0]).toBe(revisions[1]);
});
it("reserves pending import capacity for other profiles without counting completed receipts", async () => {
  const { actor, options, lib } = fixture();
  const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
  const charlie = actor(ensureProfileForEmail("charlie@example.test", options).id);
  const bytes = await zipBytes();
  const completed = await lib.begin(bytes, "completed");
  await lib.chunk(completed.uploadId, bytes);
  const receipt = await lib.commit(completed.uploadId);
  if (!("entry" in receipt)) {
    throw new Error("Expected completed import receipt");
  }
  for (let index = 0; index < 15; index++) {
    await lib.begin(bytes, `alice-pending-${index}`);
  }
  const profileRace = await Promise.allSettled(
    ["first", "second"].map((slug) => lib.begin(bytes, slug)),
  );
  expect(profileRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(profileRace.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "LIMIT" },
  });
  await expect(lib.begin(bytes, "over-profile-limit")).rejects.toMatchObject({ code: "LIMIT" });
  for (let index = 0; index < 15; index++) {
    await lib.begin(bytes, `bob-pending-${index}`, bob);
  }
  const globalRace = await Promise.allSettled(
    [bob, charlie].map((authority) => lib.begin(bytes, "last-slot", authority)),
  );
  expect(globalRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(globalRace.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "LIMIT" },
  });
  await expect(lib.begin(bytes, "over-global-limit", charlie)).rejects.toMatchObject({
    code: "LIMIT",
  });
  await expect(lib.commit(completed.uploadId)).resolves.toMatchObject({
    state: "unchanged",
    entry: { skillId: receipt.entry.skillId },
  });
  expect((await lib.list()).entries.map((entry) => entry.skillId)).toEqual([receipt.entry.skillId]);
});

it("counts merged upload owners together while preserving completion and expiry", async () => {
  const { alice, actor, options, lib } = fixture();
  const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
  const bytes = await zipBytes();
  const begun = await lib.begin(bytes, "before-merge", bob);
  for (let index = 0; index < 8; index++) {
    await lib.begin(bytes, `alice-${index}`);
    await lib.begin(bytes, `bob-${index}`, bob);
  }
  linkEmail("bob@example.test", alice.profileId!, options);
  // Durable upload owners and retained connections may still carry Bob's pre-merge ID.
  for (const authority of [alice, bob]) {
    await expect(lib.begin(bytes, "after-merge", authority)).rejects.toMatchObject({
      code: "LIMIT",
    });
  }
  await lib.chunk(begun.uploadId, bytes);
  await expect(lib.commit(begun.uploadId, bob)).resolves.toMatchObject({
    state: "published",
    entry: { ownerProfileId: alice.profileId },
  });
  await expect(lib.begin(bytes, "still-full")).rejects.toMatchObject({ code: "LIMIT" });
  openOpenClawStateDatabase(options)
    .db.prepare("UPDATE skill_library_uploads SET expires_at = 1")
    .run();
  await expect(lib.begin(bytes, "after-expiry", bob)).resolves.toMatchObject({ offset: 0 });
  await expect(lib.commit(begun.uploadId)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

it("rejects a compressed oversized ZIP member at extraction before publishing a skill", async () => {
  const { lib } = fixture();
  const bytes = await zipBytes(true);
  expect(bytes.length).toBeLessThan(4096);
  const begun = await lib.begin(bytes, "oversized");
  await expect(lib.chunk(begun.uploadId, bytes)).resolves.toEqual({
    ...begun,
    offset: bytes.length,
  });
  await expect(lib.commit(begun.uploadId)).rejects.toMatchObject({
    code: "INVALID_BUNDLE",
    message:
      "failed to extract archive: ArchiveLimitError: archive entry extracted size exceeds limit",
  });
  expect((await lib.list()).entries).toEqual([]);
  expect(await lib.seed()).toEqual([]);
});
it("bounds growing team defaults without stopping session creation", async () => {
  const { actor, options, lib } = fixture();
  const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
  for (let index = 0; index < 65; index += 1) {
    const saved = await lib.save({ slug: `team-${index}`, content, expectedRevision: null });
    await lib.change(saved.entry, "share");
  }
  const library = await lib.list(bob);
  const selected = await lib.seed(bob);
  expect(library.defaultSelectionNotice).toContain("detach");
  expect(selected).toHaveLength(64);
  const revisionReads = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(openOpenClawStateDatabase(options).db),
    ["revisions"],
    (sql) =>
      sql.startsWith("select ") && sql.includes('from "skill_library_revisions"')
        ? "revisions"
        : null,
  );
  try {
    const ordered = selected.toReversed();
    expect(loadSkillLibrarySelection(ordered, options).map((entry) => entry.skill.name)).toEqual(
      ordered.map((pin) => pin.name),
    );
    expect(revisionReads.counts.revisions).toBe(1);
    expect(revisionReads.rowCounts.revisions).toBe(64);
  } finally {
    revisionReads.restore();
  }
  const omitted = library.entries.find(
    (entry) => !selected.some((pin) => pin.skillId === entry.skillId),
  )!;
  const fewer = await lib.select(
    selected,
    { sessionKey: "test", action: "detach", skillId: selected[0]!.skillId },
    bob,
  );
  expect(
    await lib.select(
      fewer,
      { sessionKey: "test", action: "attach", skillId: omitted.skillId },
      bob,
    ),
  ).toHaveLength(64);
});
