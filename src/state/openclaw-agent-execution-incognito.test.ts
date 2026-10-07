import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  withAcquiredIncognitoSessionBinding,
  withIncognitoSessionEntrySummaries,
} from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import * as workerStores from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { IncognitoSessionEndedError } from "./incognito-session-error.js";
import { getOpenClawAgentDatabaseIfOpen } from "./openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "./openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "./openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const references = new Set<IncognitoAgentDatabaseExecution>();
const authority = { assertCurrent(this: void) {} };
let stateRoot: string;
let tempRoot: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  const root = tempDirs.make("incognito-execution-");
  stateRoot = path.join(root, "state");
  tempRoot = path.join(root, "temp");
  fs.mkdirSync(stateRoot);
  fs.mkdirSync(tempRoot);
  env = { OPENCLAW_STATE_DIR: stateRoot };
  vi.stubEnv("TMPDIR", tempRoot);
  vi.stubEnv("TEMP", tempRoot);
  vi.stubEnv("TMP", tempRoot);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...references].map((reference) => reference.close()));
  references.clear();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function captureIncognito(
  options: { agentId: string; env: NodeJS.ProcessEnv },
  source = authority,
  request: { existingOnly?: boolean; signal?: AbortSignal } = {},
) {
  return captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    ...options,
    authority: source,
    ...request,
  });
}

async function open(agentId = "main", source = authority, signal?: AbortSignal) {
  const reference = await captureIncognito({ agentId, env }, source, { signal });
  assert(reference);
  references.add(reference);
  return reference;
}

function memory(reference: IncognitoAgentDatabaseExecution) {
  return reference.run(authority, (scope) =>
    scope.execute({ type: "database.incognito.memory", input: undefined }),
  );
}

function cancelDispatchedCreation(controller: AbortController) {
  const posted = vi.spyOn(Worker.prototype, "postMessage");
  vi.spyOn(Worker.prototype, "emit").mockImplementation(function (this: Worker, event, ...args) {
    if (
      event === "online" &&
      posted.mock.calls.some(([message]) => isRecord(message) && message.type === "open")
    ) {
      controller.abort(new Error("cancelled dispatched creation"));
    }
    return EventEmitter.prototype.emit.call(this, event, ...args);
  });
}

it("acquires only requested actors and releases the captured root after the consumer settles", async () => {
  const target = {
    agentId: "main",
    env: { ...env },
    sessionKey: "agent:main:dashboard:incognito-acquisition",
  };
  const pathname = resolveIncognitoOpenClawAgentSqlitePath(target);
  const consume = vi.fn(async () => "missing");
  expect(await withAcquiredIncognitoSessionBinding(target, authority, consume)).toBeUndefined();
  expect(consume).not.toHaveBeenCalled();
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  let captured:
    | Parameters<Parameters<typeof withAcquiredIncognitoSessionBinding>[2]>[0]
    | undefined;
  const acquiring = withAcquiredIncognitoSessionBinding(
    target,
    authority,
    async (binding) => {
      captured = binding;
      entered.resolve();
      await finish.promise;
      binding.actor.assertReadable();
      return binding.actor.path;
    },
    { existingOnly: false },
  );
  target.env.OPENCLAW_STATE_DIR = path.join(stateRoot, "replacement");
  await entered.promise;
  expect(captured?.actor.path).toBe(pathname);
  expect(getOpenClawAgentDatabaseIfOpen({ agentId: "main", env, path: pathname })).toBeUndefined();
  finish.resolve();
  expect(await acquiring).toBe(pathname);
  expect(() => captured?.actor.assertReadable()).toThrow("released");
  expect(
    await withAcquiredIncognitoSessionBinding(
      { ...target, env },
      authority,
      async ({ actor }) => actor.path,
    ),
  ).toBe(pathname);
});

it("refuses summary disclosure when admission ends after the worker read", async () => {
  const actor = await open();
  const sessionKey = "agent:main:dashboard:incognito-summary-cancellation";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: "summary-cancellation", updatedAt: 1, incognito: true },
  });
  const admission = new AbortController();
  const disclosed: string[] = [];
  const list = actor.sessions.list.bind(actor.sessions);
  const listing = vi.spyOn(actor.sessions, "list").mockImplementation(async (...args) => {
    const result = await list(...args);
    // Cancel after the real worker read settles, before its consumer resumes.
    admission.abort(new Error("summary admission ended"));
    return result;
  });
  try {
    await expect(
      withIncognitoSessionEntrySummaries(
        { actor, admissionSignal: admission.signal },
        async (summaries) => {
          disclosed.push(...summaries.map((summary) => summary.sessionKey));
        },
      ),
    ).rejects.toThrow("summary admission ended");
    expect(disclosed).toEqual([]);
  } finally {
    listing.mockRestore();
  }
});

