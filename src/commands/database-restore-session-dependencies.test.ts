import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { requireGit } from "../agents/worktrees/git.js";
import { formatCliJsonFailure } from "../cli/failure-output.js";
import { readResolvedSessionEntryInWorker } from "../config/sessions/session-accessor.entry-read-runtime.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { captureWorkspaceSnapshot } from "../gateway/worker-environments/workspace-manifest-worker.js";
import {
  workerWorkspaceResultStaging,
  withStagedWorkerWorkspaceResult,
} from "../gateway/worker-environments/workspace-result-staging.js";
import { getNodeSqliteKysely, executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { prepareSkillLibraryBundle, skillLibraryRevisionDir } from "../skills/library/bundle.js";
import { loadSkillLibrarySelection } from "../skills/library/selection.js";
import { ensureSkillLibrarySchema } from "../skills/library/store.js";
import { captureDatabaseArtifact } from "../snapshot/database-backup.js";
import { ensureSessionRepositoryWorkspaceSchema } from "../state/openclaw-state-db-schema-additive.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { mergeProfiles } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { restoreSessionDependencies } from "./database-restore-session-dependencies.js";

let state: OpenClawTestState;
let input: string;
let seal: string;
let profileId: string;
const skillId = randomUUID();
const workspaceId = randomUUID();
const sessionId = randomUUID();
const sessionKey = "agent:main:recovery";
const content =
  "---\nname: recovered\ndescription: Selected recovery guide\n---\n# Original instructions\n";
const skill = prepareSkillLibraryBundle([{ path: "SKILL.md", content }]);
const checkpointRef = "refs/openclaw/worker-results/recovered";
const git = (root: string, ...args: string[]) =>
  requireGit(
    root,
    [
      "-c",
      "user.name=Recovery Test",
      "-c",
      "user.email=recovery@example.invalid",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    { timeoutMs: 10_000 },
  );

beforeAll(async () => {
  state = await createOpenClawTestState({ layout: "state-only", scenario: "minimal" });
  await state.writeConfig({
    plugins: { enabled: false },
    agents: { entries: { main: { workspace: state.workspaceDir } } },
  });
  input = state.path("bundle");
  await fs.mkdir(path.join(input, "skill-revision"), { recursive: true });
  await fs.writeFile(path.join(input, "skill-revision", "SKILL.md"), content);
  const root = path.join(input, "workspace.git");
  await fs.mkdir(root);
  await git(root, "init", "--quiet");
  await fs.writeFile(path.join(root, "tracked.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "base");
  const baseCommit = await git(root, "rev-parse", "HEAD");
  const base = await captureWorkspaceSnapshot({ root, baseCommit });
  await fs.writeFile(path.join(root, "tracked.txt"), "uncommitted retained edit\n");
  const current = await captureWorkspaceSnapshot({ root, baseCommit });
  await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
    root,
    stagingRoot: root,
    stagedResultRef: checkpointRef,
    baseManifestRef: base.manifestRef,
    currentManifestRef: current.manifestRef,
    baseManifestRaw: base.rawManifest,
    currentManifestRaw: current.rawManifest,
  });
  const profile = ensureProfileForEmail("recovery@example.invalid", { env: state.env });
  profileId = profile.id;
  const database = openOpenClawStateDatabase({ env: state.env });
  ensureSkillLibrarySchema({ database, env: state.env }, () => {});
  ensureSessionRepositoryWorkspaceSchema(database.db);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const query = getNodeSqliteKysely<DB>(db);
      executeSqliteQuerySync(
        db,
        query.insertInto("skill_library_entries").values({
          skill_id: skillId,
          owner_profile_id: profile.id,
          author_profile_id: profile.id,
          slug: "recovered",
          current_revision: skill.revision,
          shared: 1,
          enabled: 1,
          removed: 0,
          created_at: 1,
          updated_at: 1,
        }),
      );
      executeSqliteQuerySync(
        db,
        query.insertInto("skill_library_revisions").values({
          skill_id: skillId,
          revision: skill.revision,
          description: skill.description,
          files_json: JSON.stringify(skill.files.map(({ bytes: _bytes, ...file }) => file)),
          created_at: 1,
        }),
      );
      executeSqliteQuerySync(
        db,
        query.insertInto("session_repository_workspaces").values({
          workspace_id: workspaceId,
          agent_id: "main",
          session_key: sessionKey,
          url: "https://example.invalid/repository.git",
          requested_ref: null,
          run_setup_script: 0,
          base_commit: baseCommit,
          base_manifest_hash: base.manifestRef,
          branch: "openclaw/recovered",
          checkpoint_ref: checkpointRef,
          manifest_hash: current.manifestRef,
          revision: 1,
          created_at_ms: 1,
          updated_at_ms: 1,
          disk_authority_json: null,
        }),
      );
    },
    { database },
  );
  await closeOpenClawStateDatabaseAsync();
  const shared = path.join(input, "shared.sqlite");
  await fs.copyFile(state.statePath("state/openclaw.sqlite"), shared);
  const source = await captureDatabaseArtifact(shared);
  const request = JSON.stringify({
    version: 1,
    sourceSha256: source.sha256,
    profileId: profile.id,
    agentId: "main",
    sessionKey,
    sessionId,
    skillId,
    skillRevision: skill.revision,
    workspaceId,
  });
  await fs.writeFile(path.join(input, "request.json"), request);
  seal = createHash("sha256").update(request).digest("hex");
  const destination = openOpenClawStateDatabase({ env: state.env });
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const query = getNodeSqliteKysely<DB>(db);
      executeSqliteQuerySync(db, query.deleteFrom("skill_library_revisions"));
      executeSqliteQuerySync(db, query.deleteFrom("skill_library_entries"));
      executeSqliteQuerySync(db, query.deleteFrom("session_repository_workspaces"));
    },
    { database: destination },
  );
  await replaceSessionEntry(
    { storePath: path.join(state.sessionsDir(), "sessions.json"), sessionKey, env: state.env },
    {
      sessionId,
      updatedAt: 1,
      repositoryWorkspaceId: workspaceId,
      skillLibrarySelections: [
        { skillId, revision: skill.revision, name: "recovered", ownerProfileId: profileId },
      ],
    },
  );
  await closeOpenClawStateDatabaseAsync();
});
afterAll(async () => {
  await state?.cleanup();
});

