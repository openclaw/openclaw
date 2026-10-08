import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareSteeringDelivery } from "../../auto-reply/reply/steering-delivery-preparation.js";
import { createPresenceRecipientProjection } from "../../gateway/presence-projection.js";
import type { GatewayClient } from "../../gateway/server-methods/types.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { IncognitoSessionSyncAccessError } from "../../state/incognito-session-error.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { prepareSessionDeliveryGeneration } from "./session-delivery-generation.js";
import { updateSessionGroupCategoriesInWorker } from "./session-group-categories.js";
import { withIncognitoSessionActor } from "./session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import { updateSessionProfileInvolvementAsync } from "./session-involvement-store.js";
import {
  addSessionSuggestionInWorker,
  assignSessionOwnerInWorker,
  claimSessionSuggestionDispatchInWorker,
  finalizeSessionSuggestionClaimInWorker,
  releaseSessionSuggestionDispatchInWorker,
} from "./session-metadata-write.async.js";
import { recordSessionParticipantInWorker } from "./session-sharing-store.async.js";
import {
  addSessionMember,
  readSessionMembersInWorker,
  removeSessionMember,
} from "./session-sharing-store.js";
import { listSessionSuggestions } from "./session-suggestion-store.read.js";
import type { SessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-collaboration-") };
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
});
afterAll(async () => {
  await actor?.close();
});
afterEach(() => vi.restoreAllMocks());

async function fixture(name: string, source = authority) {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const entry = {
    sessionId: name,
    lifecycleRevision: name,
    updatedAt: 1,
    incognito: true,
    category: name,
  } satisfies SessionEntry;
  await actor.sessions.create(authority, { sessionKey, entry });
  const scope = {
    agentId: actor.agentId,
    storePath: actor.path,
    sessionKey,
    env,
    incognito: { actor, authority: source },
  } satisfies SessionCollaborationScope;
  return { scope, entry };
}

it("composes sharing, delivery, steering and presence from current actor facts without host SQL", async () => {
  const { scope, entry: initial } = await fixture("authority-composition");
  const sessionKey = scope.sessionKey;
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
        const steering = prepareSteeringDelivery({
          agentId: actor.agentId,
          storePath: actor.path,
          sessionKey,
          sessionId: initial.sessionId,
          assertCurrent: () => {},
        });
        await steering.prepareCurrent();
        await replaceSessionEntry(
          { agentId: actor.agentId, storePath: actor.path, sessionKey, env },
          { ...initial, restartRecoveryDeliveryReceiptState: "delivered-terminal" },
        );
        await expect(steering.prepareCurrent()).rejects.toThrow("delivered-terminal");
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

it("composes suggestion FIFO, claims, release and resolution without caller SQL", async () => {
  const { scope: explicitScope, entry } = await fixture("suggestions");
  const scope = { ...explicitScope, incognito: undefined };
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      const added = addSessionSuggestionInWorker(scope, {
        id: "first",
        authorId: "alice",
        text: "Private suggestion",
        createdAt: 1,
        expectedSessionId: entry.sessionId,
      });
      const listed = listSessionSuggestions(scope, { pendingOnly: true });
      expect(await listed).toEqual([await added]);
      const claims = await Promise.all([
        claimSessionSuggestionDispatchInWorker(scope, { id: "first", resolution: "send" }),
        claimSessionSuggestionDispatchInWorker(scope, { id: "first", resolution: "send" }),
      ]);
      const claim = claims[0];
      assert(claim?.kind === "claimed");
      expect(claims[1]).toEqual({ kind: "busy" });
      expect(
        await releaseSessionSuggestionDispatchInWorker(scope, {
          id: "first",
          token: "foreign",
        }),
      ).toBe(false);
      expect(
        await releaseSessionSuggestionDispatchInWorker(scope, {
          id: "first",
          token: claim.token,
        }),
      ).toBe(true);
      const next = await claimSessionSuggestionDispatchInWorker(scope, {
        id: "first",
        resolution: "dismiss",
      });
      assert(next?.kind === "claimed");
      expect(
        await finalizeSessionSuggestionClaimInWorker(scope, {
          id: "first",
          token: claim.token,
          state: "accepted",
        }),
      ).toBeNull();
      expect(
        await finalizeSessionSuggestionClaimInWorker(scope, {
          id: "first",
          token: next.token,
          state: "dismissed",
        }),
      ).toMatchObject({ id: "first", state: "dismissed" });
      expect(await listSessionSuggestions(scope, { pendingOnly: true })).toEqual([]);
      expect(await listSessionSuggestions(scope, { authorId: "alice" })).toMatchObject([
        { id: "first", state: "dismissed" },
      ]);
      expect(sql.queries).toEqual([]);
      expect(existsSync(actor.path)).toBe(false);
    });
  } finally {
    sql.restore();
  }
});