it("keeps concurrent creators viable when the initiating opening is cancelled", async () => {
  const controller = new AbortController();
  cancelDispatchedCreation(controller);
  const [cancelled, first, second] = await Promise.allSettled([
    open("main", authority, controller.signal),
    open(),
    open(),
  ] as const);
  expect(cancelled).toMatchObject({
    status: "rejected",
    reason: new Error("cancelled dispatched creation"),
  });
  assert(first.status === "fulfilled", "first valid creator must survive cancellation");
  assert(second.status === "fulfilled", "second valid creator must survive cancellation");
  expect(first.value.identity).toEqual(second.value.identity);
  expect((await memory(first.value)).databaseBytes).toBeGreaterThan(0);
  expect(fs.readdirSync(stateRoot, { recursive: true })).toEqual([]);
  expect(fs.readdirSync(tempRoot, { recursive: true })).toEqual([]);
});

it.each([false, true])(
  "settles cancellation at final publication (another creator: %s)",
  async (anotherCreator) => {
    const controller = new AbortController();
    let nativeReady = false;
    let cancellationQueued = false;
    let nativeStore: object | undefined;
    const openNative = workerStores.openEphemeralAgentDatabaseSqliteWorkerStore;
    vi.spyOn(workerStores, "openEphemeralAgentDatabaseSqliteWorkerStore").mockImplementation(
      async (...args) => {
        const store = await openNative(...args);
        nativeStore = store;
        nativeReady = true;
        return store;
      },
    );
    const creatorAuthority = {
      assertCurrent() {
        controller.signal.throwIfAborted();
        if (nativeReady && !cancellationQueued) {
          cancellationQueued = true;
          queueMicrotask(() => controller.abort(new Error("cancelled before publication")));
        }
      },
    };
    const rejected = expect(open("main", creatorAuthority, controller.signal)).rejects.toThrow(
      "cancelled before publication",
    );
    const follower = anotherCreator ? open() : undefined;
    void follower?.catch(() => undefined);
    await rejected;
    const accepted = await follower;
    const existing = await captureIncognito({ agentId: "main", env }, authority, {
      existingOnly: true,
    });
    if (existing) {
      references.add(existing);
    }
    assert(nativeStore);
    if (accepted) {
      expect(existing?.identity).toEqual(accepted.identity);
      expect((await memory(accepted)).databaseBytes).toBeGreaterThan(0);
    } else {
      expect(existing).toBeUndefined();
      expect(workerStores.isSqliteWorkerStoreAvailable(nativeStore)).toBe(false);
    }
  },
);

it("converges creating opens, pins released stores, reads only existing targets, and creates no artifacts", async () => {
  const options = { agentId: "main", env };
  const sentinel = resolveIncognitoOpenClawAgentSqlitePath(options);
  expect(await captureIncognito(options, authority, { existingOnly: true })).toBeUndefined();
  expect(fs.readdirSync(stateRoot)).toEqual([]);
  const creating = [open(), open()] as const;
  expect(await captureIncognito(options, authority, { existingOnly: true })).toBeUndefined();
  const [first, second] = await Promise.all(creating);
  expect(first.identity).toEqual(second.identity);
  expect(getOpenClawAgentDatabaseIfOpen({ ...options, path: sentinel })).toBeUndefined();
  expect(supportsOpenClawAgentDatabaseExecution({ ...options, path: sentinel })).toBe(false);
  const gauge = await memory(first);
  expect(gauge.agentId).toBe("main");
  expect(gauge.pageCount).toBeGreaterThan(0);
  expect(gauge.pageSize).toBeGreaterThan(0);
  expect(gauge.databaseBytes).toBe(gauge.pageCount * gauge.pageSize);
  await Promise.all([first.release(), second.release()]);
  const sibling = await open("sibling");
  const existing = await captureIncognito(options, authority, {
    existingOnly: true,
  });
  assert(existing);
  references.add(existing);
  expect(existing.identity).toEqual(first.identity);
  expect(await memory(existing)).toEqual(gauge);
  expect(sibling.identity).not.toEqual(first.identity);
  expect((await memory(sibling)).agentId).toBe("sibling");
  expect(fs.readdirSync(stateRoot, { recursive: true })).toEqual([]);
  expect(fs.readdirSync(tempRoot, { recursive: true })).toEqual([]);
  expect(
    await captureIncognito(
      { agentId: "main", env: { OPENCLAW_STATE_DIR: path.join(stateRoot, "other") } },
      authority,
      { existingOnly: true },
    ),
  ).toBeUndefined();
  await Promise.all([existing.close(), sibling.close()]);
  expect(fs.readdirSync(stateRoot, { recursive: true })).toEqual([]);
  expect(fs.readdirSync(tempRoot, { recursive: true })).toEqual([]);
  const recreated = await open();
  expect(recreated.identity).not.toEqual(first.identity);
  expect(() => existing.assertCurrent()).toThrow(IncognitoSessionEndedError);
  expect(() => memory(existing)).toThrow(IncognitoSessionEndedError);
  await existing.close();
  expect((await memory(recreated)).databaseBytes).toBeGreaterThan(0);
});

