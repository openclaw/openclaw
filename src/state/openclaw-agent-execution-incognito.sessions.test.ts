import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSubagentControllerRead } from "../agents/subagents/registry/subagent-controller-read.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { createBoardWidgetApprovalResolver } from "../gateway/board-widget-approval.js";
import * as execApprovalsStore from "../infra/exec-approvals-store.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { getOpenClawAgentDatabaseIfOpen } from "./openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

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
  await expect(
    actor.sessions.read(authority, { sessionKey: key("identity", "sibling") }),
  ).rejects.toThrow("refusing non-canonical session key");
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
