import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { IncognitoLifecycleEntry } from "../config/sessions/session-incognito-lifecycle-contract.js";
import { createIncognitoSessionHistoryReader } from "../gateway/session-history-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let lossActor: IncognitoAgentDatabaseExecution;
let lossWorker: Worker;
let mainStorePath: string;
let sql: ReturnType<typeof observeHostDataSql>;

beforeAll(async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-history-") };
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
    ]);
    barrier.release.resolve();
    const [written, result, [recent, page, title, preview, context, branches]] = await Promise.all([
      write,
      read,
      selected,
      barrier.held,
    ]);
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

it("ends queued history reads with the typed error when their actor is lost", async () => {
  const target = await create("actor-loss", lossActor, "loss");
  const barrier = await hold(lossActor);
  const rejected = expect(hydrate(target, lossActor)).rejects.toMatchObject({
    code: "INCOGNITO_SESSION_ENDED",
  });
  try {
    await lossWorker.terminate();
  } finally {
    barrier.release.resolve();
    await Promise.allSettled([barrier.held]);
  }
  await rejected;
});
