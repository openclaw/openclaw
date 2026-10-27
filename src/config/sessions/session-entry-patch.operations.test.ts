import "./session-entry-patch-delivery.test-support.js";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import * as transfer from "../../infra/sqlite-worker-transfer.js";
import { createAgentWorkerTestLoaders } from "../../state/openclaw-agent-execution-operations.test-support.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import { readConversation, registerConversationAddresses } from "./conversation-registry.js";
import { resolveConversationRouteFingerprint } from "./conversation-route-fingerprint.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  applySessionEntryOperation,
  patchSessionEntryCore,
  patchSessionEntryTarget,
  recordInboundSessionMeta,
  replaceSessionEntrySync,
  updateSessionLastRouteInScope,
} from "./session-accessor.sqlite-entry.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { withActor } from "./session-actor-worker.test-support.js";
import { createSessionCompoundWorkerFixture as fixture } from "./session-compound-worker.test-support.js";
import { readSessionEntryInWorker } from "./session-entry-read-runtime.js";
import { captureSessionEntrySourceAssertion } from "./session-entry-source-authority.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";
import type { SessionEntry } from "./types.js";

const { getSessionEntryPatchDelivery } =
  await import("./session-entry-patch-delivery.test-support.js");
const delivery = getSessionEntryPatchDelivery();
const withFixture = (run: (f: ReturnType<typeof fixture>) => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, () => run(fixture()));

it.each(["entry", "target"] as const)(
  "prepares %s callback patches from complete current owner facts without another entry reply",
  async (selection) => {
    await withFixture(async (f) => {
      const prompt = "synthetic retained instructions ".repeat(1024);
      replaceSessionEntrySync(f.scope, {
        ...f.read()!,
        skillsSnapshot: { prompt, skills: [] },
      });
      await readSessionEntryInWorker(f.scope);
      delivery.commands.length = 0;
      const update = (entry: SessionEntry) => {
        expect(entry.skillsSnapshot?.prompt).toBe(prompt);
        return { label: "prepared from published facts" };
      };
      const result =
        selection === "entry"
          ? await patchSessionEntryCore(f.scope, update, { workerGuard: {} })
          : await patchSessionEntryTarget({ ...f.scope, target: f.target }, update, {
              workerGuard: {},
            });
      expect(result).toMatchObject({
        label: "prepared from published facts",
        skillsSnapshot: { prompt },
      });
      expect(delivery.commands).toEqual(["session.entry.patch.commit"]);
      expect(f.read()).toEqual(result);
    });
  },
);

it("keeps multi-key target selection in the worker even when canonical facts are warm", async () => {
  await withFixture(async (f) => {
    const otherKey = "agent:main:other-worker";
    replaceSessionEntrySync(
      { ...f.scope, sessionKey: otherKey },
      {
        sessionId: "other",
        updatedAt: 1,
      },
    );
    await readSessionEntryInWorker(f.scope);
    delivery.commands.length = 0;
    const update = vi.fn(() => ({ label: "must not run" }));
    await expect(
      patchSessionEntryTarget(
        {
          ...f.scope,
          target: { canonicalKey: f.scope.sessionKey, storeKeys: [f.scope.sessionKey, otherKey] },
        },
        update,
        { workerGuard: {} },
      ),
    ).rejects.toThrow("duplicate rows resolve to canonical session key");
    expect(update).not.toHaveBeenCalled();
    expect(delivery.commands).toEqual(["session.entry.patch.prepare"]);
    expect(f.read()?.label).toBe("initial");
  });
});

it("accepts hydrated owner ordering but rejects a changed owner during callback patches", async () => {
  await withFixture(async (f) => {
    const owner = assignSessionOwner(f.scope, {
      owner: { type: "human", id: "synthetic-owner" },
      assignedBy: { type: "system", id: "synthetic-system" },
      assignedAt: 20,
    });
    await readSessionEntryInWorker(f.scope);
    await applySessionEntryOperation(
      f.scope,
      { kind: "fields", patch: { pinnedAt: 30 } },
      { skipMaintenance: true },
    );
    const result = await patchSessionEntryCore(
      f.scope,
      (entry) => {
        // Retained facts keep owner before new metadata; SQL hydration appends it last.
        const keys = Object.keys(entry);
        expect(keys.indexOf("owner")).toBeLessThan(keys.indexOf("pinnedAt"));
        return { label: "prepared with the same owner" };
      },
      { skipMaintenance: true, workerGuard: {} },
    );
    expect(result).toMatchObject({ label: "prepared with the same owner", pinnedAt: 30, owner });
    expect(f.read()).toEqual(result);

    delivery.beforeCommit = () => {
      delivery.beforeCommit = undefined;
      assignSessionOwner(f.scope, {
        owner: { type: "human", id: "replacement-owner" },
        assignedBy: { type: "system", id: "synthetic-system" },
        assignedAt: 40,
      });
    };
    await expect(
      patchSessionEntryCore(f.scope, () => ({ label: "stale owner patch" }), {
        skipMaintenance: true,
        workerGuard: {},
      }),
    ).rejects.toBeInstanceOf(SqliteSessionMutationConflictError);
    expect(f.read()).toMatchObject({
      label: "prepared with the same owner",
      owner: { actor: { type: "human", id: "replacement-owner" }, assignedAt: 40 },
    });
  });
});

