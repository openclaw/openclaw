import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import * as sessionStorePaths from "../../../config/sessions/session-store-path.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  bindInProcessSessionRun,
  takeInProcessFreshChildSession,
} from "../../../gateway/in-process-session-run.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSubagentSessionContext } from "./subagent-spawn-context.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";
import * as spawnRuntime from "./subagent-spawn.runtime.js";

it.each(["creation", "fork"] as const)(
  "keeps the selected physical store when its alias changes before child %s",
  async (operation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "main";
      const parentSessionKey = "agent:main:parent";
      const childSessionKey = "agent:main:subagent:retarget-child";
      const original = openOpenClawAgentDatabase({
        agentId,
        path: state.statePath("original", "store.sqlite"),
      });
      const successor = openOpenClawAgentDatabase({
        agentId,
        path: state.statePath("successor", "store.sqlite"),
      });
      for (const [database, source] of [
        [original, "original"],
        [successor, "successor"],
      ] as const) {
        const sessionId = `${source}-parent`;
        writeSessionEntry(database, parentSessionKey, {
          sessionId,
          updatedAt: 1,
          totalTokens: 1,
          totalTokensFresh: true,
          totalTokensVersion: 1,
        });
        if (operation === "fork") {
          await replaceTranscriptEvents(
            { agentId, sessionKey: parentSessionKey, sessionId, storePath: database.path },
            [
              { type: "session", version: 3, id: sessionId, timestamp: "2026-09-26T00:00:00Z" },
              {
                type: "message",
                id: "user-message",
                parentId: null,
                message: { role: "user", content: `${source} context` },
              },
              {
                type: "message",
                id: "assistant-message",
                parentId: "user-message",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: `${source} reply` }],
                  api: "openai-responses",
                  provider: "openai",
                  model: "gpt-5.4",
                  stopReason: "stop",
                  timestamp: 1,
                },
              },
            ],
          );
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
                if (params.key === parentSessionKey) {
                  expect(target.readSource?.path).toBe(original.path);
                  await moveAlias();
                }
                return target;
              });
      try {
        const result =
          operation === "creation"
            ? await createFromParent({
                cfg,
                requesterAgentId: agentId,
                targetAgentId: agentId,
                childSessionKey,
                incognito: false,
                requesterInternalKey: parentSessionKey,
                creationPolicy: { actor: { type: "agent", id: agentId } },
                completionOwnerSessionKey: parentSessionKey,
                modelPatch: {},
                collect: false,
              })
            : await prepareSubagentSessionContext({
                cfg,
                contextMode: "fork",
                requesterAgentId: agentId,
                targetAgentId: agentId,
                requesterInternalKey: parentSessionKey,
                childSessionKey,
              });
        expect(result).toMatchObject({ status: "ok" });
        expect(aliasMoved).toBe(true);
        const originalChild = loadSessionEntry({
          agentId,
          sessionKey: childSessionKey,
          storePath: original.path,
        });
        const successorChild = loadSessionEntry({
          agentId,
          sessionKey: childSessionKey,
          storePath: successor.path,
        });
        expect({
          original: originalChild?.sessionId,
          successor: successorChild?.sessionId,
        }).toEqual({
          original: expect.any(String),
          successor: undefined,
        });
        if (operation === "fork") {
          expect(result).toMatchObject({ mode: "fork" });
          expect(
            await loadTranscriptEvents({
              agentId,
              sessionKey: childSessionKey,
              sessionId: originalChild!.sessionId,
              storePath: original.path,
            }),
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "message",
                message: { role: "user", content: "original context" },
              }),
            ]),
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
// Spawn parameters for a same-agent child of `sessionKey`; lineage facts come from overrides.
function lineageSpawnParams(
  sessionKey: string,
  childSessionKey: string,
  lineage: { expectedParentSessionId?: string; senderIsOwner: boolean },
) {
  return {
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
    ...lineage,
  };
}

// Writes the parent row again whenever the child's store target is prepared.
function writeParentDuringChildPrepare(
  childSessionKey: string,
  write: () => Promise<unknown>,
): { mockRestore: () => void } {
  const preparePhysical = sessionStorePaths.preparePhysicalSessionStorePath;
  return vi
    .spyOn(sessionStorePaths, "preparePhysicalSessionStorePath")
    .mockImplementation(async (...args) => {
      if (args[0].sessionKey === childSessionKey) {
        await write();
      }
      return preparePhysical(...args);
    });
}

