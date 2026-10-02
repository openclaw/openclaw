import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AgentHarness } from "../agents/harness/types.js";
import { withSqliteSessionDeletions } from "../config/sessions/session-accessor.sqlite-deletion.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type {
  IncognitoLifecycleEntry,
  IncognitoLifecycleOperations,
} from "../config/sessions/session-incognito-lifecycle-contract.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
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
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-lifecycle-") };
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
      ([message]) =>
        isRecord(message) && message.type === "open" && message.databasePath === sentinel,
    );
    const worker: unknown = posted.mock.contexts[index];
    assert(worker instanceof Worker);
    lossWorker = worker;
  } finally {
    posted.mockRestore();
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
function withDeletion<T>(
  entries: IncognitoLifecycleEntry[],
  run: Parameters<typeof withSqliteSessionDeletions<T>>[2],
  agentId = "main",
) {
  return withSqliteSessionDeletions(
    { agentId, env, path: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }) },
    entries,
    run,
  );
}

function remove(
  target: IncognitoLifecycleEntry,
  reason: "deleted" | "reset" = "deleted",
  owner = actor,
  source = authority,
  capture?: Parameters<IncognitoAgentDatabaseExecution["sessions"]["lifecycle"]>[3],
): Promise<IncognitoLifecycleOperations["session.lifecycle.delete"]["output"]> {
  if (!capture) {
    return withDeletion([target], (assertCurrent, captured) =>
      remove(
        target,
        reason,
        owner,
        {
          assertCurrent() {
            assertCurrent();
            source.assertCurrent();
          },
          authorize(stage, facts) {
            return source.authorize?.(stage, facts);
          },
        },
        captured,
      ),
    );
  }
  return owner.sessions.lifecycle(
    source,
    {
      type: "session.lifecycle.delete",
      input: { target, reason, admissionIdentities: [] },
    },
    undefined,
    capture,
  );
}

function reclaim(
  plan: IncognitoLifecycleOperations["session.lifecycle.reclaim"]["input"]["plan"],
  owner = actor,
  agentId = "main",
) {
  return withDeletion(
    plan.entries.flatMap(({ sessionKey, expectedEntry }) =>
      expectedEntry ? [{ sessionKey, entry: expectedEntry }] : [],
    ),
    (assertCurrent, capture) =>
      owner.sessions.lifecycle(
        { assertCurrent },
        { type: "session.lifecycle.reclaim", input: { plan } },
        undefined,
        capture,
      ),
    agentId,
  );
}

it.each(["deleted", "reset"] as const)(
  "serializes %s with appends, preserves siblings, and executes zero caller-thread SQL",
  async (reason) => {
    const target = await create(`fifo-${reason}`);
    const sibling = await create(`sibling-${reason}`);
    const siblingClaim = actor.sessions.captureCurrent(sibling.sessionKey);
    const oldClaim = actor.sessions.captureCurrent(target.sessionKey);
    await withDeletion([target], async (assertCurrent, capture) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const held = actor.run(authority, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const sql = observeHostDataSql();
      const order: string[] = [];
      try {
        expect(() => remove(sibling, reason, actor, { assertCurrent }, capture)).toThrow(
          "Session mutation target was not prepared",
        );
        const before = append(target, "before deletion").then((value) => {
          order.push("append");
          return value;
        });
        const deletion = remove(
          target,
          reason,
          actor,
          {
            assertCurrent,
            authorize(stage) {
              if (stage === "transaction") {
                order.push("delete");
              }
            },
          },
          capture,
        );
        const after = append(target, "after deletion");
        release.resolve();
        const [appended, deleted, refused] = await Promise.all([before, deletion, after, held]);
        expect(appended.ok).toBe(true);
        expect(deleted).toMatchObject({
          deleted: true,
          archivedTranscripts: [],
          deletedSessionId: target.entry.sessionId,
        });
        expect(refused.ok).toBe(false);
        expect(order).toEqual(["append", "delete"]);
        expect(
          (await actor.sessions.read(authority, { sessionKey: target.sessionKey })).entry,
        ).toBeUndefined();
        expect(
          (await actor.sessions.read(authority, { sessionKey: sibling.sessionKey })).entry
            ?.sessionId,
        ).toBe(sibling.entry.sessionId);
        siblingClaim.assertCurrent();
        expect(() => oldClaim.assertCurrent()).toThrow("generation is no longer current");
        expect(sql.queries).toEqual([]);
      } finally {
        release.resolve();
        await held;
        sql.restore();
      }
    });
  },
);

