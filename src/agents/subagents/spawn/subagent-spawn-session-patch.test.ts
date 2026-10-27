import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import * as sessionStorePaths from "../../../config/sessions/session-store-path.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  bindInProcessSessionRun,
  takeInProcessFreshChildSession,
} from "../../../gateway/in-process-session-run.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { insertRegistryWorktree } from "../../worktrees/registry.js";
import { prepareSubagentSessionContext } from "./subagent-spawn-context.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";
import * as spawnRuntime from "./subagent-spawn.runtime.js";

const readEntry = (storePath: string, sessionKey: string) =>
  loadSessionEntry({ agentId: "main", storePath, sessionKey });
const sessionKey = "agent:main:parent";
const childSessionKey = "agent:main:subagent:child";
type SpawnInput = Parameters<typeof createInitialSubagentSession>[0];
async function spawn(patch: Partial<SpawnInput> = {}) {
  const input = {
    cfg: {},
    requesterAgentId: "main",
    targetAgentId: "main",
    childSessionKey,
    incognito: false,
    requesterInternalKey: sessionKey,
    creationPolicy: { actor: { type: "agent" as const, id: "main" } },
    completionOwnerSessionKey: sessionKey,
    modelPatch: {},
    collect: false,
    ...patch,
  };
  const parentTarget =
    input.parentTarget ??
    (await spawnRuntime.resolveGatewaySessionStoreTargetInWorker({
      cfg: input.cfg,
      key: input.requesterInternalKey,
      agentId: input.requesterAgentId,
      projection: "full",
    }));
  return createInitialSubagentSession({ ...input, parentTarget });
}

async function seedManagedParent(workspaceDir: string, storePath: string) {
  const worktree = {
    id: "managed-parent-worktree",
    name: "managed-parent",
    repoFingerprint: "synthetic-source",
    repoRoot: workspaceDir,
    path: workspaceDir,
    branch: "openclaw/parent",
    baseRef: "main",
    ownerKind: "session" as const,
    ownerId: sessionKey,
    createdAt: 1,
    lastActiveAt: 1,
  };
  await insertRegistryWorktree(process.env, worktree);
  await upsertSessionEntryCore(
    { agentId: "main", storePath, sessionKey },
    {
      sessionId: "managed-parent-session",
      lifecycleRevision: "managed-parent-generation",
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
    },
  );
}

it("records managed workspace inheritance only for new selector-free same-agent helpers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await seedManagedParent(state.workspaceDir, storePath);
    const inherited = {
      spawnedWorkspaceDir: state.workspaceDir,
      sessionPermissionPolicy: { mode: "workspace" as const, root: state.workspaceDir },
    };
    const child = await spawn(inherited);
    expect(child).toMatchObject({ status: "ok" });
    expect(readEntry(storePath, childSessionKey)).toMatchObject({
      inheritedWorktreeId: "managed-parent-worktree",
      spawnedBySessionId: "managed-parent-session",
      parentSessionLifecycleRevision: "managed-parent-generation",
      spawnedWorkspaceDir: state.workspaceDir,
      sessionRoot: state.workspaceDir,
      permissionMode: "workspace",
    });
    expect(readEntry(storePath, childSessionKey)).not.toHaveProperty("worktree");

    const nestedKey = "agent:main:subagent:nested";
    expect(
      await spawn({
        ...inherited,
        requesterInternalKey: childSessionKey,
        childSessionKey: nestedKey,
      }),
    ).toMatchObject({ status: "ok" });
    expect(readEntry(storePath, nestedKey)).toMatchObject({
      inheritedWorktreeId: "managed-parent-worktree",
      spawnedBy: childSessionKey,
    });

    for (const [key, selection] of [
      ["agent:main:subagent:explicit", { targetAgentId: "main", spawnedCwd: state.workspaceDir }],
      ["agent:worker:subagent:other-agent", { targetAgentId: "worker" }],
    ] as const) {
      expect(await spawn({ ...inherited, ...selection, childSessionKey: key })).toMatchObject({
        status: "ok",
      });
      expect(
        loadSessionEntry({
          agentId: selection.targetAgentId,
          storePath: resolveOpenClawAgentSqlitePath({ agentId: selection.targetAgentId }),
          sessionKey: key,
        }),
      ).not.toHaveProperty("inheritedWorktreeId");
    }

    // An old helper's path and lineage alone must not opt its descendants into sharing.
    await upsertSessionEntryCore(
      { agentId: "main", storePath, sessionKey: childSessionKey },
      { inheritedWorktreeId: undefined },
    );
    const legacyDescendant = "agent:main:subagent:legacy-descendant";
    expect(
      await spawn({
        ...inherited,
        requesterInternalKey: childSessionKey,
        childSessionKey: legacyDescendant,
      }),
    ).toMatchObject({ status: "ok" });
    expect(readEntry(storePath, legacyDescendant)).not.toHaveProperty("inheritedWorktreeId");
  });
});

