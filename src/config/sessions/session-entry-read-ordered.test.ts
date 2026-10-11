import { expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { withSessionEntriesFromStoresInWorker } from "./session-entry-read-runtime.js";

it("retains the foreground FIFO through a nested ordered read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:nested-read";
    writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
    const options = { agentId: "main", path: database.path, env };
    const entered = createDeferred();
    const ready = createDeferred();
    const order: string[] = [];
    const outer = runOpenClawAgentWriteAdmission(options, async () => {
      entered.resolve();
      await ready.promise;
      await withSessionEntriesFromStoresInWorker(
        [{ agentId: "main", storePath: database.path, sessionKeys: [sessionKey], env }],
        ([read]) => {
          read?.assertCurrent();
          expect(read?.result.entries[0]?.entry.sessionId).toBe("original");
          order.push("read");
        },
        { ordered: true },
      );
      expect(order).toEqual(["read"]);
    });
    await awaitGateBeforeSettlement(entered.promise, outer, "Foreground admission did not begin");
    const following = runOpenClawAgentWriteAdmission(options, () => {
      order.push("writer");
    });
    ready.resolve();
    await Promise.all([outer, following]);
    expect(order).toEqual(["read", "writer"]);
  });
});

it("rejects an ordered read inside an active worker reservation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:reserved-read";
    writeSessionEntry(database, sessionKey, { sessionId: "reserved", updatedAt: 1 });
    let consumed = false;
    const prepared = createDeferred();
    const { pending } = await runOpenClawAgentWorkerWrite(
      { agentId: "main", path: database.path, env },
      async () => {
        const read = withSessionEntriesFromStoresInWorker(
          [{ agentId: "main", storePath: database.path, sessionKeys: [sessionKey], env }],
          () => {
            consumed = true;
          },
          { ordered: true, prepareSource: () => prepared.resolve() },
        );
        void read.catch(() => {});
        await awaitGateBeforeSettlement(prepared.promise, read, "Reader source was not prepared");
        return { pending: read };
      },
    );
    await expect(pending).rejects.toThrow("cannot reenter an active SQLite writer admission");
    expect(consumed).toBe(false);
  });
});

it("rejects ordered reads that invert an inherited store acquisition", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const first = openOpenClawAgentDatabase({ agentId: "first", env });
    const second = openOpenClawAgentDatabase({ agentId: "second", env });
    const lower = first.path < second.path ? first : second;
    const higher = lower === first ? second : first;
    const sessionKey = `agent:${lower.agentId}:ordered-read`;
    writeSessionEntry(lower, sessionKey, { sessionId: "lower", updatedAt: 1 });
    await expect(
      runOpenClawAgentWriteAdmission({ agentId: higher.agentId, path: higher.path, env }, () =>
        withSessionEntriesFromStoresInWorker(
          [{ agentId: lower.agentId, storePath: lower.path, sessionKeys: [sessionKey], env }],
          () => {},
          { ordered: true },
        ),
      ),
    ).rejects.toThrow("would invert inherited SQLite writer admission order");
  });
});
