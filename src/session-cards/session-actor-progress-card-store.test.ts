import { expect, it, onTestFinished } from "vitest";
import { failSessionActorMemoryPublication } from "../config/sessions/session-actor-memory-publication.test-support.js";
import { createMemorySessionActorOwner } from "../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageCommand } from "../config/sessions/session-actor-storage-contract.js";
import { progressCardStore } from "../gateway/progress-card-store.js";

const sessionKey = "agent:main:dashboard:incognito-progress";
const authority = { assertCurrent() {}, authorize() {} };
async function createFixture() {
  const path = ":memory:progress";
  const owner = createMemorySessionActorOwner({ agentId: "main", path });
  onTestFinished(() => owner.close());
  const lifetime = { assertCurrent() {}, assertReadable() {} };
  const acquire = () => owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const binding = { actor: await acquire(), authority, agentId: "main", path };
  const fixture = {
    get: () => progressCardStore.get(sessionKey),
    put: (input: Parameters<typeof progressCardStore.put>[1]) =>
      progressCardStore.put(sessionKey, input),
    readEntry: () =>
      binding.actor.storage!.read({ type: "session.entry.read", input: {} }, authority),
    commit: async (command: SessionActorStorageCommand) => {
      expect((await binding.actor.storage!.mutate(command, authority)).kind).toBe("committed");
    },
    reacquire: async () => {
      binding.actor = await acquire();
    },
  };
  await fixture.commit({
    type: "session.entry.create",
    input: { entry: { sessionId: "window-1", updatedAt: 1, incognito: true } },
  });
  return { binding, fixture };
}
async function withFixture(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>["fixture"]) => Promise<void>,
) {
  const { binding, fixture } = await createFixture();
  return runWithSessionActorStorage(binding, () => run(fixture));
}

it("reports publication failure after retaining the committed card", () =>
  withFixture(async ({ get, put }) => {
    onTestFinished(failSessionActorMemoryPublication(sessionKey));
    await expect(put({ markdown: "Saved" })).rejects.toMatchObject({
      name: "SessionActorStorageCommittedError",
    });
    expect(await get()).toMatchObject({ markdown: "Saved", revision: 1 });
  }));

it("replaces the whole card in FIFO order and preserves clear revision tombstones", () =>
  withFixture(async ({ get, put }) => {
    expect(await get()).toBeNull();
    const steps = [{ step: "Inspect", status: "in_progress" as const }];
    const first = put({ markdown: "  Working  ", steps });
    steps[0]!.step = "caller mutation";
    expect((await first).card).toMatchObject({
      markdown: "  Working  ",
      steps: [{ step: "Inspect" }],
      revision: 1,
    });
    await put({ markdown: "New work", expectedRevision: 0 });
    expect(await get()).toMatchObject({ markdown: "New work", revision: 2 });
    expect((await get())!.steps).toBeUndefined();
    expect(await put({ expectedRevision: 1 })).toMatchObject({ card: { revision: 2 } });
    expect(await put({ markdown: " \n ", steps: [], expectedRevision: 2 })).toEqual({ card: null });
    expect(await put({ expectedRevision: 3 })).toEqual({ card: null });
    const next = put({ markdown: "Next" });
    const staleClear = put({ expectedRevision: 2 });
    expect(await next).toMatchObject({ card: { revision: 4 } });
    expect(await staleClear).toMatchObject({ card: { markdown: "Next", revision: 4 } });
    expect(await get()).toMatchObject({ markdown: "Next", revision: 4 });
  }));

it("clears the logical card on reset and discards it when the session is deleted", () =>
  withFixture(async ({ get, put, readEntry, commit, reacquire }) => {
    await put({ markdown: "Before reset" });
    const expected = (await readEntry())!;
    await commit({
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
    });
    await reacquire();
    expect(await get()).toBeNull();
    expect(await put({ markdown: "After reset" })).toMatchObject({ card: { revision: 3 } });
    await commit({ type: "session.lifecycle.delete", input: {} });
    await reacquire();
    expect(await get()).toBeNull();
  }));