it("refuses managed inheritance when the captured requester changes before child commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await seedManagedParent(state.workspaceDir, storePath);
    const preparePhysical = sessionStorePaths.preparePhysicalSessionStorePath;
    using _ = vi
      .spyOn(sessionStorePaths, "preparePhysicalSessionStorePath")
      .mockImplementation(async (...args) => {
        if (args[0].sessionKey === childSessionKey) {
          await upsertSessionEntryCore(
            { agentId: "main", storePath, sessionKey },
            { lifecycleRevision: "replaced-parent-generation" },
          );
        }
        return preparePhysical(...args);
      });
    expect(await spawn({ spawnedWorkspaceDir: state.workspaceDir })).toMatchObject({
      status: "error",
      error: expect.stringContaining("workspace"),
    });
    expect(readEntry(storePath, childSessionKey)).toBeUndefined();
  });
});

it.each(["creation", "fork"] as const)(
  "keeps the selected physical store when its alias changes before child %s",
  async (operation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "main";
      const openDatabase = (name: string) =>
        openOpenClawAgentDatabase({
          agentId,
          path: state.statePath(name, "store.sqlite"),
        });
      const original = openDatabase("original");
      const successor = openDatabase("successor");
      for (const [database, source] of [
        [original, "original"],
        [successor, "successor"],
      ] as const) {
        const sessionId = `${source}-parent`;
        writeSessionEntry(database, sessionKey, {
          sessionId,
          updatedAt: 1,
        });
        if (operation === "fork") {
          for (const message of [
            { role: "user", content: `${source} context` },
            {
              role: "assistant",
              content: [{ type: "text", text: `${source} reply` }],
              stopReason: "stop",
            },
          ]) {
            await appendTranscriptMessage(
              { agentId, sessionKey, sessionId, storePath: database.path },
              { message },
            );
          }
        }
      }
      if (operation === "fork") {
        writeSessionEntry(original, childSessionKey, { sessionId: "original-child", updatedAt: 1 });
      }
      const alias = state.statePath("selected");
      const heldAlias = state.statePath("selected-before");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(path.dirname(original.path), alias, linkType);
      const cfg = { session: { store: path.join(alias, "store.sqlite") } };
      const resolveTarget = spawnRuntime.resolveGatewaySessionStoreTargetInWorker;
      let aliasMoved = false;
      const moveAlias = async () => {
        await fs.rename(alias, heldAlias);
        aliasMoved = true;
        await fs.symlink(path.dirname(successor.path), alias, linkType);
      };
      const preparePhysical = sessionStorePaths.preparePhysicalSessionStorePath;
      const selected =
        operation === "creation"
          ? vi
              .spyOn(sessionStorePaths, "preparePhysicalSessionStorePath")
              .mockImplementation(async (...args) => {
                const physical = await preparePhysical(...args);
                if (args[0].sessionKey === childSessionKey) {
                  expect(physical).toBe(original.path);
                  await moveAlias();
                }
                return physical;
              })
          : vi
              .spyOn(spawnRuntime, "resolveGatewaySessionStoreTargetInWorker")
              .mockImplementation(async (params) => {
                const target = await resolveTarget(params);
                if (params.key === sessionKey) {
                  expect(target.readSource?.path).toBe(original.path);
                  await moveAlias();
                }
                return target;
              });
      try {
        const result =
          operation === "creation"
            ? await spawn({ cfg })
            : await prepareSubagentSessionContext({
                cfg,
                contextMode: "fork",
                requesterAgentId: agentId,
                targetAgentId: agentId,
                requesterInternalKey: sessionKey,
                childSessionKey,
              });
        const originalChild = readEntry(original.path, childSessionKey);
        expect([
          result,
          aliasMoved,
          originalChild?.sessionId,
          readEntry(successor.path, childSessionKey)?.sessionId,
        ]).toEqual([
          expect.objectContaining({ status: "ok" }),
          true,
          expect.any(String),
          undefined,
        ]);
        if (operation === "fork") {
          expect(result).toMatchObject({ mode: "fork" });
          expect(
            await loadTranscriptEvents({
              agentId,
              sessionKey: childSessionKey,
              sessionId: originalChild!.sessionId,
              storePath: original.path,
            }),
          ).toContainEqual(
            expect.objectContaining({
              type: "message",
              message: { role: "user", content: "original context" },
            }),
          );
        }
      } finally {
        selected.mockRestore();
        if (aliasMoved) {
          await fs.rm(alias, { recursive: true, force: true });
          await fs.rename(heldAlias, alias);
        }
      }
    });
  },
);
it("rejects replaced parent incarnations and never retains a reused child grant", async () => {
  await withOpenClawTestState({ label: "spawn-parent-identity" }, async () => {
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const scope = { storePath, sessionKey };
    const child = () => readEntry(storePath, childSessionKey);
    await upsertSessionEntryCore(scope, {
      sessionId: "parent-first",
      lifecycleRevision: "first",
      updatedAt: 1,
    });
    expect(
      await spawn({ expectedParentSessionId: "parent-old", senderIsOwner: true }),
    ).toMatchObject({ status: "error", error: expect.stringContaining("Parent session changed") });
    expect(child()).toBeUndefined();
    expect(
      await spawn({ expectedParentSessionId: "parent-first", senderIsOwner: true }),
    ).toMatchObject({ status: "ok" });
    expect(child()).toMatchObject({
      spawnedBySessionId: "parent-first",
      parentSessionLifecycleRevision: "first",
      spawnedBySenderIsOwner: true,
    });
    expect(await spawn({ senderIsOwner: false })).toMatchObject({ status: "ok" });
    expect(child()).toMatchObject({ spawnedBySenderIsOwner: false });
  });
});