it.each(["members", "suggestions"] as const)(
  "refuses %s disclosure after its borrowed actor releases inside an accepted composition",
  async (kind) => {
    const { scope } = await fixture(`released-${kind}`);
    await addSessionMember(scope, {
      identityId: "alice",
      addedBy: "private-creator",
      addedAt: 1,
    });
    await addSessionSuggestionInWorker(scope, {
      id: `private-suggestion-${kind}`,
      authorId: "alice",
      text: "Private suggestion",
    });
    const borrowed = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: actor.agentId,
      env,
      authority,
      existingOnly: true,
    });
    assert(borrowed);
    let releasing: Promise<void> | undefined;
    const current: IncognitoSessionAuthority = {
      assertCurrent() {},
      authorize(stage) {
        if (stage === "commit") {
          releasing ??= borrowed.release();
        }
      },
    };
    const captured = { ...scope, incognito: { actor: borrowed, authority: current } };
    const disclosed = vi.fn();
    try {
      await expect(
        borrowed.sessions.withSharedState(async () => {
          const value =
            kind === "members"
              ? await readSessionMembersInWorker(captured)
              : await listSessionSuggestions(captured);
          disclosed(value);
        }),
      ).rejects.toThrow("reference is released");
      await releasing;
      expect(disclosed).not.toHaveBeenCalled();
    } finally {
      await borrowed.release();
    }
  },
);

it.each(["release", "finalize"] as const)(
  "retains a committed suggestion claim token through %s after borrower release",
  async (settlement) => {
    const { scope } = await fixture(`retained-${settlement}`);
    const id = `accepted-suggestion-${settlement}`;
    await addSessionSuggestionInWorker(scope, {
      id,
      authorId: "alice",
      text: "Accepted private suggestion",
    });
    const borrowed = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: actor.agentId,
      env,
      authority,
      existingOnly: true,
    });
    assert(borrowed);
    let releasing: Promise<void> | undefined;
    const current: IncognitoSessionAuthority = {
      assertCurrent() {},
      authorize(stage) {
        if (stage === "commit") {
          releasing ??= borrowed.release();
        }
      },
    };
    const captured = { ...scope, incognito: { actor: borrowed, authority: current } };
    try {
      await expect(
        borrowed.sessions.withSharedState(async () => {
          const claim = await claimSessionSuggestionDispatchInWorker(captured, {
            id,
            resolution: "dismiss",
          });
          assert(claim?.kind === "claimed");
          const params = { id: claim.suggestion.id, token: claim.token };
          if (settlement === "release") {
            expect(await releaseSessionSuggestionDispatchInWorker(captured, params)).toBe(true);
          } else {
            expect(
              await finalizeSessionSuggestionClaimInWorker(captured, {
                ...params,
                state: "dismissed",
              }),
            ).toMatchObject({ id: params.id, state: "dismissed" });
          }
        }),
      ).rejects.toThrow("reference is released");
      await releasing;
      expect(await listSessionSuggestions(scope)).toMatchObject([
        { state: settlement === "release" ? "pending" : "dismissed" },
      ]);
      if (settlement === "release") {
        const next = await claimSessionSuggestionDispatchInWorker(scope, {
          id,
          resolution: "dismiss",
        });
        assert(next?.kind === "claimed");
        await releaseSessionSuggestionDispatchInWorker(scope, { id, token: next.token });
      }
    } finally {
      await borrowed.release();
    }
  },
);

