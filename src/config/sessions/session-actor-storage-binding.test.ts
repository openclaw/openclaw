import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionActorStorage } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import {
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
} from "./session-actor-storage-binding.js";
import type { SessionActorStorageWrites } from "./session-actor-storage-contract.js";

const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const readEntry = (storage: SessionActorStorage, sessionKey?: string) =>
  storage.readCurrent({ type: "session.entry.read", input: { sessionKey } }, authority);
const mutate = <Key extends keyof SessionActorStorageWrites>(
  storage: SessionActorStorage,
  command: { type: Key; input: SessionActorStorageWrites[Key]["input"] },
) => storage.mutate(command, authority);
const owned: Array<{ agentId: string; path: string }> = [];
afterEach(() => {
  for (const options of owned.splice(0)) {
    memorySessionActorOwners.closeDatabase(options);
  }
});

async function fixture(name: string) {
  const env = { OPENCLAW_STATE_DIR: `/synthetic/actor-storage-binding/${name}` };
  const options = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  owned.push(options);
  const owner = memorySessionActorOwners.get(options);
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const storage = actor.storage!;
  const created = await mutate(storage, {
    type: "session.entry.create",
    input: { entry: { sessionId: name, updatedAt: 1 } },
  });
  expect(created.kind).toBe("committed");
  return { env, owner, sessionKey, actor, storage, binding: { ...options, actor, authority } };
}

describe("selected actor storage binding", () => {
  it("refuses another incognito session or owner while accepting its logical store locator", async () => {
    const { env, sessionKey, binding } = await fixture("scope");
    runWithSessionActorStorage(binding, () => {
      expect(getSessionActorStorageBinding({ sessionKey })?.actor).toBe(binding.actor);
      expect(() =>
        getSessionActorStorageBinding({ sessionKey: "agent:main:dashboard:incognito-other" }),
      ).toThrow("another session");
      expect(getSessionActorStorageBinding({ sessionKey: "agent:main:durable" })).toBeUndefined();
      expect(() =>
        getSessionActorStorageBinding({ sessionKey: "agent:main:durable", sessionActor: binding }),
      ).toThrow("another session");
      expect(
        getSessionActorStorageBinding({
          sessionKey,
          storePath: path.join(env.OPENCLAW_STATE_DIR, "agents/main/sessions/sessions.json"),
        })?.actor,
      ).toBe(binding.actor);
      const foreign = resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: "/synthetic/actor-storage-binding/foreign" },
      });
      expect(() => getSessionActorStorageBinding({ sessionKey, storePath: foreign })).toThrow(
        "another owner",
      );
    });
  });

  it("reads committed sibling state without acquisition and closes public handles with their session", async () => {
    const { actor, storage, owner, sessionKey } = await fixture("siblings");
    const siblingKey = "agent:main:dashboard:incognito-sibling";
    const sibling = await owner.acquire(
      { database: owner.identity, sessionKey: siblingKey },
      lifetime,
    );
    expect(
      await mutate(sibling.storage!, {
        type: "session.entry.create",
        input: { entry: { sessionId: "sibling", updatedAt: 2 } },
      }),
    ).toMatchObject({ kind: "committed" });
    expect(readEntry(storage, siblingKey)).toMatchObject({ sessionId: "sibling", updatedAt: 2 });
    expect(
      await mutate(sibling.storage!, {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { label: "changed" } } },
      }),
    ).toMatchObject({ kind: "committed" });
    expect(readEntry(storage, siblingKey)).toMatchObject({ label: "changed" });
    owner.closeSession(sessionKey);
    expect(() => actor.assertCurrent()).toThrow(/closed/);
    expect(() => actor.assertReadable()).toThrow(/closed/);
    expect(() => readEntry(storage, siblingKey)).toThrow(/closed/);
    expect(() => sibling.assertReadable()).not.toThrow();
    await Promise.all([actor.release(), sibling.release()]);
  });

  it("acquires separate handles from the captured owner after rotation and release", async () => {
    const { actor, storage, sessionKey } = await fixture("rotate");
    const before = readEntry(storage)!;
    expect(
      await mutate(storage, {
        type: "session.lifecycle.reset",
        input: { expected: before, nextEntry: { ...before, sessionId: "rotated" } },
      }),
    ).toMatchObject({ kind: "committed" });
    expect(() => actor.assertCurrent()).toThrow(/closed/);
    const replacement = await storage.acquire(sessionKey);
    expect(replacement).not.toBe(actor);
    expect(readEntry(replacement.storage!)).toMatchObject({ sessionId: "rotated" });
    await actor.release();
    const separate = await storage.acquire(sessionKey);
    await replacement.release();
    expect(() => replacement.assertReadable()).toThrow(/released/);
    expect(() => separate.assertReadable()).not.toThrow();
    expect(readEntry(separate.storage!)).toMatchObject({ sessionId: "rotated" });
    await separate.release();
  });
});
