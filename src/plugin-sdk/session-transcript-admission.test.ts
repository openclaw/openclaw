import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  appendTranscriptEvent,
  loadTranscriptEvents,
  replaceTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readSessionTranscriptContextMessages } from "../config/sessions/session-accessor.sqlite-model-context.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import {
  historyLane,
  rotateDatabaseWorkers,
} from "../config/sessions/session-transcript-worker-resources.js";
import { createRuntimeAgent } from "../plugins/runtime/runtime-agent.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
const {
  readTranscriptAdmission: readSessionTranscriptAdmission,
  acceptTranscriptAdmission: acceptSessionTranscriptAdmission,
} = createRuntimeAgent().session;
import { readVisibleSessionTranscriptMessageEntries } from "./session-transcript-runtime.js";
let state: OpenClawTestState;
let scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string };
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-reset-admission-" });
  scope = {
    agentId: "main",
    sessionId: "fixed",
    sessionKey: "agent:main:reset-proof",
    storePath: path.join(state.root, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
});
afterEach(async () => {
  await state.cleanup();
});
it.each(["clear", "preserve-tail"] as const)(
  "reproduces reset-ineligible SDK entries after %s",
  async (context) => {
    for (let i = 0; i < 10; i++) {
      await appendTranscriptMessage(scope, {
        eventId: "old-" + i,
        message: { role: i % 2 ? "assistant" : "user", content: "old-" + i, timestamp: i },
      });
    }
    await resetSessionEntryLifecycle({
      storePath: scope.storePath,
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      resetBoundary: { context, reason: "reset", cwd: state.root },
      buildNextEntry: () => ({ sessionId: scope.sessionId, updatedAt: 20 }),
    });
    await appendTranscriptMessage(scope, {
      eventId: "new-user",
      message: { role: "user", content: "new-user", timestamp: 11 },
    });
    const generic = await readVisibleSessionTranscriptMessageEntries(scope);
    const canonical = readSessionTranscriptContextMessages(scope, (messages) => [...messages]);
    expect(canonical).toHaveLength(context === "clear" ? 1 : 7);
    expect(generic).toHaveLength(11);
    const snapshot = await readSessionTranscriptAdmission(scope);
    expect(snapshot.kind).toBe("snapshot");
    if (snapshot.kind !== "snapshot") {
      throw new Error("missing admission snapshot");
    }
    expect(snapshot.entries).toHaveLength(canonical.length);
    expect(snapshot.entries.map((entry) => entry.message)).toEqual(canonical);
    expect(await acceptSessionTranscriptAdmission(snapshot.token, () => "committed")).toEqual({
      kind: "accepted",
      value: "committed",
    });
  },
);

async function getAdmissionSnapshot() {
  const value = await readSessionTranscriptAdmission(scope);
  if (value.kind !== "snapshot") {
    throw new Error("expected snapshot, got " + value.kind);
  }
  return value;
}
async function reset(context: "clear" | "preserve-tail" = "clear") {
  return resetSessionEntryLifecycle({
    storePath: scope.storePath,
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    resetBoundary: { context, reason: "reset", cwd: state.root },
    buildNextEntry: ({ currentEntry }) => ({
      ...currentEntry,
      sessionId: scope.sessionId,
      updatedAt: (currentEntry?.updatedAt ?? 0) + 1,
    }),
  });
}

it("distinguishes an empty admitted context, missing session, and stale identity", async () => {
  const empty = await getAdmissionSnapshot();
  expect(empty.entries).toEqual([]);
  expect(empty.boundary).toBeNull();
  expect(
    await readSessionTranscriptAdmission({ ...scope, sessionKey: "agent:main:missing" }),
  ).toEqual({ kind: "missing" });
  expect(await readSessionTranscriptAdmission({ ...scope, sessionId: "not-current" })).toEqual({
    kind: "stale",
  });
});

