import path from "node:path";
import { expect, test, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as transcriptWorker from "../../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { registerProjectRegistry } from "../../projects/project-registry.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { retainUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { projectsHandlers as registeredProjectsHandlers } from "./projects.js";
import { initializeRepository, invokeProjectMethod } from "./projects.test-support.js";

test("projects.list returns only the caller's deterministic resolved recents", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  let releaseCatalog: (() => void) | undefined;
  let projection: SessionRowProjection | undefined;
  try {
    const repo = await initializeRepository(state.root);
    const project = await registerProjectRegistry({ path: repo, name: "Registered" });
    const sourceProfile = ensureProfileForEmail("source@example.test");
    const targetProfile = ensureProfileForEmail("target@example.test");
    const foreignProfile = ensureProfileForEmail("foreign@example.test");
    const actor = { type: "human" as const, source: "profile" as const, id: sourceProfile.id };
    const repository = getSessionRepositoryWorkspaceStore().create({
      agentId: "main",
      sessionKey: "agent:main:cloud",
      url: "https://github.com/octocat/hello-world.git",
      assertCurrent: () => {},
    });
    const entries: Array<{
      key: string;
      updatedAt: number;
      projectId?: string;
      spawnedCwd?: string;
      repositoryWorkspaceId?: string;
      archivedAt?: number;
    }> = [
      { key: "agent:main:a", updatedAt: 500, projectId: project.id },
      { key: "agent:main:b", updatedAt: 500, projectId: project.id },
      { key: "agent:main:cloud", updatedAt: 450, repositoryWorkspaceId: repository.workspaceId },
      {
        key: "agent:main:c",
        updatedAt: 400,
        projectId: "stale",
        spawnedCwd: "/work/scratch",
        archivedAt: 1,
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        key: `agent:main:folder-${index}`,
        updatedAt: 300 - index,
        spawnedCwd: `/work/folder-${index}`,
      })),
    ];
    for (const entry of entries) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: entry.key },
        {
          sessionId: `session-${entry.key.split(":").at(-1)}`,
          updatedAt: entry.updatedAt,
          createdActor: actor,
          archivedAt: entry.archivedAt,
          ...(entry.projectId ? { projectId: entry.projectId } : {}),
          ...(entry.spawnedCwd ? { spawnedCwd: entry.spawnedCwd } : {}),
          ...(entry.repositoryWorkspaceId
            ? { repositoryWorkspaceId: entry.repositoryWorkspaceId }
            : {}),
        },
      );
    }
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:other" },
      {
        sessionId: "session-other",
        updatedAt: 1_000,
        createdActor: { type: "human", source: "profile", id: "profile-bob" },
        spawnedCwd: "/work/private-bob",
      },
    );
    replaceSessionEntrySync(
      {
        agentId: "main",
        sessionKey: "agent:main:dashboard:incognito-recent",
        storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
      },
      {
        sessionId: "incognito-recent",
        updatedAt: 350,
        createdActor: actor,
        incognito: true,
        execCwd: "/work/incognito",
      },
    );
    const cfg = { agents: { list: [{ id: "main", default: true, workspace: "/workspace" }] } };
    linkEmail("source@example.test", targetProfile.id);
    releaseCatalog = retainUserProfileCatalog();
    const readResult = await invokeProjectMethod(
      "projects.list",
      {},
      cfg,
      ["operator.read"],
      targetProfile.id,
    );
    if (!readResult?.payload) {
      throw new Error("projects.list did not return recents");
    }
    expect((readResult.payload as { recents?: unknown[] }).recents).toEqual([
      { kind: "project", projectId: project.id, displayName: "Registered" },
    ]);
    const writeResult = await invokeProjectMethod(
      "projects.list",
      {},
      cfg,
      ["operator.write"],
      targetProfile.id,
    );
    const expectedRecents = [
      { kind: "project", projectId: project.id, displayName: "Registered" },
      { kind: "repository", url: repository.url, displayName: "hello-world" },
      { kind: "folder", folder: "/work/scratch", displayName: "scratch" },
      { kind: "folder", folder: "/work/incognito", displayName: "incognito" },
      ...Array.from({ length: 4 }, (_, index) => ({
        kind: "folder",
        folder: `/work/folder-${index}`,
        displayName: `folder-${index}`,
      })),
    ];
    expect((writeResult?.payload as { recents?: unknown[] } | undefined)?.recents).toEqual(
      expectedRecents,
    );
    projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    do {
      await projection.ensureMaterialized();
    } while (projection.needsMaterialization);
    const workerReads = vi.spyOn(transcriptWorker, "withSessionHistoryWorkerDatabases");
    try {
      for (const [scope, expected] of [
        ["operator.read", readResult],
        ["operator.write", writeResult],
      ] as const) {
        expect(
          await invokeProjectMethod(
            "projects.list",
            {},
            cfg,
            [scope],
            targetProfile.id,
            registeredProjectsHandlers,
            projection,
          ),
        ).toEqual(expected);
      }
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:updated-recent" },
        {
          sessionId: "updated-recent",
          updatedAt: 2_000,
          createdActor: actor,
          spawnedCwd: "/work/updated",
        },
      );
      const updated = await invokeProjectMethod(
        "projects.list",
        {},
        cfg,
        ["operator.write"],
        targetProfile.id,
        registeredProjectsHandlers,
        projection,
      );
      expect(updated?.payload).toMatchObject({
        recents: [
          { kind: "folder", folder: "/work/updated", displayName: "updated" },
          ...expectedRecents.slice(0, 7),
        ],
      });
      expect(workerReads.mock.calls.length).toBe(0);
    } finally {
      workerReads.mockRestore();
    }
    const tiedKeys = ["agent:main:e\u0301", "agent:main:é"] as const;
    expect(tiedKeys[0].localeCompare(tiedKeys[1])).toBe(0);
    for (const [index, sessionKey] of tiedKeys.entries()) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: `tie-${index}`,
          updatedAt: 3_000,
          createdActor: actor,
          spawnedCwd: `/work/tie-${index}`,
        },
      );
    }
    do {
      await projection.ensureMaterialized();
    } while (projection.needsMaterialization);
    const tiedRecents = [
      ...tiedKeys.map((_, index) => ({
        kind: "folder",
        folder: `/work/tie-${index}`,
        displayName: `tie-${index}`,
      })),
      { kind: "folder", folder: "/work/updated", displayName: "updated" },
      ...expectedRecents.slice(0, 5),
    ];
    const workerGolden = await invokeProjectMethod(
      "projects.list",
      { includeObserved: true },
      cfg,
      ["operator.write"],
      targetProfile.id,
    );
    expect((workerGolden?.payload as { recents?: unknown[] } | undefined)?.recents).toEqual(
      tiedRecents,
    );
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: tiedKeys[0] },
      {
        sessionId: "tie-0",
        updatedAt: 3_000,
        createdActor: actor,
        spawnedCwd: "/work/tie-0",
        label: "Updated without changing recency",
      },
    );
    const afterPublication = await invokeProjectMethod(
      "projects.list",
      {},
      cfg,
      ["operator.write"],
      targetProfile.id,
      registeredProjectsHandlers,
      projection,
    );
    expect((afterPublication?.payload as { recents?: unknown[] } | undefined)?.recents).toEqual(
      tiedRecents,
    );
    const anonymous = await invokeProjectMethod("projects.list", {}, cfg, ["operator.read"]);
    expect(anonymous?.payload).not.toHaveProperty("recents");
    const external = new (requireNodeSqlite().DatabaseSync)(openOpenClawStateDatabase().path);
    try {
      external
        .prepare("UPDATE user_profiles SET merged_into = ? WHERE id = ?")
        .run(foreignProfile.id, sourceProfile.id);
    } finally {
      external.close();
    }
    const afterAliasChange = await invokeProjectMethod(
      "projects.list",
      {},
      cfg,
      ["operator.write"],
      targetProfile.id,
      registeredProjectsHandlers,
      projection,
    );
    expect(afterAliasChange?.payload).toMatchObject({ recents: [] });
  } finally {
    projection?.dispose();
    releaseCatalog?.();
    await state.cleanup();
  }
});

