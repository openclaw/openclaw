import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActor, SessionActorAuthority } from "./session-actor-contract.js";
import { createSessionActorFactory } from "./session-actor-durable.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";

// Architecture contract: factory acquisition and commands need no database or worker.
vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory factory opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory factory allocated a worker");
  }),
}));

const database = { agentId: "main", path: "/synthetic/incognito" };
const sessionKey = "agent:main:dashboard:incognito-factory-test";
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const actors: SessionActor[] = [];

afterEach(async () => {
  await Promise.all(actors.splice(0).map((actor) => actor.release()));
  memorySessionActorOwners.reset();
});

async function acquire(options = database, key = sessionKey) {
  const actor = await createSessionActorFactory(options).acquire(
    { sessionKey: key, database: { kind: "memory" } },
    lifetime,
  );
  if ("kind" in actor) {
    throw new Error("Expected a memory actor");
  }
  actors.push(actor);
  return actor;
}

async function initialize(actor: SessionActor) {
  const result = await actor.acceptInput(
    {
      commandId: "initialize",
      phaseId: "turn",
      expectedState: {},
      lifecycle: {},
      turn: {
        agentId: "main",
        sessionKey: actor.target.sessionKey,
        options: {
          expectedSessionId: "session-1",
          initialSessionEntry: { sessionId: "session-1", updatedAt: 1, incognito: true },
          messages: [{ message: { role: "user", content: "Hello" }, eventId: "user-1", now: 1 }],
        },
      },
    },
    authority,
  );
  expect(result.kind).toBe("committed");
}

describe("memory actor owner registry", () => {
  it("selects one memory owner across factories without opening SQLite or allocating a worker", async () => {
    expect(memorySessionActorOwners.read(database)).toBeUndefined();
    const actor = await acquire();
    const same = await acquire({ agentId: "MAIN", path: "/synthetic/unused/../incognito" });
    await initialize(actor);
    const owner = memorySessionActorOwners.read(database)!;
    const owned = await owner.acquire(actor.target, lifetime);
    actors.push(owned);
    expect(same.snapshot(authority)?.entry?.sessionId).toBe("session-1");
    expect(owned.snapshot(authority)?.entry?.sessionId).toBe("session-1");
    await owned.patch(
      { commandId: "activity", phaseId: "turn", reducers: [{ kind: "activity", updatedAt: 10 }] },
      authority,
    );
    expect(actor.snapshot(authority)?.entry?.updatedAt).toBe(10);
    expect(same.snapshot(authority)?.entry?.updatedAt).toBe(10);
  });

  it("closes the selected session on the acquired owner while retaining its siblings", async () => {
    const actor = await acquire();
    const sibling = await acquire(database, "agent:main:dashboard:incognito-sibling");
    await initialize(actor);
    await initialize(sibling);
    memorySessionActorOwners.closeSession(database, sessionKey);
    expect(() => actor.snapshot(authority)).toThrow("closed");
    expect(sibling.snapshot(authority)?.entry?.sessionId).toBe("session-1");
    const replacement = await acquire();
    expect(replacement.snapshot(authority)?.entry).toBeUndefined();
    expect(() => actor.snapshot(authority)).toThrow("closed");
  });

  it.each(["database", "all"] as const)(
    "closes %s owners and reacquires empty state",
    async (scope) => {
      const actor = await acquire();
      const otherDatabase = { agentId: "main", path: "/synthetic/other-incognito" };
      const other = await acquire(otherDatabase);
      await initialize(actor);
      await initialize(other);
      const owner = memorySessionActorOwners.read(database)!;
      if (scope === "database") {
        memorySessionActorOwners.closeDatabase(database);
      } else {
        memorySessionActorOwners.reset();
      }
      expect(memorySessionActorOwners.read(database)).toBeUndefined();
      expect(() => actor.snapshot(authority)).toThrow("closed");
      await expect(owner.acquire(actor.target, lifetime)).rejects.toThrow("closed");
      if (scope === "database") {
        expect(other.snapshot(authority)?.entry?.sessionId).toBe("session-1");
      } else {
        expect(() => other.snapshot(authority)).toThrow("closed");
      }
      const replacement = await acquire();
      expect(replacement.snapshot(authority)?.entry).toBeUndefined();
    },
  );
});
