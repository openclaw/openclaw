import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { prepareQualifiedSessionEntryTarget } from "../config/sessions/session-accessor.entry.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import * as sessionEntryReaders from "../config/sessions/session-entry-read-runtime.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../state/openclaw-agent-write-admission-state.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveGatewaySessionStoreTargetWithStoreAsync,
  withGatewaySessionStoreTarget,
} from "./session-utils-store-lookup.js";
import { withQualifiedGatewaySessionStoreTarget } from "./session-utils-store-retained.js";
import { withQualifiedGatewaySessionEntry } from "./session-utils-store.js";

const sessionEntry = { sessionId: "same-session", updatedAt: 1 };
const memberIds = (rows: readonly { identityId: string }[] | undefined) =>
  rows?.map(({ identityId }) => identityId).toSorted();
type Consume = Parameters<typeof withQualifiedGatewaySessionStoreTarget>[0]["consume"];
type WorkerRead = typeof sessionEntryReaders.withSessionEntriesFromStoresInWorker;

function interceptRead(wrap: (read: WorkerRead) => WorkerRead) {
  const original = sessionEntryReaders.withSessionEntriesFromStoresInWorker;
  return vi
    .spyOn(sessionEntryReaders, "withSessionEntriesFromStoresInWorker")
    .mockImplementation(wrap(original));
}

function makeSession(env: NodeJS.ProcessEnv) {
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  setRuntimeConfigSnapshot(cfg);
  const key = "agent:main:freshness";
  const scope = { agentId: "main", sessionKey: key, env };
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  return {
    lookup: { cfg, key, env },
    scope,
    database,
    commit: (write: () => void) =>
      runOpenClawAgentWriteAdmission({ agentId: "main", path: database.path, env }, write),
    write: (label: string, updatedAt: number) =>
      writeSessionEntry(database, key, { ...sessionEntry, label, updatedAt }),
    member: (identityId: string, addedAt = 1) =>
      addSessionMember(scope, { identityId, addedBy: "owner", addedAt }),
  };
}

async function withSession(run: (fixture: ReturnType<typeof makeSession>) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, ({ env }) => run(makeSession(env)));
}

async function qualify(lookup: ReturnType<typeof makeSession>["lookup"]) {
  const { key, env } = lookup;
  const selected = await resolveGatewaySessionStoreTargetWithStoreAsync({
    ...lookup,
    exactRead: true,
  });
  const qualified = await prepareQualifiedSessionEntryTarget(
    { ...selected, requestedKey: key, storeKey: key, readSource: selected.capturedReadSource },
    selected.capturedReadSources,
    env,
  );
  return { target: qualified, logicalStorePath: selected.storePath, env };
}

it("reads current qualified facts and recovers lifecycle timestamps only when requested", async () => {
  await withSession(async ({ lookup, scope, member }) => {
    const sessionId = "qualified-lifecycle";
    const entry = { sessionId, updatedAt: 2_000, lastInteractionAt: 1_500 };
    await replaceSessionEntry(scope, { ...entry, label: "before" });
    await replaceTranscriptEvents({ ...scope, sessionId }, [
      { type: "session", id: sessionId, version: 3, timestamp: "1970-01-01T00:00:01.000Z" },
    ]);
    member("first-member");
    const selected = await qualify(lookup);
    const read = (includeLifecycle = false) =>
      withQualifiedGatewaySessionEntry({
        ...selected,
        cfg: lookup.cfg,
        includeMembership: true,
        includeLifecycle,
        assertConfigCurrent() {},
        consume(current, members, assertCurrent) {
          assertCurrent();
          return {
            label: current.entry?.label,
            members: memberIds(members.get(lookup.key)),
            timestamps: current.lifecycleTimestamps,
          };
        },
      });
    const before = { label: "before", members: ["first-member"], timestamps: {} };
    await expect(read()).resolves.toEqual(before);
    await replaceSessionEntry(scope, { ...entry, label: "after" });
    member("second-member", 2);
    const after = { ...before, label: "after", members: ["first-member", "second-member"] };
    await expect(read()).resolves.toEqual(after);
    await expect(read(true)).resolves.toEqual({
      ...after,
      timestamps: { sessionStartedAt: 1_000, lastInteractionAt: 1_500 },
    });
  });
});

