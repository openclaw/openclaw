import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindMemoryProvider } from "./memory-provider-adapter.js";
import type { MemoryProviderHandle } from "./memory-provider-types.js";

vi.mock("../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } = await import("./memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
vi.mock("../config/sessions/session-entry-read-runtime.js", async () => {
  const { fakeSessionEntryReadModule } = await import("./memory-audience.test-support.js");
  return fakeSessionEntryReadModule;
});

import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
  delegateMemoryAudience,
  isHostMemoryAudience,
  type MemoryAudienceResolution,
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

function resolveAt(sessionKey: string, entry: FakeSessionRow, senderIsOwner?: boolean) {
  fakeSessionOwner.rows.set(sessionKey, entry);
  return resolveMemoryAudienceFromEntry(
    {
      agentId: AGENT_ID,
      sessionKey,
      sessionId: entry.sessionId,
      senderIsOwner,
      storePath: STORE_PATH,
    },
    entry,
  );
}

async function grantAt(sessionKey: string, entry: FakeSessionRow, senderIsOwner?: boolean) {
  const resolution = await resolveAt(sessionKey, entry, senderIsOwner);
  if (resolution.status !== "granted") {
    throw new Error(`expected a memory audience: ${resolution.reason}`);
  }
  return resolution;
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

beforeEach(() => {
  fakeSessionOwner.reset();
});

describe("memory audience resolution", () => {
  it.each([
    ["owner direct", "direct", true, "owner-private"],
    ["non-owner direct", "direct", false, "conversation"],
    ["group", "group", true, "conversation"],
    ["channel", "channel", true, "conversation"],
  ] as const)("maps a %s root", async (_name, chatType, owner, expectedKind) => {
    const root = rootEntry(chatType);
    const { audience } = await grantAt(ROOT_KEY, root, owner);
    expect(audience).toEqual(
      expectedKind === "owner-private"
        ? { kind: "owner-private", agentId: AGENT_ID }
        : {
            kind: "conversation",
            agentId: AGENT_ID,
            sessionKey: ROOT_KEY,
            sessionId: root.sessionId,
          },
    );
    expect(isHostMemoryAudience(audience)).toBe(true);
    expect(Object.isFrozen(audience)).toBe(true);
  });

  it("uses durable chat type for threaded sessions", async () => {
    const root = rootEntry("group");
    const threadKey = "agent:main:discord:group:room:thread:reply";
    const { audience } = await grantAt(threadKey, root, true);
    expect(audience).toEqual({
      kind: "conversation",
      agentId: AGENT_ID,
      sessionKey: threadKey,
      sessionId: root.sessionId,
    });
  });

  it("reuses an admitted root entry without a session read", async () => {
    await grantAt(ROOT_KEY, rootEntry(), true);
    expect(fakeSessionOwner.workerReads).toEqual([]);
  });

  it("reads a child's durable parent on the session read worker", async () => {
    const root = rootEntry();
    const resolution = await resolveChild(root, childEntry(root));
    expect(resolution).toMatchObject({
      status: "granted",
      audience: { kind: "owner-private", agentId: AGENT_ID },
    });
    expect(fakeSessionOwner.workerReads).toEqual([ROOT_KEY]);
  });

  it("denies a missing parent, missing chat type, missing session id, or mismatched session id", async () => {
    const root = rootEntry();
    const child = childEntry(root);
    fakeSessionOwner.rows.set(CHILD_KEY, child);
    await expect(
      resolveMemoryAudienceFromEntry(
        {
          agentId: AGENT_ID,
          sessionKey: CHILD_KEY,
          sessionId: child.sessionId,
          senderIsOwner: true,
          storePath: STORE_PATH,
        },
        child,
      ),
    ).resolves.toMatchObject({ status: "denied", kind: "stale-lineage" });
    await expect(
      resolveAt(ROOT_KEY, { ...root, chatType: undefined }, true),
    ).resolves.toMatchObject({ status: "denied", kind: "ineligible" });
    for (const [sessionId, kind] of [
      [undefined, "ineligible"],
      [randomUUID(), "unverified"],
    ] as const) {
      await expect(
        resolveMemoryAudienceFromEntry(
          {
            agentId: AGENT_ID,
            sessionKey: ROOT_KEY,
            sessionId,
            senderIsOwner: true,
            storePath: STORE_PATH,
          },
          root,
        ),
      ).resolves.toMatchObject({ status: "denied", kind });
    }
    expect(fakeSessionOwner.activeLeases).toBe(0);
  });

  it.each([
    ["private", "direct", true, "owner-private"],
    ["non-owner conversation", "direct", false, "conversation"],
    ["group conversation", "group", true, "conversation"],
  ] as const)(
    "inherits the root %s audience through nested children",
    async (_name, chatType, owner, kind) => {
      const root = rootEntry(chatType);
      const child = { ...childEntry(root), spawnedBySenderIsOwner: owner };
      const nestedKey = "agent:main:subagent:nested";
      fakeSessionOwner.rows.set(ROOT_KEY, root);
      fakeSessionOwner.rows.set(CHILD_KEY, child);
      const { audience } = await grantAt(nestedKey, childEntry(child, CHILD_KEY), !owner);
      expect(audience.kind).toBe(kind);
      if (audience.kind === "conversation") {
        expect(audience).toMatchObject({ sessionKey: ROOT_KEY, sessionId: root.sessionId });
      }
    },
  );

  it("denies malformed, stale, cyclic, and cross-agent lineage", async () => {
    const mutations: Array<
      [
        Extract<MemoryAudienceResolution, { status: "denied" }>["kind"],
        (parent: FakeSessionRow, child: FakeSessionRow) => void,
      ]
    > = [
      [
        "ineligible",
        (_parent, child) => {
          child.spawnedBySessionId = undefined;
        },
      ],
      [
        "stale-lineage",
        (_parent, child) => {
          child.spawnedBySessionId = randomUUID();
        },
      ],
      [
        "stale-lineage",
        (parent) => {
          parent.lifecycleRevision = randomUUID();
        },
      ],
      [
        "stale-lineage",
        (_parent, child) => {
          child.parentSessionLifecycleRevision = undefined;
        },
      ],
      [
        "ineligible",
        (_parent, child) => {
          child.parentSessionKey = "agent:main:other";
        },
      ],
      [
        "ineligible",
        (_parent, child) => {
          child.spawnedBy = child.parentSessionKey = "agent:foreign:root";
        },
      ],
      [
        "ineligible",
        (_parent, child) => {
          child.spawnedBy = child.parentSessionKey = CHILD_KEY;
          child.spawnedBySessionId = child.sessionId;
          child.parentSessionLifecycleRevision = child.lifecycleRevision;
        },
      ],
    ];
    for (const [kind, mutate] of mutations) {
      const parent = rootEntry();
      const child = childEntry(parent);
      mutate(parent, child);
      await expect(resolveChild(parent, child)).resolves.toMatchObject({ status: "denied", kind });
    }
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

  it.each([
    [
      "missing both receipts",
      { spawnedBySenderIsOwner: undefined, parentSessionLifecycleRevision: undefined },
    ],
    ["missing the owner receipt", { spawnedBySenderIsOwner: undefined }],
  ] as const)(
    "fails closed with a respawn instruction for a pre-existing spawned row %s",
    async (_name, legacy) => {
      const parent = rootEntry();
      const resolution = await resolveChild(parent, { ...childEntry(parent), ...legacy });
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
    },
  );

  it("grants a conversation audience to a new child of a group row without a lifecycle revision", async () => {
    // Channel-created group rows carry no lifecycle revision; the child records that absence.
    const { lifecycleRevision: _revision, ...group } = rootEntry("group");
    const child = { ...childEntry(group), parentSessionLifecycleRevision: undefined };
    fakeSessionOwner.rows.set(ROOT_KEY, group);
    const resolution = await resolveAt(CHILD_KEY, child, false);
    if (resolution.status !== "granted") {
      throw new Error(resolution.reason);
    }
    expect(resolution.audience).toEqual({
      kind: "conversation",
      agentId: AGENT_ID,
      sessionKey: ROOT_KEY,
      sessionId: group.sessionId,
    });
    assertMemoryAudienceSession(resolution.audience, CHILD_KEY);
    // A reset that gives the parent a lifecycle revision ends the child's grant.
    fakeSessionOwner.rows.set(ROOT_KEY, { ...group, lifecycleRevision: randomUUID() });
    expect(() => assertMemoryAudienceCurrent(resolution.audience)).toThrow("no longer current");
  });
});

describe("memory audience currency", () => {
  it.each(["reset", "removal"] as const)("revokes a child after parent %s", async (change) => {
    const parent = rootEntry();
    const resolution = await resolveChild(parent, childEntry(parent));
    if (resolution.status !== "granted") {
      throw new Error(resolution.reason);
    }
    if (change === "reset") {
      fakeSessionOwner.rows.set(ROOT_KEY, { ...parent, lifecycleRevision: randomUUID() });
    } else {
      fakeSessionOwner.rows.delete(ROOT_KEY);
    }
    expect(() => assertMemoryAudienceCurrent(resolution.audience)).toThrow("no longer current");
    // A later write that restores the old incarnation cannot revive the grant.
    fakeSessionOwner.rows.set(ROOT_KEY, parent);
    expect(() => assertMemoryAudienceCurrent(resolution.audience)).toThrow("no longer current");
  });

  it("checks currency synchronously without session reads and fails closed while a write is pending", async () => {
    const { audience } = await grantAt(ROOT_KEY, rootEntry(), true);
    assertMemoryAudienceCurrent(audience);
    assertMemoryAudienceCurrent(audience);
    fakeSessionOwner.pendingKeys.add(ROOT_KEY);
    expect(() => assertMemoryAudienceCurrent(audience)).toThrow("currency is unavailable");
    fakeSessionOwner.pendingKeys.delete(ROOT_KEY);
    assertMemoryAudienceCurrent(audience);
    expect(fakeSessionOwner.workerReads).toEqual([]);
  });

  it("rejects a retained audience after its owner releases it", async () => {
    const { audience, release } = await grantAt(ROOT_KEY, rootEntry(), true);
    release();
    expect(() => assertMemoryAudienceCurrent(audience)).toThrow("released by its owner");
    expect(fakeSessionOwner.activeLeases).toBe(0);
  });
});

describe("memory audience delegation", () => {
  it("binds the delegate to its child session and folds parent revocation into provider calls", async () => {
    const root = rootEntry();
    const { audience } = await grantAt(ROOT_KEY, root, true);
    fakeSessionOwner.rows.set(CHILD_KEY, { sessionId: "recall-session", updatedAt: 1 });
    const delegated = await delegateMemoryAudience(audience, {
      sessionKey: CHILD_KEY,
      storePath: STORE_PATH,
    });
    expect(delegated.audience).toEqual(audience);
    expect(delegated.audience).not.toBe(audience);
    expect(Object.isFrozen(delegated.audience)).toBe(true);
    expect(isHostMemoryAudience(delegated.audience)).toBe(true);
    expect(() => assertMemoryAudienceSession(audience, ROOT_KEY)).not.toThrow();
    expect(() => assertMemoryAudienceSession(delegated.audience, ROOT_KEY)).toThrow(
      "different session",
    );
    const raw = provider();
    const bound = bindMemoryProvider(raw, "test", {
      authority: {
        kind: "session",
        sessionKey: CHILD_KEY,
        sandboxed: false,
        audience: delegated.audience,
      },
      assertCurrent() {},
    });
    await expect(bound.health()).resolves.toMatchObject({ status: "ready" });
    fakeSessionOwner.rows.set(ROOT_KEY, { ...root, lifecycleRevision: randomUUID() });
    await expect(bound.health()).rejects.toThrow("no longer current");
    expect(() => assertMemoryAudienceCurrent(audience)).toThrow("no longer current");
    await expect(
      delegateMemoryAudience(audience, { sessionKey: "agent:main:other", storePath: STORE_PATH }),
    ).rejects.toThrow("no longer current");
    expect(raw.health).toHaveBeenCalledTimes(1);
  });

  it("requires an existing child session for the same agent", async () => {
    const { audience } = await grantAt(ROOT_KEY, rootEntry(), true);
    await expect(
      delegateMemoryAudience(audience, { sessionKey: CHILD_KEY, storePath: STORE_PATH }),
    ).rejects.toThrow("requires an existing child session");
    await expect(
      delegateMemoryAudience(audience, { sessionKey: "agent:other:child", storePath: STORE_PATH }),
    ).rejects.toThrow("requires a session for the same agent");
  });
});