it("retains FIFO publication and rechecks authority after queue waits and before disclosure", async () => {
  const reference = await open();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const order: string[] = [];
  const first = reference.run(authority, async (scope) => {
    order.push("first");
    entered.resolve();
    await release.promise;
    await scope.execute({ type: "database.incognito.memory", input: undefined });
    order.push("published");
  });
  await entered.promise;
  let allowed = true;
  const source = {
    assertCurrent() {
      if (!allowed) {
        throw new Error("revoked");
      }
    },
  };
  const rejected = expect(
    reference.run(source, async (scope) => {
      order.push("revoked callback");
      return scope.execute({ type: "database.incognito.memory", input: undefined });
    }),
  ).rejects.toThrow("revoked");
  const last = reference.run(authority, async (scope) => {
    order.push("last");
    return scope.execute({ type: "database.incognito.memory", input: undefined });
  });
  const competing = runOpenClawAgentWorkerWrite(
    { target: reference.identity, assertCurrent: authority.assertCurrent },
    async () => {
      order.push("external reservation");
    },
  );
  const released = reference.release();
  allowed = false;
  release.resolve();
  await Promise.all([first, rejected, last, competing, released]);
  expect(order).toEqual(["first", "published", "last", "external reservation"]);
  const next = await open();
  allowed = true;
  await expect(
    next.run(source, async (scope) => {
      const result = await scope.execute({ type: "database.incognito.memory", input: undefined });
      allowed = false;
      return result;
    }),
  ).rejects.toThrow("revoked");
  let closing: Promise<void> | undefined;
  let revoke = false;
  const revokesOwner = {
    assertCurrent() {
      if (revoke) {
        closing = next.close();
      }
    },
  };
  await expect(
    next.run(revokesOwner, async (scope) => {
      const result = await scope.execute({ type: "database.incognito.memory", input: undefined });
      revoke = true;
      return result;
    }),
  ).rejects.toThrow(IncognitoSessionEndedError);
  await closing;
});

it("rechecks its acquisition authority at session transaction and commit grants", async () => {
  const healthy = await open();
  for (const revokeAt of ["transaction", "commit"] as const) {
    let current = true;
    const source = {
      assertCurrent() {
        if (!current) {
          throw new Error(`acquisition revoked at ${revokeAt}`);
        }
      },
    };
    const borrowed = await captureIncognito({ agentId: "main", env }, source, {
      existingOnly: true,
    });
    assert(borrowed);
    const sessionKey = `agent:main:dashboard:incognito-acquisition-${revokeAt}`;
    const requested: IncognitoSessionAuthority = {
      assertCurrent() {},
      authorize(stage) {
        if (stage === revokeAt) {
          current = false;
        }
      },
    };
    try {
      await expect(
        borrowed.sessions.create(requested, {
          sessionKey,
          entry: { sessionId: revokeAt, updatedAt: 1, incognito: true },
        }),
      ).rejects.toThrow(`acquisition revoked at ${revokeAt}`);
      expect(() => borrowed.assertReadable()).toThrow(`acquisition revoked at ${revokeAt}`);
      expect((await healthy.sessions.read(authority, { sessionKey })).entry).toBeUndefined();
    } finally {
      await borrowed.release();
    }
  }
});

