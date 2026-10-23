import { existsSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { BoardWidgetMaterializedPutParams } from "../../packages/gateway-protocol/src/index.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useSqliteWorkerFault } from "../../test/helpers/sqlite-worker-fault.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as configEnv from "../config/config-env-vars.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import { retainSessionEntryWorkerPublication } from "../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { removeSessionMember as removeSessionMemberSync } from "../config/sessions/session-sharing-store.native.js";
import * as historyReaders from "../config/sessions/session-transcript-worker-readers.js";
import { historyLane } from "../config/sessions/session-transcript-worker-resources.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "../gateway/session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "../gateway/session-sharing.test-utils.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import * as workerStore from "../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { BoardValidationError } from "./board-layout.js";
import {
  boardFixture,
  boardClient,
  closeBoardDatabases,
  htmlWidget,
  mcpContent,
} from "./board-store.fixtures.test-support.js";
import type { BoardSnapshotWithHtmlViewMetadata } from "./board-store.js";
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
  const store = new SqliteBoardStore({
    resolveSession: () => ({ ...seeded.options, sessionKey: seeded.sessionKey }),
    env: seeded.env,
  });
  return {
    ...seeded,
    ...boardClient(store, seeded.target),
    putHtml: (name: string, html = `<p>${name}</p>`) =>
      store.putWidget(htmlWidget(seeded.sessionKey, name, html)),
  };
}

function observeChanges(sessionKey: string) {
  const changes: SessionRowChange[] = [];
  const unsubscribe = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === sessionKey) {
      changes.push(change);
    }
  });
  return { changes, [Symbol.dispose]: unsubscribe };
}

