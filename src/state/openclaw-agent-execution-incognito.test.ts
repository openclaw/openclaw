import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as workerStores from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getOpenClawAgentDatabaseIfOpen } from "./openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { IncognitoSessionEndedError } from "./openclaw-agent-execution-contract.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "./openclaw-agent-execution.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const references = new Set<IncognitoAgentDatabaseExecution>();
const authority = { assertCurrent() {} };
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
  await Promise.all([...references].map((reference) => reference.close()));
  references.clear();
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
  const released = reference.release();
  allowed = false;
  release.resolve();
  await Promise.all([first, rejected, last, released]);
  expect(order).toEqual(["first", "published", "last"]);
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
