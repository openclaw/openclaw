import { existsSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useSqliteWorkerFault } from "../../test/helpers/sqlite-worker-fault.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as configEnv from "../config/config-env-vars.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import { retainSessionEntryWorkerPublication } from "../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { removeSessionMember as removeSessionMemberSync } from "../config/sessions/session-sharing-store.native.js";
import * as historyReaders from "../config/sessions/session-transcript-worker-readers.js";
import { historyLane } from "../config/sessions/session-transcript-worker-resources.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "../gateway/session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "../gateway/session-sharing.test-utils.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import * as workerStore from "../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { BoardValidationError } from "./board-layout.js";
import { boardFixture, htmlWidget, mcpContent } from "./board-store.fixtures.test-support.js";
import type { BoardSnapshotWithHtmlViewMetadata } from "./board-store.js";
import { closeBoardDatabases } from "./board-store.test-support.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";
import { readBoardSnapshotWithHtmlViewMetadata } from "./sqlite-board-store.kernel.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeBoardDatabases();
    cleanup();
  }),
);

function fixture() {
  const seeded = boardFixture(tempDirs.make("board-worker-mutations-"));
  return {
    ...seeded,
    putHtml: (name: string, html = `<p>${name}</p>`) =>
      seeded.store.putWidget(htmlWidget(seeded.sessionKey, name, html)),
  };
}

function observeChanges(sessionKey: string, database?: ReturnType<typeof fixture>["database"]) {
  const changes: SessionRowChange[] = [];
  const transactions: boolean[] = [];
  const unsubscribe = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === sessionKey) {
      changes.push(change);
      if (database) {
        transactions.push(database.db.isTransaction);
      }
    }
  });
  return { changes, transactions, [Symbol.dispose]: unsubscribe };
}

function observePublications(database: ReturnType<typeof fixture>["database"], sessionKey: string) {
  const changes: Array<{ change: SessionRowChange; inTransaction: boolean; revision: number }> = [];
  const facts: SessionRowChange[] = [];
  const sql: string[] = [];
  let readingPublication = false;
  const host = observeHostDataSql((query) => {
    if (!readingPublication) {
      sql.push(query);
    }
  });
  const unsubscribe = sessionChanges.subscribe((change) => {
    if (!("sessionKey" in change) || change.sessionKey !== sessionKey) {
      return;
    }
    readingPublication = true;
    try {
      changes.push({
        change,
        inTransaction: database.db.isTransaction,
        revision: readBoardSnapshotWithHtmlViewMetadata(database, sessionKey)!.snapshot.revision,
      });
    } finally {
      readingPublication = false;
    }
  });
  const stopFacts = sessionChanges.subscribeFacts((change) => {
    if ("sessionKey" in change && change.sessionKey === sessionKey) {
      facts.push(change);
    }
  });
  return {
    expectRevision: (revision: number) => {
      const change = { sessionKey, storePath: database.path };
      expect(changes.splice(0)).toEqual([{ change, inTransaction: false, revision }]);
      expect(facts.splice(0)).toEqual([{ ...change, facts: { kind: "unchanged" } }]);
      expect(sql).toEqual([]);
    },
    [Symbol.dispose]() {
      stopFacts();
      unsubscribe();
      host.restore();
    },
  };
}

function interceptSnapshotRead(
  afterRead: (snapshot: BoardSnapshotWithHtmlViewMetadata | undefined) => void | Promise<void>,
) {
  const create = historyReaders.createSessionHistoryWorkerReaders;
  return vi.spyOn(historyReaders, "createSessionHistoryWorkerReaders").mockImplementation((run) => {
    const readers = create(run);
    return {
      ...readers,
      async readBoardSnapshot(input) {
        const snapshot = await readers.readBoardSnapshot(input);
        await afterRead(snapshot);
        return snapshot;
      },
    };
  });
}

