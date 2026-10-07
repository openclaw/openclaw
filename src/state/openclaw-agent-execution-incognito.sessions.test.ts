import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSubagentControllerRead } from "../agents/subagents/registry/subagent-controller-read.js";
import { loadCombinedSessionStoreForGatewayCoreAsync } from "../config/sessions/combined-store-gateway-read.js";
import { createSessionEntryWithTranscript } from "../config/sessions/session-accessor.entry-mutation.js";
import {
  readResolvedSessionEntryInWorker,
  resolveSessionEntryCandidateTargetForRuntime,
} from "../config/sessions/session-accessor.entry.js";
import { loadSessionEntryForAdmission } from "../config/sessions/session-accessor.sqlite-entry-admission.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { SessionCanonicalKeyMigrationRequiredError } from "../config/sessions/session-canonical-key-error.js";
import { prepareSessionDeliveryGeneration } from "../config/sessions/session-delivery-generation.js";
import {
  captureNativeSessionEntryCurrentRead,
  captureSessionEntryCurrentRead,
} from "../config/sessions/session-entry-current-runtime.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { readPlacementSessionIdentityEvidence } from "../config/sessions/session-placement-evidence.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createBoardWidgetApprovalResolver } from "../gateway/board-widget-approval.js";
import { createPresenceRecipientProjection } from "../gateway/presence-projection.js";
import type { GatewayClient } from "../gateway/server-methods/types.js";
import { prepareGatewaySessionLifecycleTargets } from "../gateway/session-lifecycle-preparation.js";
import { prepareSessionMutationFacts } from "../gateway/session-sharing-preparation.js";
import { createCompletionGrantLineageAdmission } from "../gateway/tool-resolution-completion.js";
import * as execApprovalsStore from "../infra/exec-approvals-store.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { readAgentDatabaseDeletionSnapshot } from "./agent-deletion-journal.read.js";
import { getOpenClawAgentDatabaseIfOpen } from "./openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "./openclaw-agent-write-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const references = new Set<IncognitoAgentDatabaseExecution>();
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
const DAY_MS = 24 * 60 * 60_000;
const reviewWidget = vi.hoisted(() => vi.fn());
// mock-isolation: Keep model/provider startup outside this SQLite ownership fixture.
vi.mock("../agents/exec-auto-reviewer.js", () => ({
  createModelExecAutoReviewer: () => reviewWidget,
}));
let env: NodeJS.ProcessEnv;
let actor: IncognitoAgentDatabaseExecution;

async function capture(agentId = "main", environment = env, existingOnly = false) {
  const reference = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId,
    env: environment,
    authority,
    existingOnly,
  });
  if (reference) {
    references.add(reference);
  }
  return reference;
}

function key(name: string, agentId = "main") {
  return `agent:${agentId}:dashboard:incognito-${name}`;
}

function entry(sessionId: string, createdAt = 10_000) {
  return {
    sessionId,
    createdAt,
    updatedAt: createdAt,
    incognito: true as const,
    lifecycleRevision: "initial",
    label: `Private label ${sessionId}`,
  };
}

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-session-actor-") };
  const opened = await capture();
  assert(opened);
  actor = opened;
});

afterEach(async () => {
  for (const reference of references) {
    if (reference === actor) {
      continue;
    }
    if (reference.identity.incarnation === actor.identity.incarnation) {
      await reference.release();
    } else {
      await reference.close();
    }
    references.delete(reference);
  }
});

afterAll(async () => {
  await Promise.all([...references].map((reference) => reference.close()));
});