function observePublications(database: ReturnType<typeof fixture>["database"], sessionKey: string) {
  const changes: Array<{ change: SessionRowChange; inTransaction: boolean; revision: number }> = [];
  const facts: SessionRowChange[] = [];
  const pipelineSql: string[] = [];
  let readingPublication = false;
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
  clearNodeSqliteKyselyCacheForDatabase(requireNativeSqliteDatabase(database.db));
  const host = observeHostDataSql((sql) => {
    // Publication observers intentionally read the committed snapshot on the host.
    if (!readingPublication) {
      pipelineSql.push(sql);
    }
  });
  return {
    host,
    pipelineSql,
    changes,
    expectRevision: (revision: number) => {
      const change = { sessionKey, storePath: database.path };
      expect(changes.splice(0)).toEqual([{ change, inTransaction: false, revision }]);
      expect(facts.splice(0)).toEqual([{ ...change, facts: { kind: "unchanged" } }]);
    },
    [Symbol.dispose]() {
      host.restore();
      stopFacts();
      unsubscribe();
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
  "rejects a Board write whose session is replaced during preparation (cross-store: %s)",
  async (crossStore) => {
    const { database, env, options, store, target } = fixture();
    const source = crossStore ? openOpenClawAgentDatabase({ agentId: "source", env }) : undefined;
    const sourceEntry = { sessionId: "source-session", updatedAt: 1 };
    const scope = source && {
      agentId: "source",
      sessionKey: "agent:source:authority",
      storePath: source.path,
      env,
    };
    if (scope) {
      replaceSessionEntrySync(scope, sourceEntry);
    }
    const assertCurrent =
      scope &&
      captureSessionEntrySourceAssertion({
        scope,
        expected: sourceEntry,
        fields: ["sessionId"],
        assertCurrent() {},
        refuse(): never {
          throw new Error("Board source changed");
        },
      });
    const replaceSession = () =>
      replaceSessionEntrySync(
        { ...target, agentId: options.agentId, storePath: database.path },
        { sessionId: "replacement-session", updatedAt: 2 },
      );
    const pending = store.putWidget(
      { ...target, name: "app", content: mcpContent() },
      {
        assertCurrent,
        resolveMcpAppInteraction: async () => {
          replaceSession();
          return true;
        },
      },
    );
    await expect(pending).rejects.toMatchObject({
      code: "invalid_operation",
      message: "board session changed; retry",
    });
    expect(await store.getSnapshot(target)).toMatchObject({ revision: 0, widgets: [] });
  },
);

it("admits authorized Board writes off host and publishes each committed change once", async () => {
  const { database, store, target, document } = fixture();
  const assertCurrent = vi.fn();
  const authority = { assertCurrent };
  using observed = observePublications(database, target.sessionKey);
  const { host, changes, pipelineSql, expectRevision: expectPublication } = observed;
  expect(
    await store.applyOps(target, [{ kind: "tab_create", tabId: "main", title: "Main" }], authority),
  ).toMatchObject({ revision: 1, tabs: [{ tabId: "main" }] });
  expectPublication(1);
  const put = await store.putWidget(
    {
      ...htmlWidget(target.sessionKey, "status", "<p>committed</p>"),
      declared: { tools: ["health"] },
    },
    authority,
  );
  expect(put).toMatchObject({ revision: 2, widgets: [{ revision: 1, grantState: "pending" }] });
  expectPublication(2);
  expect(
    await store.grant(target, "status", "granted", 1, put.widgets[0]?.instanceId, authority),
  ).toMatchObject({ revision: 3, widgets: [{ revision: 1, grantState: "granted" }] });
  expectPublication(3);
  expect(await document("status")).toMatchObject({
    html: "<p>committed</p>",
    grantState: "granted",
  });
  expect(
    host.queries.filter(
      (sql) =>
        /\bboard_(?:tabs|widgets)\b/iu.test(sql) &&
        (/^\s*(?:insert|update|delete|replace|create|alter|drop)\b/iu.test(sql) ||
          /\bfrom\s+sqlite_schema\b/iu.test(sql)),
    ),
  ).toEqual([]);
  expect(changes).toEqual([]);
  expect(assertCurrent).toHaveBeenCalled();
  expect(
    pipelineSql.filter((sql) =>
      /\bboard_(?:tabs|widgets)\b|select "entry_json" from "session_nodes"/iu.test(sql),
    ),
  ).toEqual([]);
});

it("preserves untouched widget rows while persisting later layout changes", async () => {
  const { database, store, target, putHtml } = fixture();
  const readRows = () =>
    database.db.prepare("SELECT name, size_w, updated_at FROM board_widgets ORDER BY name").all();
  await putHtml("first", "first");
  database.db.prepare("UPDATE board_widgets SET updated_at = 100 WHERE name = 'first'").run();
  await putHtml("second", "second");
  const before = readRows();
  expect(before).toMatchObject([{ name: "first", updated_at: 100 }, { name: "second" }]);
  await store.applyOps(target, [{ kind: "widget_resize", name: "first", sizeW: 8, sizeH: 6 }]);
  const after = readRows();
  expect(after).toEqual([{ ...before[0], size_w: 8, updated_at: expect.any(Number) }, before[1]]);
  expect(after[0]?.updated_at).not.toBe(100);
  expect((await store.getSnapshot(target)).widgets).toMatchObject([
    { name: "first", sizeW: 8, sizeH: 6 },
    { name: "second" },
  ]);
});

it.each([false, true])(
  "retains queued Board input and rejects revoked authority (revoked: %s)",
  async (revoke) => {
    const { database, options, store, target, document, snapshot } = fixture();
    using observed = observeChanges(target.sessionKey);
    const { changes } = observed;
    await using writer = await holdWriter(options);
    const authority = new AbortController();
    const params: BoardWidgetMaterializedPutParams = htmlWidget(
      target.sessionKey,
      "captured",
      "<p>captured</p>",
    );
    const pending = writer.track(
      store.putWidget(params, { assertCurrent: () => authority.signal.throwIfAborted() }),
    );
    params.name = "changed";
    params.content = { kind: "html", html: "<p>changed</p>" };
    if (revoke) {
      authority.abort(new Error("Board request retired while queued"));
    }
    expect(changes).toEqual([]);
    await writer.release();
    if (revoke) {
      await expect(pending).rejects.toThrow("Board request retired while queued");
      expect(await snapshot()).toMatchObject({ revision: 0, widgets: [] });
      expect(changes).toEqual([]);
    } else {
      await expect(pending).resolves.toMatchObject({
        resolvedWidgetName: "captured",
        widgets: [{ name: "captured", revision: 1 }],
      });
      expect(await document("captured")).toMatchObject({ html: "<p>captured</p>" });
      expect(changes).toEqual([{ sessionKey: target.sessionKey, storePath: database.path }]);
    }
  },
);

it("preserves committed Boards and admits followers after publication cleanup is refused", async () => {
  const { database, store, target, putHtml: put } = fixture();
  using observed = observeChanges(target.sessionKey);
  const { changes } = observed;
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
  void first.catch(() => undefined);
  void queued.catch(() => undefined);
  try {
    expect(await first).toMatchObject({ revision: 1, resolvedWidgetName: "first" });
    expect(await queued).toMatchObject({ revision: 2, resolvedWidgetName: "queued" });
    expect(refusals).toBe(1);
    interception.mockRestore();
    const final = await put("later");
    expect(final.revision).toBe(3);
    expect(final.widgets.map(({ name }) => name).toSorted()).toEqual(["first", "later", "queued"]);
    expect(changes).toEqual(
      Array.from({ length: 3 }, () => ({
        sessionKey: target.sessionKey,
        storePath: database.path,
      })),
    );
    await closeOpenClawAgentDatabasesAsync();
    const { resolvedWidgetName: _, ...snapshot } = final;
    expect(await store.getSnapshot(target)).toEqual(snapshot);
  } finally {
    interception.mockRestore();
    await Promise.allSettled([first, queued]);
  }
});

it.each(["snapshot", "metadata", "mcp"] as const)(
  "reads the committed Board %s after an earlier queued write",
  async (operation) => {
    const { options, store, target } = fixture();
    const put = (toolCallId: string) =>
      store.putWidget({ ...target, name: "app", content: mcpContent({ toolCallId }, false) });
    await put("initial");
    await using writer = await holdWriter(options);
    const written = writer.track(put("updated"));
    const read =
      operation === "mcp"
        ? writer.track(store.readWidgetMcpApp(target, "app"))
        : writer.track(
            operation === "snapshot"
              ? store.getSnapshot(target)
              : store.getSnapshotWithHtmlViewMetadata(target).then(({ snapshot }) => snapshot),
          );
    await writer.release();
    await written;
    expect(await read).toMatchObject(
      operation === "mcp"
        ? { revision: 2, descriptor: { toolCallId: "updated" } }
        : { revision: 2, widgets: [{ name: "app", revision: 2 }] },
    );
  },
);

it("reads Board snapshots and documents without a write-capable publication", async () => {
  const { store, target, putHtml, document } = fixture();
  const put = await putHtml("status", "read-only");
  using publication = vi
    .spyOn(workerStore, "openOpenClawAgentSqliteWorkerStore")
    .mockImplementation(() => {
      throw new Error("Board read acquired a write-capable publication");
    });
  expect(await store.getSnapshotWithHtmlViewMetadata(target)).toMatchObject({
    snapshot: { revision: put.revision, widgets: [{ name: "status" }] },
  });
  expect(await document("status")).toMatchObject({ html: "read-only" });
  publication.mockRestore();
});

it("refuses Board disclosure when its target changes during a read", async () => {
  const { options, target, putHtml } = fixture();
  await putHtml("status", "private");
  let sessionKey = target.sessionKey;
  const reader = new SqliteBoardStore({
    resolveSession: () => ({
      ...options,
      sessionKey,
      assertCurrent() {
        if (sessionKey !== target.sessionKey) {
          throw new BoardValidationError("invalid_operation", "board session changed; retry");
        }
      },
    }),
    env: options.env,
  });
  using interception = interceptSnapshotRead(() => {
    sessionKey = "agent:main:replacement";
  });
  const consume = vi.fn();
  await expect(reader.useSnapshot(target, consume)).rejects.toThrow("board session changed; retry");
  expect(consume).not.toHaveBeenCalled();
  interception.mockRestore();
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
    const following = runOpenClawAgentWorkerWrite(options, async () => {
      writerSettled.resolve();
      return "following writer";
    });
    try {
      const result = await Promise.race([
        outcome,
        historyRetiring.promise.then(
          () => new Error("Board read cleanup waits on its own queued writer"),
        ),
      ]);
      expect(result).toBeInstanceOf(BoardValidationError);
      expect(result).toMatchObject({ code: "invalid_operation" });
      await expect(following).resolves.toBe("following writer");
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
    const { options, store, target } = fixture();
    const put = (name: string) =>
      store.putWidget({ ...target, name, content: { kind: "html", html: name } });
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
    expect((await store.getSnapshot(target)).widgets.map(({ name }) => name)).toEqual([
      "initial",
      "following",
      ...(consumer === "write" ? ["consumer"] : []),
    ]);
  },
);

it.each(["mutation", "snapshot", "document"] as const)(
  "retains a queued Board %s in its mixed-case Windows state root",
  async (operation) => {
    const { env, options, target, putHtml } = fixture();
    await putHtml("initial", "original");
    const home = tempDirs.make("board-windows-env-home-");
    const laterRoot = path.join(home, "later-state");
    const mixedEnv = { HOME: home, USERPROFILE: home, OpenClaw_State_Dir: env.OPENCLAW_STATE_DIR };
    const cloneEnv = configEnv.cloneEnvWithPlatformSemantics;
    using clone = vi.spyOn(configEnv, "cloneEnvWithPlatformSemantics").mockImplementation((input) =>
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
        : operation === "snapshot"
          ? captured.useSnapshot(target, (snapshot) => snapshot.widgets[0]?.name)
          : captured.useWidgetDocument(target, "initial", (document) =>
              document && "html" in document ? document.html : undefined,
            ),
    );
    let settled = false;
    const settledCallback = () => {
      settled = true;
    };
    void pending.then(settledCallback, settledCallback);
    mixedEnv.OpenClaw_State_Dir = laterRoot;
    await setImmediate();
    expect(settled).toBe(false);
    await writer.release();
    expect(await pending).toBe(
      operation === "mutation" ? "queued" : operation === "snapshot" ? "initial" : "original",
    );
    expect(existsSync(path.join(home, ".openclaw"))).toBe(false);
    expect(existsSync(laterRoot)).toBe(false);
    clone.mockRestore();
  },
);

it("rejects a Board read through an alias when its physical database closes", async () => {
  const { database, options, target, putHtml } = fixture();
  await putHtml("status", "private");
  const physicalPath = realpathSync(options.path);
  const aliasDirectory = path.join(options.env.OPENCLAW_STATE_DIR, "board-alias");
  symlinkSync(path.dirname(physicalPath), aliasDirectory, "junction");
  const aliasOptions = { ...options, path: path.join(aliasDirectory, path.basename(physicalPath)) };
  const reader = new SqliteBoardStore({
    resolveSession: () => ({ ...aliasOptions, sessionKey: target.sessionKey }),
    env: options.env,
  });

  // With no host connection, only the reader's retained close registration can revoke it.
  await closeOpenClawAgentDatabasesAsync();
  expect(database.db.isOpen).toBe(false);
  expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
  expect(getOpenClawAgentDatabaseIfOpen(aliasOptions)).toBeUndefined();

  let readCompleted = false;
  using interception = interceptSnapshotRead(async (snapshot) => {
    expect(snapshot?.snapshot.widgets).toEqual([
      expect.objectContaining({ name: "status", revision: 1 }),
    ]);
    readCompleted = true;
    // Keep the completed read retained until its physical owner has closed.
    await closeOpenClawAgentDatabaseByPathAsync(physicalPath);
  });
  const consume = vi.fn();
  await expect(reader.useSnapshot(target, consume)).rejects.toThrow(
    "Session history database read was revoked",
  );
  expect(readCompleted).toBe(true);
  expect(consume).not.toHaveBeenCalled();
  interception.mockRestore();
});

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

  it("round-trips and removes a board with many tabs", async () => {
    const { target, snapshot, ops } = fixture();
    const empty = { ...target, tabs: [], widgets: [] };
    const created = await ops(...createTabs);
    expect(created.tabs.map((tab) => tab.tabId)).toEqual(tabIds);
    expect(await snapshot()).toEqual(created);
    expect(await ops(...deleteTabs)).toEqual({ ...empty, revision: 2 });
    expect(await snapshot()).toEqual({ ...empty, revision: 0 });
  });

  it("rolls back late board writes and preserves surviving widget documents", async () => {
    const { target, database, ops, snapshot, putHtml, document } = fixture();
    await ops(...createTabs);
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
    const changes: Array<{ change: unknown; inTransaction: boolean }> = [];
    onTestFinished(
      sessionChanges.subscribe((change) => {
        changes.push({ change, inTransaction: database.db.isTransaction });
      }),
    );
    fault.enable(0);
    await expect(ops({ kind: "tab_update", tabId: "tab-0", title: "changed" })).rejects.toThrow(
      "late tab write",
    );
    expect({ changes, ...readRows() }).toEqual({ changes: [], ...beforeRows });
    fault.disable();
    expect(await snapshot()).toEqual(before);

    const removeOps = names.slice(0, -1).map((name) => ({ kind: "widget_remove" as const, name }));
    fault.enable(1);
    await expect(ops(...removeOps)).rejects.toThrow("late widget delete");
    expect({ changes, ...readRows() }).toEqual({ changes: [], ...beforeRows });
    fault.disable();
    const removed = await ops(...removeOps);
    expect(changes).toEqual([
      { change: { ...target, storePath: database.path }, inTransaction: false },
    ]);
    expect(removed.widgets.map((widget) => widget.name)).toEqual(["tab-47"]);
    expect(await snapshot()).toEqual(removed);
    expect(await document("tab-47")).toMatchObject({ html: "tab-47" });
    expect(await document("tab-46")).toBeUndefined();
  });
});

describe("Board source authority", () => {
  type Declared = Parameters<SqliteBoardStore["putWidget"]>[0]["declared"];

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
    const write = (name: string, declared?: Declared) =>
      store.putWidget(
        { ...target, name, content: { kind: "html", html: name }, declared },
        options,
      );
    return { source, target, store, memberId, authorize, authorization, options, write };
  }

  function withFixture(run: (context: Awaited<ReturnType<typeof sourceFixture>>) => Promise<void>) {
    return withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = await sourceFixture();
      using _ = { [Symbol.dispose]: () => context.authorization.release?.() };
      await run(context);
    });
  }

  it("uses retained source facts for every Board mutation and agrees with cold authorization after revocation", () =>
    withFixture(async ({ source, target, store, memberId, authorize, options, write }) => {
      {
        const host = observeHostDataSql();
        using _ = { [Symbol.dispose]: host.restore };
        const put = await write("allowed", { tools: ["health"] });
        await store.applyOps(
          target,
          [{ kind: "widget_resize", name: "allowed", sizeW: 8, sizeH: 6 }],
          options,
        );
        await store.grant(target, "allowed", "granted", 1, put.widgets[0]?.instanceId, options);
        expect(host.queries).toEqual([]);
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