async function holdWriter(options: Parameters<typeof runOpenClawAgentWorkerWrite>[0]) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = runOpenClawAgentWorkerWrite(options, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const pending: Promise<unknown>[] = [held];
  return {
    async release() {
      release.resolve();
      await held;
    },
    track<T>(promise: Promise<T>): Promise<T> {
      pending.push(promise);
      void promise.catch(() => undefined);
      return promise;
    },
    async [Symbol.asyncDispose]() {
      release.resolve();
      await Promise.allSettled(pending);
    },
  };
}

it.each([false, true])(
  "retains queued Board input and rejects revoked authority (revoked: %s)",
  async (revoke) => {
    const { database, options, store, target, document, snapshot } = fixture();
    using observed = observeChanges(target.sessionKey);
    await using writer = await holdWriter(options);
    const authority = new AbortController();
    const params = htmlWidget(target.sessionKey, "captured", "<p>captured</p>");
    const pending = writer.track(
      store.putWidget(params, { assertCurrent: () => authority.signal.throwIfAborted() }),
    );
    params.name = "changed";
    params.content = { kind: "html", html: "<p>changed</p>" };
    if (revoke) {
      authority.abort(new Error("Board request retired while queued"));
    }
    expect(observed.changes).toEqual([]);
    await writer.release();
    if (revoke) {
      await expect(pending).rejects.toThrow("Board request retired while queued");
      expect(await snapshot()).toMatchObject({ revision: 0, widgets: [] });
      expect(observed.changes).toEqual([]);
    } else {
      await expect(pending).resolves.toMatchObject({
        resolvedWidgetName: "captured",
        widgets: [{ name: "captured", revision: 1 }],
      });
      expect(await document("captured")).toMatchObject({ html: "<p>captured</p>" });
      expect(observed.changes).toEqual([
        { sessionKey: target.sessionKey, storePath: database.path },
      ]);
    }
  },
);

it("preserves committed Boards and admits followers after publication cleanup is refused", async () => {
  const { database, store, target, putHtml: put } = fixture();
  using observed = observeChanges(target.sessionKey);
  let refuseCleanup = false;
  let refusals = 0;
  const interception = probe.admission(admission, (request, grant, admit) => {
    if (refuseCleanup && request.stage === "prepare") {
      refuseCleanup = false;
      refusals++;
      throw new Error("controlled Board publication cleanup admission refusal");
    }
    admit(request, grant);
    if (request.stage === "commit" && refusals === 0) {
      refuseCleanup = true;
    }
  });
  const first = put("first");
  const queued = put("queued");
  const settled = Promise.allSettled([first, queued]);
  try {
    expect(await first).toMatchObject({ revision: 1, resolvedWidgetName: "first" });
    expect(await queued).toMatchObject({ revision: 2, resolvedWidgetName: "queued" });
    expect(refusals).toBe(1);
    interception.mockRestore();
    const final = await put("later");
    expect(final.revision).toBe(3);
    expect(final.widgets.map(({ name }) => name).toSorted()).toEqual(["first", "later", "queued"]);
    const change = { sessionKey: target.sessionKey, storePath: database.path };
    expect(observed.changes).toEqual([change, change, change]);
    await closeOpenClawAgentDatabasesAsync();
    const { resolvedWidgetName: _, ...snapshot } = final;
    expect(await store.getSnapshot(target)).toEqual(snapshot);
  } finally {
    interception.mockRestore();
    await settled;
  }
});

it("serves committed dashboard metadata while an unrelated writer holds admission", async ({
  signal,
}) => {
  const { options, store, target, putHtml } = fixture();
  await putHtml("initial");
  await store.getSnapshotWithHtmlViewMetadata(target);
  await using writer = await holdWriter(options);
  const read = writer.track(store.getSnapshotWithHtmlViewMetadata(target));
  expect(await withinTest(read, signal)).toMatchObject({
    snapshot: { revision: 1, widgets: [{ name: "initial", revision: 1 }] },
  });
});

