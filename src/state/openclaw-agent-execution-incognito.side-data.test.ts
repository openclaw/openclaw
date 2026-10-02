import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;

function key(name: string) {
  return `agent:main:dashboard:incognito-${name}`;
}

function create(name: string, category?: string) {
  return actor.sessions.create(authority, {
    sessionKey: key(name),
    entry: {
      sessionId: name,
      updatedAt: 10_000,
      createdAt: 10_000,
      lifecycleRevision: "initial",
      incognito: true,
      ...(category ? { category } : {}),
    },
  });
}

beforeAll(async () => {
  const root = tempDirs.make("incognito-side-data-");
  const target = path.join(root, "state");
  const alias = path.join(root, "state-alias");
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: alias },
    authority,
  });
  assert(opened);
  actor = opened;
});

afterAll(async () => {
  await actor?.close();
});

it.each(["foreign key", "prepare refusal"] as const)(
  "keeps readers usable after a prepared sharing command fails at %s",
  async (failure) => {
    const name = failure.replaceAll(" ", "-");
    const sessionKey = key(name);
    await create(name);
    let allowed = true;
    let prepareReached = false;
    const source: IncognitoSessionAuthority = {
      assertCurrent() {
        if (!allowed) {
          throw new Error("prepare authority revoked");
        }
      },
    };
    const original = workerAdmission.createSqliteWorkerOperationAdmission;
    const observer =
      failure === "prepare refusal"
        ? vi
            .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
            .mockImplementation((admit, attachment) =>
              original((request, grant) => {
                if (request.stage === "prepare") {
                  prepareReached = true;
                  allowed = false;
                }
                admit(request, grant);
              }, attachment),
            )
        : undefined;
    try {
      await expect(
        actor.sessions.sideData(source, {
          type: "session.sharing.add",
          input: {
            sessionKey:
              failure === "foreign key" ? "agent:sibling:dashboard:incognito-foreign" : sessionKey,
            params: { identityId: "viewer", addedBy: "owner", addedAt: 12_000 },
          },
        }),
      ).rejects.toThrow(
        failure === "foreign key"
          ? "refusing non-canonical session key"
          : "prepare authority revoked",
      );
      if (failure === "prepare refusal") {
        expect(prepareReached).toBe(true);
      }
    } finally {
      observer?.mockRestore();
    }
    expect(
      await actor.sessions.sideData(authority, {
        type: "session.members.read",
        input: { sessionKey },
      }),
    ).toEqual([]);
    expect(
      await actor.sessions.sideData(authority, {
        type: "session.progressCard.get",
        input: { sessionKey },
      }),
    ).toBeNull();
  },
);

it("publishes membership and participant changes through the actor catalog", async () => {
  const sessionKey = key("sharing");
  await create("sharing");
  const member = { identityId: "viewer", addedBy: "owner", addedAt: 12_000 };
  const grants: boolean[] = [];
  const source: IncognitoSessionAuthority = {
    assertCurrent() {},
    authorize(stage, facts) {
      expect(() => actor.sessions.readSharing(sessionKey)).toThrow("pending or unavailable");
      expect(() =>
        actor.sessions.sideData(authority, {
          type: "session.members.read",
          input: { sessionKey },
        }),
      ).toThrow("Incognito authority callbacks cannot call their actor");
      grants.push(facts.sharing?.membership.has("viewer") ?? false);
      expect(facts.sharing?.membership.has("viewer")).toBe(stage === "commit");
    },
  };
  expect(
    await actor.sessions.sideData(source, {
      type: "session.sharing.add",
      input: { sessionKey, params: { ...member, expectedSessionId: "sharing" } },
    }),
  ).toMatchObject({ value: { inserted: true, member } });
  expect(grants).toEqual([false, true]);
  expect(actor.sessions.readSharing(sessionKey)?.membership.has("viewer")).toBe(true);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.members.read",
      input: { sessionKey },
    }),
  ).toEqual([member]);

  const identity = { type: "agent" as const, id: "contributor" };
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.sharing.participant",
      input: { sessionKey, params: { identity, promptedAt: 13_000, sessionAgentId: "main" } },
    }),
  ).toMatchObject({ value: "inserted" });
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.participants.read",
      input: { sessionKey },
    }),
  ).toEqual([{ identity, contributionCount: 1, firstPromptedAt: 13_000, lastPromptedAt: 13_000 }]);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.catalog.read",
      input: { sessionKeys: [sessionKey] },
    }),
  ).toEqual([
    [
      sessionKey,
      null,
      ["viewer"],
      { participants: [{ identity }], participantCount: 1 },
      "sharing",
    ],
  ]);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.sharing.remove",
      input: { sessionKey, identityId: "viewer", expectedSessionId: "sharing" },
    }),
  ).toMatchObject({ value: member });
  expect(actor.sessions.readSharing(sessionKey)?.membership.has("viewer")).toBe(false);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.members.read",
      input: { sessionKey },
    }),
  ).toEqual([]);
});

