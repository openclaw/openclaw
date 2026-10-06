import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readSessionEntryResetRecallCutoff } from "../../packages/memory-host-sdk/src/host/session-files.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { IncognitoLifecycleEntry } from "../config/sessions/session-incognito-lifecycle-contract.js";
import {
  readActiveTranscriptEntryAnchorAsync,
  readSessionTranscriptAnchorsAsync,
} from "../config/sessions/session-transcript-anchor-read.js";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence.js";
import {
  createIncognitoSessionComputeReader,
  createIncognitoSessionHistoryReader,
} from "../gateway/session-history-snapshot.js";
import {
  readSessionTranscriptAccountingAsync,
  readSessionTranscriptBoundedMessageTailPageAsync,
} from "../gateway/session-transcript-readers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { registerIncognitoHistoryWiringTests } from "./openclaw-agent-execution-incognito.history-wiring.test-support.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let lossActor: IncognitoAgentDatabaseExecution;
let lossWorker: Worker;
let mainStorePath: string;
let env: NodeJS.ProcessEnv;
let sql: ReturnType<typeof observeHostDataSql>;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-history-") };
  mainStorePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
  const posted = vi.spyOn(Worker.prototype, "postMessage");
  try {
    const opened = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "main",
      env,
      authority,
    });
    const loss = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "loss",
      env,
      authority,
    });
    assert(opened && loss);
    actor = opened;
    lossActor = loss;
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "loss", env });
    const index = posted.mock.calls.findIndex(
      ([request]) =>
        isRecord(request) && request.type === "open" && request.databasePath === sentinel,
    );
    const worker: unknown = posted.mock.contexts[index];
    assert(worker instanceof Worker);
    lossWorker = worker;
  } finally {
    posted.mockRestore();
  }
});
beforeEach(() => {
  sql = observeHostDataSql();
});
afterEach(() => {
  try {
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});
afterAll(async () => {
  await Promise.all([actor?.close(), lossActor?.close()]);
  await closeOpenClawStateDatabaseAsync();
});

async function create(
  name: string,
  owner = actor,
  agentId = "main",
): Promise<IncognitoLifecycleEntry> {
  const sessionKey = `agent:${agentId}:dashboard:incognito-${name}`;
  const created = await owner.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId: name,
      createdAt: 10_000,
      updatedAt: 10_000,
      lifecycleRevision: "initial",
      incognito: true,
    },
  });
  assert(created.entry);
  return { sessionKey, entry: created.entry };
}
function targetInput(target: IncognitoLifecycleEntry) {
  return {
    sessionKey: target.sessionKey,
    sessionId: target.entry.sessionId,
    lifecycleRevision: target.entry.lifecycleRevision,
  };
}
function append(target: IncognitoLifecycleEntry, content: string, owner = actor) {
  return owner.sessions.transcript(authority, {
    type: "session.message.append",
    input: {
      sessionKey: target.sessionKey,
      sessionId: target.entry.sessionId,
      fence: { expectedLifecycleRevision: target.entry.lifecycleRevision },
      message: { role: "assistant", content: [{ type: "text", text: content }], timestamp: 10_000 },
    },
  });
}
function hydrate(target: IncognitoLifecycleEntry, owner = actor, grant = authority) {
  return owner.sessions.history(grant, {
    type: "session.history.hydrate",
    input: targetInput(target),
  });
}
function message(content: string) {
  return expect.objectContaining({
    message: expect.objectContaining({ content: [{ type: "text", text: content }] }),
  });
}
async function hold(owner = actor) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = owner.run(authority, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return { release, held };
}

async function computeReader(target: IncognitoLifecycleEntry, owner = actor, grant = authority) {
  const scope = { ...targetInput(target), agentId: owner.agentId, storePath: owner.path };
  const reader = await createIncognitoSessionComputeReader({
    actor: owner,
    authority: grant,
    target: scope,
  });
  return { reader, scope };
}