it("reads the committed MCP document after an earlier queued write", async () => {
  const { options, store, target } = fixture();
  const put = (toolCallId: string) =>
    store.putWidget({ ...target, name: "app", content: mcpContent({ toolCallId }, false) });
  await put("initial");
  await using writer = await holdWriter(options);
  const written = writer.track(put("updated"));
  const read = writer.track(store.readWidgetMcpApp(target, "app"));
  await writer.release();
  await written;
  expect(await read).toMatchObject({ revision: 2, descriptor: { toolCallId: "updated" } });
});

it.each(["snapshot", "document"] as const)(
  "retains Board validation errors without waiting on writer-dependent retirement (%s)",
  async (operation) => {
    const { database, options, target, putHtml, document, snapshot } = fixture();
    await putHtml("status", "private");
    database.db
      .prepare("UPDATE board_widgets SET manifest = ? WHERE session_key = ? AND name = 'status'")
      .run(JSON.stringify({ contentOwner: "invalid" }), target.sessionKey);
    const historyRetiring = createDeferredCore();
    const writerSettled = createDeferredCore();
    const releaseHistory = createDeferredCore();
    const retirement = vi.spyOn(historyLane.pool, "rotate").mockImplementation(() => {
      historyRetiring.resolve();
      return Promise.race([writerSettled.promise, releaseHistory.promise]);
    });
    const read = operation === "snapshot" ? snapshot() : document("status");
    const outcome = read.catch((error: unknown) => error);
    const following = runOpenClawAgentWorkerWrite(options, async () => writerSettled.resolve());
    try {
      const result = await Promise.race([outcome, historyRetiring.promise]);
      expect(result).toBeInstanceOf(BoardValidationError);
      expect(result).toMatchObject({ code: "invalid_operation" });
      await expect(following).resolves.toBeUndefined();
    } finally {
      releaseHistory.resolve();
      await Promise.allSettled([read, following]);
      retirement.mockRestore();
    }
  },
);

it.each([
  { consumer: "write", microtasks: 0, source: "snapshot" },
  { consumer: "write", microtasks: 2, source: "snapshot" },
  { consumer: "read", microtasks: 2, source: "snapshot" },
  { consumer: "write", microtasks: 2, source: "document" },
] as const)(
  "queues $source consumer $consumer behind an earlier Board writer ($microtasks microtasks)",
  async ({ consumer, microtasks, source }) => {
    const { options, store, target, putHtml: put } = fixture();
    await put("initial");
    await using writer = await holdWriter(options);
    const consume = async () => {
      for (let turn = 0; turn < microtasks; turn++) {
        await Promise.resolve();
      }
      return consumer === "write"
        ? put("consumer")
        : store.useSnapshot(target, (snapshot) => snapshot);
    };
    const consumed = writer.track(
      source === "snapshot"
        ? store.useSnapshot(target, consume)
        : store.useWidgetDocument(target, "initial", consume),
    );
    const following = writer.track(put("following"));
    await writer.release();
    expect(await following).toMatchObject({ revision: 2, resolvedWidgetName: "following" });
    expect(await consumed).toMatchObject(
      consumer === "write" ? { revision: 3, resolvedWidgetName: "consumer" } : { revision: 2 },
    );
  },
);

