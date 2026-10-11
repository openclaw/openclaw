import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../../../config/sessions/session-actor-storage-binding.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { createSubagentControllerRead } from "../registry/subagent-controller-read.js";
import {
  readAcpSpawnParentDeliveryContext,
  resolveAcpSpawnRequesterState,
} from "./acp-spawn-requester.js";
import {
  resolvePersistedSubagentToolPolicyEnvelope,
  resolveStoredSubagentCapabilities,
  resolveSubagentCapabilityStore,
} from "./subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { createSubagentSessionStore } from "./subagent-session-store.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";
import * as spawnRuntime from "./subagent-spawn.runtime.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory subagent capability lookup opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory subagent capability lookup allocated a database worker");
  }),
}));
vi.mock("./subagent-spawn.runtime.js", async () => ({
  upsertSessionEntryCore: (
    await import("../../../config/sessions/session-accessor.sqlite-entry.js")
  ).upsertSessionEntryCore,
}));

const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
type MemoryOwner = ReturnType<typeof memorySessionActorOwners.get>;
let parent: MemoryOwner;
let sibling: MemoryOwner;
const skillLibrarySelections = [
  { skillId: "spawn-skill", revision: "revision-one", name: "spawn-skill", ownerProfileId: null },
];

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/subagent-capabilities");
  parent = memorySessionActorOwners.get({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
  });
  sibling = memorySessionActorOwners.get({
    agentId: "research",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "research" }),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  memorySessionActorOwners.reset();
  vi.unstubAllEnvs();
});

async function create(
  owner: MemoryOwner,
  name: string,
  patch: Partial<SessionEntry> = {},
  kind: "dashboard" | "subagent" = "dashboard",
) {
  const sessionKey = `agent:${owner.agentId}:${kind}:incognito-${name}`;
  const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  try {
    const result = await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: {
          entry: {
            sessionId: name,
            lifecycleRevision: "original",
            updatedAt: 1,
            incognito: true,
            ...patch,
          },
        },
      },
      authority,
    );
    expect(result.kind).toBe("committed");
  } finally {
    await actor.release();
  }
  return sessionKey;
}

async function withMemorySource<T>(owner: MemoryOwner, sessionKey: string, run: () => Promise<T>) {
  const actor = await owner.acquireExisting(sessionKey, lifetime);
  if (!actor) {
    throw new Error("Expected memory session fixture");
  }
  try {
    return await runWithSessionActorStorage(
      { actor, authority, agentId: owner.agentId, path: owner.path },
      run,
    );
  } finally {
    await actor.release();
  }
}

it.each([false, true])(
  "resolves current capability envelopes and cross-agent depth (bound=%s)",
  async (bound) => {
    const parentKey = await create(parent, "capability-parent", { spawnDepth: 2 });
    const childKey = await create(sibling, "capability-child", {
      spawnedBy: parentKey,
      spawnDepth: 3,
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read"],
      inheritedToolDeny: ["exec"],
    });
    const read = async () => {
      const store = resolveSubagentCapabilityStore(childKey, { cfg: {} });
      expect(resolveStoredSubagentCapabilities(childKey, { cfg: {}, store }).depth).toBe(3);
      expect(
        resolvePersistedSubagentToolPolicyEnvelope(childKey, { cfg: {}, store }),
      ).toMatchObject({
        spawnedBy: parentKey,
        inheritedToolAllow: ["read"],
        inheritedToolDeny: ["exec"],
      });
      await withMemorySource(sibling, childKey, () =>
        patchSessionEntryCore({ storePath: sibling.path, sessionKey: childKey }, () => ({
          spawnDepth: undefined,
          inheritedToolDeny: ["exec", "write"],
        })),
      );
      expect(
        resolvePersistedSubagentToolPolicyEnvelope(childKey, { cfg: {}, store }),
      ).toMatchObject({
        inheritedToolDeny: ["exec", "write"],
      });
      expect(getSubagentDepthFromSessionStore(childKey, { cfg: {} })).toBe(3);
      const explicitStore = createSubagentSessionStore(sibling.path, "research");
      expect(explicitStore.getById("capability-child")).toMatchObject({
        sessionId: "capability-child",
        inheritedToolAllow: ["read"],
      });
      expect(explicitStore.getById("capability-parent")).toBeUndefined();
      expect(explicitStore.getById("missing-id")).toBeUndefined();
      expect(explicitStore.get("agent:research:dashboard:incognito-missing")).toBeUndefined();
    };
    await (bound ? withMemorySource(sibling, childKey, read) : read());
  },
);