it("reads existing actor sessions without creating missing stores or crossing namespaces", async () => {
  const foreignEnv = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-session-foreign-") };
  expect(await capture("main", foreignEnv, true)).toBeUndefined();
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(foreignEnv)).toEqual([]);
  expect(fs.readdirSync(foreignEnv.OPENCLAW_STATE_DIR)).toEqual([]);
  const sessionKey = key("identity");
  const missing = await actor.sessions.read(authority, { sessionKey });
  expect(missing.entry).toBeUndefined();
  expect(actor.sessions.readSharing(sessionKey)).toBeUndefined();
  const created = await actor.sessions.create(authority, {
    sessionKey,
    entry: entry("identity"),
  });
  expect(created.entry).toMatchObject(entry("identity"));
  expect(() => missing.claim.assertCurrent()).toThrow("generation is no longer current");
  const read = await actor.sessions.read(authority, {
    sessionKey,
    expected: { sessionId: "identity", lifecycleRevision: "initial" },
  });
  expect(read.entry).toEqual(created.entry);
  await expect(
    actor.sessions.read(authority, {
      sessionKey,
      expected: { sessionId: "identity", lifecycleRevision: "replaced" },
    }),
  ).rejects.toThrow("generation is no longer current");
  const foreignRead = actor.sessions.read(authority, { sessionKey: key("identity", "sibling") });
  await expect(foreignRead).rejects.toBeInstanceOf(SessionCanonicalKeyMigrationRequiredError);
  await expect(foreignRead).rejects.toThrow("refusing non-canonical session key");
  await expect(
    actor.sessions.create(authority, {
      sessionKey: "agent:main:dashboard:ordinary",
      entry: entry("ordinary"),
    }),
  ).rejects.toThrow("incognito session key");
  const sibling = await capture("sibling");
  assert(sibling);
  try {
    const localStores = captureOpenClawAgentDatabaseExecution.listIncognito(env);
    expect(localStores.map((store) => store.agentId).toSorted()).toEqual(["main", "sibling"]);
    expect(localStores.find((store) => store.agentId === "main")?.identity).toEqual(actor.identity);
    expect(
      (await sibling.sessions.read(authority, { sessionKey: key("identity", "sibling") })).entry,
    ).toBeUndefined();
  } finally {
    await sibling.close();
  }
  const foreign = await capture("main", foreignEnv);
  assert(foreign);
  try {
    expect(
      captureOpenClawAgentDatabaseExecution
        .listIncognito(foreignEnv)
        .map((store) => store.identity),
    ).toEqual([foreign.identity]);
    expect((await foreign.sessions.read(authority, { sessionKey })).entry).toBeUndefined();
  } finally {
    await foreign.close();
  }
  expect(
    getOpenClawAgentDatabaseIfOpen({
      agentId: "main",
      env,
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
    }),
  ).toBeUndefined();
  expect(fs.readdirSync(env.OPENCLAW_STATE_DIR!, { recursive: true })).toEqual([]);
  expect(fs.readdirSync(foreignEnv.OPENCLAW_STATE_DIR, { recursive: true })).toEqual([]);
});

it("withholds staged sharing from grants and publishes detached facts before its caller resumes", async () => {
  const sessionKey = key("publication");
  const stages: string[] = [];
  const source: IncognitoSessionAuthority = {
    assertCurrent() {},
    authorize(stage, facts) {
      stages.push(stage);
      expect(() => actor.sessions.readSharing(sessionKey)).toThrow("pending or unavailable");
      expect(() => actor.sessions.captureCurrent(sessionKey)).toThrow("pending or unavailable");
      expect(() => actor.sessions.read(authority, { sessionKey })).toThrow(
        "Incognito authority callbacks cannot call their actor",
      );
      expect(() =>
        actor.run(authority, (scope) =>
          scope.execute({ type: "database.incognito.memory", input: undefined }),
        ),
      ).toThrow("Incognito authority callbacks cannot call their actor");
      expect(facts.sharing?.entry?.sessionId).toBe(stage === "commit" ? "publication" : undefined);
    },
  };
  const created = await actor.sessions.create(source, { sessionKey, entry: entry("publication") });
  expect(stages).toEqual(["transaction", "commit"]);
  created.claim.assertCurrent();
  const sharing = actor.sessions.readSharing(sessionKey);
  expect(sharing?.entry).toMatchObject({ sessionId: "publication", incognito: true });
  expect(sharing?.entry).not.toHaveProperty("label");
  expect(sharing?.membership.size).toBe(0);
  assert(sharing?.entry && created.entry);
  sharing.entry.sessionId = "mutated caller snapshot";
  created.entry.label = "mutated full read";
  expect(actor.sessions.readSharing(sessionKey)?.entry?.sessionId).toBe("publication");
  expect((await actor.sessions.read(authority, { sessionKey })).entry?.label).toBe(
    "Private label publication",
  );
  created.claim.assertCurrent();
});