it("composes anchor publication inside its actor FIFO and accounting/tail reads without host SQL", async () => {
  const session = await create("anchor-accounting-tail");
  const target = targetInput(session);
  const scope = { ...target, agentId: actor.agentId, storePath: actor.path };
  const binding = { actor, authority, target };
  const first = await append(session, "original message");
  assert(first.ok && first.value.append);
  const entryId = first.value.append.messageId;
  const barrier = await hold();
  try {
    const writing = actor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        sessionKey: target.sessionKey,
        sessionId: target.sessionId,
        fence: { expectedLifecycleRevision: target.lifecycleRevision },
        message: {
          role: "assistant",
          content: "newest accounted answer",
          usage: { input: 200, output: 7 },
          __openclaw: { turnTainted: true },
        },
      },
    });
    let published = false;
    const reading = readSessionTranscriptAnchorsAsync(
      scope,
      { entryIds: [entryId], afterSeq: 0 },
      undefined,
      (facts) => {
        expect(facts.anchors[0]).toMatchObject({ entryId, activeMessagePosition: 0 });
        expect(facts.tail?.entries).toHaveLength(2);
        published = true;
      },
      binding,
    );
    const following = actor.run(authority, async () => {
      expect(published).toBe(true);
    });
    const accounting = readSessionTranscriptAccountingAsync(
      scope,
      { includeByteSize: true, includeUsage: true, includeTurnTaint: true },
      undefined,
      binding,
    );
    const tail = readSessionTranscriptBoundedMessageTailPageAsync(
      scope,
      { maxBytes: 4096, maxMessages: 1, offset: 0 },
      undefined,
      binding,
    );
    barrier.release.resolve();
    const [written, anchors, , usage, page] = await Promise.all([
      writing,
      reading,
      following,
      accounting,
      tail,
    ]);
    expect(written.ok).toBe(true);
    expect(usage).toMatchObject({
      eventCount: 2,
      turnTainted: true,
      usage: { promptTokens: 200, outputTokens: 7, trailingMessages: [] },
    });
    expect(usage.byteSize).toBeGreaterThan(0);
    expect(page).toMatchObject({
      totalMessages: 2,
      newestContiguousEventCount: 1,
      events: [{ event: { message: { content: "newest accounted answer" } } }],
    });
    expect(
      await readActiveTranscriptEntryAnchorAsync({ ...scope, entryId }, undefined, binding),
    ).toEqual(anchors.anchors[0]);
  } finally {
    barrier.release.resolve();
    await barrier.held;
  }
});

it("refuses bound history facades for another store and revoked queued readers", async () => {
  const session = await create("bound-history-revocation");
  await append(session, "private answer");
  const target = targetInput(session);
  const scope = { ...target, agentId: actor.agentId, storePath: actor.path };
  let revoked = false;
  const binding = {
    actor,
    target,
    authority: {
      assertCurrent() {
        if (revoked) {
          throw new Error("bound history revoked");
        }
      },
    },
  };
  const reads = [
    (selected: typeof scope) =>
      readSessionTranscriptAnchorsAsync(selected, { entryIds: [] }, undefined, undefined, binding),
    (selected: typeof scope) =>
      readSessionTranscriptAccountingAsync(
        selected,
        { includeByteSize: true, includeUsage: true },
        undefined,
        binding,
      ),
    (selected: typeof scope) =>
      readSessionTranscriptBoundedMessageTailPageAsync(
        selected,
        { maxBytes: 4096, maxMessages: 1, offset: 0 },
        undefined,
        binding,
      ),
  ];
  for (const read of reads) {
    await expect(read({ ...scope, storePath: lossActor.path })).rejects.toThrow(
      "another session or store",
    );
  }
  const barrier = await hold();
  try {
    const refused = reads.map((read) =>
      expect(read(scope)).rejects.toThrow("bound history revoked"),
    );
    revoked = true;
    barrier.release.resolve();
    await Promise.all(refused);
  } finally {
    barrier.release.resolve();
    await barrier.held;
  }
});

