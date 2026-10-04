import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import * as metadataReader from "../acp/runtime/session-meta-readonly.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
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

it("orders set, link and clear through both owners with zero caller-thread SQL", async () => {
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
    expect((await actor.acp.readEntry(target))?.acp).toBeUndefined();
    const set = await actor.acp.upsertMeta({
      ...target,
      now: () => 200,
      mutate: () => meta,
    });
    expect(set).toMatchObject({ sessionId: "sequence", acp: meta });
    expect(set?.updatedAt).toBeGreaterThan(100);
    expect(sequence).toEqual(["entry", "metadata"]);
    const stored = (await actor.sessions.read(authority, { sessionKey })).entry;
    expect(stored?.acp).toBeUndefined();
    const joined = await actor.acp.readEntry(target);
    expect(joined?.acp).toEqual(meta);
    expect(joined?.updatedAt).toBe(stored?.updatedAt);
    sequence.length = 0;
    expect(await actor.acp.upsertMeta({ ...target, mutate: () => undefined })).toMatchObject({
      acp: meta,
    });
    expect(sequence).toEqual([]);
    expect(await actor.acp.upsertMeta({ ...target, mutate: () => null })).toMatchObject({
      sessionId: "sequence",
    });
    expect(sequence).toEqual(["entry", "metadata"]);
    expect((await actor.acp.readEntry(target))?.acp).toBeUndefined();
    const linked = await actor.acp.upsertMeta({
      ...target,
      sessionKey: key("new-link"),
      mutate: () => meta,
    });
    expect(linked?.lifecycleRevision).toEqual(expect.any(String));
    expect((await actor.acp.readEntry({ ...target, sessionKey: key("new-link") }))?.acp).toEqual(
      meta,
    );
    expect(observe.queries).toEqual([]);
  } finally {
    observe.restore();
    sideData.mockRestore();
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
