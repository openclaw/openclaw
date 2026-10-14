import { describe, expect, it, onTestFinished } from "vitest";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import { createMemorySessionActorOwner } from "../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import { progressCardStore } from "../gateway/progress-card-store.js";

const sessionKey = "agent:main:dashboard:incognito-progress";
const authority = { assertCurrent() {}, authorize() {} };
type Fixture = { store: typeof progressCardStore; actor: SessionActor; reacquire(): Promise<void> };
async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const path = ":memory:progress";
  const owner = createMemorySessionActorOwner({ agentId: "main", path });
  onTestFinished(() => owner.close());
  const acquire = () =>
    owner.acquire(
      { database: owner.identity, sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
  const actor = await acquire();
  expect(
    (
      await actor.storage!.mutate(
        {
          type: "session.entry.create",
          input: { entry: { sessionId: "window-1", updatedAt: 1, incognito: true } },
        },
        authority,
      )
    ).kind,
  ).toBe("committed");
  const binding = { actor, authority, agentId: "main", path };
  return runWithSessionActorStorage(binding, () =>
    run({
      store: progressCardStore,
      get actor() {
        return binding.actor;
      },
      async reacquire() {
        binding.actor = await acquire();
      },
    }),
  );
}

describe("session actor progress-card store", () => {
  it("replaces the whole card in FIFO order and preserves clear revision tombstones", () =>
    withFixture(async ({ store }) => {
      expect(await store.get(sessionKey)).toBeNull();
      const steps = [{ step: "Inspect", status: "in_progress" as const }];
      const first = store.put(sessionKey, { markdown: "  Working  ", steps });
      steps[0]!.step = "caller mutation";
      expect((await first).card).toMatchObject({
        markdown: "  Working  ",
        steps: [{ step: "Inspect" }],
        revision: 1,
      });
      await store.put(sessionKey, { markdown: "New work", expectedRevision: 0 });
      expect(await store.get(sessionKey)).toMatchObject({ markdown: "New work", revision: 2 });
      expect((await store.get(sessionKey))!.steps).toBeUndefined();
      expect(await store.put(sessionKey, { expectedRevision: 1 })).toMatchObject({
        card: { revision: 2 },
      });
      expect(
        await store.put(sessionKey, { markdown: " \n ", steps: [], expectedRevision: 2 }),
      ).toEqual({ card: null });
      expect(await store.put(sessionKey, { expectedRevision: 3 })).toEqual({ card: null });
      const next = store.put(sessionKey, { markdown: "Next" });
      const staleClear = store.put(sessionKey, { expectedRevision: 2 });
      expect(await next).toMatchObject({ card: { revision: 4 } });
      expect(await staleClear).toMatchObject({ card: { markdown: "Next", revision: 4 } });
      expect(await store.get(sessionKey)).toMatchObject({ markdown: "Next", revision: 4 });
    }));

  it("clears the logical card on reset and discards it when the session is deleted", () =>
    withFixture(async (fixtureValue) => {
      const { store } = fixtureValue;
      await store.put(sessionKey, { markdown: "Before reset" });
      const expected = (await fixtureValue.actor.storage!.read(
        { type: "session.entry.read", input: {} },
        authority,
      ))!;
      expect(
        (
          await fixtureValue.actor.storage!.mutate(
            {
              type: "session.lifecycle.reset",
              input: {
                expected,
                nextEntry: { ...expected, sessionId: "window-2" },
                resetBoundary: {
                  context: "clear",
                  reason: "reset",
                  cwd: "/synthetic",
                  boundaryId: "reset-1",
                },
              },
            },
            authority,
          )
        ).kind,
      ).toBe("committed");
      await fixtureValue.reacquire();
      expect(await store.get(sessionKey)).toBeNull();
      expect(await store.put(sessionKey, { markdown: "After reset" })).toMatchObject({
        card: { revision: 3 },
      });
      expect(
        (
          await fixtureValue.actor.storage!.mutate(
            { type: "session.lifecycle.delete", input: {} },
            authority,
          )
        ).kind,
      ).toBe("committed");
      await fixtureValue.reacquire();
      expect(await store.get(sessionKey)).toBeNull();
    }));
});