it("preserves invalid source config diagnostics and repair guidance", async () => {
  const config = await fs.readFile(state.configPath, "utf8");
  try {
    await state.writeConfig({ gateway: { port: "not-a-number" } });
    const error = await restoreSessionDependencies({ input, sha256: seal }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({
      code: "INVALID_CONFIG",
      recovery: "doctor",
      message: expect.stringContaining(state.configPath),
      details: expect.stringContaining("gateway.port"),
    });
    expect(formatCliJsonFailure(error).error.message).toContain("openclaw doctor --fix");
    expect(await fs.readFile(state.configPath, "utf8")).toContain("not-a-number");
  } finally {
    await fs.writeFile(state.configPath, config);
  }
});

it.each(["foreign profile", "reassigned skill"])(
  "refuses %s without changing rows, grants, or publishing artifacts",
  async (conflict) => {
    const other = ensureProfileForEmail("other@example.invalid", { env: state.env });
    const requestBytes = await fs.readFile(path.join(input, "request.json"), "utf8");
    const request = JSON.parse(requestBytes);
    const selectedProfile = conflict === "foreign profile" ? other.id : profileId;
    request.profileId = selectedProfile;
    const changedRequest = JSON.stringify(request);
    await fs.writeFile(path.join(input, "request.json"), changedRequest);
    await replaceSessionEntry(
      { storePath: path.join(state.sessionsDir(), "sessions.json"), sessionKey, env: state.env },
      {
        sessionId,
        updatedAt: 1,
        repositoryWorkspaceId: workspaceId,
        skillLibrarySelections: [
          { skillId, revision: skill.revision, name: "recovered", ownerProfileId: selectedProfile },
        ],
      },
    );
    const database = openOpenClawStateDatabase({ env: state.env });
    if (conflict === "reassigned skill") {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db).insertInto("skill_library_entries").values({
              skill_id: skillId,
              owner_profile_id: other.id,
              author_profile_id: other.id,
              slug: "recovered",
              current_revision: skill.revision,
              shared: 0,
              enabled: 1,
              removed: 0,
              created_at: 2,
              updated_at: 2,
            }),
          );
        },
        { database },
      );
    }
    const readRows = () => {
      const { db } = openOpenClawStateDatabase({ env: state.env });
      return {
        entries: db.prepare("SELECT * FROM skill_library_entries ORDER BY skill_id").all(),
        revisions: db
          .prepare("SELECT * FROM skill_library_revisions ORDER BY skill_id, revision")
          .all(),
        workspaces: db
          .prepare("SELECT * FROM session_repository_workspaces ORDER BY workspace_id")
          .all(),
        profiles: db.prepare("SELECT * FROM user_profiles ORDER BY id").all(),
        identities: db
          .prepare("SELECT * FROM user_profile_identities ORDER BY provider, subject")
          .all(),
        emails: db.prepare("SELECT * FROM user_profile_emails ORDER BY email").all(),
      };
    };
    const before = readRows();
    const sessionScope = { cfg: {}, env: state.env, agentId: "main", sessionKey };
    const sessionBefore = await readResolvedSessionEntryInWorker(sessionScope);
    await closeOpenClawStateDatabaseAsync();
    const destinations = [
      skillLibraryRevisionDir(skillId, skill.revision, state.env),
      state.statePath("state/repository-workspaces", workspaceId + ".git"),
    ];
    try {
      await expect(
        restoreSessionDependencies({
          input,
          sha256: createHash("sha256").update(changedRequest).digest("hex"),
        }),
      ).rejects.toThrow(
        conflict === "foreign profile" ? "Selected skill owner" : "Existing skill ownership",
      );
      expect(readRows()).toEqual(before);
      expect(await readResolvedSessionEntryInWorker(sessionScope)).toEqual(sessionBefore);
      await closeOpenClawStateDatabaseAsync();
      for (const destination of destinations) {
        await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      const current = openOpenClawStateDatabase({ env: state.env });
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .deleteFrom("skill_library_entries")
              .where("skill_id", "=", skillId),
          );
        },
        { database: current },
      );
      await closeOpenClawStateDatabaseAsync();
      await Promise.all(
        destinations.map((destination) => fs.rm(destination, { recursive: true, force: true })),
      );
      await fs.writeFile(path.join(input, "request.json"), requestBytes);
      await replaceSessionEntry(
        { storePath: path.join(state.sessionsDir(), "sessions.json"), sessionKey, env: state.env },
        {
          sessionId,
          updatedAt: 1,
          repositoryWorkspaceId: workspaceId,
          skillLibrarySelections: [
            { skillId, revision: skill.revision, name: "recovered", ownerProfileId: profileId },
          ],
        },
      );
    }
  },
);