it.for(["membership", "explicit", "qualified"] as const)(
  "consumes facts committed before its %s-ordered snapshot",
  async (ordering) => {
    await withSession(async ({ lookup, scope, commit, write, member }) => {
      const { key } = lookup;
      await replaceSessionEntry(scope, sessionEntry);
      const selected = ordering === "qualified" ? await qualify(lookup) : undefined;
      const committedValues: string[] = [];
      const pendingValues = ["first-value", "second-value"];
      const ordered = ordering === "explicit";
      using _ = interceptRead((readEntries) => async (inputs, consume, options) => {
        const value = pendingValues.shift();
        if (value) {
          // Real writes win the FIFO before the reader starts its snapshot.
          await commit(() => {
            if (!ordered) {
              member(value);
            } else {
              write(value, 2);
            }
            committedValues.push(value);
          });
        }
        return readEntries(inputs, consume, options);
      });
      let consumptions = 0;
      const consume: Consume = (target, membership, assertCurrent) => {
        consumptions += 1;
        assertCurrent();
        expect(target.store[key]?.sessionId).toBe("same-session");
        return ordered ? target.store[key]?.label : memberIds(membership.get(key));
      };
      const result = selected
        ? await withQualifiedGatewaySessionStoreTarget({
            ...selected,
            includeMembership: true,
            consume,
          })
        : await withGatewaySessionStoreTarget(
            { ...lookup, includeMembership: !ordered, ordered },
            consume,
          );
      expect(result).toEqual(ordered ? committedValues.at(-1) : committedValues.toSorted());
      expect(committedValues).toContain("first-value");
      expect(consumptions).toBe(1);
    });
  },
);

it("consumes a fresh metadata snapshot before the next queued writer", async () => {
  await withSession(async ({ lookup, scope, database, commit, write }) => {
    replaceSessionEntrySync(scope, { ...sessionEntry, label: "initial" });
    const events: string[] = [];
    const writes: Promise<void>[] = [];
    const read = interceptRead((readEntries) => async (inputs, consume, options) => {
      await Promise.all(writes);
      // Writer results settle before their FIFO drain releases the idle lane.
      await SQLITE_SESSION_WRITER_QUEUES.get(database.path)?.drainPromise;
      return readEntries(
        inputs,
        (prepared) => {
          const revision = writes.length + 1;
          const label = `write-${revision}`;
          // Commit after snapshot capture, or queue behind a reader that owns the FIFO.
          const pending = commit(() => {
            write(label, revision + 1);
            events.push(label);
          });
          writes.push(pending);
          void pending.catch(() => {});
          return consume(prepared);
        },
        options,
      );
    });
    try {
      const label = await withGatewaySessionStoreTarget(
        lookup,
        (target, _membership, assertCurrent) => {
          assertCurrent();
          events.push("consume");
          return target.store[lookup.key]?.label;
        },
      );
      await Promise.all(writes);
      expect(label).toBe("write-1");
      expect(events).toEqual(["write-1", "consume", "write-2"]);
      expect(loadSessionEntry(scope)?.label).toBe("write-2");
    } finally {
      read.mockRestore();
      await Promise.allSettled(writes);
    }
  });
});

it.each(["during", "repeated", "consume"] as const)(
  "consumes an ordered sharing snapshot with a native write %s admission",
  async (timing) => {
    await withSession(async ({ lookup, scope, database, member }) => {
      const { key } = lookup;
      await replaceSessionEntry(scope, sessionEntry);
      const committedMembers: string[] = [];
      const pendingMembers =
        timing === "repeated" ? ["first-member", "second-member"] : ["first-member"];
      let reads = 0;
      using _ = interceptRead((readEntries) => async (inputs, consume, options) => {
        reads += 1;
        return readEntries(inputs, consume, {
          ...options,
          onReadAdmitted() {
            options?.onReadAdmitted?.();
            if (timing === "during" || timing === "repeated") {
              const identityId = pendingMembers.shift();
              if (identityId) {
                member(identityId);
                committedMembers.push(identityId);
              }
            }
          },
        });
      });
      let consumptions = 0;
      const reading = withGatewaySessionStoreTarget(
        { ...lookup, includeMembership: true },
        (target, membership, assertCurrent) => {
          consumptions += 1;
          if (timing === "consume") {
            database.db
              .prepare("UPDATE session_nodes SET updated_at = updated_at + 1 WHERE session_key = ?")
              .run(key);
          }
          assertCurrent();
          expect(target.store[key]?.sessionId).toBe("same-session");
          return memberIds(membership.get(key));
        },
      );
      if (timing === "repeated" || timing === "consume") {
        await expect(reading).rejects.toThrow("Session entry changed during read");
        expect(reads).toBe(timing === "repeated" ? 2 : 1);
        expect(consumptions).toBe(timing === "consume" ? 1 : 0);
      } else {
        expect(await reading).toEqual(committedMembers.toSorted());
        expect({ reads, consumptions }).toEqual({ reads: 2, consumptions: 1 });
      }
    });
  },
);