it("keeps resident SQL metadata out of callback patch preparation and commit bytes", async () => {
  await withActor(async (f) => {
    const prompt = "synthetic tool instructions ".repeat(400);
    const label = "synthetic session title ".repeat(400);
    f.writeEntry({ ...f.nativeEntry()!, label, skillsSnapshot: { prompt, skills: [] } });
    f.read();
    const context: AgentWorkerOperationContext = {
      options: { agentId: f.database.agentId, path: f.database.path },
      open: () => f.database,
      admit() {},
      writeTransaction: (_operation, _owner, write) =>
        runSqliteImmediateTransactionSync(f.database.db, () => write(f.database)),
    };
    const operations = await createAgentWorkerTestLoaders(context)["session.entry.patch.prepare"]();
    const selection = { kind: "entry" as const, sessionKey: f.target.sessionKey, exact: true };
    const prepared = structuredClone(operations["session.entry.patch.prepare"](selection, context));
    const writeBase = prepared[0]!.entry;
    const input = {
      selection,
      prepared,
      sessionKey: f.target.sessionKey,
      writeBase,
      next: { ...writeBase, label: "small patch" },
      operationLabel: "session-entry.patch" as const,
      validateCanonicalKeys: true,
    };
    // The logical preimage is required for CAS; its duplicate SQL JSON is not.
    const logicalEntryBudget = Buffer.byteLength(prompt) + Buffer.byteLength(label) + 4_096;
    expect(serialize(prepared).byteLength).toBeLessThan(logicalEntryBudget);
    expect(serialize(input).byteLength).toBeLessThan(logicalEntryBudget);
    f.patchEntry(structuredClone(input));
    expect(f.nativeEntry()).toMatchObject({
      label: "small patch",
      skillsSnapshot: { prompt, skills: [] },
    });
  });
});

async function conversationGuard(f: ReturnType<typeof fixture>, peerId: string) {
  const identity = buildConversationIdentity({
    channel: "reef",
    accountId: "default",
    kind: "direct",
    peerId,
    deliveryTarget: `user:${peerId}`,
  })!;
  await registerConversationAddresses(f.scope, [identity]);
  const conversation = (await readConversation(f.scope, identity.conversationRef))!;
  return {
    conversationRef: identity.conversationRef,
    expectedRouteFingerprint: resolveConversationRouteFingerprint(conversation),
  };
}

function replaceRouteBeforeCommit(f: ReturnType<typeof fixture>, conversationRef: string) {
  delivery.beforeCommit = () => {
    delivery.beforeCommit = undefined;
    const foreign = new (requireNodeSqlite().DatabaseSync)(f.database.path);
    try {
      foreign
        .prepare("UPDATE conversations SET delivery_target = ? WHERE conversation_id = ?")
        .run("user:replacement", conversationRef);
    } finally {
      foreign.close();
    }
  };
}

it.each(["inbound", "route"] as const)(
  "merges %s metadata with an in-process write without a detached comparison read",
  async (kind) => {
    await withFixture(async (f) => {
      const original = f.read()!;
      delivery.beforeCommit = () => {
        delivery.beforeCommit = undefined;
        replaceSessionEntrySync(f.scope, {
          ...original,
          label: "concurrent label",
          updatedAt: original.updatedAt + 100,
          delivery: {
            kind: "external",
            route: {
              channel: "reef",
              target: { to: "user:existing" },
              thread: { id: "old-thread" },
            },
            context: { channel: "reef", to: "user:existing", threadId: "old-thread" },
            origin: { provider: "reef", to: "user:existing", threadId: "old-thread" },
          },
        });
      };
      const ctx = { Provider: "reef", From: "reef:alice", ChatType: "direct", SenderName: "Alice" };
      const result =
        kind === "inbound"
          ? await recordInboundSessionMeta({ ...f.scope, ctx })
          : await updateSessionLastRouteInScope(f.scope, {
              channel: "reef",
              to: "user:alice",
              ctx,
            });
      expect(result).toMatchObject({
        label: "concurrent label",
        updatedAt: original.updatedAt + 100,
        delivery: { origin: { label: "Alice" } },
      });
      expect(f.read()).toEqual(result);
      expect(delivery.commands).toEqual(["session.entry.patch.commit"]);
    });
  },
);