it("authorizes controller policy from transaction facts while its actor projection is pending", async () => {
  const sessionKey = "agent:main:subagent:incognito-controller";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { ...entry("controller"), spawnDepth: 1 },
  });
  const cfg = { agents: { entries: { main: {} }, defaults: { subagents: { maxSpawnDepth: 2 } } } };
  const controller = createSubagentControllerRead({
    config: () => cfg,
    agentSessionKey: sessionKey,
    agentId: "main",
    assertCurrent() {},
    incognito: () => actor,
  });
  const stages: string[] = [];
  const sql = observeMainThreadSql();
  try {
    await controller.prepare();
    expect(controller.read().controlScope).toBe("children");
    await actor.sessions.sideData(
      {
        assertCurrent: controller.assertCurrent,
        authorize(stage, facts) {
          stages.push(stage);
          expect(() => controller.read()).toThrow("pending or unavailable");
          expect(controller.read([facts]).controlScope).toBe("children");
          expect(() =>
            controller.read([
              { ...facts, identity: { ...facts.identity, incarnation: "foreign" } },
            ]),
          ).toThrow("Session access facts are unavailable");
          cfg.agents.defaults.subagents.maxSpawnDepth = 1;
          expect(controller.read([facts]).controlScope).toBe("none");
          cfg.agents.defaults.subagents.maxSpawnDepth = 2;
        },
      },
      {
        type: "session.sharing.add",
        input: { sessionKey, params: { identityId: "viewer", addedBy: "owner" } },
      },
    );
    expect(stages).toEqual(["transaction", "commit"]);
    expect(actor.sessions.readSharing(sessionKey)?.membership.has("viewer")).toBe(true);
    controller.read();
    sql.expectIdle();
  } finally {
    sql.restore();
    controller.release();
  }
});

it.each(["policy", "reviewer"] as const)(
  "refuses a board assessment when actor facts change during its %s wait",
  async (wait) => {
    const sessionKey = key(`board-${wait}`);
    const read = await actor.sessions.create(authority, {
      sessionKey,
      entry: { ...entry(`board-${wait}`), permissionMode: "workspace" },
    });
    const prepared = {
      agentId: "main",
      ...read,
      snapshot: actor.sessions.captureSnapshot(sessionKey),
    };
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const policyRead = vi
      .spyOn(execApprovalsStore, "readExecApprovalsPolicyReadOnlyAsync")
      .mockImplementation(async () => {
        if (wait === "policy") {
          entered.resolve();
          await resume.promise;
        }
        return { file: { version: 1 }, revision: "synthetic-policy" };
      });
    reviewWidget.mockImplementation(async () => {
      entered.resolve();
      await resume.promise;
      return { decision: "allow-once", risk: "low", rationale: "synthetic widget" };
    });
    const sql = observeMainThreadSql();
    try {
      const result = createBoardWidgetApprovalResolver()({
        cfg: { agents: { entries: { main: {} } }, tools: { exec: { mode: "auto" } } },
        agentId: "main",
        sessionKey,
        name: "synthetic",
        content: { kind: "html", html: "<p>synthetic</p>" },
        declared: { tools: ["health"] },
        incognitoSession: prepared,
      });
      const rejected = expect(result).rejects.toThrow("Incognito session snapshot changed");
      await entered.promise;
      await actor.sessions.sideData(authority, {
        type: "session.sharing.add",
        input: { sessionKey, params: { identityId: "viewer", addedBy: "owner" } },
      });
      prepared.claim.assertCurrent();
      resume.resolve();
      await rejected;
      sql.expectIdle();
    } finally {
      resume.resolve();
      sql.restore();
      policyRead.mockRestore();
      reviewWidget.mockReset();
    }
  },
);

it("serializes reads, creation, publication, and queued revocation in the actor FIFO", async () => {
  const borrower = await capture();
  assert(borrower);
  const sessionKey = key("fifo");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = actor.run(authority, async (scope) => {
    entered.resolve();
    await release.promise;
    await scope.execute({ type: "database.incognito.memory", input: undefined });
  });
  await entered.promise;
  let allowed = true;
  const source: IncognitoSessionAuthority = {
    assertCurrent() {
      if (!allowed) {
        throw new Error("queued session authority revoked");
      }
    },
  };
  const before = actor.sessions.read(authority, { sessionKey });
  const rejected = expect(
    actor.sessions.create(source, {
      sessionKey: key("revoked"),
      entry: entry("revoked"),
    }),
  ).rejects.toThrow("queued session authority revoked");
  const input = { sessionKey, entry: entry("fifo") };
  const creating = borrower.sessions.create(authority, input);
  const releasing = borrower.release();
  input.entry.sessionId = "caller changed after enqueue";
  const after = actor.sessions.read(authority, { sessionKey });
  allowed = false;
  release.resolve();
  const [, initial, , created, final] = await Promise.all([
    held,
    before,
    rejected,
    creating,
    after,
    releasing,
  ]);
  expect(initial.entry).toBeUndefined();
  expect(created.entry?.sessionId).toBe("fifo");
  expect(final.entry?.sessionId).toBe("fifo");
  expect(() => initial.claim.assertCurrent()).toThrow("generation is no longer current");
  final.claim.assertCurrent();
  expect(
    (await actor.sessions.read(authority, { sessionKey: key("revoked") })).entry,
  ).toBeUndefined();
});

