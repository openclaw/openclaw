import path from "node:path";
import { expect, test, vi } from "vitest";
import type { ProjectRecent } from "../../../packages/gateway-protocol/src/index.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { listProjectRegistry, registerProjectRegistry } from "../../projects/project-registry.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as repositoryWorkspaces from "../../state/session-repository-workspaces.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { listProjectRecents } from "./projects-recents.js";
import { projectsHandlers as registeredProjectsHandlers } from "./projects.js";
import { initializeRepository, invokeProjectMethod } from "./projects.test-support.js";

const folderRecent = (name: string) => ({
  kind: "folder",
  folder: `/work/${name}`,
  displayName: name,
});
function expectRecents(
  result: Awaited<ReturnType<typeof invokeProjectMethod>>,
  recents: unknown[],
) {
  expect(result?.ok).toBe(true);
  expect(result?.payload).toHaveProperty("recents", recents);
}

test("folder recents deduplicate normalized nodes without merging different runners", async () => {
  const candidates = [" node-a ", "node-a", "node-b", " ", undefined].map((execNode, index) => ({
    key: `agent:main:folder-${index}`,
    agentId: "main",
    entry: { sessionId: `folder-${index}`, updatedAt: index, spawnedCwd: "/work/app", execNode },
  }));
  const usedSessions = new Set<string>();
  expect(await listProjectRecents(candidates, [], usedSessions)).toEqual([
    { kind: "folder", folder: "/work/app", displayName: "app", execNode: "node-a" },
    { kind: "folder", folder: "/work/app", displayName: "app", execNode: "node-b" },
    { kind: "folder", folder: "/work/app", displayName: "app" },
  ]);
  expect([...usedSessions]).toEqual([0, 2, 3].map((index) => `agent:main:folder-${index}`));
});