it("projects Memory and Codex snapshots after committed actor writes without host SQL", async () => {
  const target = await create("memory-codex-fifo");
  const { reader, scope } = await computeReader(target);
  const barrier = await hold();
  try {
    const write = append(target, "committed for Memory and Codex");
    const memory = reader.memoryEntry("actor-memory", { sessionKind: "unknown" });
    const recall = reader.memoryResetRecall();
    const context = reader.nativeContext(scope, (messages, header) => ({
      messages: [...messages],
      header,
    }));
    barrier.release.resolve();
    const [written, entry, cutoff, native] = await Promise.all([write, memory, recall, context]);
    expect(written.ok).toBe(true);
    assert(entry);
    expect(entry.content).toBe("Assistant: committed for Memory and Codex");
    expect(entry.lineMap).toEqual([2]);
    expect(cutoff).toEqual({ state: "absent" });
    expect(readSessionEntryResetRecallCutoff(entry)).toEqual(cutoff);
    expect(native.header).toMatchObject({ type: "session", id: scope.sessionId });
    expect(native.messages).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "committed for Memory and Codex" }] },
    ]);
  } finally {
    barrier.release.resolve();
    await barrier.held;
  }
});

it("refuses Memory and Codex disclosure when caller authority is revoked during a FIFO wait", async () => {
  const target = await create("memory-codex-revoked");
  let current = true;
  const grant: IncognitoSessionAuthority = {
    assertCurrent() {
      if (!current) {
        throw new Error("compute caller revoked");
      }
    },
  };
  const pending = computeReader(target, actor, grant);
  current = false;
  await expect(pending).rejects.toThrow("compute caller revoked");
  current = true;
  const { reader, scope } = await computeReader(target, actor, grant);
  const barrier = await hold();
  try {
    const refused = [
      reader.memoryEntry("actor-memory"),
      reader.memoryResetRecall(),
      reader.nativeContext(scope, () => "must not disclose"),
    ].map((result) => expect(result).rejects.toThrow("compute caller revoked"));
    current = false;
    barrier.release.resolve();
    await Promise.all(refused);
  } finally {
    barrier.release.resolve();
    await barrier.held;
  }
});

it("keeps Memory and Codex history isolated for identical session IDs in different agents", async () => {
  const main = await create("memory-codex-shared");
  const other = await create("memory-codex-shared", lossActor, "loss");
  await append(main, "main private content");
  await append(other, "other private content", lossActor);
  const own = await computeReader(main);
  const foreign = await computeReader(other, lossActor);
  for (const [binding, content] of [
    [own, "main private content"],
    [foreign, "other private content"],
  ] as const) {
    expect((await binding.reader.memoryEntry("actor-memory"))?.content).toBe(
      `Assistant: ${content}`,
    );
    expect(
      await binding.reader.nativeContext(binding.scope, (messages) => [...messages]),
    ).toMatchObject([{ content: [{ type: "text", text: content }] }]);
  }
  expect(() => own.reader.memoryEntry("actor-memory", foreign.scope)).toThrow(
    "another session or store",
  );
  await expect(own.reader.nativeContext(foreign.scope, () => "foreign")).rejects.toThrow(
    "another session or store",
  );
  for (const type of [
    "session.history.memory-entry",
    "session.history.memory-reset-recall",
    "session.history.native-context",
  ] as const) {
    await expect(
      actor.sessions.history(authority, { type, input: targetInput(other) }),
    ).rejects.toThrow("refusing non-canonical session key write");
  }
});

it("revalidates Codex history after asynchronous consumption and joins it before release", async () => {
  const target = await create("codex-consumption");
  await append(target, "snapshot content");
  const { reader, scope } = await computeReader(target);
  await expect(
    reader.nativeContext(scope, async (messages) => {
      const result = [...messages];
      await append(target, "invalidates snapshot");
      return result;
    }),
  ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);

  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: actor.agentId,
    env,
    authority,
    existingOnly: true,
  });
  assert(borrowed);
  const bound = await computeReader(target, borrowed);
  const ready = createDeferredCore();
  const resume = createDeferredCore();
  const work = bound.reader.nativeContext(bound.scope, async () => {
    ready.resolve();
    await resume.promise;
    return "private result";
  });
  void work.catch(ready.reject);
  const rejected = expect(work).rejects.toThrow("Incognito execution reference is released");
  try {
    await ready.promise;
    let released = false;
    const releasing = borrowed.release().then(() => {
      released = true;
    });
    // Settle another FIFO turn without invalidating the captured transcript.
    await actor.run(authority, async () => undefined);
    expect(released).toBe(false);
    resume.resolve();
    await Promise.all([releasing, rejected]);
  } finally {
    resume.resolve();
    await Promise.allSettled([work, borrowed.release()]);
  }
});