it.each([
  { crossAgent: false, revoked: false },
  { crossAgent: false, revoked: true },
  { crossAgent: true, revoked: false },
  { crossAgent: true, revoked: true },
])(
  "guards exact parent skills before child commit ($crossAgent, revoked=$revoked)",
  async ({ crossAgent, revoked }) => {
    const name = `skills-${crossAgent}-${revoked}`;
    const parentKey = await create(parent, name, { skillLibrarySelections });
    const childOwner = crossAgent ? sibling : parent;
    const childKey = `agent:${childOwner.agentId}:dashboard:incognito-child-${name}`;
    const upsert = spawnRuntime.upsertSessionEntryCore;
    vi.spyOn(spawnRuntime, "upsertSessionEntryCore").mockImplementation(async (...args) => {
      await withMemorySource(parent, parentKey, () =>
        patchSessionEntryCore({ storePath: parent.path, sessionKey: parentKey }, () => ({
          updatedAt: 2,
          totalTokens: 10,
          ...(revoked ? { skillLibrarySelections: [] } : {}),
        })),
      );
      return upsert(...args);
    });
    const result = await withMemorySource(parent, parentKey, () =>
      createInitialSubagentSession({
        cfg: {},
        requesterAgentId: parent.agentId,
        targetAgentId: childOwner.agentId,
        requesterInternalKey: parentKey,
        childSessionKey: childKey,
        incognito: true,
        expectedParentSessionId: name,
        senderIsOwner: true,
        creationPolicy: { actor: { type: "agent", id: parent.agentId } },
        completionOwnerSessionKey: parentKey,
        admissionPatch: {
          spawnDepth: 1,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
        },
        inheritedToolAllowlist: ["read"],
        inheritedToolDenylist: ["exec"],
        modelPatch: {},
        collect: false,
      }),
    );
    expect(result).toMatchObject(
      revoked
        ? { status: "error", error: expect.stringContaining("Parent skill selection changed") }
        : { status: "ok" },
    );
    const child = childOwner.readSession(childKey, authority)?.entry;
    if (revoked) {
      expect(child).toBeUndefined();
    } else {
      expect(child).toMatchObject({
        spawnedBy: parentKey,
        spawnedBySessionId: name,
        parentSessionLifecycleRevision: "original",
        skillLibrarySelections,
        inheritedToolAllow: ["read"],
        inheritedToolDeny: ["exec"],
      });
    }
  },
);

it("reads unbound ACP requester delivery and heartbeat routing from memory", async () => {
  const parentKey = await create(parent, "heartbeat", {
    delivery: {
      kind: "external",
      route: {
        channel: "telegram",
        accountId: "default",
        target: { to: "123", chatType: "direct" },
      },
      origin: { provider: "telegram", to: "123" },
      context: { channel: "telegram", to: "123", accountId: "default" },
    },
  });
  expect(
    await readAcpSpawnParentDeliveryContext({
      parentSessionKey: parentKey,
      requesterAgentId: parent.agentId,
    }),
  ).toMatchObject({ channel: "telegram", to: "123" });
  const requester = await resolveAcpSpawnRequesterState({
    cfg: { agents: { defaults: { heartbeat: { every: "5m", target: "last" } } } },
    parentSessionKey: parentKey,
    requesterAgentId: parent.agentId,
    ownerAgentId: sibling.agentId,
    ctx: {},
  });
  expect(requester.heartbeatRelayRouteUsable).toBe(true);
});

it("checks current memory controller depth before cancellation", async () => {
  const sessionKey = await create(parent, "controller", { spawnDepth: 1 }, "subagent");
  const controller = createSubagentControllerRead({
    config: () => ({ agents: { defaults: { subagents: { maxSpawnDepth: 3 } } } }),
    agentSessionKey: sessionKey,
    agentId: "main",
    assertCurrent() {},
  });
  try {
    await controller.prepare();
    expect(controller.read().controlScope).toBe("children");
    await withMemorySource(parent, sessionKey, () =>
      patchSessionEntryCore({ storePath: parent.path, sessionKey }, () => ({ spawnDepth: 3 })),
    );
    expect(controller.read().controlScope).toBe("none");
  } finally {
    controller.release();
  }
});