it("inherits admitted skill pins without overwriting a parent refresh", async () => {
  await withOpenClawTestState({ label: "spawn-parent-skill-refresh" }, async () => {
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const scope = { storePath, sessionKey };
    const skillLibrarySelections = [
      {
        skillId: "spawn-skill",
        revision: "revision-one",
        name: "spawn-skill",
        ownerProfileId: null,
      },
    ];
    await upsertSessionEntryCore(scope, {
      sessionId: "parent-first",
      lifecycleRevision: "first",
      updatedAt: 1,
      skillLibrarySelections,
    });
    let refreshedParent: SessionEntry | null = null;
    const preparePhysical = sessionStorePaths.preparePhysicalSessionStorePath;
    using _ = vi
      .spyOn(sessionStorePaths, "preparePhysicalSessionStorePath")
      .mockImplementation(async (...args) => {
        if (args[0].sessionKey === childSessionKey) {
          refreshedParent = await upsertSessionEntryCore(scope, {
            updatedAt: 2,
            totalTokens: 10,
            skillLibrarySelections: [],
          });
        }
        return preparePhysical(...args);
      });

    const result = await spawn({
      expectedParentSessionId: "parent-first",
      senderIsOwner: true,
    });
    expect(result).toMatchObject({ status: "ok" });
    const child = readEntry(storePath, childSessionKey);
    expect(child).toMatchObject({
      spawnedBySessionId: "parent-first",
      spawnedBySenderIsOwner: true,
      skillLibrarySelections,
    });
    expect(refreshedParent).toMatchObject({
      totalTokens: 10,
      skillLibrarySelections: [],
    });
    expect(loadSessionEntry(scope)).toEqual(refreshedParent);
  });
});