it("rejects reset between snapshot and acceptance without invoking persistence", async () => {
  await appendTranscriptMessage(scope, { message: { role: "user", content: "before" } });
  const before = await getAdmissionSnapshot();
  await reset();
  let invoked = false;
  expect(
    await acceptSessionTranscriptAdmission(before.token, () => {
      invoked = true;
    }),
  ).toEqual({ kind: "stale" });
  expect(invoked).toBe(false);
  const after = await getAdmissionSnapshot();
  expect(after.entries).toEqual([]);
  expect(after.boundary).not.toBeNull();
});

it("holds reset admission through async plugin persistence and consumes tokens once", async () => {
  const first = await getAdmissionSnapshot();
  const entered = createDeferredCore();
  const persist = createDeferredCore();
  const order: string[] = [];
  const acceptance = acceptSessionTranscriptAdmission(first.token, async () => {
    entered.resolve();
    await persist.promise;
    order.push("plugin-committed");
    return 1;
  });
  await entered.promise;
  const resetting = reset().then(() => {
    order.push("reset-committed");
  });
  persist.resolve();
  expect(await acceptance).toEqual({ kind: "accepted", value: 1 });
  await resetting;
  expect(order).toEqual(["plugin-committed", "reset-committed"]);
  expect(
    await acceptSessionTranscriptAdmission(first.token, () => {
      throw new Error("duplicate callback");
    }),
  ).toEqual({ kind: "stale" });
});

it("propagates persistence failure without replaying it or stranding reset", async () => {
  const before = await getAdmissionSnapshot();
  const failure = new Error("plugin persistence failed");
  await expect(
    acceptSessionTranscriptAdmission(before.token, () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  await reset();
  expect((await getAdmissionSnapshot()).boundary).not.toBeNull();
});

it("reconciles duplicate and out-of-order lifecycle hints against the current durable boundary", async () => {
  await reset();
  const older = await getAdmissionSnapshot();
  await reset();
  const newer = await getAdmissionSnapshot();
  let conversation: string | null = null;
  let rotations = 0;
  const reconcile = async () => {
    const current = await getAdmissionSnapshot();
    return acceptSessionTranscriptAdmission(current.token, (boundary) => {
      if (conversation !== boundary?.entryId) {
        conversation = boundary?.entryId ?? null;
        rotations++;
      }
    });
  };
  await reconcile(); // Bootstrap can win before either delayed notification.
  await reconcile(); // Newer hook.
  await reconcile(); // Older hook.
  expect(conversation).toBe(newer.boundary?.entryId);
  expect(rotations).toBe(1);
  expect(older.boundary?.rawSeq).toBeLessThan(newer.boundary!.rawSeq);
  expect(
    await acceptSessionTranscriptAdmission(older.token, () => {
      throw new Error("late reset");
    }),
  ).toEqual({ kind: "stale" });
});

it.each(["append", "branch", "rewrite"] as const)(
  "invalidates detached work on %s without mutating its payload",
  async (change) => {
    await appendTranscriptMessage(scope, {
      eventId: "first",
      message: { role: "user", content: "first" },
    });
    await appendTranscriptMessage(scope, {
      eventId: "second",
      message: { role: "assistant", content: "second" },
    });
    const before = await getAdmissionSnapshot();
    if (change === "rewrite") {
      await replaceTranscriptEvents(scope, await loadTranscriptEvents(scope));
    } else if (change === "branch") {
      await appendTranscriptEvent(scope, {
        type: "leaf",
        id: "branch",
        targetId: "first",
        parentId: "second",
      });
    } else {
      await appendTranscriptMessage(scope, { message: { role: "user", content: "append" } });
    }
    expect(
      await acceptSessionTranscriptAdmission(before.token, () => {
        throw new Error("stale write");
      }),
    ).toEqual({ kind: "stale" });
    expect(before.entries.map((entry) => entry.entryId)).toEqual(["first", "second"]);
  },
);

it("keeps reset-eligible raw messages across host compaction", async () => {
  await appendTranscriptMessage(scope, {
    eventId: "raw-first",
    message: { role: "user", content: "raw" },
  });
  await appendTranscriptMessage(scope, {
    eventId: "raw-last",
    message: { role: "assistant", content: "answer" },
  });
  await appendTranscriptEvent(scope, {
    type: "compaction",
    id: "compact",
    parentId: "raw-last",
    summary: "host summary",
    firstKeptEntryId: "raw-last",
    tokensBefore: 10,
    timestamp: new Date(0).toISOString(),
  });
  expect((await getAdmissionSnapshot()).entries.map((entry) => entry.entryId)).toEqual([
    "raw-first",
    "raw-last",
  ]);
});

it("retains tool-call/result groups and leaves raw events unchanged", async () => {
  await appendTranscriptMessage(scope, {
    eventId: "user",
    message: { role: "user", content: "use tool" },
  });
  await appendTranscriptMessage(scope, {
    eventId: "call",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "proof", arguments: {} }],
    },
  });
  await appendTranscriptMessage(scope, {
    eventId: "result",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "proof",
      content: [{ type: "text", text: "result" }],
      isError: false,
    },
  });
  await appendTranscriptMessage(scope, {
    eventId: "answer",
    message: { role: "assistant", content: "done" },
  });
  const rawBefore = await loadTranscriptEvents(scope);
  await reset("preserve-tail");
  const current = await getAdmissionSnapshot();
  expect(current.entries.map((entry) => entry.entryId)).toEqual([
    "user",
    "call",
    "result",
    "answer",
  ]);
  const rawAfter = await loadTranscriptEvents(scope);
  expect(rawAfter.slice(0, rawBefore.length)).toEqual(rawBefore);
  await acceptSessionTranscriptAdmission(current.token, () => undefined);
  expect(await loadTranscriptEvents(scope)).toEqual(rawAfter);
});

