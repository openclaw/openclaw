import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { IncognitoAcpSessionAccess } from "../acp/runtime/session-meta-incognito.types.js";
import {
  prepareAcpSessionEntryRead,
  readAcpSessionEntryAsync,
  withAcpSessionEntryRead,
} from "../acp/runtime/session-meta-read.js";
import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import * as metadataReader from "../acp/runtime/session-meta-readonly.js";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta-write.js";
import { readAcpSessionEntry, readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import * as sharedWorker from "./openclaw-state-worker-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
const meta: SessionAcpMeta = {
  backend: "fixture",
  agent: "fixture",
  runtimeSessionName: "fixture-runtime",
  mode: "persistent",
  state: "idle",
  lastActivityAt: 100,
};
let env: NodeJS.ProcessEnv;
let actor: IncognitoAgentDatabaseExecution;
const key = (name: string) => `agent:main:dashboard:incognito-${name}`;
const entry = (sessionId: string) => ({
  sessionId,
  lifecycleRevision: sessionId,
  updatedAt: 100,
  createdAt: 100,
  incognito: true as const,
});

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-acp-") };
  openOpenClawStateDatabase({ env });
  const captured = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(captured);
  actor = captured;
});
afterAll(async () => {
  vi.restoreAllMocks();
  await actor?.close();
  await closeOpenClawStateDatabaseAsync();
});

it.each(["read", "upsert"] as const)(
  "rechecks ACP caller after %s composition settles",
  async (operation) => {
    const sessionKey = key(`settled-${operation}`);
    await actor.sessions.create(authority, { sessionKey, entry: entry(`settled-${operation}`) });
    await actor.acp.upsertMeta({ authority, cfg, env, sessionKey, mutate: () => meta });
    let current = true;
    const source: IncognitoSessionAuthority = {
      assertCurrent() {
        if (!current) {
          throw new Error("ACP caller retired after settlement");
        }
      },
    };
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
      const target = { authority: source, cfg, env, sessionKey };
      await expect(
        operation === "read"
          ? actor.acp.readEntry(target)
          : actor.acp.upsertMeta({ ...target, mutate: () => ({ ...meta, lastActivityAt: 200 }) }),
      ).rejects.toThrow("ACP caller retired after settlement");
      actor.assertReadable();
      expect((await actor.acp.readEntry({ authority, cfg, env, sessionKey }))?.acp).toMatchObject({
        lastActivityAt: operation === "read" ? 100 : 200,
      });
    } finally {
      completed.mockRestore();
    }
  },
);