it("reduces a fixed patch against the current row in one worker request without losing foreign metadata", async () => {
  await withFixture(async (f) => {
    const original = f.read()!;
    delivery.beforeCommit = () => {
      delivery.beforeCommit = undefined;
      replaceSessionEntrySync(f.scope, { ...original, compactionCount: 4, label: "foreign edit" });
    };
    const published: SessionEntry[] = [];
    const result = await applySessionEntryOperation(
      f.scope,
      {
        kind: "compaction-accounting",
        expected: {
          sessionId: original.sessionId,
          lifecycleRevision: original.lifecycleRevision,
          activeWriterRunId: original.activeWriterRunId,
        },
        accounting: { amount: 2, tokensAfter: 123 },
      },
      { skipMaintenance: true, onCommitted: (entry) => published.push(entry) },
    );
    expect(delivery.commands.length).toBeLessThanOrEqual(1);
    expect(result).toMatchObject({ compactionCount: 6, totalTokens: 123, label: "foreign edit" });
    expect(f.read()).toEqual(result);
    expect(published).toEqual([result]);

    const current = f.read()!;
    for (const expected of [
      { sessionId: "retired" },
      { sessionId: current.sessionId, lifecycleRevision: "retired" },
      { sessionId: current.sessionId, activeWriterRunId: "retired" },
    ]) {
      const unchanged = await applySessionEntryOperation(
        f.scope,
        { kind: "compaction-accounting", expected, accounting: { amount: 10 } },
        { skipMaintenance: true, onCommitted: (entry) => published.push(entry) },
      );
      expect(unchanged).toEqual(current);
      expect(f.read()).toEqual(current);
    }
    expect(published).toEqual([result]);
  });
});

it("acknowledges no-result patches without transferring the entry and keeps final authority", async () => {
  await withFixture(async (f) => {
    const prompt = "synthetic instructions ".repeat(4096);
    replaceSessionEntrySync(f.scope, {
      ...f.read()!,
      skillsSnapshot: { prompt, skills: [] },
    });
    const deliveredBytes: number[] = [];
    const collect = transfer.createSqliteWorkerTransferCollector;
    vi.spyOn(transfer, "createSqliteWorkerTransferCollector").mockImplementation((kind, consume) =>
      collect(kind, (value) => {
        deliveredBytes.push(serialize(value).byteLength);
        consume(value);
      }),
    );
    const operation = {
      kind: "fields" as const,
      expected: { sessionId: "retired" },
      patch: { label: "must not apply" },
    };
    const result = await applySessionEntryOperation(f.scope, operation, { skipMaintenance: true });
    expect(result).toMatchObject({ label: "initial", skillsSnapshot: { prompt } });
    expect(deliveredBytes.at(-1)).toBeGreaterThan(prompt.length);
    result!.skillsSnapshot!.prompt = "caller-owned change";
    expect(f.read()?.skillsSnapshot?.prompt).toBe(prompt);

    await expect(
      applySessionEntryOperation(f.scope, operation, { result: "none", skipMaintenance: true }),
    ).resolves.toBeUndefined();
    expect(deliveredBytes.at(-1)).toBeLessThan(1024);
    expect(f.read()).toMatchObject({ label: "initial", skillsSnapshot: { prompt } });

    const onCommitted = vi.fn();
    await expect(
      applySessionEntryOperation(
        f.scope,
        { kind: "fields", patch: { label: "observed" } },
        { result: "none", skipMaintenance: true, onCommitted },
      ),
    ).resolves.toBeUndefined();
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ label: "observed", skillsSnapshot: { prompt, skills: [] } }),
    );

    let current = true;
    const refused = new Error("patch authority revoked before commit");
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) =>
        createAdmission((request, grant) => {
          if (
            request.stage === "commit" &&
            isRecord(request.facts) &&
            isRecord(request.facts.publication) &&
            request.facts.publication.kind === "session-entry-patch-committed"
          ) {
            current = false;
          }
          callback(request, grant);
        }, attachment),
    );
    await expect(
      applySessionEntryOperation(f.scope, operation, {
        result: "none",
        skipMaintenance: true,
        workerGuard: {
          assertMutationAllowed() {
            if (!current) {
              throw refused;
            }
          },
        },
      }),
    ).rejects.toBe(refused);
    expect(current).toBe(false);
    expect(f.read()).toMatchObject({ label: "observed", skillsSnapshot: { prompt } });
  });
});