it("preserves outer acquisition authority and admission through nested bindings", async () => {
  const healthy = await open();
  for (const revoke of ["authority", "admission"] as const) {
    let current = true;
    const failure = new Error(`outer acquisition ${revoke} revoked`);
    const outerAuthority = {
      assertCurrent() {
        if (!current) {
          throw failure;
        }
      },
    };
    const inherited = new AbortController();
    const inner = new AbortController();
    const target = {
      agentId: "main",
      env,
      sessionKey: `agent:main:dashboard:incognito-nested-${revoke}`,
    };
    await expect(
      withAcquiredIncognitoSessionBinding(
        target,
        outerAuthority,
        () =>
          withAcquiredIncognitoSessionBinding(
            target,
            authority,
            async (binding) => {
              if (revoke === "authority") {
                current = false;
              } else {
                inherited.abort(failure);
              }
              return binding.actor.sessions.create(
                authority,
                {
                  sessionKey: target.sessionKey,
                  entry: { sessionId: revoke, updatedAt: 1, incognito: true },
                },
                binding.admissionSignal,
              );
            },
            { signal: inner.signal },
          ),
        { signal: inherited.signal },
      ),
    ).rejects.toThrow(failure.message);
    expect((await healthy.sessions.read(authority, target)).entry).toBeUndefined();
  }
});

it("joins deferred compute cleanup before closing without disclosing its revoked result", async () => {
  const order: string[] = [];
  const opening = workerStores.openEphemeralAgentDatabaseSqliteWorkerStore;
  vi.spyOn(workerStores, "openEphemeralAgentDatabaseSqliteWorkerStore").mockImplementation(
    async (...args) => {
      const store = await opening(...args);
      assert(store);
      const close = store.close.bind(store);
      vi.spyOn(store, "close").mockImplementation(async () => {
        order.push("transport-close");
        await close();
      });
      return store;
    },
  );
  const reference = await open();
  const target = {
    sessionKey: "agent:main:dashboard:incognito-deferred-cleanup",
    sessionId: "deferred-cleanup",
    lifecycleRevision: "initial",
  };
  await reference.sessions.create(authority, {
    sessionKey: target.sessionKey,
    entry: { sessionId: target.sessionId, lifecycleRevision: "initial", updatedAt: 1 },
  });
  const run = workerStores.runSqliteWorkerStoreOperation;
  vi.spyOn(workerStores, "runSqliteWorkerStoreOperation").mockImplementation(
    <Operations extends SqliteWorkerOperations, T>(
      store: SqliteWorkerStore<Operations>,
      operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
      stateContext?: Parameters<typeof run>[2],
      assertCurrent?: Parameters<typeof run>[3],
      createAdmission?: Parameters<typeof run>[4],
    ) =>
      run(
        store,
        (scope) =>
          operation({
            execute: async (command, options) => {
              const result = await scope.execute(command, options);
              if (command.type === "session.compute.source.release") {
                order.push("source-released");
              }
              if (command.type === "session.compute.usage.releaseLock") {
                order.push("lock-released");
              }
              return result;
            },
          }),
        stateContext,
        assertCurrent,
        createAdmission,
      ),
  );
  const ready = createDeferredCore();
  const resume = createDeferredCore();
  const work = reference.sessions.withCompute(authority, target, async (compute) => {
    await compute.execute({
      type: "session.compute.source.open",
      input: { ...target, sourceId: "deferred-source" },
    });
    await compute.execute({
      type: "session.compute.usage.acquireLock",
      input: {
        ...target,
        request: {
          previousRaw: null,
          previousOwnerIsRunning: false,
          lockJson: "deferred-lock",
          startedAt: 1,
        },
      },
    });
    ready.resolve();
    await resume.promise;
    return "private result";
  });
  void work.catch(ready.reject);
  const rejected = expect(work).rejects.toThrow(IncognitoSessionEndedError);
  let closing: Promise<void> | undefined;
  try {
    await ready.promise;
    closing = reference.close();
    expect(() => memory(reference)).toThrow(IncognitoSessionEndedError);
    expect(order).toEqual([]);
    resume.resolve();
    await Promise.all([rejected, closing]);
    expect(order).toEqual(["source-released", "lock-released", "transport-close"]);
  } finally {
    resume.resolve();
    await Promise.allSettled([work, closing]);
  }
});