it("composes hydration navigation and maintenance on the captured actor", async () => {
  const target = await create("hydration-navigation");
  const reader = (await computeReader(target)).reader.prepareHydration();
  const first = await append(target, "first hydration entry");
  assert(first.ok && first.value.append);
  const second = await append(target, "latest hydration entry");
  assert(second.ok && second.value.append);
  const snapshot = await reader.read();
  assert(snapshot.kind === "full");
  const entryId = second.value.append.messageId;
  const request = {
    entryId,
    version: snapshot.snapshot.version,
    includeEntry: true,
    sessionKey: `${target.sessionKey}-another-session`,
    sessionId: "another-session",
  };
  const current = await reader.readCurrentTurnEntry(request);
  expect(current.event).toEqual(message("latest hydration entry"));
  expect(current.anchor?.entryId).toBe(entryId);
  expect(await reader.readLatestActiveMessage()).toMatchObject({ event: { id: entryId } });
  expect(await reader.readRecentActiveEvents(1)).toEqual([message("latest hydration entry")]);
  const identity = await reader.readMaintenance({ operation: "identity", eventId: entryId });
  assert(identity.seq !== undefined);
  expect(
    await reader.readMaintenance({ operation: "previous", beforeSeq: identity.seq }),
  ).toMatchObject({
    previous: { id: first.value.append.messageId },
  });
  expect(await reader.readMaintenance({ operation: "version" })).toMatchObject({
    version: snapshot.snapshot.version,
    lifecycleRevision: target.entry.lifecycleRevision,
    appendParentId: entryId,
  });
  expect(
    await reader.readMaintenance({
      operation: "suffix",
      startSeq: identity.seq,
      maxBytes: 8192,
      maxEvents: 5,
      retainedCustomDataIds: [],
    }),
  ).toMatchObject({ events: [message("latest hydration entry")] });
  await append(target, "changes replay admission");
  await expect(
    reader.readCurrentTurnEntry({
      entryId,
      version: snapshot.snapshot.version,
      includeEntry: false,
    }),
  ).rejects.toThrow("changed before replay admission");
});

it("rechecks hydration authority after queue waits and refuses a mismatched generation", async () => {
  const target = await create("hydration-revoked");
  let revoked = false;
  const reader = (
    await computeReader(target, actor, {
      assertCurrent() {
        if (revoked) {
          throw new Error("hydration revoked");
        }
      },
    })
  ).reader.prepareHydration();
  const barrier = await hold();
  const pending = reader.readLatestActiveMessage();
  const rejected = expect(pending).rejects.toThrow("hydration revoked");
  revoked = true;
  barrier.release.resolve();
  await Promise.all([rejected, barrier.held]);
  const stale = (
    await createIncognitoSessionComputeReader({
      actor,
      authority,
      target: { ...targetInput(target), lifecycleRevision: "another-generation" },
    })
  ).prepareHydration();
  await expect(stale.readRecentActiveEvents(1)).rejects.toThrow("generation is no longer current");
});