it("spawns from a parent without a stored row, as before lineage receipts", async () => {
  await withOpenClawTestState({ label: "spawn-rowless-parent" }, async () => {
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    expect(
      await spawn({
        expectedParentSessionId: "turn-session",
        senderIsOwner: true,
      }),
    ).toMatchObject({ status: "ok" });
    expect(readEntry(storePath, childSessionKey)).toMatchObject({
      spawnedBy: sessionKey,
      spawnedBySenderIsOwner: false,
    });
  });
});

it.each(["sqlite", "json"] as const)(
  "creates the child in its configured %s store independently of the parent's history",
  async (extension) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const historical = state.statePath("history", "store.sqlite");
      const configured = state.statePath("current", `store.${extension}`);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath: historical },
        { sessionId: "historical-parent", updatedAt: 1 },
      );
      const parentTarget = await spawnRuntime.resolveGatewaySessionStoreTargetInWorker({
        cfg: { session: { store: historical } },
        key: sessionKey,
        agentId: "main",
        projection: "full",
      });
      // A legacy JSON selector must keep the registered suffix owner's routing.
      if (extension === "json") {
        openOpenClawAgentDatabase({
          agentId: "other",
          path: state.statePath("current", "store.sqlite"),
        });
      }
      const result = await spawn({
        senderIsOwner: true,
        cfg: { session: { store: configured } },
        parentTarget,
        firstAdmission: { group: {} },
      });
      expect(result).toMatchObject({ status: "ok", freshChild: { storePath: configured } });
      expect(
        readEntry(
          state.statePath("current", extension === "json" ? "store.main.sqlite" : "store.sqlite"),
          childSessionKey,
        ),
      ).toMatchObject({ spawnedBy: sessionKey, sessionId: expect.any(String) });
      expect(readEntry(historical, childSessionKey)).toBeUndefined();
      expect(readEntry(historical, sessionKey)).toMatchObject({ sessionId: "historical-parent" });
    });
  },
);

it("commits group and delivery facts with creation for one host-bound admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const groupSessionKey = "agent:main:discord:channel:group-one";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const group = { groupId: "group-one", groupChannel: "discord", space: "workspace-one" };
    const context = { channel: "discord", to: "channel:group-one", accountId: "default" };
    await upsertSessionEntryCore(
      { storePath, sessionKey: groupSessionKey },
      { sessionId: "parent", ...group },
    );
    const result = await spawn({
      requesterInternalKey: groupSessionKey,
      completionOwnerSessionKey: groupSessionKey,
      senderIsOwner: true,
      firstAdmission: {
        delivery: context,
        group: { groupId: group.groupId },
      },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || !result.freshChild) {
      throw new Error("Fresh child creation did not return its committed entry");
    }
    const { entry } = result.freshChild;
    expect(readEntry(storePath, childSessionKey)).toMatchObject({
      sessionId: entry.sessionId,
      createdVia: "spawn",
      parentSessionKey: groupSessionKey,
      ...group,
      sessionStartedAt: expect.any(Number),
      lastInteractionAt: expect.any(Number),
      delivery: { kind: "external", context },
    });
    const request = bindInProcessSessionRun(
      { sessionKey: childSessionKey, idempotencyKey: "first-run" },
      {
        sessionKey: childSessionKey,
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision ?? null,
        runId: "first-run",
        freshChild: result.freshChild,
      },
    );
    expect(takeInProcessFreshChildSession({ ...request })).toBeUndefined();
    expect(takeInProcessFreshChildSession(request)).toEqual(result.freshChild);
    expect(takeInProcessFreshChildSession(request)).toBeUndefined();
  });
});
