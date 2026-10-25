import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../../../config/sessions/session-actor-storage-binding.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { normalizeSessionDeliveryState } from "../../../utils/delivery-context.shared.js";
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
// mock-isolation: Exercise memory session creation without loading the spawn barrel's Gateway/channel runtime.
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
  const owner = (agentId: string) =>
    memorySessionActorOwners.get({
      agentId,
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId }),
    });
  parent = owner("main");
  sibling = owner("research");
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
    const entry = {
      sessionId: name,
      lifecycleRevision: "original",
      updatedAt: 1,
      incognito: true,
      ...patch,
    } satisfies SessionEntry;
    const result = await actor.storage!.mutate(
      { type: "session.entry.create", input: { entry } },
      authority,
    );
    expect(result.kind).toBe("committed");
  } finally {
    await actor.release();
  }
  return sessionKey;
}

async function withMemorySource<T>(owner: MemoryOwner, sessionKey: string, run: () => Promise<T>) {
  const actor = expectDefined(
    await owner.acquireExisting(sessionKey, lifetime),
    "memory session fixture",
  );
  try {
    return await runWithSessionActorStorage(
      { actor, authority, agentId: owner.agentId, path: owner.path },
      run,
    );
  } finally {
    await actor.release();
  }
}

const patchMemory = (owner: MemoryOwner, sessionKey: string, patch: Partial<SessionEntry>) =>
  withMemorySource(owner, sessionKey, () =>
    patchSessionEntryCore({ storePath: owner.path, sessionKey }, () => patch),
  );

it.each([
  { bound: false, crossAgent: false },
  { bound: false, crossAgent: true },
  { bound: true, crossAgent: false },
  { bound: true, crossAgent: true },
])(
  "inherits current memory capabilities (bound=$bound, crossAgent=$crossAgent)",
  async ({ bound, crossAgent }) => {
    const parentKey = await create(parent, "capability-parent", {
      spawnDepth: 2,
      skillLibrarySelections,
    });
    const childOwner = crossAgent ? sibling : parent;
    const childKey = `agent:${childOwner.agentId}:dashboard:incognito-child`;
    const parentEntry = expectDefined(
      parent.readSession(parentKey, authority)?.entry,
      "parent entry",
    );
    const result = await withMemorySource(parent, parentKey, () =>
      createInitialSubagentSession({
        cfg: {},
        requesterAgentId: parent.agentId,
        targetAgentId: childOwner.agentId,
        requesterInternalKey: parentKey,
        parentTarget: {
          agentId: parent.agentId,
          storePath: parent.path,
          canonicalKey: parentKey,
          storeKeys: [parentKey],
          store: { [parentKey]: parentEntry },
        },
        childSessionKey: childKey,
        incognito: true,
        expectedParentSessionId: "capability-parent",
        senderIsOwner: true,
        creationPolicy: { actor: { type: "agent", id: parent.agentId } },
        completionOwnerSessionKey: parentKey,
        inheritedToolAllowlist: ["read"],
        inheritedToolDenylist: ["exec"],
        modelPatch: {},
        collect: false,
      }),
    );
    expect(result).toMatchObject({ status: "ok" });
    await patchMemory(childOwner, childKey, { spawnDepth: 3 });
    const child = expectDefined(childOwner.readSession(childKey, authority)?.entry, "child entry");
    expect(child).toMatchObject({
      spawnedBySessionId: "capability-parent",
      parentSessionLifecycleRevision: "original",
      skillLibrarySelections,
    });
    const read = async () => {
      const store = resolveSubagentCapabilityStore(childKey, { cfg: {} });
      const policy = () => resolvePersistedSubagentToolPolicyEnvelope(childKey, { cfg: {}, store });
      expect(resolveStoredSubagentCapabilities(childKey, { cfg: {}, store }).depth).toBe(3);
      expect(policy()).toMatchObject({
        spawnedBy: parentKey,
        inheritedToolAllow: ["read"],
        inheritedToolDeny: ["exec"],
      });
      await patchMemory(childOwner, childKey, { inheritedToolDeny: ["exec", "write"] });
      expect(policy()).toMatchObject({ inheritedToolDeny: ["exec", "write"] });
      await patchMemory(childOwner, childKey, { spawnDepth: undefined });
      expect(policy()).toBeUndefined();
      expect(getSubagentDepthFromSessionStore(childKey, { cfg: {} })).toBe(3);
      const explicitStore = createSubagentSessionStore(childOwner.path, childOwner.agentId);
      expect(explicitStore.getById(child.sessionId)).toMatchObject({
        sessionId: child.sessionId,
        inheritedToolAllow: ["read"],
      });
      if (crossAgent) {
        expect(explicitStore.getById("capability-parent")).toBeUndefined();
      }
      expect(explicitStore.getById("missing-id")).toBeUndefined();
      expect(explicitStore.get("agent:research:dashboard:incognito-missing")).toBeUndefined();
    };
    await (bound ? withMemorySource(childOwner, childKey, read) : read());
  },
);

it("reads unbound ACP requester delivery from memory", async () => {
  const parentKey = await create(parent, "delivery", {
    delivery: normalizeSessionDeliveryState({
      context: { channel: "telegram", to: "123", accountId: "default" },
    }),
  });
  expect(
    await readAcpSpawnParentDeliveryContext({
      parentSessionKey: parentKey,
      requesterAgentId: parent.agentId,
    }),
  ).toMatchObject({ channel: "telegram", to: "123" });
  const requester = await resolveAcpSpawnRequesterState({
    cfg: {},
    parentSessionKey: parentKey,
    requesterAgentId: parent.agentId,
    ownerAgentId: sibling.agentId,
    ctx: {},
  });
  expect(requester).toMatchObject({
    isSubagentSession: false,
    hasActiveSubagentBinding: false,
    hasThreadContext: false,
  });
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
    await patchMemory(parent, sessionKey, { spawnDepth: 3 });
    expect(controller.read().controlScope).toBe("none");
  } finally {
    controller.release();
  }
});