it.each(["mutation", "document"] as const)(
  "retains a queued Board %s in its mixed-case Windows state root",
  async (operation) => {
    const { env, options, target, putHtml } = fixture();
    await putHtml("initial", "original");
    const home = tempDirs.make("board-windows-env-home-");
    const laterRoot = path.join(home, "later-state");
    const mixedEnv = { HOME: home, USERPROFILE: home, OpenClaw_State_Dir: env.OPENCLAW_STATE_DIR };
    const cloneEnv = configEnv.cloneEnvWithPlatformSemantics;
    using _ = vi.spyOn(configEnv, "cloneEnvWithPlatformSemantics").mockImplementation((input) =>
      // Exercise the Windows clone while paths and native SQLite retain the host platform.
      withMockedPlatform("win32", () => cloneEnv(input)),
    );
    const captured = new SqliteBoardStore({
      resolveSession: () => ({ agentId: options.agentId, sessionKey: target.sessionKey }),
      env: mixedEnv,
    });
    await using writer = await holdWriter(options);
    const pending = writer.track(
      operation === "mutation"
        ? captured
            .putWidget(htmlWidget(target.sessionKey, "queued", "queued"))
            .then((result) => result.resolvedWidgetName)
        : captured.useWidgetDocument(target, "initial", (document) =>
            document && "html" in document ? document.html : undefined,
          ),
    );
    const settled = vi.fn();
    void pending.then(settled, settled);
    mixedEnv.OpenClaw_State_Dir = laterRoot;
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();
    await writer.release();
    expect(await pending).toBe(operation === "mutation" ? "queued" : "original");
    expect(existsSync(path.join(home, ".openclaw"))).toBe(false);
    expect(existsSync(laterRoot)).toBe(false);
  },
);

it.each([
  { revoked: "target", metadata: false },
  { revoked: "database", metadata: false },
  { revoked: "target", metadata: true },
  { revoked: "database", metadata: true },
])(
  "refuses disclosure after $revoked revocation during an aliased read (metadata: $metadata)",
  async ({ revoked, metadata }) => {
    const { database, options, target, putHtml } = fixture();
    await putHtml("status", "private");
    const authority = new AbortController();
    const physicalPath = realpathSync(options.path);
    const aliasDirectory = path.join(options.env.OPENCLAW_STATE_DIR, "board-alias");
    symlinkSync(path.dirname(physicalPath), aliasDirectory, "junction");
    const reader = new SqliteBoardStore({
      resolveSession: () => ({
        ...options,
        path: path.join(aliasDirectory, path.basename(physicalPath)),
        sessionKey: target.sessionKey,
        assertCurrent: () => authority.signal.throwIfAborted(),
      }),
      env: options.env,
    });
    // With no host connection, only the reader's retained close registration can revoke it.
    await closeOpenClawAgentDatabasesAsync();
    expect(database.db.isOpen).toBe(false);
    using publication = vi
      .spyOn(workerStore, "openOpenClawAgentSqliteWorkerStore")
      .mockImplementation(() => {
        throw new Error("Board read acquired a write-capable publication");
      });
    expect(await reader.getSnapshotWithHtmlViewMetadata(target)).toMatchObject({
      snapshot: { revision: 1, widgets: [{ name: "status" }] },
    });
    const document = await reader.useWidgetDocument(target, "status", (value) => value);
    expect(document).toMatchObject({ html: "private" });
    let readCompleted = false;
    using _ = interceptSnapshotRead(async () => {
      readCompleted = true;
      if (revoked === "target") {
        authority.abort(
          new BoardValidationError("invalid_operation", "board session changed; retry"),
        );
      } else {
        await closeOpenClawAgentDatabaseByPathAsync(physicalPath);
      }
    });
    const consume = vi.fn();
    const read = metadata
      ? reader.getSnapshotWithHtmlViewMetadata(target).then(consume)
      : reader.useSnapshot(target, consume);
    await expect(read).rejects.toThrow(
      revoked === "target"
        ? "board session changed; retry"
        : "Session history database read was revoked",
    );
    expect(readCompleted).toBe(true);
    expect(consume).not.toHaveBeenCalled();
    publication.mockRestore();
  },
);