it("reads committed actor writes in FIFO order and retains the hydration snapshot", async () => {
  const target = await create("fifo");
  const barrier = await hold();
  try {
    const write = append(target, "committed before history");
    const read = hydrate(target);
    const input = targetInput(target);
    const selected = Promise.all([
      actor.sessions.history(authority, {
        type: "session.history.recent",
        input: { ...input, options: { maxMessages: 10 } },
      }),
      actor.sessions.history(authority, {
        type: "session.history.page",
        input: { ...input, options: { offset: 0, maxMessages: 10 } },
      }),
      actor.sessions.history(authority, { type: "session.history.title", input }),
      actor.sessions.history(authority, {
        type: "session.history.preview",
        input: { ...input, maxItems: 10, maxChars: 200 },
      }),
      actor.sessions.history(authority, { type: "session.history.context", input }),
      actor.sessions.history(authority, { type: "session.history.branches", input }),
      actor.sessions.history(authority, {
        type: "session.history.search",
        input: { sessions: [input], sessionId: input.sessionId, query: "committed" },
      }),
    ]);
    barrier.release.resolve();
    const [written, result, [recent, page, title, preview, context, branches, searched]] =
      await Promise.all([write, read, selected, barrier.held]);
    assert(written.ok && written.value.append);
    assert(result.kind === "full");
    expect(result.snapshot.events).toContainEqual(message("committed before history"));
    for (const selectedPage of [recent, page]) {
      expect(selectedPage).toMatchObject({
        totalMessages: 1,
        messages: [
          { role: "assistant", content: [{ type: "text", text: "committed before history" }] },
        ],
      });
    }
    expect(title.fields.lastMessagePreview).toBe("committed before history");
    expect(preview.items).toEqual([{ role: "assistant", text: "committed before history" }]);
    expect(context.events).toContainEqual(message("committed before history"));
    expect(searched).toMatchObject({
      kind: "transcript-search",
      result: {
        hits: [
          {
            sessionKey: target.sessionKey,
            sessionId: target.entry.sessionId,
            messageId: written.value.append.messageId,
            snippet: "committed before history",
          },
        ],
        // A FIFO read does not certify global projection maintenance.
        indexing: true,
      },
    });
    expect(searched.result).not.toHaveProperty("found");
    expect(searched.result).not.toHaveProperty("revision");
    expect(branches).toMatchObject({
      status: "ok",
      branches: [
        {
          leafEntryId: written.value.append.messageId,
          headline: "committed before history",
          messageCount: 1,
          active: true,
        },
      ],
    });
    const version = structuredClone(result.snapshot.version);
    await append(target, "written after snapshot");
    expect(result.snapshot.events).not.toContainEqual(message("written after snapshot"));
    expect(result.snapshot.version).toEqual(version);
    const fresh = await hydrate(target);
    assert(fresh.kind === "full");
    expect(fresh.snapshot.events).toContainEqual(message("written after snapshot"));
    expect(fresh.snapshot.version).not.toEqual(version);
  } finally {
    barrier.release.resolve();
    await barrier.held;
  }
});

it.each(["transaction", "commit"] as const)(
  "refuses a read denied at %s before disclosure",
  async (deniedStage) => {
    const target = await create(`denied-${deniedStage}`);
    await append(target, "private history");
    const stages: string[] = [];
    await expect(
      hydrate(target, actor, {
        assertCurrent() {},
        authorize(stage, facts) {
          expect(facts.identity).toEqual(actor.identity);
          expect(facts.sessionKey).toBe(target.sessionKey);
          stages.push(stage);
          if (stage === deniedStage) {
            throw new Error("history disclosure denied");
          }
        },
      }),
    ).rejects.toThrow("history disclosure denied");
    expect(stages).toContain(deniedStage);
  },
);

it("rechecks caller authority after a FIFO wait", async () => {
  const target = await create("revoked");
  const barrier = await hold();
  let current = true;
  try {
    const rejected = expect(
      hydrate(target, actor, {
        assertCurrent() {
          if (!current) {
            throw new Error("history caller revoked");
          }
        },
      }),
    ).rejects.toThrow("history caller revoked");
    current = false;
    barrier.release.resolve();
    await Promise.all([rejected, barrier.held]);
  } finally {
    barrier.release.resolve();
    await barrier.held;
  }
});