test("projects.list returns only the caller's deterministic resolved recents", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  const memoryLocation = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
  };
  let releaseCatalog: (() => void) | undefined;
  let projection: SessionRowProjection | undefined;
  try {
    const repo = await initializeRepository(state.root);
    const project = await registerProjectRegistry({ path: repo, name: "Registered" });
    const sourceProfile = ensureProfileForEmail("source@example.test");
    const targetProfile = ensureProfileForEmail("target@example.test");
    const foreignProfile = ensureProfileForEmail("foreign@example.test");
    const actor = { type: "human" as const, source: "profile" as const, id: sourceProfile.id };
    const seed = (key: string, entry: Partial<InternalSessionEntry> & { updatedAt: number }) =>
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { sessionId: `session-${key.split(":").at(-1)}`, createdActor: actor, ...entry },
      );
    const repository = await repositoryWorkspaces.getSessionRepositoryWorkspaceStore().create({
      agentId: "main",
      sessionKey: "global",
      url: "https://github.com/octocat/hello-world.git",
      assertCurrent: () => {},
    });
    for (const key of ["agent:main:a", "agent:main:b"]) {
      seed(key, { updatedAt: 500, projectId: project.id });
    }
    seed("global", { updatedAt: 450, repositoryWorkspaceId: repository.workspaceId });
    seed("agent:main:wrong-owner", {
      updatedAt: 449,
      repositoryWorkspaceId: repository.workspaceId,
    });
    seed("agent:main:c", {
      updatedAt: 400,
      projectId: "stale",
      spawnedCwd: "/work/scratch",
      archivedAt: 1,
    });
    for (let index = 0; index < 8; index++) {
      seed(`agent:main:folder-${index}`, {
        updatedAt: 300 - index,
        spawnedCwd: `/work/folder-${index}`,
      });
    }
    seed("agent:main:other", {
      sessionId: "session-other",
      updatedAt: 1_000,
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      spawnedCwd: "/work/private-bob",
    });
    await replaceSessionEntry(
      {
        agentId: "main",
        sessionKey: "agent:main:dashboard:incognito-recent",
        storePath: memoryLocation.path,
      },
      {
        sessionId: "incognito-recent",
        updatedAt: 350,
        createdActor: actor,
        incognito: true,
        execCwd: "/work/incognito",
      },
    );
    const cfg = { agents: { entries: { main: { workspace: "/workspace" } } } };
    const list = (scopes = ["operator.write"], params = {}, projected = Boolean(projection)) =>
      invokeProjectMethod(
        "projects.list",
        params,
        cfg,
        scopes,
        targetProfile.id,
        projected ? registeredProjectsHandlers : undefined,
        projected ? projection : undefined,
      );
    linkEmail("source@example.test", targetProfile.id);
    releaseCatalog = (await prepareUserProfileCatalog()).release;
    const readResult = await list(["operator.read"]);
    expectRecents(readResult, [
      { kind: "project", projectId: project.id, displayName: "Registered" },
    ]);
    const writeResult = await list();
    const expectedRecents = [
      { kind: "project", projectId: project.id, displayName: "Registered" },
      { kind: "repository", url: repository.url, displayName: "hello-world" },
      folderRecent("scratch"),
      folderRecent("incognito"),
      ...Array.from({ length: 4 }, (_, index) => folderRecent(`folder-${index}`)),
    ];
    expectRecents(writeResult, expectedRecents);
    projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    do {
      await projection.ensureMaterialized();
    } while (projection.needsMaterialization);
    sessionChanges.emit({ all: true, scope: "catalog" });
    for (const [scope, expected] of [
      ["operator.read", readResult],
      ["operator.write", writeResult],
    ] as const) {
      const sql = observeHostDataSql();
      expect(await list([scope]).finally(sql.restore)).toEqual(expected);
      expect(
        sql.queries.filter((statement) =>
          /\buser_profile(?:s|_emails|_identities)\b/u.test(statement),
        ),
      ).toEqual([]);
    }
    seed("agent:main:updated-recent", {
      sessionId: "updated-recent",
      updatedAt: 2_000,
      spawnedCwd: "/work/updated",
    });
    expect((await list())?.payload).toMatchObject({
      recents: [folderRecent("updated"), ...expectedRecents.slice(0, 7)],
    });
    const tiedKeys = ["agent:main:e\u0301", "agent:main:é"] as const;
    expect(tiedKeys[0].localeCompare(tiedKeys[1])).toBe(0);
    for (const [index, sessionKey] of tiedKeys.entries()) {
      seed(sessionKey, {
        sessionId: `tie-${index}`,
        updatedAt: 3_000,
        spawnedCwd: `/work/tie-${index}`,
      });
    }
    do {
      await projection.ensureMaterialized();
    } while (projection.needsMaterialization);
    const tiedRecents = [
      ...tiedKeys.map((_, index) => folderRecent(`tie-${index}`)),
      folderRecent("updated"),
      ...expectedRecents.slice(0, 5),
    ];
    expectRecents(await list(["operator.write"], { includeObserved: true }, false), tiedRecents);
    const tieEntry = {
      sessionId: "tie-0",
      updatedAt: 3_000,
      spawnedCwd: "/work/tie-0",
    };
    seed(tiedKeys[0], {
      ...tieEntry,
      label: "Updated without changing recency",
    });
    expectRecents(await list(), tiedRecents);
    const findRepositories = repositoryWorkspaces.findSessionRepositoryWorkspaces;
    const repositoryRead = vi
      .spyOn(repositoryWorkspaces, "findSessionRepositoryWorkspaces")
      .mockImplementationOnce(async (...args) => {
        const result = await findRepositories(...args);
        seed(tiedKeys[0], { ...tieEntry, visibility: "draft" });
        const changed = projection!.capture({ agentId: "main", key: tiedKeys[0] })!;
        expect(
          projection!.readCapabilityEntry({
            agentId: "main",
            key: tiedKeys[0],
            storePath: changed.storeTarget.storePath,
          })?.entry?.visibility,
        ).toBe("draft");
        return result;
      });
    try {
      expect(await list()).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("Project access changed") },
      });
      expect(repositoryRead).toHaveBeenCalled();
    } finally {
      repositoryRead.mockRestore();
    }
    const anonymous = await invokeProjectMethod("projects.list", {}, cfg, ["operator.read"]);
    expect(anonymous?.payload).not.toHaveProperty("recents");
    const databasePath = openOpenClawStateDatabase().path;
    projection.dispose();
    projection = undefined;
    releaseCatalog();
    releaseCatalog = undefined;
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    // External repairs require offline custody; live writes use the profile owner.
    const external = new (requireNodeSqlite().DatabaseSync)(databasePath);
    try {
      external
        .prepare("UPDATE user_profiles SET merged_into = ? WHERE id = ?")
        .run(foreignProfile.id, sourceProfile.id);
    } finally {
      external.close();
    }
    projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    expect((await list())?.payload).toMatchObject({ recents: [] });
  } finally {
    projection?.dispose();
    releaseCatalog?.();
    memorySessionActorOwners.closeDatabase(memoryLocation);
    await state.cleanup();
  }
});