it("publishes actor membership, owner, participant and category changes through their owners", async () => {
  const { scope: explicitScope, entry } = await fixture("sharing");
  const scope = { ...explicitScope, incognito: undefined };
  const changes: SessionRowChange[] = [];
  const stop = sessionChanges.subscribeFacts((change) => changes.push(change));
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      await addSessionMember(scope, { identityId: "alice", addedBy: "creator", addedAt: 1 });
      expect((await readSessionMembersInWorker(scope)).members).toEqual([
        { identityId: "alice", addedBy: "creator", addedAt: 1 },
      ]);
      await assignSessionOwnerInWorker(scope, {
        owner: { type: "human", id: "alice" },
        assignedBy: { type: "human", id: "creator" },
        assignedAt: 2,
        expectedSessionId: entry.sessionId,
      });
      expect(
        await recordSessionParticipantInWorker(scope, {
          identity: { type: "agent", id: "helper" },
          promptedAt: 3,
        }),
      ).toBe("inserted");
      expect(await updateSessionGroupCategoriesInWorker({ scope, from: entry.category })).toBe(1);
      await removeSessionMember(scope, "alice");
      expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
      const current = await actor.sessions.read(authority, { sessionKey: scope.sessionKey });
      expect(current.entry).toMatchObject({ owner: { actor: { type: "human", id: "alice" } } });
      expect(current.entry?.category).toBeUndefined();
      expect(
        await updateSessionProfileInvolvementAsync(scope, {
          expectedSessionId: entry.sessionId,
          profileIds: ["alice"],
          change: { kind: "visibility", hidden: true },
        }),
      ).toBe(false);
      expect(changes.flatMap((change) => ("facts" in change ? [change.facts?.kind] : []))).toEqual([
        "member",
        "owner",
        "participants",
        "category",
        "member",
      ]);
      expect(sql.queries).toEqual([]);
    });
  } finally {
    sql.restore();
    stop();
  }
});

it.each(["revoked-authority", "lost-reply"] as const)(
  "publishes a committed category change after %s without replay",
  async (failureMode) => {
    let revoked = false;
    const failure = new Error(`Synthetic ${failureMode}`);
    const { scope, entry } = await fixture(failureMode, {
      assertCurrent() {
        if (revoked) {
          throw failure;
        }
      },
    });
    let executions = 0;
    const run = workerStore.runSqliteWorkerStoreOperation;
    vi.spyOn(workerStore, "runSqliteWorkerStoreOperation").mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        store: SqliteWorkerStore<Operations>,
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof run>[2],
        assertCurrent?: Parameters<typeof run>[3],
        admission?: Parameters<typeof run>[4],
      ) =>
        run(
          store,
          (operationScope) =>
            operation({
              execute: async (command, options) => {
                const value = await operationScope.execute(command, options);
                if (command.type === "session.category.apply") {
                  executions++;
                  if (failureMode === "lost-reply") {
                    throw failure;
                  }
                  revoked = true;
                }
                return value;
              },
            }),
          stateContext,
          assertCurrent,
          admission,
        ),
    );
    const changes: SessionRowChange[] = [];
    const stop = sessionChanges.subscribeFacts((change) => changes.push(change));
    const sql = observeHostDataSql();
    try {
      await expect(
        updateSessionGroupCategoriesInWorker({ scope, from: entry.category }),
      ).rejects.toBe(failure);
      expect(executions).toBe(1);
      expect(changes).toEqual([
        expect.objectContaining({
          agentId: actor.agentId,
          storePath: actor.path,
          sessionKey: scope.sessionKey,
          ...(failureMode === "lost-reply"
            ? { factsInvalidated: "category" }
            : { facts: { kind: "category", sessionId: entry.sessionId, category: null } }),
        }),
      ]);
      expect(
        (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry?.category,
      ).toBeUndefined();
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      stop();
    }
  },
);

it.each(["transaction", "commit"] as const)(
  "retains the actionable incognito refusal at suggestion %s admission",
  async (refusedStage) => {
    let enforce = true;
    const failure = new IncognitoSessionSyncAccessError(
      "readSessionContext",
      "readSessionContextAsync",
    );
    const { scope } = await fixture(`refusal-${refusedStage}`, {
      assertCurrent() {},
      authorize(stage) {
        if (enforce && stage === refusedStage) {
          throw failure;
        }
      },
    });
    await expect(
      addSessionSuggestionInWorker(scope, {
        authorId: "alice",
        text: "Must roll back",
      }),
    ).rejects.toBe(failure);
    enforce = false;
    expect(await listSessionSuggestions(scope)).toEqual([]);
  },
);

it("refuses a captured actor belonging to another physical store", async () => {
  const { scope } = await fixture("wrong-store");
  await expect(
    addSessionSuggestionInWorker(
      {
        ...scope,
        env: { OPENCLAW_STATE_DIR: tempDirs.make("foreign-collaboration-") },
      },
      { authorId: "alice", text: "Must not be rerouted" },
    ),
  ).rejects.toThrow("Explicit incognito database target does not match its agent and state root");
  expect(await listSessionSuggestions(scope)).toEqual([]);
});