it("reuses unchanged resident entry fields across patches without losing result isolation or newer writes", async () => {
  await withFixture(async (f) => {
    const prompt = "synthetic retained instructions ".repeat(4096);
    const skills = [{ name: "synthetic-skill", requiredEnv: ["SYNTHETIC_REQUIRED"] }];
    replaceSessionEntrySync(f.scope, {
      ...f.read()!,
      skillsSnapshot: { prompt, skills },
      pinnedAt: 20,
    });
    await applySessionEntryOperation(
      f.scope,
      { kind: "fields", patch: { label: "warm" } },
      { result: "none", skipMaintenance: true },
    );
    const deliveredBytes: number[] = [];
    const collect = transfer.createSqliteWorkerTransferCollector;
    vi.spyOn(transfer, "createSqliteWorkerTransferCollector").mockImplementation((kind, consume) =>
      collect(kind, (value) => {
        deliveredBytes.push(serialize(value).byteLength);
        consume(value);
      }),
    );
    const result = await applySessionEntryOperation(
      f.scope,
      { kind: "fields", patch: { label: "changed", pinnedAt: undefined } },
      { skipMaintenance: true },
    );
    expect(result).toMatchObject({ label: "changed", skillsSnapshot: { prompt, skills } });
    expect(result?.pinnedAt).toBeUndefined();
    expect(deliveredBytes.at(-1)).toBeLessThan(prompt.length / 4);
    const resident = await readSessionEntryInWorker(f.scope);
    expect(result!.skillsSnapshot).toBe(resident!.skillsSnapshot);
    result!.label = "caller-owned";
    expect(Reflect.set(result!.skillsSnapshot!, "prompt", "caller-owned")).toBe(false);
    expect(Reflect.set(result!.skillsSnapshot!.skills[0]!, "name", "caller-mutated")).toBe(false);
    expect(() => result!.skillsSnapshot!.skills[0]!.requiredEnv!.push("CALLER_ADDED")).toThrow();
    expect(() => result!.skillsSnapshot!.skills.push({ name: "caller-added" })).toThrow();
    expect((await readSessionEntryInWorker(f.scope))?.label).toBe("changed");
    const next = await applySessionEntryOperation(
      f.scope,
      { kind: "fields", patch: { label: "next" } },
      { skipMaintenance: true },
    );
    expect(next?.skillsSnapshot).toMatchObject({ prompt, skills });
    expect(deliveredBytes.at(-1)).toBeLessThan(prompt.length / 4);
    delivery.beforeCommit = () => {
      delivery.beforeCommit = undefined;
      replaceSessionEntrySync(f.scope, {
        ...f.read()!,
        skillsSnapshot: { prompt: "newer persisted instructions", skills: [] },
      });
    };
    const latest = await applySessionEntryOperation(
      f.scope,
      { kind: "fields", patch: { label: "after concurrent write" } },
      { skipMaintenance: true },
    );
    expect(latest?.skillsSnapshot?.prompt).toBe("newer persisted instructions");
    expect(f.read()).toEqual(latest);
  });
});