test("project recents preserve path ranking, folder names, locale ties, and the RPC pre-access limit", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const repo = await initializeRepository(state.root);
    const registered = await registerProjectRegistry({ path: repo, name: "Registered" });
    const otherWorkspace = path.join(state.root, "other");
    const localeWorkspaceDir = path.join(state.root, "locale");
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          main: { workspace: repo },
          work: { workspace: repo },
          other: { workspace: otherWorkspace },
          "a-b": { workspace: localeWorkspaceDir },
          a_b: { workspace: localeWorkspaceDir },
        },
      },
    };
    const localeWorkspace =
      "workspace:a-b".localeCompare("workspace:a_b") < 0 ? "workspace:a-b" : "workspace:a_b";
    const tieIds = ["é", "e\u0301"] as const;
    expect(tieIds[0].localeCompare(tieIds[1])).toBe(0);
    for (const [index, id] of tieIds.entries()) {
      openOpenClawStateDatabase()
        .db.prepare(
          `INSERT INTO projects
            (id, display_name, repo_root, source, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, 'registered', 1, 1)`,
        )
        .run(id, index === 0 ? "First tie" : "Second tie", "/work/ties");
    }
    const projects = await listProjectRegistry(cfg);
    const projectRecent = (projectId: string, displayName: string): ProjectRecent => ({
      kind: "project",
      projectId,
      displayName,
    });
    type RankingCase = [
      agent: string,
      folder: string,
      expected: ProjectRecent[],
      association?: { sessionKey?: string; projectId?: string; repositoryWorkspaceId?: string },
    ];
    const cases: RankingCase[] = [
      ["main", repo, [projectRecent("workspace:main", "registered")]],
      ["work", repo, [projectRecent("workspace:work", "registered")]],
      ["other", repo, [projectRecent(registered.id, "Registered")]],
      ["main", repo, [projectRecent(registered.id, "Registered")], { sessionKey: "global" }],
      ["main", otherWorkspace, [projectRecent("workspace:other", "other")]],
      ["main", localeWorkspaceDir, [projectRecent(localeWorkspace, "locale")]],
      ["main", "/work/ties", [projectRecent(tieIds[0], "First tie")]],
      ["main", repo, [projectRecent(registered.id, "Registered")], { projectId: registered.id }],
      ["main", `${repo}/`, [{ kind: "folder", folder: `${repo}/`, displayName: "registered" }]],
      ["main", repo, [], { projectId: registered.id, repositoryWorkspaceId: "missing-workspace" }],
      ...(
        [
          ["C:\\Users\\dev\\projects\\windows-project\\", "windows-project"],
          ["C:\\Users/dev\\projects/mixed-project/", "mixed-project"],
        ] as const
      ).map(([folder, displayName]): RankingCase => [
        "main",
        folder,
        [{ kind: "folder", folder, displayName }],
      ]),
    ];
    for (const [index, [agent, folder, expected, association]] of cases.entries()) {
      const { sessionKey = `agent:${agent}:ranking-${index}`, ...entry } = association ?? {};
      const candidate = {
        agentId: agent,
        key: sessionKey,
        entry: { sessionId: `ranking-${index}`, updatedAt: 100, spawnedCwd: folder, ...entry },
      };
      expect(await listProjectRecents([candidate], projects, new Set())).toEqual(expected);
    }

    const limited = ensureProfileForEmail("limited-recents@example.test");
    for (let index = 0; index < 9; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:limited-${index}` },
        {
          sessionId: `limited-${index}`,
          updatedAt: 100 - index,
          createdActor: { type: "human", source: "profile", id: limited.id },
          spawnedCwd: index === 8 ? repo : `/work/folder-${index}`,
        },
      );
    }
    const read = await invokeProjectMethod("projects.list", {}, cfg, ["operator.read"], limited.id);
    expect(read).toMatchObject({ ok: true, payload: { recents: [] } });
  } finally {
    await state.cleanup();
  }
});