describe("batched Board writes", () => {
  const fault = useSqliteWorkerFault([
    {
      name: "reject_late_tab_write",
      match: /^insert into board_tabs\b/u,
      sql: `CREATE TEMP TRIGGER reject_late_tab_write BEFORE UPDATE ON main.board_tabs
      WHEN NEW.tab_id = 'tab-129' BEGIN SELECT RAISE(ABORT, 'late tab write'); END;`,
    },
    {
      name: "reject_late_widget_delete",
      match: /^delete from board_widgets\b/u,
      sql: `CREATE TEMP TRIGGER reject_late_widget_delete BEFORE DELETE ON main.board_widgets
      WHEN OLD.name = 'tab-46' BEGIN SELECT RAISE(ABORT, 'late widget delete'); END;`,
    },
  ]);

  const tabIds = Array.from({ length: 130 }, (_, index) => `tab-${index}`);
  const createTabs = tabIds.map((tabId) => ({ kind: "tab_create" as const, tabId, title: tabId }));
  const deleteTabs = tabIds.map((tabId) => ({ kind: "tab_delete" as const, tabId }));

  it("round-trips batched Boards, rolls back late failures, and removes surviving documents", async () => {
    const { target, database, ops, snapshot, putHtml, document } = fixture();
    const created = await ops(...createTabs);
    expect(created.tabs.map((tab) => tab.tabId)).toEqual(tabIds);
    expect(await snapshot()).toEqual(created);
    const names = tabIds.slice(0, 48);
    for (const name of names) {
      await putHtml(name, name);
    }
    const before = await snapshot();
    const readRows = () => ({
      tabs: database.db.prepare("SELECT * FROM board_tabs ORDER BY session_key, tab_id").all(),
      widgets: database.db.prepare("SELECT * FROM board_widgets ORDER BY session_key, name").all(),
    });
    const beforeRows = readRows();
    using observed = observeChanges(target.sessionKey, database);
    fault.enable(0);
    await expect(ops({ kind: "tab_update", tabId: "tab-0", title: "changed" })).rejects.toThrow(
      "late tab write",
    );
    expect({ changes: observed.changes, ...readRows() }).toEqual({ changes: [], ...beforeRows });
    fault.disable();
    expect(await snapshot()).toEqual(before);

    const removeOps = names.slice(0, -1).map((name) => ({ kind: "widget_remove" as const, name }));
    fault.enable(1);
    await expect(ops(...removeOps)).rejects.toThrow("late widget delete");
    expect({ changes: observed.changes, ...readRows() }).toEqual({ changes: [], ...beforeRows });
    fault.disable();
    const removed = await ops(...removeOps);
    expect(observed.changes).toEqual([{ ...target, storePath: database.path }]);
    expect(observed.transactions).toEqual([false]);
    expect(removed.widgets.map((widget) => widget.name)).toEqual(["tab-47"]);
    expect(await snapshot()).toEqual(removed);
    expect(await document("tab-47")).toMatchObject({ html: "tab-47" });
    expect(await document("tab-46")).toBeUndefined();
    await ops({ kind: "widget_remove", name: "tab-47" });
    const empty = { ...target, tabs: [], widgets: [] };
    expect(await ops(...deleteTabs)).toEqual({ ...empty, revision: removed.revision + 2 });
    expect(await snapshot()).toEqual({ ...empty, revision: 0 });
  });
});