it("isolates equal session IDs across agents and checks the source read grant", async () => {
  const main = await create("shared-id");
  const other = await create("shared-id", lossActor, "loss");
  await append(main, "main agent private history");
  await append(other, "other agent private history", lossActor);
  const own = await hydrate(main);
  const foreign = await hydrate(other, lossActor);
  assert(own.kind === "full" && foreign.kind === "full");
  expect(own.snapshot.events).toContainEqual(message("main agent private history"));
  expect(own.snapshot.events).not.toContainEqual(message("other agent private history"));
  expect(foreign.snapshot.events).toContainEqual(message("other agent private history"));
  expect(foreign.snapshot.events).not.toContainEqual(message("main agent private history"));
  await expect(hydrate(other)).rejects.toThrow("refusing non-canonical session key write");
  await expect(hydrate(main, lossActor)).rejects.toThrow(
    "refusing non-canonical session key write",
  );
  const deniedSource: IncognitoSessionAuthority = {
    assertCurrent() {},
    authorize(_stage, facts) {
      expect(facts.identity).toEqual(actor.identity);
      expect(facts.sessionKey).toBe(main.sessionKey);
      throw new Error("source history denied");
    },
  };
  await expect(hydrate(main, actor, deniedSource)).rejects.toThrow("source history denied");
  await expect(actor.sessions.read(deniedSource, { sessionKey: main.sessionKey })).rejects.toThrow(
    "source history denied",
  );
});

it("continues byte-bounded actor deltas without skipping unread committed messages", async () => {
  const target = await create("delta");
  const input = targetInput(target);
  const head = await actor.sessions.history(authority, {
    type: "session.history.recent",
    input: { ...input, options: { maxMessages: 1 } },
  });
  assert(head.deltaCursor);
  await append(target, "first delta message");
  await append(target, "second delta message");
  const delta = (cursor: string, maxBytes: number) =>
    actor.sessions.history(authority, {
      type: "session.history.delta",
      input: { ...input, options: { cursor, maxBytes } },
    });
  const blocked = await delta(head.deltaCursor, 1);
  assert(blocked.kind === "page" && blocked.requiredBytes);
  expect(blocked).toMatchObject({
    cursor: head.deltaCursor,
    events: [],
    hasMore: true,
    serializedBytes: 0,
  });
  const first = await delta(blocked.cursor, blocked.requiredBytes);
  assert(first.kind === "page");
  expect(first.events.map(({ event }) => event)).toEqual([message("first delta message")]);
  expect(first.serializedBytes).toBe(blocked.requiredBytes);
  expect(first.hasMore).toBe(true);
  const last = await delta(first.cursor, 4096);
  assert(last.kind === "page");
  expect(last.events.map(({ event }) => event)).toEqual([message("second delta message")]);
  expect(last.hasMore).toBe(false);
  expect(await delta(last.cursor, 4096)).toMatchObject({
    cursor: last.cursor,
    events: [],
    hasMore: false,
  });
});

it("composes matching RPC and HTTP pages while rechecking disclosure after display computation", async () => {
  const session = await create("composed");
  await append(session, "older answer");
  const appended = await actor.sessions.transcript(authority, {
    type: "session.message.append",
    input: {
      sessionKey: session.sessionKey,
      sessionId: session.entry.sessionId,
      fence: { expectedLifecycleRevision: session.entry.lifecycleRevision },
      message: {
        role: "user",
        content: "scheduled answer",
        timestamp: 10_001,
        provenance: {
          kind: "inter_session",
          sourceTool: "sessions_send",
          sourceSessionKey: "agent:main:cron:report:run:completed",
        },
      },
    },
  });
  expect(appended.ok).toBe(true);
  let current = true;
  let revokeDuringDisplay = false;
  const preparedDisplayFacts = {
    resolveCurrentUserProfileDisplay: () => ({ kind: "unresolved" as const }),
    subagentCoordination: { isSubagentSession: () => false, isSubagentRunMessage: () => false },
    resolveCronJobName(jobId: string) {
      expect(jobId).toBe("report");
      if (revokeDuringDisplay) {
        current = false;
      }
      return "Prepared report name";
    },
  };
  const target = { ...targetInput(session), agentId: "main", storePath: mainStorePath };
  const reader = createIncognitoSessionHistoryReader({
    actor,
    target,
    ...preparedDisplayFacts,
    authority: {
      assertCurrent() {
        if (!current) {
          throw new Error("display caller revoked");
        }
      },
    },
  });
  const request = {
    entry: session.entry,
    provider: undefined,
    sessionId: target.sessionId,
    storePath: mainStorePath,
    sessionAgentId: "main",
    canonicalKey: session.sessionKey,
    max: 1,
    maxHistoryBytes: 4096,
    effectiveMaxChars: 1000,
    offset: undefined,
    messageId: undefined,
    encodeResponse: true,
  };
  const rpc = await reader.rpc(request);
  const http = await reader.http({ target, limit: 1 });
  assert(rpc.encodedResponse && http.history.nextCursor);
  expect(JSON.parse(new TextDecoder().decode(rpc.encodedResponse.messages))).toEqual(
    http.history.messages,
  );
  expect(rpc.encodedResponse.messagesBytes).toBe(
    Buffer.byteLength(JSON.stringify(http.history.messages)),
  );
  expect(http.history.messages).toMatchObject([
    { content: "scheduled answer", senderSession: { label: "Prepared report name" } },
  ]);
  expect(rpc.encodedResponse.hasMore).toBe(http.history.hasMore);
  const olderRpc = await reader.rpc({ ...request, offset: rpc.encodedResponse.nextOffset });
  const olderHttp = await reader.http({ target, limit: 1, cursor: http.history.nextCursor });
  assert(olderRpc.encodedResponse);
  expect(JSON.parse(new TextDecoder().decode(olderRpc.encodedResponse.messages))).toEqual(
    olderHttp.history.messages,
  );
  expect(olderHttp.history.messages).toMatchObject([
    { content: [{ type: "text", text: "older answer" }] },
  ]);
  await expect(reader.rpc({ ...request, sessionAgentId: "loss" })).rejects.toThrow(
    "another session or store",
  );
  await expect(reader.http({ target: { ...target, agentId: "loss" } })).rejects.toThrow(
    "another session or store",
  );
  revokeDuringDisplay = true;
  await expect(reader.rpc(request)).rejects.toThrow("display caller revoked");
  current = true;
  await expect(reader.http({ target, limit: 1 })).rejects.toThrow("display caller revoked");
});

