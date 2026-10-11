import { expect, it, vi } from "vitest";
import { prepareQualifiedSessionEntryTarget } from "../config/sessions/session-accessor.entry.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import * as sessionEntryReaders from "../config/sessions/session-entry-read-runtime.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../state/openclaw-agent-write-admission-state.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveGatewaySessionStoreTargetWithStore,
  withGatewaySessionStoreTarget,
} from "./session-utils-store-lookup.js";
import { withQualifiedGatewaySessionStoreTarget } from "./session-utils-store-retained.js";

it.for(["membership", "explicit", "qualified"] as const)(
  "consumes facts committed before its %s-ordered snapshot",
  async (ordering) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const key = "agent:main:sharing-before-snapshot";
      const scope = { agentId: "main", sessionKey: key, env };
      await replaceSessionEntry(scope, { sessionId: "same-session", updatedAt: 1 });
      const selected =
        ordering === "qualified"
          ? resolveGatewaySessionStoreTargetWithStore({ cfg, key, env, exactRead: true })
          : undefined;
      const qualified = selected
        ? prepareQualifiedSessionEntryTarget(
            {
              ...selected,
              requestedKey: key,
              storeKey: key,
              readSource: selected.capturedReadSource,
            },
            selected.capturedReadSources,
            env,
          )
        : undefined;
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const committedValues: string[] = [];
      const pendingValues = ["first-value", "second-value"];
      const readEntries = sessionEntryReaders.withSessionEntriesFromStoresInWorker;
      const read = vi
        .spyOn(sessionEntryReaders, "withSessionEntriesFromStoresInWorker")
        .mockImplementation(async (inputs, consume, options) => {
          const value = pendingValues.shift();
          if (value) {
            // Real writes win the FIFO before the reader starts its snapshot.
            await runOpenClawAgentWriteAdmission(
              { agentId: "main", path: database.path, env },
              () => {
                if (ordering !== "explicit") {
                  addSessionMember(scope, { identityId: value, addedBy: "owner", addedAt: 1 });
                } else {
                  writeSessionEntry(database, key, {
                    sessionId: "same-session",
                    updatedAt: 2,
                    label: value,
                  });
                }
                committedValues.push(value);
              },
            );
          }
          return readEntries(inputs, consume, options);
        });
      let consumptions = 0;
      try {
        const consume: Parameters<
          typeof withQualifiedGatewaySessionStoreTarget<{ members?: string[]; label?: string }>
        >[0]["consume"] = (target, membership, assertCurrent) => {
          consumptions += 1;
          assertCurrent();
          expect(target.store[key]?.sessionId).toBe("same-session");
          return ordering !== "explicit"
            ? {
                members: membership
                  .get(key)
                  ?.map((member) => member.identityId)
                  .toSorted(),
              }
            : { label: target.store[key]?.label };
        };
        const result =
          qualified && selected
            ? await withQualifiedGatewaySessionStoreTarget({
                target: qualified.target,
                logicalStorePath: selected.storePath,
                env,
                includeMembership: true,
                consume,
              })
            : await withGatewaySessionStoreTarget(
                {
                  cfg,
                  key,
                  env,
                  includeMembership: ordering === "membership",
                  ordered: ordering === "explicit",
                },
                consume,
              );
        expect(result).toEqual(
          ordering !== "explicit"
            ? { members: committedValues.toSorted() }
            : { label: committedValues.at(-1) },
        );
        expect(committedValues).toContain("first-value");
        expect(consumptions).toBe(1);
      } finally {
        read.mockRestore();
        qualified?.release();
      }
    });
  },
);

it("consumes a fresh metadata snapshot before the next queued writer", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const key = "agent:main:concurrent-metadata";
    const scope = { agentId: "main", sessionKey: key, env };
    replaceSessionEntrySync(scope, {
      sessionId: "same-session",
      updatedAt: 1,
      label: "initial",
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const events: string[] = [];
    const writes: Promise<void>[] = [];
    const readEntries = sessionEntryReaders.withSessionEntriesFromStoresInWorker;
    const read = vi
      .spyOn(sessionEntryReaders, "withSessionEntriesFromStoresInWorker")
      .mockImplementation(async (inputs, consume, options) => {
        await Promise.all(writes);
        // Writer results settle before their FIFO drain releases the idle lane.
        await SQLITE_SESSION_WRITER_QUEUES.get(database.path)?.drainPromise;
        return readEntries(
          inputs,
          (prepared) => {
            const revision = writes.length + 1;
            const label = `write-${revision}`;
            // Commit after snapshot capture, or queue behind a reader that owns the FIFO.
            const write = runOpenClawAgentWriteAdmission(
              { agentId: "main", path: database.path, env },
              () => {
                writeSessionEntry(database, key, {
                  sessionId: "same-session",
                  updatedAt: revision + 1,
                  label,
                });
                events.push(label);
              },
            );
            writes.push(write);
            void write.catch(() => {});
            return consume(prepared);
          },
          options,
        );
      });
    try {
      const label = await withGatewaySessionStoreTarget(
        { cfg, key, env },
        (target, _membership, assertCurrent) => {
          assertCurrent();
          events.push("consume");
          return target.store[key]?.label;
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
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const key = "agent:main:sharing-before-snapshot";
      const scope = { agentId: "main", sessionKey: key, env };
      await replaceSessionEntry(scope, { sessionId: "same-session", updatedAt: 1 });
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const committedMembers: string[] = [];
      const pendingMembers =
        timing === "repeated" ? ["first-member", "second-member"] : ["first-member"];
      let reads = 0;
      const readEntries = sessionEntryReaders.withSessionEntriesFromStoresInWorker;
      const read = vi
        .spyOn(sessionEntryReaders, "withSessionEntriesFromStoresInWorker")
        .mockImplementation(async (inputs, consume, options) => {
          reads += 1;
          const write = () => {
            const identityId = pendingMembers.shift();
            if (identityId) {
              addSessionMember(scope, { identityId, addedBy: "owner", addedAt: 1 });
              committedMembers.push(identityId);
            }
          };
          return readEntries(inputs, consume, {
            ...options,
            onReadAdmitted() {
              options?.onReadAdmitted?.();
              if (timing === "during" || timing === "repeated") {
                write();
              }
            },
          });
        });
      let consumptions = 0;
      try {
        const reading = withGatewaySessionStoreTarget(
          { cfg, key, env, includeMembership: true },
          (target, membership, assertCurrent) => {
            consumptions += 1;
            if (timing === "consume") {
              database.db
                .prepare(
                  "UPDATE session_nodes SET updated_at = updated_at + 1 WHERE session_key = ?",
                )
                .run(key);
            }
            assertCurrent();
            expect(target.store[key]?.sessionId).toBe("same-session");
            return membership
              .get(key)
              ?.map((member) => member.identityId)
              .toSorted();
          },
        );
        if (timing === "repeated" || timing === "consume") {
          await expect(reading).rejects.toThrow("Session entry changed during read");
          expect(reads).toBe(timing === "repeated" ? 2 : 1);
          expect(consumptions).toBe(timing === "consume" ? 1 : 0);
        } else {
          expect(await reading).toEqual(committedMembers.toSorted());
          expect(reads).toBe(2);
          expect(consumptions).toBe(1);
        }
      } finally {
        read.mockRestore();
      }
    });
  },
);