it("keeps the admitted current turn outside bootstrap and refuses it after reset", async () => {
  await appendTranscriptMessage(scope, {
    eventId: "prior",
    message: { role: "user", content: "prior" },
  });
  const current = await appendTranscriptMessage(scope, {
    eventId: "current",
    message: { role: "user", content: "current" },
  });
  if (!current?.anchor) {
    throw new Error("expected admitted current turn");
  }
  const admission = { ...current.anchor, role: "user" as const, logicalTurnId: "current-turn" };
  const before = await runWithSessionTranscriptReadFence(admission, getAdmissionSnapshot);
  expect(before.entries.map((entry) => entry.entryId)).toEqual(["prior"]);
  await reset();
  expect(
    await runWithSessionTranscriptReadFence(admission, () => readSessionTranscriptAdmission(scope)),
  ).toEqual({ kind: "stale" });
  expect(
    await acceptSessionTranscriptAdmission(before.token, () => {
      throw new Error("retired bootstrap");
    }),
  ).toEqual({ kind: "stale" });
});

it("does not reconstruct a serialized capability or reuse one after host closure", async () => {
  const captured = await getAdmissionSnapshot();
  expect(
    await acceptSessionTranscriptAdmission(structuredClone(captured.token), () => {
      throw new Error("reconstructed token");
    }),
  ).toEqual({ kind: "stale" });
  await state.cleanup();
  let invoked = false;
  await expect(
    acceptSessionTranscriptAdmission(captured.token, () => {
      invoked = true;
    }),
  ).rejects.toThrow();
  expect(invoked).toBe(false);
});

it("accepts unchanged work after ordinary idle-reader retirement", async () => {
  await appendTranscriptMessage(scope, { message: { role: "user", content: "stable" } });
  const captured = await getAdmissionSnapshot();
  await rotateDatabaseWorkers(historyLane);
  expect(await acceptSessionTranscriptAdmission(captured.token, () => "persisted")).toEqual({
    kind: "accepted",
    value: "persisted",
  });
});