it.each(["transaction", "commit"] as const)(
  "rolls creation back when live authority is revoked at the %s grant",
  async (revokedStage) => {
    const sessionKey = key(`refused-${revokedStage}`);
    let allowed = true;
    const reached: string[] = [];
    const source: IncognitoSessionAuthority = {
      assertCurrent() {
        if (!allowed) {
          throw new Error(`revoked at ${revokedStage}`);
        }
      },
      authorize(stage) {
        reached.push(stage);
        if (stage === revokedStage) {
          allowed = false;
        }
      },
    };
    await expect(
      actor.sessions.create(source, {
        sessionKey,
        entry: entry(`refused-${revokedStage}`),
      }),
    ).rejects.toThrow(`revoked at ${revokedStage}`);
    expect(reached).toEqual(
      revokedStage === "transaction" ? ["transaction"] : ["transaction", "commit"],
    );
    expect(actor.sessions.readSharing(sessionKey)).toBeUndefined();
    expect((await actor.sessions.read(authority, { sessionKey })).entry).toBeUndefined();
    expect(actor.sessions.deadlines().some((deadline) => deadline.sessionKey === sessionKey)).toBe(
      false,
    );
  },
);

it.each(["lost reply", "lost receipt", "revoked disclosure"] as const)(
  "settles creation without replay after %s",
  async (fault) => {
    const sessionKey = key(fault.replaceAll(" ", "-"));
    let allowed = true;
    let executed = 0;
    const source: IncognitoSessionAuthority = {
      assertCurrent() {
        if (!allowed) {
          throw new Error("disclosure revoked");
        }
      },
    };
    const original = workerStore.runSqliteWorkerStoreOperation;
    let receiptFault: { mockRestore(): void } | undefined;
    const observer = vi
      .spyOn(workerStore, "runSqliteWorkerStoreOperation")
      .mockImplementation(
        <Operations extends SqliteWorkerOperations, T>(
          target: SqliteWorkerStore<Operations>,
          operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
          stateContext?: Parameters<typeof original>[2],
          assertCurrent?: Parameters<typeof original>[3],
          createAdmission?: Parameters<typeof original>[4],
        ) => {
          let native: SqliteWorkerOperationAdmission | undefined;
          return original(
            target,
            (worker) =>
              operation({
                execute: async (command, options) => {
                  const result = await worker.execute(command, options);
                  if (command.type !== "session.entry.create") {
                    return result;
                  }
                  executed++;
                  expect(native?.committed).toMatchObject({ facts: [{ sessionKey }] });
                  expect(native?.settlement?.kind).toBe("completed");
                  if (fault === "revoked disclosure") {
                    allowed = false;
                    return result;
                  }
                  if (fault === "lost receipt") {
                    assert(native);
                    receiptFault = vi.spyOn(native, "committed", "get").mockReturnValue(undefined);
                  }
                  throw new Error("reply delivery failed");
                },
              }),
            stateContext,
            assertCurrent,
            createAdmission &&
              ((retained) => {
                const admitted = createAdmission({
                  settled: retained.settled.then((settlement) =>
                    fault === "lost reply"
                      ? { kind: "unknown" as const, error: new Error("reply delivery failed") }
                      : settlement,
                  ),
                });
                native = admitted.admission;
                return admitted;
              }),
          );
        },
      );
    try {
      await expect(
        actor.sessions.create(source, { sessionKey, entry: entry(fault) }),
      ).rejects.toThrow(
        fault === "revoked disclosure"
          ? "disclosure revoked"
          : fault === "lost receipt"
            ? "no confirmed commit receipt"
            : "reply delivery failed",
      );
      expect(executed).toBe(1);
      if (fault === "lost receipt") {
        expect(() => actor.sessions.readSharing(sessionKey)).toThrow("pending or unavailable");
      } else {
        expect(actor.sessions.readSharing(sessionKey)?.entry?.sessionId).toBe(fault);
      }
    } finally {
      receiptFault?.mockRestore();
      observer.mockRestore();
    }
    const reconciled = await actor.sessions.read(authority, { sessionKey });
    expect(reconciled.entry?.sessionId).toBe(fault);
    expect(actor.sessions.readSharing(sessionKey)?.entry?.sessionId).toBe(fault);
    reconciled.claim.assertCurrent();
  },
);

