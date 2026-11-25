import { expect, it } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionActor } from "./session-actor-contract.js";
import { memorySessionActorRegistry } from "./session-actor-memory-registry.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
  runWithSessionActorStorage,
} from "./session-actor-storage-binding.js";

const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };

async function seed(actor: SessionActor, sessionId: string) {
  expect(
    await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId, updatedAt: 1 }, cwd: "/synthetic" },
      },
      authority,
    ),
  ).toMatchObject({ kind: "committed", value: { sessionId } });
}

it("reads later registrations while preserving selected owners across same-path replacement", async () => {
  const env = { OPENCLAW_STATE_DIR: "/synthetic/session-owner-import-order" };
  const target = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const scope = {
    agentId: target.agentId,
    storePath: target.path,
    sessionKey: "agent:main:dashboard:incognito-import-order",
  };
  const capture = () => captureSessionActorStorageOwner(scope, authority)!;
  expect(capture().owner).toBeUndefined();
  expect(memorySessionActorRegistry.read(target)).toBeUndefined();

  // Read ownership before loading creation: both module orders must use the same registry.
  const { acquireSessionActorStorage } = await import("./session-actor-storage-acquisition.js");
  const { createMemorySessionActorOwner } = await import("./session-actor-memory.js");
  const actors: SessionActor[] = [];
  const directOwner = createMemorySessionActorOwner(target);
  try {
    await expect(
      acquireSessionActorStorage(scope, { authority, lifetime }),
    ).resolves.toBeUndefined();
    expect(capture().owner).toBeUndefined();
    const pending = acquireSessionActorStorage(scope, { authority, lifetime, create: true });
    const registeredBeforeYield = capture().owner;
    const registered = (await pending)!;
    actors.push(registered.actor);
    expect(registeredBeforeYield).toBeDefined();
    await seed(registered.actor, "registered-session");
    expect(readCapturedSessionActorEntry(capture(), scope.sessionKey)?.sessionId).toBe(
      "registered-session",
    );

    const directActor = await directOwner.acquire(
      { database: directOwner.identity, sessionKey: scope.sessionKey },
      lifetime,
    );
    actors.push(directActor);
    await seed(directActor, "direct-session");
    const direct = { actor: directActor, authority, agentId: target.agentId, path: target.path };
    await runWithSessionActorStorage(registered, async () => {
      await Promise.resolve();
      expect(readCapturedSessionActorEntry(capture(), scope.sessionKey)?.sessionId).toBe(
        "registered-session",
      );
      const explicit = captureSessionActorStorageOwner({ ...scope, sessionActor: direct })!;
      expect(readCapturedSessionActorEntry(explicit, scope.sessionKey)?.sessionId).toBe(
        "direct-session",
      );
      await runWithSessionActorStorage(direct, async () => {
        await Promise.resolve();
        expect(readCapturedSessionActorEntry(capture(), scope.sessionKey)?.sessionId).toBe(
          "direct-session",
        );
      });
      expect(readCapturedSessionActorEntry(capture(), scope.sessionKey)?.sessionId).toBe(
        "registered-session",
      );
    });

    memorySessionActorRegistry.closeDatabase(target);
    const replacement = (await acquireSessionActorStorage(scope, {
      authority,
      lifetime,
      create: true,
    }))!;
    actors.push(replacement.actor);
    await seed(replacement.actor, "replacement-session");
    expect(readCapturedSessionActorEntry(capture(), scope.sessionKey)?.sessionId).toBe(
      "replacement-session",
    );
    const stale = captureSessionActorStorageOwner({ ...scope, sessionActor: registered })!;
    expect(() => readCapturedSessionActorEntry(stale, scope.sessionKey)).toThrow("closed");
    const selected = captureSessionActorStorageOwner({ ...scope, sessionActor: direct })!;
    expect(readCapturedSessionActorEntry(selected, scope.sessionKey)?.sessionId).toBe(
      "direct-session",
    );
    directOwner.close();
    const closed = captureSessionActorStorageOwner({ ...scope, sessionActor: direct })!;
    expect(() => readCapturedSessionActorEntry(closed, scope.sessionKey)).toThrow("closed");
  } finally {
    await Promise.all(actors.map((actor) => actor.release()));
    directOwner.close();
    memorySessionActorRegistry.closeDatabase(target);
  }
});
