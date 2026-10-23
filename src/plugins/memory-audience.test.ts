import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createDeferredCore } from "../shared/deferred.js";
import { bindMemoryProvider } from "./memory-provider-adapter.js";
import type { MemoryAudience, MemoryProviderHandle } from "./memory-provider-types.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRecord } from "./status.test-helpers.js";
import { createPluginToolFactoryContext } from "./tool-factory-context.js";
import { bindPluginToolCallbacks } from "./tool-factory-runtime.js";

vi.mock("../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } = await import("./memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
vi.mock("../config/sessions/session-entry-read-runtime.js", async () => {
  const { fakeSessionEntryReadModule } = await import("./memory-audience.test-support.js");
  return fakeSessionEntryReadModule;
});

import {
  assertMemoryAudienceCurrent as assertCurrent,
  assertMemoryAudienceSession as assertSession,
  delegateMemoryAudience,
  isHostMemoryAudience,
  type MemoryAudienceResolution,
  prepareMemoryAudienceRead,
  resolveMemoryAudienceFromEntry,
} from "./memory-audience.js";
import { fakeSessionOwner, type FakeSessionRow } from "./memory-audience.test-support.js";

const AGENT_ID = "main";
const ROOT_KEY = "agent:main:root";
const CHILD_KEY = "agent:main:subagent:child";
const STORE_PATH = "/tmp/openclaw-memory-audience/main.sqlite";

function rootEntry(chatType: FakeSessionRow["chatType"] = "direct"): FakeSessionRow {
  return { sessionId: randomUUID(), lifecycleRevision: randomUUID(), chatType, updatedAt: 1 };
}

function childEntry(parent: FakeSessionRow, parentKey = ROOT_KEY): FakeSessionRow {
  return {
    sessionId: randomUUID(),
    updatedAt: 1,
    lifecycleRevision: randomUUID(),
    spawnedBy: parentKey,
    parentSessionKey: parentKey,
    spawnedBySessionId: parent.sessionId,
    parentSessionLifecycleRevision: parent.lifecycleRevision,
    spawnedBySenderIsOwner: true,
  };
}

function resolveAt(
  sessionKey: string,
  entry: FakeSessionRow,
  senderIsOwner?: boolean,
  identity: { sessionId?: string } = { sessionId: entry.sessionId },
) {
  fakeSessionOwner.rows.set(sessionKey, entry);
  return resolveMemoryAudienceFromEntry(
    {
      agentId: AGENT_ID,
      sessionKey,
      sessionId: identity.sessionId,
      senderIsOwner,
      storePath: STORE_PATH,
    },
    entry,
  );
}

function delegate(audience: MemoryAudience, sessionKey = CHILD_KEY) {
  return delegateMemoryAudience(audience, { sessionKey, storePath: STORE_PATH });
}

async function delegatedChild() {
  const root = rootEntry();
  const rootGrant = await grantAt(ROOT_KEY, root, true);
  fakeSessionOwner.rows.set(CHILD_KEY, childEntry(root));
  return { rootGrant, grant: await delegate(rootGrant.audience) };
}

function bindProvider(raw: MemoryProviderHandle, audience: MemoryAudience, signal?: AbortSignal) {
  return bindMemoryProvider(raw, "test", {
    authority: { kind: "session", sessionKey: CHILD_KEY, sandboxed: false, audience },
    assertCurrent() {},
    signal,
  });
}

async function grantAt(sessionKey: string, entry: FakeSessionRow, senderIsOwner?: boolean) {
  return requireGrant(await resolveAt(sessionKey, entry, senderIsOwner));
}

function resolveChild(parent: FakeSessionRow, child: FakeSessionRow) {
  fakeSessionOwner.rows.set(ROOT_KEY, parent);
  return resolveAt(CHILD_KEY, child, false);
}

function provider(): MemoryProviderHandle & { health: ReturnType<typeof vi.fn> } {
  return {
    capabilities: { sources: ["memory"], pagination: false, candidates: [], projectFilter: false },
    search: vi.fn(async () => ({ hits: [] })),
    get: vi.fn(async () => ({ status: "not_found" as const })),
    health: vi.fn(async () => ({ status: "ready" as const })),
    close: vi.fn(async () => {}),
  };
}

function pendingPublication(sessionKey: string) {
  const publication = createDeferredCore();
  fakeSessionOwner.publications.set(sessionKey, publication.promise);
  fakeSessionOwner.pendingKeys.add(sessionKey);
  return () => {
    fakeSessionOwner.pendingKeys.delete(sessionKey);
    fakeSessionOwner.publications.delete(sessionKey);
    publication.resolve();
  };
}

function conversation(root: FakeSessionRow) {
  return {
    kind: "conversation",
    agentId: AGENT_ID,
    sessionKey: ROOT_KEY,
    sessionId: root.sessionId,
  };
}

function requireGrant(resolution: MemoryAudienceResolution) {
  if (resolution.status !== "granted") {
    throw new Error(resolution.reason);
  }
  return resolution;
}

beforeEach(() => fakeSessionOwner.reset());

it.each([
  ["owner direct", "direct", true, false, "owner-private"],
  ["non-owner direct", "direct", false, false, "conversation"],
  ["group", "group", true, false, "conversation"],
  ["channel", "channel", true, false, "conversation"],
  ["nested private", "direct", true, true, "owner-private"],
  ["nested non-owner", "direct", false, true, "conversation"],
  ["nested group", "group", true, true, "conversation"],
] as const)("maps a %s audience", async (_name, chatType, owner, nested, expectedKind) => {
  const root = rootEntry(chatType);
  let sessionKey = ROOT_KEY;
  let entry = root;
  if (nested) {
    const child = { ...childEntry(root), spawnedBySenderIsOwner: owner };
    fakeSessionOwner.rows.set(ROOT_KEY, root);
    fakeSessionOwner.rows.set(CHILD_KEY, child);
    sessionKey = "agent:main:subagent:nested";
    entry = childEntry(child, CHILD_KEY);
  }
  const { audience } = await grantAt(sessionKey, entry, nested ? !owner : owner);
  expect(audience).toEqual(
    expectedKind === "owner-private"
      ? { kind: "owner-private", agentId: AGENT_ID }
      : conversation(root),
  );
  expect(isHostMemoryAudience(audience)).toBe(true);
  expect(Object.isFrozen(audience)).toBe(true);
});

it.each([
  ["missing parent", "stale-lineage"],
  ["missing chat type", "ineligible"],
  ["missing session id", "ineligible"],
  ["mismatched session id", "unverified"],
] as const)("denies %s", async (missing, kind) => {
  const root = rootEntry();
  const result =
    missing === "missing parent"
      ? resolveAt(CHILD_KEY, childEntry(root), true)
      : missing === "missing chat type"
        ? resolveAt(ROOT_KEY, { ...root, chatType: undefined }, true)
        : resolveAt(ROOT_KEY, root, true, {
            sessionId: missing === "missing session id" ? undefined : randomUUID(),
          });
  await expect(result).resolves.toMatchObject({ status: "denied", kind });
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("denies malformed, stale, cyclic, and cross-agent lineage", async () => {
  const mutations = [
    ["child", "spawnedBySessionId", undefined, "ineligible"],
    ["child", "spawnedBySessionId", randomUUID(), "stale-lineage"],
    ["parent", "lifecycleRevision", randomUUID(), "stale-lineage"],
    ["child", "parentSessionLifecycleRevision", undefined, "stale-lineage"],
    ["child", "parentSessionKey", "agent:main:other", "ineligible"],
    ["lineage", "spawnedBy", "agent:foreign:root", "ineligible"],
    ["cycle", "spawnedBy", CHILD_KEY, "ineligible"],
  ] as const;
  for (const [target, field, value, kind] of mutations) {
    const parent = rootEntry();
    const child = childEntry(parent);
    Reflect.set(target === "parent" ? parent : child, field, value);
    if (target === "lineage" || target === "cycle") {
      child.parentSessionKey = child.spawnedBy;
    }
    if (target === "cycle") {
      child.spawnedBySessionId = child.sessionId;
      child.parentSessionLifecycleRevision = child.lifecycleRevision;
    }
    await expect(resolveChild(parent, child)).resolves.toMatchObject({ status: "denied", kind });
  }
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("grants owner-private memory across agents only for an owner spawn from an owner direct root", async () => {
  const FOREIGN_CHILD_KEY = "agent:fm-know:subagent:child";
  const resolveForeignChild = (parent: FakeSessionRow, child: FakeSessionRow) => {
    const resolveAgentStorePath = vi.fn((agentId: string) => `/tmp/stores/${agentId}.sqlite`);
    fakeSessionOwner.rows.set(ROOT_KEY, parent);
    fakeSessionOwner.rows.set(FOREIGN_CHILD_KEY, child);
    const resolution = resolveMemoryAudienceFromEntry(
      {
        agentId: "fm-know",
        sessionKey: FOREIGN_CHILD_KEY,
        sessionId: child.sessionId,
        senderIsOwner: false,
        storePath: "/tmp/stores/fm-know.sqlite",
        resolveAgentStorePath,
      },
      child,
    );
    return { resolution, resolveAgentStorePath };
  };

  const owner = rootEntry();
  const granted = resolveForeignChild(owner, childEntry(owner));
  const grant = requireGrant(await granted.resolution);
  expect(grant.audience).toEqual({ kind: "owner-private", agentId: "fm-know" });
  expect(granted.resolveAgentStorePath).toHaveBeenCalledWith("main");
  grant.release();

  const group = rootEntry("group");
  await expect(resolveForeignChild(group, childEntry(group)).resolution).resolves.toMatchObject({
    status: "denied",
    kind: "ineligible",
  });
  const nonOwnerSpawn = { ...childEntry(owner), spawnedBySenderIsOwner: false };
  await expect(resolveForeignChild(owner, nonOwnerSpawn).resolution).resolves.toMatchObject({
    status: "denied",
    kind: "ineligible",
  });
  const reset = { ...owner, lifecycleRevision: randomUUID() };
  await expect(resolveForeignChild(reset, childEntry(owner)).resolution).resolves.toMatchObject({
    status: "denied",
    kind: "stale-lineage",
  });
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("denies lineage beyond 64 hops", async () => {
  let parentKey = ROOT_KEY;
  let parent = rootEntry();
  fakeSessionOwner.rows.set(ROOT_KEY, parent);
  for (let index = 0; index < 64; index += 1) {
    const key = `agent:main:subagent:${index}`;
    const child = childEntry(parent, parentKey);
    fakeSessionOwner.rows.set(key, child);
    parentKey = key;
    parent = child;
  }
  await expect(resolveAt(parentKey, parent, true)).resolves.toMatchObject({
    status: "denied",
    reason: "session lineage exceeds 64 hops",
  });
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("fails closed with a respawn instruction for a spawned row missing its owner receipt", async () => {
  const parent = rootEntry();
  const resolution = await resolveChild(parent, {
    ...childEntry(parent),
    spawnedBySenderIsOwner: undefined,
  });
  expect(resolution).toEqual({
    status: "denied",
    kind: "stale-lineage",
    reason: expect.stringContaining(
      `spawned session ${CHILD_KEY} predates memory lineage receipts`,
    ),
  });
  expect(resolution.status === "denied" && resolution.reason).toContain(
    "Respawn it from its parent session to restore memory access.",
  );
  expect(fakeSessionOwner.workerReads).toEqual([]);
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("grants a conversation audience to a new child of a group row without a lifecycle revision", async () => {
  // Channel-created group rows carry no lifecycle revision; the child records that absence.
  const { lifecycleRevision: _revision, ...group } = rootEntry("group");
  const child = { ...childEntry(group), parentSessionLifecycleRevision: undefined };
  fakeSessionOwner.rows.set(ROOT_KEY, group);
  const resolution = requireGrant(await resolveAt(CHILD_KEY, child, false));
  expect(resolution.audience).toEqual(conversation(group));
  assertSession(resolution.audience, CHILD_KEY);
  // A reset that gives the parent a lifecycle revision ends the child's grant.
  fakeSessionOwner.rows.set(ROOT_KEY, { ...group, lifecycleRevision: randomUUID() });
  expect(() => assertCurrent(resolution.audience)).toThrow("no longer current");
});
it.each(["reset", "removal"] as const)("revokes a child after parent %s", async (change) => {
  const parent = rootEntry();
  const resolution = requireGrant(await resolveChild(parent, childEntry(parent)));
  if (change === "reset") {
    fakeSessionOwner.rows.set(ROOT_KEY, { ...parent, lifecycleRevision: randomUUID() });
  } else {
    fakeSessionOwner.rows.delete(ROOT_KEY);
  }
  expect(() => assertCurrent(resolution.audience)).toThrow("no longer current");
  // A later write that restores the old incarnation cannot revive the grant.
  fakeSessionOwner.rows.set(ROOT_KEY, parent);
  expect(() => assertCurrent(resolution.audience)).toThrow("no longer current");
});

it("checks currency synchronously without session reads and fails closed while a write is pending", async () => {
  const { audience } = await grantAt(ROOT_KEY, rootEntry(), true);
  assertCurrent(audience);
  assertCurrent(audience);
  fakeSessionOwner.pendingKeys.add(ROOT_KEY);
  expect(() => assertCurrent(audience)).toThrow("currency is unavailable");
  fakeSessionOwner.pendingKeys.delete(ROOT_KEY);
  assertCurrent(audience);
  expect(fakeSessionOwner.workerReads).toEqual([]);
});

it("rejects a retained audience after its owner releases it", async () => {
  const { audience, release } = await grantAt(ROOT_KEY, rootEntry(), true);
  release();
  expect(() => assertCurrent(audience)).toThrow("released by its owner");
  expect(fakeSessionOwner.activeLeases).toBe(0);
});
it("binds the delegate to its child session and folds parent revocation into provider calls", async () => {
  const root = rootEntry();
  const { audience } = await grantAt(ROOT_KEY, root, true);
  fakeSessionOwner.rows.set(CHILD_KEY, { sessionId: "recall-session", updatedAt: 1 });
  const delegated = await delegate(audience);
  expect(delegated.audience).toEqual(audience);
  expect(delegated.audience).not.toBe(audience);
  expect(Object.isFrozen(delegated.audience)).toBe(true);
  expect(isHostMemoryAudience(delegated.audience)).toBe(true);
  expect(() => assertSession(audience, ROOT_KEY)).not.toThrow();
  expect(() => assertSession(delegated.audience, ROOT_KEY)).toThrow("different session");
  const raw = provider();
  const bound = bindProvider(raw, delegated.audience);
  await expect(bound.health()).resolves.toMatchObject({ status: "ready" });
  fakeSessionOwner.rows.set(ROOT_KEY, { ...root, lifecycleRevision: randomUUID() });
  await expect(bound.health()).rejects.toThrow("no longer current");
  expect(() => assertCurrent(audience)).toThrow("no longer current");
  await expect(delegate(audience, "agent:main:other")).rejects.toThrow("no longer current");
  expect(raw.health).toHaveBeenCalledTimes(1);
});

it("requires an existing child session for the same agent", async () => {
  const { audience } = await grantAt(ROOT_KEY, rootEntry(), true);
  await expect(delegate(audience)).rejects.toThrow("requires an existing child session");
  await expect(delegate(audience, "agent:other:child")).rejects.toThrow(
    "requires a session for the same agent",
  );
});
it("observes a child publication when its parent rejects preparation", async () => {
  const { rootGrant, grant } = await delegatedChild();
  const publication = createDeferredCore();
  fakeSessionOwner.publications.set(CHILD_KEY, publication.promise);
  rootGrant.release();
  try {
    expect(() => prepareMemoryAudienceRead(grant.audience)).toThrow("released by its owner");
    publication.reject(new Error("Synthetic rejected child publication"));
    // Drain the rejection turn: Vitest must see no unhandled publication failure.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  } finally {
    fakeSessionOwner.publications.delete(CHILD_KEY);
    grant.release();
  }
});

it.each(["metadata", "reset", "release", "abort"] as const)(
  "joins a parent publication and handles %s before provider I/O",
  async (change) => {
    const { rootGrant, grant } = await delegatedChild();
    const publish = pendingPublication(ROOT_KEY);
    const controller = new AbortController();
    const native = provider();
    const bound = bindProvider(native, grant.audience, controller.signal);
    const result = bound.health();
    const observed = result.catch((error: unknown) => error);
    try {
      expect(native.health).not.toHaveBeenCalled();
      expect(() => assertCurrent(grant.audience)).toThrow("currency is unavailable");
      if (change === "reset") {
        fakeSessionOwner.rows.set(ROOT_KEY, rootEntry());
      }
      if (change === "release") {
        grant.release();
      }
      if (change === "abort") {
        controller.abort();
        expect(await observed).toBeInstanceOf(Error);
      }
      publish();
      if (change === "metadata") {
        await expect(result).resolves.toMatchObject({ status: "ready" });
        expect(native.health).toHaveBeenCalledOnce();
        expect(prepareMemoryAudienceRead(grant.audience)).toBeUndefined();
      } else {
        expect(await observed).toBeInstanceOf(Error);
        expect(native.health).not.toHaveBeenCalled();
      }
    } finally {
      publish();
      await observed;
      await bound.close();
      grant.release();
      rootGrant.release();
    }
  },
);
it.each(["memory", "other", "reset", "abort"] as const)(
  "prepares %s tool execution at the host boundary",
  async (kind) => {
    const grant = await grantAt(ROOT_KEY, rootEntry(), true);
    const builder = createTestPluginRegistry(createPluginRuntimeMock());
    const record = createPluginRecord({ id: "probe", contracts: { tools: ["probe"] } });
    builder.registry.plugins.push(record);
    builder.registry.memoryCapabilities.push({
      pluginId: kind === "other" ? "other" : "probe",
      capability: {},
      memorySlotSelected: true,
    });
    builder
      .createApi(record, { config: {}, registrationMode: "full" })
      .registerTool(() => null, { name: "probe" });
    const entry = builder.registry.tools[0]!;
    const context = createPluginToolFactoryContext({
      entry,
      registry: builder.registry,
      context: {
        sessionKey: ROOT_KEY,
        memoryAudience: grant.audience,
        assertMemoryAudienceCurrent: () => assertCurrent(grant.audience),
      },
    });
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const tool = bindPluginToolCallbacks(
      entry,
      builder.registry,
      {
        name: "probe",
        label: "probe",
        description: "probe",
        parameters: { type: "object", properties: {} },
        execute,
      },
      context.assertInvocationCurrent,
      context.memoryAudience,
    );
    const publish = pendingPublication(ROOT_KEY);
    const controller = new AbortController();
    const result = tool.execute("call", {}, controller.signal);
    const observed = result.catch((error: unknown) => error);
    try {
      if (kind === "other") {
        await result;
        expect(execute).toHaveBeenCalledOnce();
      } else {
        expect(execute).not.toHaveBeenCalled();
      }
      if (kind === "reset") {
        fakeSessionOwner.rows.set(ROOT_KEY, rootEntry());
      }
      if (kind === "abort") {
        controller.abort();
        expect(await observed).toBeInstanceOf(Error);
      }
      publish();
      if (kind === "reset" || kind === "abort") {
        expect(await observed).toBeInstanceOf(Error);
        expect(execute).not.toHaveBeenCalled();
      } else {
        await result;
        expect(execute).toHaveBeenCalledOnce();
      }
    } finally {
      publish();
      await observed;
      grant.release();
    }
  },
);

const RUN_KEY = "agent:main:cron:job-1:run:run-session";

// A scheduled run row records no spawn receipt; its execution context names the parent.
function resolveScheduledRun(
  parent: FakeSessionRow,
  senderIsOwner: boolean,
  link: { lifecycleRevision?: string } = { lifecycleRevision: parent.lifecycleRevision },
) {
  fakeSessionOwner.rows.set(ROOT_KEY, parent);
  const run: FakeSessionRow = { sessionId: randomUUID(), updatedAt: 1 };
  fakeSessionOwner.rows.set(RUN_KEY, run);
  const scheduledParent = { sessionKey: ROOT_KEY, sessionId: parent.sessionId, senderIsOwner };
  return resolveMemoryAudienceFromEntry(
    {
      agentId: AGENT_ID,
      sessionKey: RUN_KEY,
      sessionId: run.sessionId,
      senderIsOwner: undefined,
      storePath: STORE_PATH,
      scheduledParent: { ...scheduledParent, ...link },
    },
    run,
  );
}

it("grants a scheduled child its parent's audience, bound to the run session", async () => {
  const parent = rootEntry();
  const grant = requireGrant(await resolveScheduledRun(parent, true));
  expect(grant.audience).toEqual({ kind: "owner-private", agentId: AGENT_ID });
  assertSession(grant.audience, RUN_KEY);
  const shared = requireGrant(await resolveScheduledRun(rootEntry(), false));
  expect(shared.audience).toMatchObject({ kind: "conversation", sessionKey: ROOT_KEY });
  // A parent reset during the run revokes the grant before provider I/O.
  fakeSessionOwner.rows.set(ROOT_KEY, { ...parent, lifecycleRevision: randomUUID() });
  expect(() => assertCurrent(grant.audience)).toThrow("no longer current");
});

it("denies a scheduled child whose parent was reset after the link was recorded", async () => {
  const parent = rootEntry();
  const resolution = await resolveScheduledRun(parent, true, { lifecycleRevision: randomUUID() });
  expect(resolution).toMatchObject({ status: "denied", kind: "stale-lineage" });
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("matches a scheduled parent link that recorded only the session id", async () => {
  const grant = requireGrant(await resolveScheduledRun(rootEntry("group"), false, {}));
  expect(grant.audience).toMatchObject({ kind: "conversation", sessionKey: ROOT_KEY });
});

it("grants an in-session scheduled run its own linked row's audience with the occurrence's owner bit", async () => {
  const root = rootEntry();
  fakeSessionOwner.rows.set(ROOT_KEY, root);
  const link = { sessionKey: ROOT_KEY, sessionId: root.sessionId, senderIsOwner: true };
  const resolve = (scheduledParent: typeof link & { lifecycleRevision?: string }) =>
    resolveMemoryAudienceFromEntry(
      {
        agentId: AGENT_ID,
        sessionKey: ROOT_KEY,
        sessionId: root.sessionId,
        senderIsOwner: undefined,
        storePath: STORE_PATH,
        scheduledParent,
      },
      root,
    );
  const grant = requireGrant(await resolve({ ...link, lifecycleRevision: root.lifecycleRevision }));
  expect(grant.audience).toEqual({ kind: "owner-private", agentId: AGENT_ID });
  grant.release();
  const reset = await resolve({ ...link, lifecycleRevision: randomUUID() });
  expect(reset).toMatchObject({ status: "denied", kind: "stale-lineage" });
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("keeps a failed requester check as the owner cap through a spawned parent's lineage", async () => {
  // The linked parent is itself a spawned child whose receipt carries an owner bit.
  const root = rootEntry();
  fakeSessionOwner.rows.set(ROOT_KEY, root);
  const spawnedParent = childEntry(root);
  fakeSessionOwner.rows.set(CHILD_KEY, spawnedParent);
  const run: FakeSessionRow = { sessionId: randomUUID(), updatedAt: 1 };
  fakeSessionOwner.rows.set(RUN_KEY, run);
  const resolveChildOf = (senderIsOwner: boolean) =>
    resolveMemoryAudienceFromEntry(
      {
        agentId: AGENT_ID,
        sessionKey: RUN_KEY,
        sessionId: run.sessionId,
        senderIsOwner: undefined,
        storePath: STORE_PATH,
        scheduledParent: {
          sessionKey: CHILD_KEY,
          sessionId: spawnedParent.sessionId,
          lifecycleRevision: spawnedParent.lifecycleRevision,
          senderIsOwner,
        },
      },
      run,
    );
  const owner = requireGrant(await resolveChildOf(true));
  expect(owner.audience).toEqual({ kind: "owner-private", agentId: AGENT_ID });
  owner.release();
  const capped = requireGrant(await resolveChildOf(false));
  expect(capped.audience).toMatchObject({ kind: "conversation", sessionKey: ROOT_KEY });
  capped.release();
});

it("keeps a failed requester check as the owner cap for an in-session run on a spawned row", async () => {
  const root = rootEntry();
  fakeSessionOwner.rows.set(ROOT_KEY, root);
  const spawned = childEntry(root);
  fakeSessionOwner.rows.set(CHILD_KEY, spawned);
  const resolution = await resolveMemoryAudienceFromEntry(
    {
      agentId: AGENT_ID,
      sessionKey: CHILD_KEY,
      sessionId: spawned.sessionId,
      senderIsOwner: undefined,
      storePath: STORE_PATH,
      scheduledParent: {
        sessionKey: CHILD_KEY,
        sessionId: spawned.sessionId,
        lifecycleRevision: spawned.lifecycleRevision,
        senderIsOwner: false,
      },
    },
    spawned,
  );
  expect(requireGrant(resolution).audience).toMatchObject({
    kind: "conversation",
    sessionKey: ROOT_KEY,
  });
});

it("caps owner status for a scheduled run on a spawned session other than its linked parent", async () => {
  const root = rootEntry();
  fakeSessionOwner.rows.set(ROOT_KEY, root);
  const spawned = childEntry(root);
  fakeSessionOwner.rows.set(CHILD_KEY, spawned);
  const linked = rootEntry();
  fakeSessionOwner.rows.set("agent:main:linked", linked);
  const resolution = await resolveMemoryAudienceFromEntry(
    {
      agentId: AGENT_ID,
      sessionKey: CHILD_KEY,
      sessionId: spawned.sessionId,
      senderIsOwner: undefined,
      storePath: STORE_PATH,
      scheduledParent: {
        sessionKey: "agent:main:linked",
        sessionId: linked.sessionId,
        lifecycleRevision: linked.lifecycleRevision,
        senderIsOwner: false,
      },
    },
    spawned,
  );
  expect(requireGrant(resolution).audience).not.toEqual({
    kind: "owner-private",
    agentId: AGENT_ID,
  });
});
