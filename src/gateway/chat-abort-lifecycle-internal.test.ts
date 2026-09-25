import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  isCurrentChatAbortExecution,
  markChatAbortTerminalPersistenceError,
  runWithChatAbortExecution,
  waitForChatAbortControllerRemoval,
} from "./chat-abort-lifecycle-internal.js";
import {
  abortChatRunById,
  registerChatAbortController,
  removeChatAbortControllerEntry,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";

function registeredRun() {
  const entries = new Map<string, ChatAbortControllerEntry>();
  const runId = "terminal-drain";
  const registration = registerChatAbortController({
    chatAbortControllers: entries,
    runId,
    sessionId: "terminal-session",
    sessionKey: "agent:main:terminal",
    timeoutMs: 60_000,
  });
  const entry = registration.entry;
  if (!entry) {
    throw new Error("Expected a registered run");
  }
  const drain = () =>
    waitForChatAbortControllerRemoval({
      entries,
      targets: [{ runId, entry }],
      timeoutMs: 1_000,
    });
  return { entries, runId, entry, registration, drain };
}

it.each(
  ["settled", "pending", "writing", "failed"].flatMap((state) =>
    [false, true].map((alreadyRemoved) => ({ state, alreadyRemoved })),
  ),
)(
  "checks $state terminal ownership when alreadyRemoved=$alreadyRemoved",
  async ({ state, alreadyRemoved }) => {
    const { entries, runId, entry, drain } = registeredRun();
    if (state === "pending") {
      entry.projectSessionTerminalPending = true;
    } else if (state === "writing") {
      entry.projectSessionTerminalPersistence = new Promise<void>(() => {});
    } else if (state === "failed") {
      markChatAbortTerminalPersistenceError(entry, new Error("terminal write failed"));
    }
    if (alreadyRemoved) {
      removeChatAbortControllerEntry(entries, runId, entry);
    }
    const result = drain();
    removeChatAbortControllerEntry(entries, runId, entry);
    expect(await result).toBe(state === "settled");
  },
);

it("finishes an empty selection without draining unrelated registrations", async () => {
  const { entries, runId } = registeredRun();
  expect(await waitForChatAbortControllerRemoval({ entries, targets: [], timeoutMs: 1_000 })).toBe(
    true,
  );
  expect(entries.has(runId)).toBe(true);
});

it("releases the reserved terminal owner when no lifecycle subscriber adopts it", async () => {
  const { entries, runId, entry, drain } = registeredRun();
  const result = drain();
  expect(
    abortChatRunById(
      {
        chatAbortControllers: entries,
        chatRunState: createChatRunState(),
        removeChatRun: () => undefined,
        agentRunSeq: new Map(),
        broadcast: () => {},
        nodeSendToSession: () => {},
      },
      { runId, sessionKey: entry.sessionKey },
    ),
  ).toEqual({ aborted: true });
  expect(await result).toBe(true);
  expect(entries.has(runId)).toBe(false);
});

it.each(["fulfilled", "rejected"] as const)(
  "drains a promise-only registration after it is %s",
  async (outcome) => {
    const { entries, runId, entry, registration, drain } = registeredRun();
    const persistence = createDeferred();
    entry.projectSessionTerminalPersistence = persistence.promise;
    const result = drain();
    registration.cleanup();
    expect(entries.get(runId)).toBe(entry);
    if (outcome === "fulfilled") {
      persistence.resolve();
    } else {
      persistence.reject(new Error("terminal write failed"));
    }
    expect(await result).toBe(outcome === "fulfilled");
    expect(entries.has(runId)).toBe(false);
  },
);

it.each(["fulfilled", "rejected"] as const)(
  "does not retire a replacement persistence owner when an older write is %s",
  async (outcome) => {
    const { entries, runId, entry, registration, drain } = registeredRun();
    const previous = createDeferred();
    const current = createDeferred();
    entry.projectSessionTerminalPersistence = previous.promise;
    registration.cleanup();
    entry.projectSessionTerminalPersistence = current.promise;
    if (outcome === "fulfilled") {
      previous.resolve();
    } else {
      previous.reject(new Error("older terminal write failed"));
    }
    await previous.promise.catch(() => {});
    await Promise.resolve();
    expect(entries.get(runId)).toBe(entry);
    const result = drain();
    registration.cleanup();
    current.resolve();
    expect(await result).toBe(true);
  },
);

it.each(["settled", "pending", "writing", "failed"] as const)(
  "self-drain preserves %s terminal ownership and still joins its sibling",
  async (state) => {
    const { entries, runId, entry, registration } = registeredRun();
    const sibling = registerChatAbortController({
      chatAbortControllers: entries,
      runId: "sibling-tail",
      sessionId: entry.sessionId,
      sessionKey: entry.sessionKey,
      kind: "agent",
      timeoutMs: 60_000,
    });
    const siblingEntry = sibling.entry!;
    const releaseSibling = createDeferred();
    const selectedSibling = createDeferred();
    const siblingWork = runWithChatAbortExecution(
      siblingEntry,
      async () => {
        sibling.cleanup();
        await releaseSibling.promise;
      },
      sibling.cleanup,
    );
    const terminalWrite = createDeferred();
    void terminalWrite.promise.catch(() => {});
    let drainDone = false;
    const ownWork = runWithChatAbortExecution(
      entry,
      async () => {
        if (state === "pending") {
          entry.projectSessionTerminalPending = true;
        }
        if (state === "writing") {
          entry.projectSessionTerminalPersistence = terminalWrite.promise;
        }
        if (state === "failed") {
          markChatAbortTerminalPersistenceError(entry, new Error("write failed"));
        }
        const draining = waitForChatAbortControllerRemoval({
          entries,
          targets: [
            { runId, entry },
            { runId: "sibling-tail", entry: siblingEntry },
          ],
          timeoutMs: 1_000,
        });
        selectedSibling.resolve();
        expect(await draining).toBe(state === "settled");
        drainDone = true;
        entry.projectSessionTerminalPending = false;
        entry.projectSessionTerminalPersistence = undefined;
        markChatAbortTerminalPersistenceError(entry, undefined);
        registration.cleanup();
      },
      registration.cleanup,
    );
    await selectedSibling.promise;
    expect(drainDone).toBe(false);
    releaseSibling.resolve();
    if (state === "writing") {
      terminalWrite.reject(new Error("terminal write failed"));
    }
    await Promise.all([ownWork, siblingWork]);
    expect(entries.size).toBe(0);
  },
);

it("does not let an inherited continuation exclude a rejected execution owner", async () => {
  const { entries, runId, entry, registration } = registeredRun();
  const resume = createDeferred();
  let inherited: Promise<boolean> | undefined;
  const failure = new Error("execution disposal rejected");
  const execution = runWithChatAbortExecution(
    entry,
    async () => {
      inherited = resume.promise.then(() => isCurrentChatAbortExecution(entry));
      registration.cleanup();
      throw failure;
    },
    registration.cleanup,
  );
  await expect(execution).rejects.toBe(failure);
  resume.resolve();
  expect(await inherited).toBe(false);
  expect(entries.get(runId)).toBe(entry);
  expect(entry.executionSettlement?.status).toBe("rejected");
});

it("settles an expired timeout receipt while retaining pending raw execution", async () => {
  const { entries, runId, entry, registration } = registeredRun();
  const finish = createDeferred();
  const execution = runWithChatAbortExecution(
    entry,
    async () => {
      await finish.promise;
      registration.cleanup();
    },
    registration.cleanup,
  );
  let receipts = 0;
  expect(
    registration.deferTimeoutCompletion(() => {
      receipts += 1;
    }),
  ).toBe(true);
  const receipt = entry.pendingTimeoutCompletion;
  if (!receipt) {
    throw new Error("Expected the owned timeout receipt");
  }
  receipt.expiresAtMs = 0;
  try {
    expect(removeChatAbortControllerEntry(entries, runId, entry)).toBe(false);
    expect(receipts).toBe(1);
    expect(entries.get(runId)).toBe(entry);
    expect(entry.executionSettlement?.status).toBe("pending");
    expect(entry.pendingTimeoutCompletion).toBeUndefined();
  } finally {
    finish.resolve();
    await execution;
  }
  expect(entries.has(runId)).toBe(false);
  expect(receipts).toBe(1);
});

it("joins its own terminal write without waiting for its own raw completion", async () => {
  const { entries, runId, entry, registration } = registeredRun();
  const persistence = createDeferred();
  await runWithChatAbortExecution(
    entry,
    async () => {
      entry.projectSessionTerminalPersistence = persistence.promise;
      registration.cleanup();
      const draining = waitForChatAbortControllerRemoval({
        entries,
        targets: [{ runId, entry }],
        timeoutMs: 1_000,
      });
      persistence.resolve();
      expect(await draining).toBe(true);
      expect(entry.executionSettlement?.status).toBe("pending");
    },
    registration.cleanup,
  );
  expect(entries.has(runId)).toBe(false);
});