it("preserves heartbeat claims and rejects reactions without a current message", async () => {
  const sessionKey = key("outcome");
  await create("outcome");
  await actor.sessions.sideData(authority, {
    type: "session.heartbeat.persist",
    input: {
      session_key: sessionKey,
      run_session_key: sessionKey,
      outcome: "progress",
      summary: "Synthetic task advanced",
      response_reason: null,
      priority: null,
      next_check: null,
      task_names_json: null,
      wake_source: null,
      wake_reason: null,
      occurred_at: 14_000,
      updated_at: 14_000,
      context_run_id: null,
      context_claimed_at: null,
    },
  });
  for (const runId of ["run-one", "run-one"]) {
    expect(
      await actor.sessions.sideData(authority, {
        type: "session.heartbeat.claim",
        input: { sessionKey, runId },
      }),
    ).toMatchObject({ outcome: "progress", summary: "Synthetic task advanced" });
  }
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.heartbeat.claim",
      input: { sessionKey, runId: "run-two" },
    }),
  ).toBeUndefined();
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.progressCard.get",
      input: { sessionKey },
    }),
  ).toBeNull();
  for (const [expectedSessionId, message] of [
    ["outcome", "unknown message"],
    ["stale-generation", "session changed before reaction mutation"],
  ] as const) {
    await expect(
      actor.sessions.sideData(authority, {
        type: "session.reaction.set",
        input: {
          sessionKey,
          params: {
            expectedSessionId,
            messageId: "missing-message",
            emoji: "👍",
            identityId: "viewer",
          },
        },
      }),
    ).rejects.toThrow(message);
  }
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.reactions.read",
      input: { sessionKey, sessionId: "outcome" },
    }),
  ).toEqual({});
});

it("orders creation, reaction settlement, and category mutation in one FIFO", async () => {
  const sessionKey = key("fifo-side-data");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = actor.run(authority, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const creating = create("fifo-side-data", "fifo-category");
  const before = actor.sessions.sideData(authority, {
    type: "session.category.keys",
    input: { name: "fifo-category" },
  });
  const removed = actor.sessions.sideData(authority, {
    type: "session.reaction.set",
    input: {
      sessionKey,
      params: {
        expectedSessionId: "fifo-side-data",
        messageId: "missing-message",
        emoji: "👍",
        identityId: "viewer",
        remove: true,
      },
    },
  });
  const changed = actor.sessions.sideData(authority, {
    type: "session.category.apply",
    input: { from: "fifo-category" },
  });
  const after = actor.sessions.sideData(authority, {
    type: "session.catalog.read",
    input: { sessionKeys: [sessionKey] },
  });
  release.resolve();
  const [initialKeys, reaction, categories, catalog] = await Promise.all([
    before,
    removed,
    changed,
    after,
    held,
    creating,
  ]);
  expect(initialKeys).toEqual([sessionKey]);
  expect(reaction).toEqual({ changed: false, reactions: [], newestRemainingEmoji: undefined });
  expect(categories).toEqual([{ sessionKey, sessionId: "fifo-side-data" }]);
  expect(catalog).toEqual([[sessionKey, null, [], {}, "fifo-side-data"]]);
});

it("refuses queued membership work after revocation", async () => {
  const sessionKey = key("queued-revocation");
  await create("queued-revocation");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = actor.run(authority, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let allowed = true;
  const rejected = expect(
    actor.sessions.sideData(
      {
        assertCurrent() {
          if (!allowed) {
            throw new Error("membership authority revoked");
          }
        },
      },
      {
        type: "session.sharing.add",
        input: { sessionKey, params: { identityId: "revoked", addedBy: "owner", addedAt: 15_000 } },
      },
    ),
  ).rejects.toThrow("membership authority revoked");
  allowed = false;
  release.resolve();
  await Promise.all([held, rejected]);
  expect(actor.sessions.readSharing(sessionKey)?.membership.has("revoked")).toBe(false);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.members.read",
      input: { sessionKey },
    }),
  ).toEqual([]);
});

