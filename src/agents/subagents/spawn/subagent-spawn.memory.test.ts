import { afterEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../../../config/sessions/session-actor-storage-binding.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory subagent spawn opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory subagent spawn allocated a database worker");
  }),
}));
// mock-isolation: Keep real session writes without initializing the spawn barrel's Gateway/channel state.
vi.mock("./subagent-spawn.runtime.js", async () => ({
  ...(await import("../../../config/sessions/session-accessor.sqlite-entry.js")),
}));

afterEach(() => memorySessionActorOwners.reset());

it.each(["main", "research"])(
  "creates a child in the selected %s memory owner and preserves parent lineage",
  async (targetAgentId) => {
    const parentKey = "agent:main:dashboard:incognito-spawn-parent";
    const childKey = `agent:${targetAgentId}:dashboard:incognito-spawn-child`;
    const parent = memorySessionActorOwners.get({
      agentId: "main",
      path: "/synthetic/spawn/agents/main/sessions/incognito.sqlite",
    });
    const childOwner =
      targetAgentId === "main"
        ? parent
        : memorySessionActorOwners.get({
            agentId: targetAgentId,
            path: `/synthetic/spawn/agents/${targetAgentId}/sessions/incognito.sqlite`,
          });
    // The selected parent namespace must not capture another state root's matching agent.
    const foreign = memorySessionActorOwners.get({
      agentId: targetAgentId,
      path: `/synthetic/foreign/agents/${targetAgentId}/sessions/incognito.sqlite`,
    });
    const actor = await parent.acquire(
      { database: parent.identity, sessionKey: parentKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    const authority = { assertCurrent() {}, authorize() {} };
    const initialized = await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: {
          entry: {
            sessionId: "parent-session",
            lifecycleRevision: "parent-lifecycle",
            updatedAt: 1,
            incognito: true,
            skillLibrarySelections: [
              { skillId: "skill", revision: "revision", name: "skill", ownerProfileId: null },
            ],
          },
        },
      },
      authority,
    );
    expect(initialized.kind).toBe("committed");
    const result = await runWithSessionActorStorage(
      { actor, authority, agentId: "main", path: parent.path },
      () =>
        createInitialSubagentSession({
          cfg: {},
          requesterAgentId: "main",
          targetAgentId,
          requesterInternalKey: parentKey,
          childSessionKey: childKey,
          incognito: true,
          expectedParentSessionId: "parent-session",
          creationPolicy: { actor: { type: "agent", id: "main" } },
          completionOwnerSessionKey: parentKey,
          modelPatch: {},
          collect: false,
        }),
    );
    expect(result.status).toBe("ok");
    expect(childOwner.readSession(childKey, authority)?.entry).toMatchObject({
      incognito: true,
      spawnedBy: parentKey,
      parentSessionKey: parentKey,
      completionOwnerSessionKey: parentKey,
      skillLibrarySelections: [
        { skillId: "skill", revision: "revision", name: "skill", ownerProfileId: null },
      ],
    });
    expect(parent.readSession(parentKey, authority)?.entry?.sessionId).toBe("parent-session");
    expect(foreign.readSession(childKey, authority)).toBeUndefined();
  },
);