it("restores a merged owner's selected revision and checkpoint privately and replays without overwrite", async () => {
  await expect(restoreSessionDependencies({ input, sha256: "0".repeat(64) })).rejects.toThrow(
    "checksum",
  );
  expect(
    await fs
      .stat(skillLibraryRevisionDir(skillId, skill.revision, state.env))
      .catch(() => undefined),
  ).toBeUndefined();
  const sourceRoot = path.join(input, "workspace.git");
  const originalRef = await git(sourceRoot, "rev-parse", checkpointRef);
  const originalMessage = await git(sourceRoot, "show", "-s", "--format=%B", checkpointRef);
  const savedMessage = path.join(input, "checkpoint-message");
  await fs.writeFile(savedMessage, originalMessage);
  await fs.writeFile(path.join(sourceRoot, "tracked.txt"), "tampered checkpoint bytes\n");
  await git(sourceRoot, "add", "tracked.txt");
  const badTree = await git(sourceRoot, "write-tree");
  const badCommit = await git(sourceRoot, "commit-tree", badTree, "-F", savedMessage);
  await git(sourceRoot, "update-ref", checkpointRef, badCommit);
  await expect(restoreSessionDependencies({ input, sha256: seal })).rejects.toThrow("payload");
  await git(sourceRoot, "update-ref", checkpointRef, originalRef);
  const canonical = ensureProfileForEmail("canonical@example.invalid", { env: state.env });
  mergeProfiles(profileId, canonical.id, { env: state.env });
  profileId = canonical.id;
  const request = JSON.parse(await fs.readFile(path.join(input, "request.json"), "utf8"));
  request.profileId = profileId;
  const canonicalRequest = JSON.stringify(request);
  await fs.writeFile(path.join(input, "request.json"), canonicalRequest);
  seal = createHash("sha256").update(canonicalRequest).digest("hex");
  await replaceSessionEntry(
    { storePath: path.join(state.sessionsDir(), "sessions.json"), sessionKey, env: state.env },
    {
      sessionId,
      updatedAt: 1,
      repositoryWorkspaceId: workspaceId,
      skillLibrarySelections: [
        { skillId, revision: skill.revision, name: "recovered", ownerProfileId: profileId },
      ],
    },
  );
  await closeOpenClawStateDatabaseAsync();
  const result = await restoreSessionDependencies({ input, sha256: seal });
  expect(result).toMatchObject({ ok: true, skillRestored: true, workspaceRestored: true });
  expect(
    await fs.readFile(
      path.join(skillLibraryRevisionDir(skillId, skill.revision, state.env), "SKILL.md"),
      "utf8",
    ),
  ).toBe(content);
  expect(
    loadSkillLibrarySelection(
      [{ skillId, revision: skill.revision, name: "recovered", ownerProfileId: profileId }],
      {
        env: state.env,
      },
    ),
  ).toHaveLength(1);
  const artifact = state.statePath("state/repository-workspaces", workspaceId + ".git");
  await withStagedWorkerWorkspaceResult(
    { root: artifact, stagedResultRef: checkpointRef },
    async (restored) => {
      expect(restored.changedEntryCount).toBe(1);
      expect(await fs.readdir(restored.stagingRoot)).toHaveLength(1);
    },
  );
  const database = openOpenClawStateDatabase({ env: state.env });
  expect(
    database.db
      .prepare(
        "SELECT owner_profile_id, shared, enabled FROM skill_library_entries WHERE skill_id=?",
      )
      .get(skillId),
  ).toEqual({ owner_profile_id: profileId, shared: 0, enabled: 0 });
  await closeOpenClawStateDatabaseAsync();
  await expect(restoreSessionDependencies({ input, sha256: seal })).resolves.toMatchObject({
    skillRestored: false,
    workspaceRestored: false,
  });
  const changed = openOpenClawStateDatabase({ env: state.env });
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("session_repository_workspaces")
          .set({ branch: "user/current" })
          .where("workspace_id", "=", workspaceId),
      );
    },
    { database: changed },
  );
  await closeOpenClawStateDatabaseAsync();
  await expect(restoreSessionDependencies({ input, sha256: seal })).rejects.toThrow("conflicts");
});