it("commits cron state in one request while preserving concurrent metadata and cleared policy", async () => {
  await withFixture(async (f) => {
    const initial: SessionEntry = {
      ...f.read()!,
      lifecycleRevision: "admitted",
      elevatedLevel: "full",
      inheritedToolAllow: ["exec"],
      sendPolicy: "allow",
    };
    replaceSessionEntrySync(f.scope, initial);
    delivery.beforeCommit = () => {
      delivery.beforeCommit = undefined;
      const current: SessionEntry = {
        ...initial,
        label: "Renamed during the run",
        pinnedAt: 20,
        updatedAt: 20,
        sendPolicy: "deny",
      };
      delete current.elevatedLevel;
      delete current.inheritedToolAllow;
      replaceSessionEntrySync(f.scope, current);
    };
    const result = await applySessionEntryOperation(
      f.scope,
      {
        kind: "cron-session",
        sessionKey: f.scope.sessionKey,
        initial,
        next: { ...initial, status: "done", totalTokens: 42, updatedAt: 10 },
        creation: { createdVia: "cron", createdAt: 10 },
      },
      { replaceEntry: true, skipMaintenance: true },
    );
    expect(result).toMatchObject({
      label: "Renamed during the run",
      pinnedAt: 20,
      updatedAt: 20,
      sendPolicy: "deny",
      status: "done",
      totalTokens: 42,
    });
    expect(result?.elevatedLevel).toBeUndefined();
    expect(result?.inheritedToolAllow).toBeUndefined();
    expect(f.read()).toEqual(result);
    expect(delivery.commands).toEqual(["session.entry.patch.commit"]);
  });
});

it("creates the full initial cron session in one owner command", async () => {
  await withFixture(async (f) => {
    const scope = {
      ...f.scope,
      sessionKey: "agent:main:cron:created",
      sessionId: "cron-created",
    };
    const next: SessionEntry = {
      sessionId: "cron-created",
      updatedAt: 20,
      label: "Cron: initial state",
      lifecycleRevision: "admitted",
      thinkingLevel: "high",
      modelProvider: "openai",
      model: "gpt-5.4",
    };
    const result = await applySessionEntryOperation(
      scope,
      {
        kind: "cron-session",
        sessionKey: scope.sessionKey,
        next,
        creation: { createdVia: "cron", createdActor: { type: "system" }, createdAt: 10 },
      },
      { fallbackEntry: next, replaceEntry: true, skipMaintenance: true },
    );
    expect(result).toMatchObject({
      ...next,
      createdVia: "cron",
      createdActor: { type: "system" },
      createdAt: 10,
    });
    expect(readExactSessionEntryRow(f.database, scope.sessionKey)?.entry).toEqual(result);
    expect(delivery.commands).toEqual(["session.entry.patch.commit"]);
  });
});

it("rechecks conversation authority before a fixed patch commits", async () => {
  await withFixture(async (f) => {
    const conversation = await conversationGuard(f, "patch-peer");
    const workerGuard = { conversation };
    const onCommitted = vi.fn();
    const accepted = await applySessionEntryOperation(
      f.scope,
      { kind: "fields", patch: { label: "authorized" } },
      { skipMaintenance: true, workerGuard, onCommitted },
    );
    expect(accepted).toMatchObject({ label: "authorized" });
    expect(f.read()).toEqual(accepted);
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(accepted);
    onCommitted.mockClear();

    replaceRouteBeforeCommit(f, conversation.conversationRef);
    await expect(
      applySessionEntryOperation(
        f.scope,
        { kind: "fields", patch: { label: "must not persist" } },
        { skipMaintenance: true, workerGuard, onCommitted },
      ),
    ).rejects.toThrow("Conversation is no longer available");
    expect(f.read()).toEqual(accepted);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(await readConversation(f.scope, conversation.conversationRef)).toMatchObject({
      target: "user:replacement",
    });
  });
});

it("retains typed source and conversation authority when updating the last route", async () => {
  await withFixture(async (f) => {
    const conversation = await conversationGuard(f, "route-peer");
    let sourceCurrent = true;
    const refusal = new Error("route source was revoked");
    const source = captureSessionEntrySourceAssertion({
      scope: f.scope,
      expected: f.read(),
      fields: ["sessionId"],
      assertCurrent() {
        throw new Error("typed route source must use its prepared authority");
      },
      assertHostCurrent() {
        if (!sourceCurrent) {
          throw refusal;
        }
      },
      refuse() {
        throw refusal;
      },
    });
    const updateRoute = () =>
      updateSessionLastRouteInScope(f.scope, {
        channel: "reef",
        to: "user:route-peer",
        assertCommitAllowed: source,
        workerGuard: { conversation },
      });
    const accepted = await updateRoute();
    expect(accepted).toMatchObject({
      delivery: { route: { channel: "reef", target: { to: "user:route-peer" } } },
    });

    sourceCurrent = false;
    await expect(updateRoute()).rejects.toBe(refusal);
    expect(f.read()).toEqual(accepted);
    sourceCurrent = true;
    replaceRouteBeforeCommit(f, conversation.conversationRef);
    await expect(updateRoute()).rejects.toThrow("Conversation is no longer available");
    expect(f.read()).toEqual(accepted);
  });
});
