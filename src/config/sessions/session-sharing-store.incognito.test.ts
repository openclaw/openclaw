import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { IncognitoSessionSyncAccessError } from "../../state/incognito-session-error.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { updateSessionGroupCategoriesInWorker } from "./session-group-categories.js";
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
  listSessionMembersInWorker,
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

it("composes suggestion FIFO, claims, release and resolution without caller SQL", async () => {
  const { scope, entry } = await fixture("suggestions");
  const sql = observeHostDataSql();
  try {
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
  } finally {
    sql.restore();
  }
});

it("publishes actor membership, owner, participant and category changes through their owners", async () => {
  const { scope, entry } = await fixture("sharing");
  const changes: SessionRowChange[] = [];
  const stop = sessionChanges.subscribeFacts((change) => changes.push(change));
  const sql = observeHostDataSql();
  try {
    await addSessionMember(scope, { identityId: "alice", addedBy: "creator", addedAt: 1 });
    expect(await listSessionMembersInWorker(scope)).toEqual([
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
    expect(await listSessionMembersInWorker(scope)).toEqual([]);
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
  } finally {
    sql.restore();
    stop();
  }
});

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
  ).rejects.toThrow("Collaboration target differs from its captured incognito actor");
});