it("fences every category target during grants and rolls the whole batch back before commit", async () => {
  const names = ["batch-a", "batch-b"];
  const keys = names.map(key);
  await Promise.all(names.map((name) => create(name, "batch-category")));
  let allowed = true;
  const admitted: string[] = [];
  const source: IncognitoSessionAuthority = {
    assertCurrent() {
      if (!allowed) {
        throw new Error("category authority revoked");
      }
    },
    authorize(stage, facts) {
      for (const sessionKey of keys) {
        expect(() => actor.sessions.readSharing(sessionKey)).toThrow("pending or unavailable");
      }
      if (stage === "transaction") {
        admitted.push(facts.sessionKey);
      } else {
        allowed = false;
      }
    },
  };
  await expect(
    actor.sessions.sideData(source, {
      type: "session.category.apply",
      input: { from: "batch-category" },
    }),
  ).rejects.toThrow("category authority revoked");
  expect(admitted).toEqual(keys);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.category.keys",
      input: { name: "batch-category" },
    }),
  ).toEqual(keys);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.category.apply",
      input: { from: "batch-category" },
    }),
  ).toEqual(names.map((sessionId) => ({ sessionKey: key(sessionId), sessionId })));
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.category.keys",
      input: { name: "batch-category" },
    }),
  ).toEqual([]);
});

it.each(["lost reply", "lost receipt", "revoked read"] as const)(
  "settles side-data without stale disclosure after %s",
  async (fault) => {
    const name = fault.replaceAll(" ", "-");
    const keys = [key(`${name}-a`), key(`${name}-b`)];
    await Promise.all([create(`${name}-a`, name), create(`${name}-b`, name)]);
    let allowed = true;
    let executed = 0;
    const source: IncognitoSessionAuthority = {
      assertCurrent() {
        if (!allowed) {
          throw new Error("read authority revoked");
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
                  executed++;
                  if (fault === "revoked read") {
                    allowed = false;
                    return result;
                  }
                  expect(native?.committed?.facts).toEqual(
                    expect.arrayContaining(
                      keys.map((sessionKey) => expect.objectContaining({ sessionKey })),
                    ),
                  );
                  if (fault === "lost receipt") {
                    assert(native);
                    receiptFault = vi.spyOn(native, "committed", "get").mockReturnValue(undefined);
                  }
                  throw new Error("side-data reply lost");
                },
              }),
            stateContext,
            assertCurrent,
            createAdmission &&
              ((retained) => {
                const admitted = createAdmission(retained);
                native = admitted.admission;
                return admitted;
              }),
          );
        },
      );
    try {
      const reading = fault === "revoked read";
      await expect(
        reading
          ? actor.sessions.sideData(source, {
              type: "session.catalog.read",
              input: { sessionKeys: keys },
            })
          : actor.sessions.sideData(source, {
              type: "session.category.apply",
              input: { from: name },
            }),
      ).rejects.toThrow(
        reading
          ? "read authority revoked"
          : fault === "lost receipt"
            ? "no confirmed commit receipt"
            : "side-data reply lost",
      );
      expect(executed).toBe(1);
      if (fault === "lost receipt") {
        for (const sessionKey of keys) {
          expect(() => actor.sessions.readSharing(sessionKey)).toThrow("pending or unavailable");
        }
      }
    } finally {
      receiptFault?.mockRestore();
      observer.mockRestore();
    }
    const catalog = await actor.sessions.sideData(authority, {
      type: "session.catalog.read",
      input: { sessionKeys: keys },
    });
    expect(catalog.map((row) => row[1])).toEqual(
      fault === "revoked read" ? [name, name] : [null, null],
    );
    for (const sessionKey of keys) {
      expect(actor.sessions.readSharing(sessionKey)?.entry).toBeDefined();
    }
  },
);