it("rejects replaced parent incarnations and never retains a reused child grant", async () => {
  await withOpenClawTestState({ label: "spawn-parent-identity" }, async () => {
    const sessionKey = "agent:main:parent";
    const childSessionKey = "agent:main:subagent:child";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const scope = { storePath, sessionKey };
    const spawn = (lineage: { expectedParentSessionId?: string; senderIsOwner: boolean }) =>
      createFromParent(lineageSpawnParams(sessionKey, childSessionKey, lineage));
    const child = () => loadSessionEntry({ storePath, sessionKey: childSessionKey });
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
    const sessionKey = "agent:main:parent";
    const childSessionKey = "agent:main:subagent:child";
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
    // The parent's own turn keeps writing its row while the child is prepared.
    let refreshedParent: SessionEntry | null = null;
    const prepare = writeParentDuringChildPrepare(childSessionKey, async () => {
      refreshedParent = await upsertSessionEntryCore(scope, {
        updatedAt: 2,
        totalTokens: 10,
        skillLibrarySelections: [],
      });
    });
    try {
      const result = await createFromParent(
        lineageSpawnParams(sessionKey, childSessionKey, {
          expectedParentSessionId: "parent-first",
          senderIsOwner: true,
        }),
      );
      expect(result).toMatchObject({ status: "ok" });
      const child = loadSessionEntry({ storePath, sessionKey: childSessionKey });
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
    } finally {
      prepare.mockRestore();
    }
  });
});

it("spawns from a parent without a stored row, as before lineage receipts", async () => {
  await withOpenClawTestState({ label: "spawn-rowless-parent" }, async () => {
    const sessionKey = "agent:main:rowless-parent";
    const childSessionKey = "agent:main:subagent:rowless-child";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    expect(
      await createFromParent(
        lineageSpawnParams(sessionKey, childSessionKey, {
          expectedParentSessionId: "turn-session",
          senderIsOwner: true,
        }),
      ),
    ).toMatchObject({ status: "ok" });
    expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toMatchObject({
      spawnedBy: sessionKey,
      spawnedBySenderIsOwner: false,
    });
  });
});

async function createFromParent(
  input: Omit<Parameters<typeof createInitialSubagentSession>[0], "parentTarget">,
) {
  const parentTarget = await spawnRuntime.resolveGatewaySessionStoreTargetInWorker({
    cfg: input.cfg,
    key: input.requesterInternalKey,
    agentId: input.requesterAgentId,
    projection: "full",
  });
  return createInitialSubagentSession({ ...input, parentTarget });
}

it.each(["sqlite", "json"] as const)(
  "creates the child in its configured %s store independently of the parent's history",
  async (extension) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:historical-parent";
      const childSessionKey = "agent:main:subagent:configured-child";
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
      const result = await createInitialSubagentSession({
        ...lineageSpawnParams(sessionKey, childSessionKey, { senderIsOwner: true }),
        cfg: { session: { store: configured } },
        parentTarget,
        firstAdmission: { group: {} },
      });
      expect(result).toMatchObject({ status: "ok", freshChild: { storePath: configured } });
      expect(
        loadSessionEntry({
          agentId: "main",
          sessionKey: childSessionKey,
          storePath: state.statePath(
            "current",
            extension === "json" ? "store.main.sqlite" : "store.sqlite",
          ),
        }),
      ).toMatchObject({ spawnedBy: sessionKey, sessionId: expect.any(String) });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath: historical }),
      ).toBeUndefined();
      expect(
        loadSessionEntry({ agentId: "main", sessionKey, storePath: historical }),
      ).toMatchObject({
        sessionId: "historical-parent",
      });
    });
  },
);

it("commits group and delivery facts with creation for one host-bound admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const sessionKey = "agent:main:discord:channel:group-one";
    const childSessionKey = "agent:main:subagent:fresh-child";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await upsertSessionEntryCore(
      { storePath, sessionKey },
      {
        sessionId: "parent",
        groupId: "group-one",
        groupChannel: "discord",
        space: "workspace-one",
      },
    );
    const result = await createFromParent({
      ...lineageSpawnParams(sessionKey, childSessionKey, { senderIsOwner: true }),
      firstAdmission: {
        delivery: { channel: "discord", to: "channel:group-one", accountId: "default" },
        group: { groupId: "group-one" },
      },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || !result.freshChild) {
      throw new Error("Fresh child creation did not return its committed entry");
    }
    const { entry } = result.freshChild;
    expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toMatchObject({
      sessionId: entry.sessionId,
      createdVia: "spawn",
      parentSessionKey: sessionKey,
      groupId: "group-one",
      groupChannel: "discord",
      space: "workspace-one",
      sessionStartedAt: expect.any(Number),
      lastInteractionAt: expect.any(Number),
      delivery: {
        kind: "external",
        context: { channel: "discord", to: "channel:group-one", accountId: "default" },
      },
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