it("settles accepted dependent writes across release and close while checking live caller authority", async () => {
  const owner = await open();
  const sessionKey = "agent:main:dashboard:incognito-retained-composition";
  await owner.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: "retained-composition", lifecycleRevision: "initial", updatedAt: 1 },
  });
  const committed: string[] = [];
  for (const ending of ["release", "revoked", "close"] as const) {
    const reference = await open();
    let allowed = true;
    const source = {
      assertCurrent() {
        reference.assertCurrent();
        if (!allowed) {
          throw new Error("composition caller revoked");
        }
      },
    };
    const work = reference.sessions.withSharedState(async () => {
      await reference.sessions.transcript(
        source,
        {
          type: "session.message.append",
          input: {
            sessionKey,
            sessionId: "retained-composition",
            fence: { expectedLifecycleRevision: "initial" },
            message: { role: "assistant", content: [{ type: "text", text: ending }], timestamp: 1 },
          },
        },
        undefined,
        undefined,
        () => committed.push(ending),
      );
      return "private composition result";
    });
    const rejected = expect(work).rejects.toThrow(
      ending === "close"
        ? IncognitoSessionEndedError
        : ending === "revoked"
          ? "composition caller revoked"
          : "Incognito execution reference is released",
    );
    allowed = ending !== "revoked";
    // Release before the accepted callback's first microtask, not just a queued SQL command.
    const endingWork = ending === "close" ? reference.close() : reference.release();
    expect(() => memory(reference)).toThrow();
    await Promise.all([rejected, endingWork]);
    if (ending !== "close") {
      await owner.sessions.withSharedState(async () => {
        expect(() => reference.assertCurrent()).toThrow(
          "Incognito execution reference is released",
        );
      });
    }
    expect(committed).toEqual(ending === "close" ? ["release", "close"] : ["release"]);
  }
});

it.each(["existing", "future"] as const)(
  "pins only its %s shared owner across actor loss until work and retried cleanup settle",
  async (sharedOpening) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const existing = sharedOpening === "existing" ? openOpenClawStateDatabase({ env }) : undefined;
    let cleanupAttempted = false;
    let nativeStore: { close(): Promise<void> } | undefined;
    const posted = vi.spyOn(Worker.prototype, "postMessage");
    const openNative = workerStores.openEphemeralAgentDatabaseSqliteWorkerStore;
    vi.spyOn(workerStores, "openEphemeralAgentDatabaseSqliteWorkerStore").mockImplementation(
      async (...args) => {
        const store = await openNative(...args);
        assert(store);
        nativeStore = store;
        return store;
      },
    );
    const reference = await open();
    if (!existing) {
      expect(fs.readdirSync(stateRoot, { recursive: true })).toEqual([]);
    }
    const shared = existing ?? openOpenClawStateDatabase({ env });
    const unrelated = openOpenClawStateDatabase({
      path: path.join(tempDirs.make("incognito-unrelated-state-"), "state.sqlite"),
    });
    await reference.release();
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS + 1);
    expect(shared.db.isOpen).toBe(true);
    expect(unrelated.db.isOpen).toBe(false);

    const borrower = await open();
    assert(nativeStore);
    const cleanup = vi.spyOn(nativeStore, "close").mockImplementationOnce(async () => {
      cleanupAttempted = true;
      throw new Error("native cleanup refused");
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const work = expect(
      borrower.run(authority, async () => {
        entered.resolve();
        await release.promise;
      }),
    ).rejects.toThrow(IncognitoSessionEndedError);
    let failedClose: Promise<unknown> | undefined;
    try {
      await entered.promise;
      const openIndex = posted.mock.calls.findIndex(
        ([message]) =>
          isRecord(message) && message.type === "open" && message.databasePath === borrower.path,
      );
      const owningWorker: unknown = posted.mock.contexts[openIndex];
      assert(owningWorker instanceof Worker);
      await owningWorker.terminate();
      expect(() => borrower.assertCurrent()).toThrow(IncognitoSessionEndedError);
      failedClose = expect(borrower.close()).rejects.toThrow("native cleanup refused");
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS + 1);
      expect(shared.db.isOpen).toBe(true);
      expect(cleanupAttempted).toBe(false);
      release.resolve();
      await Promise.all([work, failedClose]);
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS + 1);
      expect(shared.db.isOpen).toBe(true);
      expect(() => borrower.assertCurrent()).toThrow(IncognitoSessionEndedError);
      await borrower.close();
    } finally {
      release.resolve();
      await Promise.allSettled([work, failedClose]);
      cleanup.mockRestore();
      await borrower.close();
    }
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS + 1);
    expect(shared.db.isOpen).toBe(false);
    const later = openOpenClawStateDatabase({ env });
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS + 1);
    expect(later.db.isOpen).toBe(false);
  },
);