it("orders set, link and clear through both owners with zero caller-thread SQL", async () => {
  const readComposed = async ({
    authority: boundAuthority,
    ...input
  }: Parameters<IncognitoAcpSessionAccess["readEntry"]>[0]) =>
    (
      await withIncognitoSessionActor(actor, () =>
        readAcpSessionEntryAsync({ ...input, assertCurrent: () => boundAuthority.assertCurrent() }),
      )
    )?.entry;
  const upsertComposed = ({
    authority: boundAuthority,
    ...input
  }: Parameters<IncognitoAcpSessionAccess["upsertMeta"]>[0]) =>
    withIncognitoSessionActor(actor, () =>
      upsertAcpSessionMeta({ ...input, assertCommitAllowed: () => boundAuthority.assertCurrent() }),
    );
  const sessionKey = key("sequence");
  const target = { authority, cfg, env, sessionKey };
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { ...entry("sequence"), acp: meta },
  });
  const sequence: string[] = [];
  const execute = actor.sessions.sideData;
  const sideData = vi
    .spyOn(actor.sessions, "sideData")
    .mockImplementation((commandAuthority, command, signal) => {
      if (command.type === "session.acp.entry") {
        sequence.push("entry");
      }
      return execute(commandAuthority, command, signal);
    });
  const run = sharedWorker.runOpenClawStateWorkerOperation;
  const shared = vi
    .spyOn(sharedWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      run(
        context,
        (scope) =>
          operation({
            ...scope,
            execute: new Proxy(scope.execute, {
              apply(fn, receiver, args: Parameters<typeof scope.execute>) {
                if (args[0].type === "acp.commitMutation") {
                  sequence.push("metadata");
                }
                return Reflect.apply(fn, receiver, args);
              },
            }),
          }),
        options,
      ),
    );
  const observe = observeHostDataSql();
  try {
    expect((await readComposed(target))?.acp).toBeUndefined();
    const set = await upsertComposed({
      ...target,
      now: () => 200,
      mutate: () => meta,
    });
    expect(set).toMatchObject({ sessionId: "sequence", acp: meta });
    expect(set?.updatedAt).toBeGreaterThan(100);
    expect(sequence).toEqual(["entry", "metadata"]);
    const stored = (await actor.sessions.read(authority, { sessionKey })).entry;
    expect(stored?.acp).toBeUndefined();
    const joined = await readComposed(target);
    expect(joined?.acp).toEqual(meta);
    expect(joined?.updatedAt).toBe(stored?.updatedAt);
    sequence.length = 0;
    expect(await upsertComposed({ ...target, mutate: () => undefined })).toMatchObject({
      acp: meta,
    });
    expect(sequence).toEqual([]);
    expect(await upsertComposed({ ...target, mutate: () => null })).toMatchObject({
      sessionId: "sequence",
    });
    expect(sequence).toEqual(["entry", "metadata"]);
    expect((await readComposed(target))?.acp).toBeUndefined();
    const linked = await upsertComposed({
      ...target,
      sessionKey: key("new-link"),
      mutate: () => meta,
    });
    expect(linked?.lifecycleRevision).toEqual(expect.any(String));
    expect((await readComposed({ ...target, sessionKey: key("new-link") }))?.acp).toEqual(meta);
    expect(observe.queries).toEqual([]);
  } finally {
    observe.restore();
    sideData.mockRestore();
    shared.mockRestore();
  }
});

it.each(["read", "write", "prepare"] as const)(
  "captures the ACP %s environment before deferred composition",
  async (operation) => {
    const sessionKey = key(`capture-${operation}`);
    await actor.sessions.create(authority, { sessionKey, entry: entry(`capture-${operation}`) });
    await actor.acp.upsertMeta({ authority, cfg, env, sessionKey, mutate: () => meta });
    const requestEnv = { ...env };
    const input = {
      cfg,
      env: requestEnv,
      sessionKey,
      authority,
      databasePath: resolveOpenClawStateSqlitePath(env),
    };
    const updated = { ...meta, lastActivityAt: 300 };
    const pending =
      operation === "read"
        ? readAcpSessionEntryAsync(input, { actor, authority }).then((value) => value?.acp)
        : operation === "write"
          ? upsertAcpSessionMeta({ ...input, mutate: () => updated }, { actor, authority }).then(
              (value) => value?.acp,
            )
          : actor.acp.prepareEntryRead(input).then((prepared) => {
              try {
                prepared.assertCurrent();
                return prepared.session?.acp;
              } finally {
                prepared.release();
              }
            });
    requestEnv.OPENCLAW_STATE_DIR = tempDirs.make("incognito-acp-redirect-");
    if (operation === "prepare") {
      input.sessionKey = key("wrong-preparation");
      input.databasePath = resolveOpenClawStateSqlitePath(requestEnv);
    }
    expect(await pending).toEqual(operation === "write" ? updated : meta);
    expect((await actor.acp.readEntry({ authority, cfg, env, sessionKey }))?.acp).toEqual(
      operation === "write" ? updated : meta,
    );
  },
);