it("preserves the original 24-hour deadline and refuses claims after actor replacement", async () => {
  const original = await capture("lifetime");
  assert(original);
  const sessionKey = key("deadline", "lifetime");
  const created = await original.sessions.create(authority, {
    sessionKey,
    entry: entry("deadline"),
  });
  const deadline = original.sessions.deadlines()[0];
  const originalStore = captureOpenClawAgentDatabaseExecution
    .listIncognito(env)
    .find((store) => store.agentId === "lifetime");
  assert(originalStore);
  expect(deadline).toMatchObject({ sessionKey, sessionId: "deadline", expiresAt: 10_000 + DAY_MS });
  assert(deadline);
  await original.sessions.create(
    {
      assertCurrent() {},
      authorize() {
        deadline.source.assertCurrent();
        expect(original.sessions.deadlines()[0]?.expiresAt).toBe(10_000 + DAY_MS);
      },
    },
    {
      sessionKey,
      entry: entry("deadline", 10_000 + DAY_MS - 1),
    },
  );
  expect(original.sessions.deadlines()[0]?.expiresAt).toBe(10_000 + DAY_MS);
  expect((await original.sessions.read(authority, { sessionKey })).entry?.createdAt).toBe(10_000);
  const siblingKey = key("sibling", "lifetime");
  await original.sessions.create(authority, { sessionKey: siblingKey, entry: entry("sibling") });
  created.claim.assertCurrent();
  deadline.source.assertCurrent();
  await original.release();
  deadline.source.assertCurrent();
  await original.close();
  expect(
    captureOpenClawAgentDatabaseExecution
      .listIncognito(env)
      .some((store) => store.agentId === "lifetime"),
  ).toBe(false);
  const successor = await capture("lifetime");
  assert(successor);
  expect(successor.identity).not.toEqual(original.identity);
  expect(() => originalStore.assertCurrent()).toThrow("Incognito session ended");
  expect(() => created.claim.assertCurrent()).toThrow("Incognito session ended");
  expect(() => deadline.source.assertCurrent()).toThrow("Incognito session ended");
  expect(() => original.sessions.readSharing(sessionKey)).toThrow("Incognito session ended");
  expect((await successor.sessions.read(authority, { sessionKey })).entry).toBeUndefined();
  expect(
    (await successor.sessions.read(authority, { sessionKey: siblingKey })).entry,
  ).toBeUndefined();
});

it("composes sharing, delivery and presence from current actor facts without host SQL", async () => {
  const sessionKey = key("authority-composition");
  const initial = entry("authority-composition");
  await actor.sessions.create(authority, { sessionKey, entry: initial });
  const signal = new AbortController();
  await withIncognitoSessionActor(
    actor,
    async () => {
      const sql = observeMainThreadSql();
      const facts = await prepareSessionMutationFacts({ cfg: {}, agentId: "main", sessionKey });
      const delivery = await prepareSessionDeliveryGeneration({
        agentId: "main",
        storePath: actor.path,
        sessionKey,
        sessionId: initial.sessionId,
        lifecycleRevision: initial.lifecycleRevision,
      });
      try {
        const person = { text: "actor watcher", ts: 1, watchedSessions: [sessionKey] };
        const project = createPresenceRecipientProjection({ cfg: {}, presence: [person] });
        const client: GatewayClient = {
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            role: "operator",
            scopes: ["operator.admin"],
            client: {
              id: "openclaw-control-ui",
              version: "test",
              platform: "test",
              mode: "webchat",
            },
          },
        };
        expect(facts.storageTarget.storePath).toBe(actor.path);
        expect(facts.readCurrent({}).target.entry.sessionId).toBe(initial.sessionId);
        expect(project(client)).toEqual([person]);
        delivery.assertCurrent();
        await actor.sessions.sideData(authority, {
          type: "session.sharing.add",
          input: { sessionKey, params: { identityId: "viewer", addedBy: "owner" } },
        });
        expect(facts.readCurrent({}).membership.has("viewer")).toBe(true);
        delivery.assertCurrent();
        signal.abort(new Error("authority revoked"));
        expect(() => facts.readCurrent({})).toThrow("Session access facts are unavailable");
        expect(() => delivery.assertCurrent()).toThrow(
          "Session delivery generation is unavailable",
        );
        expect(() => project(client)).toThrow("authority revoked");
        sql.expectIdle();
      } finally {
        delivery.release();
        facts.release();
        sql.restore();
      }
    },
    signal.signal,
  );
});

