import "../../../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  openIncognitoTestActor,
  useIncognitoNoHostSql,
} from "../../../state/openclaw-agent-execution-incognito.test-support.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let parent: Awaited<ReturnType<typeof openIncognitoTestActor>>;
let sibling: Awaited<ReturnType<typeof openIncognitoTestActor>>;
let env: NodeJS.ProcessEnv;
const skillLibrarySelections = [
  { skillId: "spawn-skill", revision: "revision-one", name: "spawn-skill", ownerProfileId: null },
];

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("subagent-spawn-incognito-") };
  parent = await openIncognitoTestActor(env, authority);
  sibling = await openIncognitoTestActor(env, authority, "research");
});
useIncognitoNoHostSql();
afterAll(async () => {
  await sibling?.close();
  await parent?.close();
});

async function create(owner: typeof parent, name: string, patch: Partial<SessionEntry> = {}) {
  const sessionKey = `agent:${owner.agentId}:dashboard:incognito-${name}`;
  await owner.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId: name,
      lifecycleRevision: "original",
      updatedAt: 1,
      incognito: true,
      ...patch,
    },
  });
  return sessionKey;
}

it("resolves bound capability envelopes and cross-agent depth from the actor owners", async () => {
  const parentKey = await create(parent, "capability-parent", { spawnDepth: 2 });
  const childKey = await create(sibling, "capability-child", {
    spawnedBy: parentKey,
    spawnDepth: 3,
    inheritedToolPolicyVersion: 1,
    inheritedToolAllow: ["read"],
    inheritedToolDeny: ["exec"],
  });
  await withIncognitoSessionActor(sibling, async () => {
    const store = resolveSubagentCapabilityStore(childKey, { cfg: {} });
    expect(resolveStoredSubagentCapabilities(childKey, { cfg: {}, store }).depth).toBe(3);
    expect(resolvePersistedSubagentToolPolicyEnvelope(childKey, { cfg: {}, store })).toMatchObject({
      spawnedBy: parentKey,
      inheritedToolAllow: ["read"],
      inheritedToolDeny: ["exec"],
    });
    await patchSessionEntryCore({ storePath: sibling.path, sessionKey: childKey }, () => ({
      spawnDepth: undefined,
    }));
    expect(getSubagentDepthFromSessionStore(childKey, { cfg: {} })).toBe(3);
    const explicitStore = createSubagentSessionStore(sibling.path, "research");
    expect(explicitStore.getById("capability-child")).toMatchObject({
      sessionId: "capability-child",
      inheritedToolAllow: ["read"],
    });
    expect(explicitStore.getById("capability-parent")).toBeUndefined();
    expect(explicitStore.getById("missing-id")).toBeUndefined();
    expect(explicitStore.get("agent:research:dashboard:incognito-missing")).toBeUndefined();
  });
});

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
    const intercepted = vi
      .spyOn(spawnRuntime, "upsertSessionEntryCore")
      .mockImplementation(async (...args) => {
        await withIncognitoSessionBinding({ actor: parent }, () =>
          patchSessionEntryCore({ storePath: parent.path, sessionKey: parentKey }, () => ({
            updatedAt: 2,
            totalTokens: 10,
            ...(revoked ? { skillLibrarySelections: [] } : {}),
          })),
        );
        return upsert(...args);
      });
    try {
      const result = await withIncognitoSessionBinding({ actor: parent }, () =>
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
      const child = (await childOwner.sessions.read(authority, { sessionKey: childKey })).entry;
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
    } finally {
      intercepted.mockRestore();
    }
  },
);

it("reads ACP parent delivery without granting implicit relay to an ordinary session", async () => {
  const parentKey = await create(parent, "relay", {
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
  await withIncognitoSessionActor(parent, async () => {
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
    expect(requester).toMatchObject({ isSubagentSession: false, sessionRelayRouteUsable: false });
  });
});

it("preserves selected actor absence for capability and requester reads", async () => {
  const absentEnv = { OPENCLAW_STATE_DIR: tempDirs.make("subagent-absent-") };
  await withIncognitoSessionBinding(
    { kind: "absent", agentId: "main", env: absentEnv, authority },
    async () => {
      const missing = "agent:main:dashboard:incognito-absent";
      const store = createSubagentSessionStore("unused.sqlite", "main");
      expect(store.get(missing)).toBeUndefined();
      expect(store.getById(missing)).toBeUndefined();
      expect(
        await readAcpSpawnParentDeliveryContext({
          parentSessionKey: missing,
          requesterAgentId: "main",
        }),
      ).toBeUndefined();
    },
  );
});
