import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionActorAuthority } from "../config/sessions/session-actor-contract.js";
import { createMemorySessionActorOwner } from "../config/sessions/session-actor-memory.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { resolveMemorySessionTargetsInWorker } from "../config/sessions/session-transcript-inventory-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { runSessionActorUsage } from "./session-cost-usage-memory.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory usage opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory usage allocated a worker");
  }),
}));

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const sessionKey = "agent:main:dashboard:incognito-usage";
const sessionId = "usage-1";
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

async function fixture(entry: Partial<InternalSessionEntry> = {}) {
  const owner = createMemorySessionActorOwner({ agentId: "main", path: "/synthetic/memory-usage" });
  owners.push(owner);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const binding: SessionActorStorageBinding = {
    actor,
    authority,
    agentId: "main",
    path: "/synthetic/memory-usage",
  };
  expect(
    await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId, updatedAt: 1, ...entry }, cwd: "/synthetic" },
      },
      authority,
    ),
  ).toMatchObject({ kind: "committed" });
  let next = 0;
  const append = async (input: number) => {
    const id = `assistant-${++next}`;
    expect(
      await actor.appendTranscriptEvent(
        {
          commandId: id,
          phaseId: "turn",
          sessionId,
          lifecycleRevision: null,
          eventJson: JSON.stringify({
            type: "message",
            id,
            timestamp: "2026-10-01T12:00:00.000Z",
            message: {
              role: "assistant",
              content: "answer",
              usage: {
                input,
                output: 2,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: input + 2,
                cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
              },
            },
          }),
        },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
  };
  const sessionFile = formatSqliteSessionFileMarker({
    agentId: "main",
    storePath: binding.path,
    sessionId,
  });
  return { owner, actor, binding, append, sessionFile };
}

describe("actor memory usage", () => {
  it("uses selected memory acquisition for inventory and refreshes a stale report after an in-process append", async () => {
    const { binding, append, sessionFile } = await fixture();
    await append(5);
    await runWithSessionActorStorage(binding, async () => {
      const prepared = prepareUsageCostWorker({ agentId: "main" });
      expect(prepared.databases).toEqual([]);
      expect(await runUsageCostWorker(prepared, { kind: "inventory" })).toMatchObject({
        kind: "inventory",
        files: [{ sessionId }],
      });
    });
    const refresh = () =>
      runSessionActorUsage(
        binding,
        { kind: "refresh", pricingFingerprint: "fixture" },
        () => undefined,
      );
    const report = () =>
      runSessionActorUsage(
        binding,
        {
          kind: "sessions",
          pricingFingerprint: "fixture",
          sessions: [{ sessionFile }],
          dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
        },
        () => undefined,
      );
    expect(await refresh()).toEqual({ kind: "refresh", changed: true });
    expect(await report()).toMatchObject({
      kind: "sessions",
      summaries: [{ input: 5, output: 2 }],
      cacheStatus: { staleFiles: 0 },
    });
    await append(7);
    expect(await report()).toMatchObject({ kind: "sessions", cacheStatus: { staleFiles: 1 } });
    expect(await refresh()).toEqual({ kind: "refresh", changed: true });
    expect(await report()).toMatchObject({
      kind: "sessions",
      summaries: [{ input: 12, output: 4 }],
      cacheStatus: { staleFiles: 0 },
    });
    expect(await refresh()).toEqual({ kind: "refresh", changed: false });
  });

  it("keeps captured corpus and usage bytes detached while later writes update new reads", async () => {
    const { actor, binding, append } = await fixture();
    await append(5);
    const store = actor.storage!;
    const before = await store.read(
      { type: "session.usage.snapshot", input: { includeEvents: true } },
      authority,
    );
    const corpus = await store.read(
      { type: "session.corpus.list", input: { options: {} } },
      authority,
    );
    expect(corpus).toMatchObject([
      { sessionKey, sessionId, artifactKind: "active-session", sessionKind: "interactive" },
    ]);
    await append(7);
    const after = await store.read(
      { type: "session.usage.snapshot", input: { includeEvents: true } },
      authority,
    );
    expect(after[0]!.stats.eventCount).toBe(before[0]!.stats.eventCount + 1);
    expect(before[0]!.events?.some(({ eventJson }) => eventJson.includes("assistant-2"))).toBe(
      false,
    );
    expect(
      (await store.read({ type: "session.corpus.list", input: { options: {} } }, authority))[0]!
        .contentRevision,
    ).not.toBe(corpus[0]!.contentRevision);
    await expect(
      runSessionActorUsage(
        binding,
        {
          kind: "inventory",
          sessionFiles: [
            formatSqliteSessionFileMarker({ agentId: "other", storePath: "/other", sessionId }),
          ],
        },
        () => undefined,
      ),
    ).rejects.toThrow("another session owner");
  });

  it("selects exact source and participant facts while retaining the creation date across activity writes and reset windows", async () => {
    const { owner, actor, binding } = await fixture({
      sessionStartedAt: 1,
      hookExternalContentSource: "webhook",
      chatType: "direct",
      delivery: {
        kind: "external",
        route: { channel: "slack", target: { to: "C-fixture" } },
        context: { channel: "slack", accountId: "fixture-account" },
        origin: { provider: "slack" },
      },
    });
    const store = actor.storage!;
    expect(
      await store.mutate(
        {
          type: "session.collaboration.participant",
          input: { params: { identity: { type: "profile", id: "profile-1" }, promptedAt: 2 } },
        },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
    await runWithSessionActorStorage(binding, async () => {
      expect(
        await resolveMemorySessionTargetsInWorker({ agentId: "main", participants: ["profile-1"] }),
      ).toMatchObject([
        {
          sessionId,
          channel: "slack",
          accountId: "fixture-account",
          chatType: "direct",
          hookExternalContentSource: "webhook",
          createdAt: 1,
          participants: [{ type: "profile", id: "profile-1" }],
        },
      ]);
      await actor.patch(
        {
          commandId: "activity",
          phaseId: "turn",
          reducers: [{ kind: "activity", updatedAt: 100 }],
        },
        authority,
      );
      expect(
        await resolveMemorySessionTargetsInWorker({
          agentId: "main",
          sessionIds: [sessionKey],
          since: 10,
        }),
      ).toEqual([]);
    });
    const expected = await store.read({ type: "session.entry.read", input: {} }, authority);
    expect(
      await store.mutate(
        {
          type: "session.lifecycle.reset",
          input: {
            expected,
            nextEntry: { ...expected!, sessionId: "usage-2", sessionStartedAt: 20, updatedAt: 20 },
          },
        },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
    const current = await owner.acquire(
      { database: owner.identity, sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    await runWithSessionActorStorage({ ...binding, actor: current }, async () => {
      expect(
        await resolveMemorySessionTargetsInWorker({ agentId: "main", hookSources: ["webhook"] }),
      ).toMatchObject([
        { sessionId: "usage-1", createdAt: 1 },
        { sessionId: "usage-2", createdAt: 20 },
      ]);
      expect(
        await resolveMemorySessionTargetsInWorker({
          agentId: "main",
          sessionIds: [sessionKey],
          since: 10,
        }),
      ).toMatchObject([{ sessionId: "usage-2", createdAt: 20 }]);
    });
  });
});