describe("Board source authority", () => {
  async function sourceFixture() {
    const cfg = rolePolicyConfig();
    const client = roleClient("view", "board-member");
    const memberId = client.authenticatedUserId!;
    const source = { agentId: "main", sessionKey: "agent:main:board-source" };
    replaceSessionEntrySync(source, {
      sessionId: "source-session",
      updatedAt: 1,
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: "creator" },
    });
    await addSessionMember(source, { identityId: memberId, addedBy: "creator" });
    const target = { agentId: "target", sessionKey: "agent:target:board" };
    replaceSessionEntrySync(target, { sessionId: "target-session", updatedAt: 1 });
    const store = new SqliteBoardStore({ resolveSession: () => target });
    const authorize = () =>
      resolveSessionMutationAuthorizationAsync({
        client,
        method: "board.widget.put",
        requestParams: source,
        context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
      });
    const result = await authorize();
    expect(result.error).toBeNull();
    const authorization = result.authorization!;
    const options = { assertCurrent: authorization.assertCurrent };
    const write = (name: string, declared?: { tools: string[] }) =>
      store.putWidget({ ...htmlWidget(target.sessionKey, name, name), declared }, options);
    return { source, target, store, memberId, authorize, authorization, options, write };
  }

  function withFixture(run: (context: Awaited<ReturnType<typeof sourceFixture>>) => Promise<void>) {
    return withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = await sourceFixture();
      using _ = { [Symbol.dispose]: () => context.authorization.release?.() };
      await run(context);
    });
  }

  it("rejects target replacement during preparation even with valid cross-store authority", () =>
    withFixture(async ({ store, target, options }) => {
      const resolveMcpAppInteraction = async () => {
        replaceSessionEntrySync(target, { sessionId: "replacement-session", updatedAt: 2 });
        return true;
      };
      const pending = store.putWidget(
        { ...target, name: "app", content: mcpContent() },
        { ...options, resolveMcpAppInteraction },
      );
      await expect(pending).rejects.toMatchObject({
        code: "invalid_operation",
        message: "board session changed; retry",
      });
      expect(await store.getSnapshot(target)).toMatchObject({ revision: 0, widgets: [] });
    }));

  it("publishes authorized mutations off host and agrees with cold authorization after revocation", () =>
    withFixture(async ({ source, target, store, memberId, authorize, options, write }) => {
      {
        const database = openOpenClawAgentDatabase({ agentId: target.agentId });
        using observed = observePublications(database, target.sessionKey);
        const put = await write("allowed", { tools: ["health"] });
        observed.expectRevision(1);
        const resize = { kind: "widget_resize" as const, name: "allowed", sizeW: 8, sizeH: 6 };
        await store.applyOps(target, [resize], options);
        observed.expectRevision(2);
        await store.grant(target, "allowed", "granted", 1, put.widgets[0]?.instanceId, options);
        observed.expectRevision(3);
      }
      await removeSessionMember(source, memberId);
      await expect(write("denied")).rejects.toThrow();
      {
        const cold = await authorize();
        using _ = { [Symbol.dispose]: () => cold.authorization?.release?.() };
        expect(cold.error).not.toBeNull();
      }
      expect((await store.getSnapshot(target)).widgets).toMatchObject([
        { name: "allowed", sizeW: 8, sizeH: 6, grantState: "granted" },
      ]);
    }));

  it("finishes an admitted cross-database write after source revocation and denies the next write", () =>
    withFixture(async ({ source, target, store, memberId, write }) => {
      let revoked = false;
      using interception = probe.admission(admission, (request, grant, admit) => {
        if (request.stage === "transaction" && !revoked) {
          revoked = true;
          removeSessionMemberSync(source, memberId);
        }
        admit(request, grant);
      });
      await expect(write("in-flight")).resolves.toMatchObject({ revision: 1 });
      interception.mockRestore();
      await expect(write("denied")).rejects.toThrow();
      expect((await store.getSnapshot(target)).widgets).toMatchObject([{ name: "in-flight" }]);
    }));

  it("denies new Board admissions while a source revocation is pending and after unknown settlement", () =>
    withFixture(async ({ source, target, store, write }) => {
      const database = openOpenClawAgentDatabase({ agentId: source.agentId });
      const publication = retainSessionEntryWorkerPublication({
        agentId: source.agentId,
        storePath: database.path,
        databaseIdentity: readOpenClawAgentDatabaseIdentity(database).identity,
      });
      using _ = { [Symbol.dispose]: () => publication.settle(undefined, false) };
      publication.begin([source.sessionKey], [source.sessionKey], []);
      await expect(write("pending")).rejects.toThrow();
      publication.settle(undefined, true);
      await expect(write("unknown")).rejects.toThrow();
      expect((await store.getSnapshot(target)).widgets).toEqual([]);
    }));
});