test("projects.list preserves exact-path ranking, locale ties, and the pre-access recent limit", async () => {
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
    const projectRecent = (projectId: string, displayName: string) => ({
      kind: "project",
      projectId,
      displayName,
    });
    const cases = [
      { agent: "main", folder: repo, expected: [projectRecent("workspace:main", "registered")] },
      { agent: "work", folder: repo, expected: [projectRecent("workspace:work", "registered")] },
      { agent: "other", folder: repo, expected: [projectRecent(registered.id, "Registered")] },
      {
        agent: "main",
        sessionKey: "global",
        folder: repo,
        expected: [projectRecent(registered.id, "Registered")],
      },
      {
        agent: "main",
        folder: otherWorkspace,
        expected: [projectRecent("workspace:other", "other")],
      },
      {
        agent: "main",
        folder: localeWorkspaceDir,
        expected: [projectRecent(localeWorkspace, "locale")],
      },
      { agent: "main", folder: "/work/ties", expected: [projectRecent(tieIds[0], "First tie")] },
      {
        agent: "main",
        folder: repo,
        projectId: registered.id,
        expected: [projectRecent(registered.id, "Registered")],
      },
      {
        agent: "main",
        folder: `${repo}/`,
        expected: [{ kind: "folder", folder: `${repo}/`, displayName: "registered" }],
      },
      {
        agent: "main",
        folder: repo,
        projectId: registered.id,
        repositoryWorkspaceId: "missing-workspace",
        expected: [],
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const profile = ensureProfileForEmail(`ranking-${index}@example.test`);
      replaceSessionEntrySync(
        {
          agentId: entry.agent,
          sessionKey:
            ("sessionKey" in entry ? entry.sessionKey : undefined) ??
            `agent:${entry.agent}:ranking-${index}`,
        },
        {
          sessionId: `ranking-${index}`,
          updatedAt: 100,
          createdActor: { type: "human", source: "profile", id: profile.id },
          spawnedCwd: entry.folder,
          ...("projectId" in entry ? { projectId: entry.projectId } : {}),
          ...("repositoryWorkspaceId" in entry
            ? { repositoryWorkspaceId: entry.repositoryWorkspaceId }
            : {}),
        },
      );
      const result = await invokeProjectMethod(
        "projects.list",
        {},
        cfg,
        ["operator.write"],
        profile.id,
      );
      expect(result).toMatchObject({ ok: true, payload: { recents: entry.expected } });
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

test.each([
  ["POSIX", "/Users/dev/projects/posix-project", "posix-project"],
  ["POSIX with a trailing separator", "/Users/dev/projects/posix-project/", "posix-project"],
  ["Windows", "C:\\Users\\dev\\projects\\windows-project", "windows-project"],
  [
    "Windows with a trailing separator",
    "C:\\Users\\dev\\projects\\windows-project\\",
    "windows-project",
  ],
  ["mixed separators", "C:\\Users/dev\\projects/mixed-project/", "mixed-project"],
] as const)("projects.list names folder recents from %s paths", async (_, folder, displayName) => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
  try {
    const profile = ensureProfileForEmail("windows-recents@example.test");
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:windows" },
      {
        sessionId: "session-windows",
        updatedAt: 900,
        createdActor: { type: "human", source: "profile", id: profile.id },
        spawnedCwd: folder,
      },
    );
    const result = await invokeProjectMethod(
      "projects.list",
      {},
      { agents: { list: [{ id: "main", default: true, workspace: "/workspace" }] } },
      ["operator.write"],
      profile.id,
    );
    expect((result?.payload as { recents?: unknown[] } | undefined)?.recents).toEqual([
      {
        kind: "folder",
        folder,
        displayName,
      },
    ]);
  } finally {
    await state.cleanup();
  }
});