it.each(["consume", "pending-list", "pending-read"] as const)(
  "rechecks history caller after %s composition settles",
  async (operation) => {
    const session = await create(`settled-${operation}`);
    await append(session, "Private history");
    let current = true;
    const target = { ...targetInput(session), agentId: actor.agentId, storePath: actor.path };
    const reader = createIncognitoSessionHistoryReader({
      actor,
      target,
      authority: {
        assertCurrent() {
          if (!current) {
            throw new Error("History caller retired after settlement");
          }
        },
      },
      subagentCoordination: { isSubagentSession: () => false, isSubagentRunMessage: () => false },
      resolveCurrentUserProfileDisplay: () => ({ kind: "unresolved" as const }),
    });
    const retain = actor.sessions.withSharedState.bind(actor.sessions);
    let first = true;
    const completed = vi
      .spyOn(actor.sessions, "withSharedState")
      .mockImplementation(<T>(work: () => Promise<T>) => {
        const revoke = first;
        first = false;
        return retain(work).then((result) => {
          if (revoke) {
            current = false;
          }
          return result;
        });
      });
    try {
      await expect(
        operation === "consume"
          ? reader.consume(target, (reads) => reads.readSessionMessageCountAsync(target))
          : operation === "pending-list"
            ? reader.listPendingInputs()
            : reader.readPendingInput("absent"),
      ).rejects.toThrow("History caller retired after settlement");
      actor.assertReadable();
    } finally {
      completed.mockRestore();
    }
  },
);

registerIncognitoHistoryWiringTests({
  authority,
  get actor() {
    return actor;
  },
  get env() {
    return env;
  },
  create,
  append,
  targetInput,
});

it("ends queued history reads with the typed error when their actor is lost", async () => {
  const target = await create("actor-loss", lossActor, "loss");
  const { reader, scope } = await computeReader(target, lossActor);
  const barrier = await hold(lossActor);
  const rejected = Promise.all(
    [
      hydrate(target, lossActor),
      reader.memoryEntry("actor-memory"),
      reader.memoryResetRecall(),
      reader.nativeContext(scope, () => "private result"),
    ].map((result) => expect(result).rejects.toMatchObject({ code: "INCOGNITO_SESSION_ENDED" })),
  );
  try {
    await lossWorker.terminate();
  } finally {
    barrier.release.resolve();
    await Promise.allSettled([barrier.held]);
  }
  await rejected;
});
