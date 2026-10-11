import { afterEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../../../config/sessions/session-actor-storage-binding.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
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

afterEach(() => {
  memorySessionActorOwners.reset();
  vi.unstubAllEnvs();
});

it.each([
  { targetAgentId: "main", bound: true },
  { targetAgentId: "research", bound: true },
  { targetAgentId: "research", bound: false },
])(
  "creates a child with lineage in the $targetAgentId memory owner (bound=$bound)",
  async ({ targetAgentId, bound }) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/spawn");
    const parentKey = "agent:main:dashboard:incognito-spawn-parent";
    const childKey = `agent:${targetAgentId}:dashboard:incognito-spawn-child`;
    const parent = memorySessionActorOwners.get({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });
    const childPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: targetAgentId });
    // The selected parent namespace must not capture another state root's matching agent.
    const foreign = memorySessionActorOwners.get({
      agentId: targetAgentId,
      path: resolveIncognitoOpenClawAgentSqlitePath({
        agentId: targetAgentId,
        env: { OPENCLAW_STATE_DIR: "/synthetic/foreign" },
      }),
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
    const create = () =>
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
      });
    const result = await (bound
      ? runWithSessionActorStorage({ actor, authority, agentId: "main", path: parent.path }, create)
      : create());
    const childOwner = memorySessionActorOwners.read({ agentId: targetAgentId, path: childPath });
    expect(result.status).toBe("ok");
    expect(childOwner?.readSession(childKey, authority)?.entry).toMatchObject({
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