it("keeps the outer actor reentrancy fence after nested grants consume prepared facts", async () => {
  const reference = await open();
  const sessionKey = "agent:main:dashboard:incognito-nested-grant";
  const created = await reference.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: "nested-grant", updatedAt: 1, incognito: true },
  });
  const reentered: Promise<unknown>[] = [];
  const refusals: unknown[] = [];
  const prepared: string[] = [];
  const source: IncognitoSessionAuthority = {
    assertCurrent() {},
    authorize(stage, facts) {
      created.claim.authorize(
        {
          assertCurrent() {},
          authorize(_stage, nestedFacts) {
            prepared.push(nestedFacts.sessionKey);
          },
        },
        stage,
      );
      expect(facts.sessionKey).toBe(sessionKey);
      const target = { authority, sessionKey, cfg: {}, env };
      for (const reenter of [
        () => memory(reference),
        () => reference.sessions.withSharedState(() => memory(reference)),
        () => reference.acp.readEntry(target),
        () => reference.acp.upsertMeta({ ...target, mutate: () => undefined }),
      ]) {
        try {
          reentered.push(reenter());
        } catch (error) {
          refusals.push(error);
        }
      }
    },
  };
  const read = await reference.sessions.read(source, { sessionKey });
  await Promise.allSettled(reentered);
  expect(read.entry?.sessionId).toBe("nested-grant");
  expect(prepared).toEqual([sessionKey]);
  expect(refusals).toEqual([
    new Error("Incognito authority callbacks cannot call their actor"),
    new Error("Incognito authority callbacks cannot call their actor"),
    new Error("Incognito authority callbacks cannot call their actor"),
    new Error("Incognito authority callbacks cannot call their actor"),
  ]);
  expect(reentered).toEqual([]);
});

it("ends only the lost actor's sessions and refuses old handles after replacement", async () => {
  const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
  const posted = vi.spyOn(Worker.prototype, "postMessage");
  const lost = await open();
  const sibling = await open("sibling");
  const openIndex = posted.mock.calls.findIndex(
    ([message]) =>
      isRecord(message) && message.type === "open" && message.databasePath === sentinel,
  );
  const owningWorker: unknown = posted.mock.contexts[openIndex];
  assert(owningWorker instanceof Worker);
  await owningWorker.terminate();
  expect(() => lost.assertCurrent()).toThrow(IncognitoSessionEndedError);
  expect(() => memory(lost)).toThrow(IncognitoSessionEndedError);
  expect((await memory(sibling)).databaseBytes).toBeGreaterThan(0);
  await expect(
    captureIncognito({ agentId: "main", env }, authority, {
      existingOnly: true,
    }),
  ).rejects.toMatchObject({ code: "INCOGNITO_SESSION_ENDED" });
  const replacement = await open();
  expect(replacement.identity).not.toEqual(lost.identity);
  expect(() => lost.assertCurrent()).toThrow(IncognitoSessionEndedError);
  expect((await memory(replacement)).databaseBytes).toBeGreaterThan(0);
});

it("refuses sentinel collisions and cancelled creation without publishing or touching storage", async () => {
  const options = { agentId: "main", env };
  const sentinel = resolveIncognitoOpenClawAgentSqlitePath(options);
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, "operator-owned collision");
  await expect(open()).rejects.toThrow("sentinel path already exists");
  expect(fs.readFileSync(sentinel, "utf8")).toBe("operator-owned collision");
  expect(await captureIncognito(options, authority, { existingOnly: true })).toBeUndefined();
  const controller = new AbortController();
  controller.abort(new Error("cancelled creation"));
  await expect(open("cancelled", authority, controller.signal)).rejects.toThrow(
    "cancelled creation",
  );
  expect(
    await captureIncognito({ agentId: "cancelled", env }, authority, {
      existingOnly: true,
    }),
  ).toBeUndefined();
  const dispatched = new AbortController();
  cancelDispatchedCreation(dispatched);
  await expect(open("dispatched", authority, dispatched.signal)).rejects.toThrow(
    "cancelled dispatched creation",
  );
  expect(
    await captureIncognito({ agentId: "dispatched", env }, authority, {
      existingOnly: true,
    }),
  ).toBeUndefined();
  expect(fs.readdirSync(tempRoot, { recursive: true })).toEqual([]);
});