it("forks the actor's checked transcript and preserves child lineage after deleting its parent", async () => {
  const parent = await create("fork-parent");
  const appended = await append(parent, "inherited answer");
  assert(appended.ok && appended.value.append);
  const prepare = () =>
    actor.sessions.lifecycle(authority, {
      type: "session.lifecycle.fork.prepare",
      input: { parent },
    });
  const prepared = await prepare();
  assert(prepared);
  const child = {
    sessionKey: "agent:main:dashboard:incognito-fork-child",
    entry: { ...parent.entry, sessionId: "fork-child" },
  };
  const extra = await append(parent, "new answer");
  assert(extra.ok && extra.value.append);
  await expect(
    actor.sessions.lifecycle(authority, {
      type: "session.lifecycle.fork",
      input: { parent: prepared, child },
    }),
  ).rejects.toThrow("source transcript changed");
  const fresh = await prepare();
  assert(fresh);
  const sql = observeHostDataSql();
  try {
    const fork = await captureOpenClawAgentDatabaseExecution.forkIncognitoSessionFromParent({
      source: actor,
      destination: actor,
      sourceAuthority: {
        assertCurrent() {},
        authorize(_stage, facts) {
          expect(facts.sessionKey).toBe(parent.sessionKey);
        },
      },
      destinationAuthority: {
        assertCurrent() {},
        authorize(_stage, facts) {
          expect(facts.sessionKey).toBe(child.sessionKey);
        },
      },
      parent,
      childSessionKey: child.sessionKey,
      supportsCliSessionFork: () => false,
      async buildEntry(parentEntry, current) {
        expect(parentEntry.sessionId).toBe(parent.entry.sessionId);
        expect(current).toBeUndefined();
        return child.entry;
      },
    });
    assert(fork);
    expect(fork).toMatchObject({
      sessionId: child.entry.sessionId,
      incognito: true,
      forkedFromParent: true,
      forkSource: { sessionKey: parent.sessionKey, sessionId: parent.entry.sessionId },
    });
    await remove(parent);
    const next = await append({ ...child, entry: fork }, "child answer");
    assert(next.ok && next.value.append);
    expect(next.value.append.effectiveParentId).toBe(extra.value.append.messageId);
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("settles source preparation before a cross-agent fork and rechecks source lifetime after callbacks", async () => {
  const parent = await create("cross-parent");
  const last = await append(parent, "cross-agent answer");
  assert(last.ok && last.value.append);
  const childSessionKey = "agent:loss:dashboard:incognito-cross-child";
  const fork = await captureOpenClawAgentDatabaseExecution.forkIncognitoSessionFromParent({
    source: actor,
    destination: lossActor,
    sourceAuthority: authority,
    destinationAuthority: authority,
    parent,
    childSessionKey,
    supportsCliSessionFork: () => false,
    async buildEntry() {
      // A callback can use either actor: it does not retain an SQL transaction or queue turn.
      await actor.sessions.read(authority, { sessionKey: parent.sessionKey });
      await lossActor.sessions.read(authority, { sessionKey: childSessionKey });
      return { ...parent.entry, sessionId: "cross-child" };
    },
  });
  assert(fork);
  await remove(parent);
  const next = await append(
    { sessionKey: childSessionKey, entry: fork },
    "child continues",
    lossActor,
  );
  assert(next.ok && next.value.append);
  expect(next.value.append.effectiveParentId).toBe(last.value.append.messageId);
  expect(fork.forkSource).toEqual({
    sessionKey: parent.sessionKey,
    sessionId: parent.entry.sessionId,
  });
  const revoked = await create("cross-revoked-parent");
  await expect(
    captureOpenClawAgentDatabaseExecution.forkIncognitoSessionFromParent({
      source: actor,
      destination: lossActor,
      sourceAuthority: authority,
      destinationAuthority: authority,
      parent: revoked,
      childSessionKey: "agent:loss:dashboard:incognito-refused-child",
      supportsCliSessionFork: () => false,
      async buildEntry() {
        await remove(revoked);
        return { ...revoked.entry, sessionId: "refused-child" };
      },
    }),
  ).rejects.toThrow("generation is no longer current");
  expect(
    (
      await lossActor.sessions.read(authority, {
        sessionKey: "agent:loss:dashboard:incognito-refused-child",
      })
    ).entry,
  ).toBeUndefined();
});

it.each(["denied", "revoked", "membership-revoked"] as const)(
  "rejects cross-agent forks when source permission is %s without retaining child data",
  async (mode) => {
    const parent = await create(`policy-${mode}-parent`);
    await append(parent, "private parent answer");
    const childName = `policy-${mode}-child`;
    const childSessionKey = `agent:loss:dashboard:incognito-${childName}`;
    let allowed = mode !== "denied";
    if (mode === "membership-revoked") {
      await actor.sessions.sideData(authority, {
        type: "session.sharing.add",
        input: {
          sessionKey: parent.sessionKey,
          params: { identityId: "viewer", addedBy: "owner", addedAt: 12_000 },
        },
      });
    }
    await expect(
      captureOpenClawAgentDatabaseExecution.forkIncognitoSessionFromParent({
        source: actor,
        destination: lossActor,
        sourceAuthority: {
          assertCurrent() {},
          authorize(_stage, facts) {
            expect(facts.identity).toEqual(actor.identity);
            expect(facts.sessionKey).toBe(parent.sessionKey);
            if (
              !allowed ||
              (mode === "membership-revoked" && !facts.sharing?.membership.has("viewer"))
            ) {
              throw new Error("source fork denied");
            }
          },
        },
        destinationAuthority: {
          assertCurrent() {},
          authorize(stage) {
            if (mode === "revoked" && stage === "transaction") {
              allowed = false;
            }
          },
        },
        parent,
        childSessionKey,
        supportsCliSessionFork: () => false,
        async buildEntry() {
          if (mode === "membership-revoked") {
            await actor.sessions.sideData(authority, {
              type: "session.sharing.remove",
              input: { sessionKey: parent.sessionKey, identityId: "viewer" },
            });
          }
          return { ...parent.entry, sessionId: childName };
        },
      }),
    ).rejects.toThrow("source fork denied");
    expect(
      (await lossActor.sessions.read(authority, { sessionKey: childSessionKey })).entry,
    ).toBeUndefined();
    // Creating the same session preserves any transcript rows that a failed fork leaked.
    const child = await create(childName, lossActor, "loss");
    const prepared = await lossActor.sessions.lifecycle(authority, {
      type: "session.lifecycle.fork.prepare",
      input: { parent: child },
    });
    assert(prepared);
    expect(prepared.source.branchEntries).toEqual([]);
  },
);

it.each([
  { side: "source", crossAgent: false },
  { side: "destination", crossAgent: false },
  { side: "source", crossAgent: true },
  { side: "destination", crossAgent: true },
] as const)(
  "refuses an asynchronous $side fork grant before committing (cross-agent: $crossAgent)",
  async ({ side, crossAgent }) => {
    const name = `async-${crossAgent ? "cross" : "same"}-${side}`;
    const parent = await create(`${name}-parent`);
    const destination = crossAgent ? lossActor : actor;
    const childSessionKey = `agent:${crossAgent ? "loss" : "main"}:dashboard:incognito-${name}-child`;
    const asynchronous: IncognitoSessionAuthority = {
      assertCurrent() {},
      // oxlint-disable-next-line typescript/no-misused-promises -- Prove asynchronous policies cannot obtain a synchronous native grant.
      authorize: async () => {},
    };
    await expect(
      captureOpenClawAgentDatabaseExecution.forkIncognitoSessionFromParent({
        source: actor,
        destination,
        sourceAuthority: side === "source" ? asynchronous : authority,
        destinationAuthority: side === "destination" ? asynchronous : authority,
        parent,
        childSessionKey,
        supportsCliSessionFork: () => false,
        async buildEntry() {
          return { ...parent.entry, sessionId: `${name}-child` };
        },
      }),
    ).rejects.toThrow("grants must remain synchronous");
    expect(
      (await destination.sessions.read(authority, { sessionKey: childSessionKey })).entry,
    ).toBeUndefined();
  },
);

it("rechecks reclamation snapshots and preserves sessions outside the selected lifecycle", async () => {
  const target = await create("reclaim-target");
  const sibling = await create("retained-reclaim-sibling");
  const prepare = () =>
    actor.sessions.lifecycle(authority, {
      type: "session.lifecycle.reclaim.prepare",
      input: {
        sessionKeySegmentPrefix: "dashboard:incognito-reclaim-",
        transcriptContentMarker: "synthetic cleanup",
        orphanTranscriptMinAgeMs: 0,
        nowMs: Date.now() + 86_400_000,
      },
    });
  const plan = await prepare();
  expect(plan.entries.map(({ sessionKey }) => sessionKey)).toEqual([target.sessionKey]);
  await append(target, "changed after plan");
  await expect(reclaim(plan)).rejects.toThrow("state changed before deletion");
  const sql = observeHostDataSql();
  try {
    const fresh = await prepare();
    expect(fresh.entries.map(({ sessionKey }) => sessionKey)).toEqual([target.sessionKey]);
    expect(await reclaim(fresh)).toEqual({ archivedTranscripts: [], removedEntries: 1 });
    expect(
      (await actor.sessions.read(authority, { sessionKey: sibling.sessionKey })).entry?.sessionId,
    ).toBe(sibling.entry.sessionId);
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it.each(["commit", "rollback", "actor loss"] as const)(
  "settles native companions after %s through the actor receipt",
  async (outcome) => {
    const owner = outcome === "actor loss" ? lossActor : actor;
    const agentId = outcome === "actor loss" ? "loss" : "main";
    const target = await create(`companion-${outcome.replaceAll(" ", "-")}`, owner, agentId);
    const oldPlan =
      outcome === "actor loss"
        ? await owner.sessions.lifecycle(authority, {
            type: "session.lifecycle.reclaim.prepare",
            input: {
              sessionKeySegmentPrefix: "dashboard:incognito-companion-",
              transcriptContentMarker: "synthetic",
              orphanTranscriptMinAgeMs: 0,
              nowMs: Date.now() + 86_400_000,
            },
          })
        : undefined;
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "native-owner" });
    const events: string[] = [];
    let present = true;
    let stopped: Promise<number> | undefined;
    const harness: AgentHarness = {
      id: "native-test",
      label: "Synthetic companion",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
      withSessionDeletion: async (params, run) =>
        run({
          commit() {
            params.assertCurrent();
            events.push("commit");
            present = false;
            if (outcome === "rollback") {
              throw new Error("synthetic companion failure");
            }
            if (outcome === "actor loss") {
              stopped = lossWorker.terminate();
              throw new Error("synthetic actor termination");
            }
          },
          rollback() {
            params.assertCurrent();
            events.push("rollback");
            present = true;
          },
        }),
    };
    registry.plugins.push(record);
    registry.agentHarnesses.push({ harness, pluginId: record.id, source: "runtime" });
    markPluginRegistryActive(registry);
    try {
      const operation = withPluginRuntimeRegistryScope(registry, () =>
        withSqliteSessionDeletions(
          { agentId, env, path: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }) },
          [target],
          (assertCurrent, capture) => remove(target, "deleted", owner, { assertCurrent }, capture),
        ),
      );
      if (outcome === "commit") {
        expect(await operation).toMatchObject({ deleted: true });
        expect(events).toEqual(["commit"]);
        expect(present).toBe(false);
      } else if (outcome === "rollback") {
        await expect(operation).rejects.toThrow("synthetic companion failure");
        expect(events).toEqual(["commit", "rollback"]);
        expect(present).toBe(true);
        expect(
          (await owner.sessions.read(authority, { sessionKey: target.sessionKey })).entry
            ?.sessionId,
        ).toBe(target.entry.sessionId);
      } else {
        await expect(operation).rejects.toMatchObject({ code: "INCOGNITO_SESSION_ENDED" });
        assert(stopped);
        await stopped;
        expect(events).toEqual(["commit"]);
        expect(present).toBe(false);
        expect(() => owner.assertCurrent()).toThrow("Incognito session ended");
        const successor = await captureOpenClawAgentDatabaseExecution({
          kind: "ephemeral",
          agentId,
          env,
          authority,
        });
        assert(successor && oldPlan);
        lossActor = successor;
        await create("companion-actor-loss", successor, agentId);
        await expect(reclaim(oldPlan, successor, agentId)).rejects.toThrow(
          "belongs to another actor",
        );
        expect(
          (await successor.sessions.read(authority, { sessionKey: target.sessionKey })).entry
            ?.sessionId,
        ).toBe(target.entry.sessionId);
      }
    } finally {
      markPluginRegistryRetired(registry);
    }
  },
);