it("retains actor identity before sharing waits for storage readiness", async () => {
  const sessionKey = key("authority-storage-wait");
  const initial = entry("authority-storage-wait");
  await actor.sessions.create(authority, { sessionKey, entry: initial });
  await withIncognitoSessionActor(actor, async () => {
    const ready = createDeferredCore();
    const preparing = prepareSessionMutationFacts({
      cfg: {},
      agentId: "main",
      sessionKey,
      storageReady: ready.promise,
    });
    const rejected = expect(preparing).rejects.toThrow("Session access facts are unavailable");
    await replaceSessionEntry(
      { agentId: "main", env, sessionKey, storePath: actor.path },
      { ...initial, lifecycleRevision: "replacement" },
    );
    ready.resolve();
    await rejected;
  });
});

it("rechecks a cross-agent completion lineage using committed actor facts inside grants", async () => {
  const sibling = await capture("completion-peer");
  assert(sibling);
  const sourceSessionKey = key("completion-source", "completion-peer");
  const targetSessionKey = key("completion-requester");
  const initial: SessionEntry = {
    ...entry("completion-source"),
    spawnedBy: targetSessionKey,
    spawnDepth: 1,
    subagentRole: "orchestrator" as const,
    subagentControlScope: "children" as const,
    inheritedToolPolicyVersion: 1,
  };
  await sibling.sessions.create(authority, { sessionKey: sourceSessionKey, entry: initial });
  await actor.sessions.create(authority, {
    sessionKey: targetSessionKey,
    entry: entry("completion-requester"),
  });
  await withIncognitoSessionActor(actor, async () => {
    const sql = observeMainThreadSql();
    try {
      const lineage = createCompletionGrantLineageAdmission({
        cfg: { agents: { entries: { main: {}, "completion-peer": {} } } },
        context: {
          sessionKey: targetSessionKey,
          sessionId: "completion-requester",
          modelProvider: "claude-cli",
          modelId: "opus",
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey,
            sourceChannel: "internal",
            sourceTool: "subagent_announce",
          },
          trustedInternalHandoff: {
            kind: "subagent-completion",
            sourceSessionKey,
            sourceSessionId: initial.sessionId,
            targetSessionKey,
            targetSessionId: "completion-requester",
            provider: "claude-cli",
            model: "opus",
          },
        },
      });
      assert(lineage.admission);
      const prepared = await lineage.admission.prepare();
      expect(prepared.isCurrent()).toBe(true);
      await actor.sessions.sideData(
        {
          assertCurrent: authority.assertCurrent,
          authorize() {
            prepared.current.assertCurrent([]);
            expect(prepared.isCurrent()).toBe(true);
          },
        },
        {
          type: "session.sharing.add",
          input: {
            sessionKey: targetSessionKey,
            params: { identityId: "viewer", addedBy: "owner" },
          },
        },
      );
      await withIncognitoSessionActor(sibling, () =>
        replaceSessionEntry(
          { agentId: sibling.agentId, env, sessionKey: sourceSessionKey, storePath: sibling.path },
          { ...initial, completionOwnerSessionKey: key("other-requester") },
        ),
      );
      expect(prepared.isCurrent()).toBe(false);
      expect(() => prepared.current.assertCurrent([])).toThrow("requester policy");
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it("composes entry reads, currency, candidates and admission without caller-thread SQL", async () => {
  expect(
    resolveSessionEntryCandidateTargetForRuntime({
      cfg: {},
      agentId: "main",
      candidateKeys: [],
      fallback: { sessionKey: "fallback", entry: entry("unbound") },
    }),
  ).toMatchObject({ persisted: false, sessionKey: "fallback" });
  const sessionKey = key("entry-composition");
  const initial = entry("entry-composition");
  await actor.sessions.create(authority, { sessionKey, entry: initial });
  await withIncognitoSessionActor(actor, async () => {
    const sql = observeMainThreadSql();
    try {
      const scope = { agentId: "main", sessionKey };
      expect(await readResolvedSessionEntryInWorker({ ...scope, cfg: {} })).toMatchObject(initial);
      await withSessionEntryReadOnlyInWorker(
        { ...scope, sessionKey: `  ${sessionKey.toUpperCase()}  ` },
        authority.assertCurrent,
        async (read, owner) => {
          assert(read.ok);
          expect(read.value?.sessionId).toBe(initial.sessionId);
          const current = captureSessionEntryCurrentRead(scope, owner);
          expect((await current.readCurrent())?.sessionId).toBe(initial.sessionId);
        },
      );
      expect(
        await resolveSessionEntryCandidateTargetForRuntime({
          cfg: {},
          agentId: "main",
          candidateKeys: [
            "current",
            key("missing-candidate"),
            sessionKey.toUpperCase(),
            sessionKey,
          ],
        }),
      ).toMatchObject({ sessionKey, entry: { sessionId: initial.sessionId }, persisted: true });
      expect(captureNativeSessionEntryCurrentRead(scope).readCurrent()?.sessionId).toBe(
        initial.sessionId,
      );
      expect(
        await resolveSessionEntryCandidateTargetForRuntime({
          cfg: {},
          agentId: "main",
          candidateKeys: ["main", key("absent-fallback")],
          fallback: { sessionKey: "  fallback  ", entry: initial },
        }),
      ).toMatchObject({ candidateKey: "fallback", sessionKey: "fallback", persisted: false });
      const admission = await loadSessionEntryForAdmission(scope);
      expect(admission.entry?.sessionId).toBe(initial.sessionId);
      admission.databaseClaim.assertCurrent();
      await admission.databaseClaim.release();
      expect(admission.databaseClaim.isCurrent()).toBe(false);
      await expect(
        withSessionEntryReadOnlyInWorker(scope, authority.assertCurrent, async () => {
          await replaceSessionEntry(
            { ...scope, env, storePath: actor.path },
            {
              ...initial,
              label: "rewritten during consumer",
            },
          );
        }),
      ).rejects.toThrow("snapshot changed");
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it("discovers every captured actor and preserves placement identity evidence", async () => {
  const other = await capture("topology-peer");
  assert(other);
  const mainKey = key("topology-main");
  const otherKey = key("topology-other", "topology-peer");
  await actor.sessions.create(authority, { sessionKey: mainKey, entry: entry("topology-main") });
  await other.sessions.create(authority, { sessionKey: otherKey, entry: entry("topology-other") });
  const snapshot = readAgentDatabaseDeletionSnapshot(env, "runtime");
  await withIncognitoSessionActor(actor, async () => {
    const sql = observeMainThreadSql();
    try {
      const cfg = { agents: { entries: { main: {}, "topology-peer": {} } } };
      const combined = await loadCombinedSessionStoreForGatewayCoreAsync(cfg, {
        discovery: { env, snapshot },
      });
      expect(combined.store[mainKey]?.sessionId).toBe("topology-main");
      expect(combined.store[otherKey]?.sessionId).toBe("topology-other");
      const scoped = await loadCombinedSessionStoreForGatewayCoreAsync(cfg, {
        discovery: { env, snapshot },
        agentId: " TOPOLOGY-PEER ",
      });
      expect(scoped.store[otherKey]?.sessionId).toBe("topology-other");
      expect(scoped.store[mainKey]).toBeUndefined();
      expect(
        await readPlacementSessionIdentityEvidence(cfg, [
          { agentId: "topology-peer", sessionKey: otherKey, sessionId: "topology-other" },
          { agentId: "main", sessionKey: mainKey, sessionId: "absent-identity" },
          { agentId: "not-created", sessionKey: key("absent", "not-created"), sessionId: "absent" },
        ]),
      ).toEqual([
        { status: "current", sessionKey: otherKey },
        { status: "absent" },
        { status: "absent" },
      ]);
      expect(
        captureOpenClawAgentDatabaseExecution
          .listIncognito(env)
          .some((target) => target.agentId === "not-created"),
      ).toBe(false);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it.each([
  { kind: "absent", abortAdmission: false },
  { kind: "existing", abortAdmission: false },
  { kind: "absent", abortAdmission: true },
  { kind: "existing", abortAdmission: true },
] as const)(
  "commits an $kind actor target under prepared authority (admission aborted: $abortAdmission)",
  async ({ kind, abortAdmission }) => {
    const sessionId = `prepared-creation-${kind}-${abortAdmission}`;
    const sessionKey = key(sessionId);
    const initial = entry(sessionId);
    const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, env };
    if (kind === "existing") {
      await actor.sessions.create(authority, { sessionKey, entry: initial });
    }
    const admission = new AbortController();
    await withIncognitoSessionActor(
      actor,
      async () => {
        const sql = observeMainThreadSql();
        try {
          await using targets = prepareGatewaySessionLifecycleTargets({
            cfg: {},
            targets: [
              {
                target: { ...scope, canonicalKey: sessionKey },
                ...(kind === "existing" ? { entry: initial } : {}),
              },
            ],
          });
          let committed = false;
          const prepared = await targets.prepareCreationTargets(() => committed);
          const result = await createSessionEntryWithTranscript(
            scope,
            () => ({ ok: true, entry: initial }),
            {
              bindCreation: prepared.bindCreation,
              commitGuard: prepared.assertCurrent,
              onPhase(phase) {
                if (phase === "commit" && abortAdmission) {
                  admission.abort(new Error("parent admission ended"));
                }
              },
              onLifecycleCommitted() {
                committed = true;
              },
            },
          );
          expect(result).toMatchObject({ ok: true, entry: { sessionId } });
          expect(committed).toBe(true);
          expect((await actor.sessions.read(authority, { sessionKey })).entry?.sessionId).toBe(
            sessionId,
          );
          if (abortAdmission) {
            await expect(
              prepareSessionMutationFacts({
                cfg: {},
                agentId: actor.agentId,
                sessionKey,
              }),
            ).rejects.toThrow("Session access facts are unavailable");
          }
          sql.expectIdle();
        } finally {
          sql.restore();
        }
      },
      admission.signal,
    );
  },
);

it("rejects an ambient store-root change while the actor listing waits for FIFO custody", async () => {
  const originalRoot = process.env.OPENCLAW_STATE_DIR;
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const started = createDeferredCore();
  const replacementRoot = tempDirs.make("incognito-listing-replacement-root-");
  process.env.OPENCLAW_STATE_DIR = env.OPENCLAW_STATE_DIR;
  const held = runOpenClawAgentWorkerWrite(
    { target: actor.identity, assertCurrent: () => actor.assertReadable() },
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  try {
    await entered.promise;
    const listing = withIncognitoSessionActor(actor, () => {
      const result = loadCombinedSessionStoreForGatewayCoreAsync({
        agents: { entries: { main: {} } },
      });
      started.resolve();
      return result;
    });
    const rejected = expect(listing).rejects.toThrow(
      "Session stores changed while preparing the listing",
    );
    await started.promise;
    process.env.OPENCLAW_STATE_DIR = replacementRoot;
    release.resolve();
    await held;
    await rejected;
  } finally {
    release.resolve();
    await held;
    if (originalRoot === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalRoot;
    }
  }
});

it.each(["default", "explicit", "durable-only"] as const)(
  "keeps %s combined discovery within its selected physical root",
  async (mode) => {
    const originalRoot = process.env.OPENCLAW_STATE_DIR;
    const foreignEnv = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-foreign-listing-root-") };
    const durableKey = `agent:main:bound-root-durable-${mode}`;
    const privateKey = key(`bound-root-private-${mode}`);
    await replaceSessionEntry(
      { agentId: "main", sessionKey: durableKey, env },
      { sessionId: `durable-root-a-${mode}`, updatedAt: 1 },
    );
    await actor.sessions.create(authority, {
      sessionKey: privateKey,
      entry: entry(`private-root-a-${mode}`),
    });
    process.env.OPENCLAW_STATE_DIR = foreignEnv.OPENCLAW_STATE_DIR;
    try {
      await withIncognitoSessionActor(actor, async () => {
        if (mode === "explicit") {
          await expect(async () =>
            loadCombinedSessionStoreForGatewayCoreAsync(
              {},
              {
                discovery: { env: foreignEnv, snapshot: undefined },
              },
            ),
          ).rejects.toThrow("Combined discovery belongs to another incognito state root");
          return;
        }
        const combined = await loadCombinedSessionStoreForGatewayCoreAsync(
          {},
          mode === "durable-only" ? { includeIncognito: false } : {},
        );
        expect(combined.store[durableKey]?.sessionId).toBe(
          mode === "default" ? `durable-root-a-${mode}` : undefined,
        );
        expect(combined.store[privateKey]?.sessionId).toBe(
          mode === "default" ? `private-root-a-${mode}` : undefined,
        );
        if (mode === "default") {
          const probes = Object.entries({
            [durableKey]: `durable-root-a-${mode}`,
            [privateKey]: `private-root-a-${mode}`,
          }).map(([sessionKey, sessionId]) => ({ agentId: "main", sessionKey, sessionId }));
          expect(await readPlacementSessionIdentityEvidence({}, probes)).toEqual([
            { status: "current", sessionKey: durableKey },
            { status: "current", sessionKey: privateKey },
          ]);
        }
      });
    } finally {
      if (originalRoot === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalRoot;
      }
    }
  },
);