it("fences binding cleanup when ACP metadata commits after its actor entry", async () => {
  const sessionKey = key("binding-cleanup");
  await actor.sessions.create(authority, { sessionKey, entry: entry("binding-cleanup") });
  const store = createPluginStateKeyedStore<string>("fixture", {
    namespace: "incognito-acp-cleanup",
    maxEntries: 10,
    env,
  });
  await store.register("binding", sessionKey);
  const reached = createDeferredCore();
  const resume = createDeferredCore();
  const run = sharedWorker.runOpenClawStateWorkerOperation;
  const shared = vi
    .spyOn(sharedWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      run(
        context,
        (scope) =>
          operation({
            ...scope,
            execute: new Proxy(scope.execute, {
              async apply(fn, receiver, args: Parameters<typeof scope.execute>) {
                if (args[0].type === "acp.commitMutation") {
                  reached.resolve();
                  await resume.promise;
                }
                return Reflect.apply(fn, receiver, args);
              },
            }),
          }),
        options,
      ),
    );
  const updating = actor.acp.upsertMeta({ authority, cfg, env, sessionKey, mutate: () => meta });
  void updating.catch(() => {});
  let prepared: Awaited<ReturnType<IncognitoAcpSessionAccess["prepareEntryRead"]>> | undefined;
  const observe = observeHostDataSql();
  try {
    await awaitGateBeforeSettlement(
      reached.promise,
      updating,
      "ACP mutation skipped shared commit",
    );
    const request = { cfg, env: { ...env }, sessionKey, authority };
    const preparing = withIncognitoSessionActor(actor, async () => {
      const preparation = prepareAcpSessionEntryRead(request);
      assert(preparation);
      request.sessionKey = key("wrong-binding");
      request.env.OPENCLAW_STATE_DIR = tempDirs.make("incognito-acp-cleanup-redirect-");
      return preparation;
    });
    prepared = await preparing;
    expect(prepared.session?.sessionKey).toBe(sessionKey);
    expect(prepared.session?.acp).toBeUndefined();
    resume.resolve();
    await updating;
    expect(() => prepared!.assertCurrent()).toThrow("Prepared ACP session changed");
    await expect(
      store.delete("binding", { assertCurrent: prepared.assertCurrent }),
    ).rejects.toThrow();
    expect(await store.lookup("binding")).toBe(sessionKey);
    expect(observe.queries).toEqual([]);
  } finally {
    resume.resolve();
    await Promise.allSettled([updating]);
    prepared?.release();
    observe.restore();
    shared.mockRestore();
  }
});

it.each(["snapshot", "policy"] as const)(
  "refuses changed %s before shared publication without replaying the mutator",
  async (change) => {
    const sessionKey = key(`revoked-${change}`);
    let allowed = true;
    const currentAuthority: IncognitoSessionAuthority = {
      assertCurrent() {},
      authorize() {
        if (!allowed) {
          throw new Error("ACP policy revoked");
        }
      },
    };
    const target = { authority: currentAuthority, cfg, env, sessionKey };
    await actor.sessions.create(authority, { sessionKey, entry: entry("revoked") });
    const reached = createDeferredCore();
    const release = createDeferredCore();
    const run = sharedWorker.runOpenClawStateWorkerOperation;
    const shared = vi
      .spyOn(sharedWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        run(
          context,
          (scope) =>
            operation({
              ...scope,
              execute: new Proxy(scope.execute, {
                apply(fn, receiver, args: Parameters<typeof scope.execute>) {
                  if (args[0].type === "acp.commitMutation") {
                    reached.resolve();
                    return release.promise.then(() => Reflect.apply(fn, receiver, args));
                  }
                  return Reflect.apply(fn, receiver, args);
                },
              }),
            }),
          options,
        ),
      );
    const mutate = vi.fn(() => meta);
    const pending = actor.acp.upsertMeta({ ...target, mutate });
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        reached.promise,
        outcome.then(() => {
          throw new Error("ACP update settled before publication gate");
        }),
      ]);
      if (change === "policy") {
        allowed = false;
      } else {
        await actor.sessions.sideData(authority, {
          type: "session.acp.entry",
          input: {
            agentId: "main",
            sessionKey,
            expectedEntry: entry("revoked"),
            mutation: { kind: "clear" },
          },
        });
      }
      release.resolve();
      expect(String(await outcome)).toContain(
        change === "policy" ? "ACP policy revoked" : "snapshot changed",
      );
      expect(mutate).toHaveBeenCalledOnce();
      expect((await actor.acp.readEntry({ ...target, authority }))?.acp).toBeUndefined();
    } finally {
      release.resolve();
      await outcome;
      shared.mockRestore();
    }
  },
);

it("rechecks policy before disclosing the joined shared metadata", async () => {
  const sessionKey = key("read-policy");
  await actor.sessions.create(authority, { sessionKey, entry: entry("read-policy") });
  await actor.acp.upsertMeta({
    authority,
    sessionKey,
    cfg,
    env,
    mutate: () => meta,
  });
  let allowed = true;
  const read = metadataReader.readAcpSessionMetaForEntries;
  const intercepted = vi
    .spyOn(metadataReader, "readAcpSessionMetaForEntries")
    .mockImplementation(async (...args) => {
      const result = await read(...args);
      allowed = false;
      return result;
    });
  try {
    await expect(
      actor.acp.readEntry({
        sessionKey,
        cfg,
        env,
        authority: {
          assertCurrent() {},
          authorize() {
            if (!allowed) {
              throw new Error("ACP read policy revoked");
            }
          },
        },
      }),
    ).rejects.toThrow("ACP read policy revoked");
  } finally {
    intercepted.mockRestore();
  }
});

it.each(["revision", "consume-release", "prepared-release"] as const)(
  "retains bound ACP read custody and refuses %s disclosure",
  async (change) => {
    const sessionKey = key(`bound-consumer-${change}`);
    await actor.sessions.create(authority, {
      sessionKey,
      entry: entry(`bound-consumer-${change}`),
    });
    const borrowed = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: actor.agentId,
      env,
      authority,
      existingOnly: true,
    });
    assert(borrowed);
    const input = { cfg, env, sessionKey };
    const observe = observeHostDataSql();
    let retiring: Promise<void> | undefined;
    let disclosed = false;
    try {
      await expect(
        withIncognitoSessionActor(borrowed, async () => {
          expect(() => readAcpSessionEntry(input)).toThrow("Await readAcpSessionEntryAsync");
          expect(() => readAcpSessionMeta(input)).toThrow("Await readAcpSessionMetaAsync");
          if (change === "prepared-release") {
            const preparation = prepareAcpSessionEntryRead(input);
            assert(preparation);
            const prepared = await preparation;
            try {
              retiring = borrowed.release();
              prepared.assertCurrent();
              disclosed = true;
            } finally {
              prepared.release();
            }
          } else {
            await withAcpSessionEntryRead(input, async (read) => {
              expect(read?.entry?.sessionId).toBe(`bound-consumer-${change}`);
              if (change === "revision") {
                await upsertAcpSessionMeta({ ...input, mutate: () => meta });
              } else {
                retiring = borrowed.release();
                await Promise.resolve();
              }
            });
            disclosed = true;
          }
        }),
      ).rejects.toThrow(
        change === "revision"
          ? /snapshot changed|Prepared ACP session changed/
          : "reference is released",
      );
      expect(disclosed).toBe(false);
      expect(observe.queries).toEqual([]);
    } finally {
      observe.restore();
      await retiring;
      await borrowed.release();
    }
  },
);

it("keeps shared ACP metadata after the volatile actor ends", async () => {
  const sessionKey = key("retention");
  const target = { authority, cfg, env, sessionKey };
  await actor.sessions.create(authority, { sessionKey, entry: entry("retention") });
  const persisted = await actor.acp.upsertMeta({ ...target, mutate: () => meta });
  assert(persisted);
  await actor.close();
  expect(
    await readAcpSessionMetaForEntries({
      entries: [{ sessionKey, agentId: "main", entry: persisted }],
      cfg,
      env,
    }),
  ).toEqual([meta]);
  expect(() => actor.acp.readEntry(target)).toThrow(/ended/i);
});
