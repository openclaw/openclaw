import fs from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { initializeSessionReadContext } from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { sessionSharingHandlers } from "../../gateway/server-methods/sessions-sharing.js";
import {
  identifiedClient,
  sessionSharingTestContext as context,
  soloClient,
} from "../../gateway/server-methods/sessions-sharing.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../../gateway/server-methods/types.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { patchSessionEntryCore, upsertSessionEntryCore } from "./session-accessor.js";
import { addSessionMember } from "./session-sharing-store.js";
import { listSessionMembersInWorker } from "./session-transcript-worker-runtime.js";

it("reads complete current member rows without executing SQLite on the caller", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:worker-members" };
    const entry = { sessionId: "worker-members", updatedAt: 1 };
    await patchSessionEntryCore(scope, () => entry, {
      fallbackEntry: entry,
      skipMaintenance: true,
    });
    addSessionMember(scope, { identityId: "zoe", addedBy: "actor-evidence:unknown", addedAt: 2 });
    addSessionMember(scope, {
      identityId: "alice",
      addedBy: "actor-evidence:unattributed",
      addedAt: 3,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const databasePrototype: DatabaseSync = Object.getPrototypeOf(database.db);
    const methods = [
      vi.spyOn(prototype, "all"),
      vi.spyOn(prototype, "get"),
      vi.spyOn(prototype, "iterate"),
      vi.spyOn(prototype, "run"),
      vi.spyOn(databasePrototype, "exec"),
    ];
    try {
      expect(await listSessionMembersInWorker(scope)).toEqual([
        { identityId: "alice", addedBy: "actor-evidence:unattributed", addedAt: 3 },
        { identityId: "zoe", addedBy: "actor-evidence:unknown", addedAt: 2 },
      ]);
      for (const method of methods) {
        expect(method).not.toHaveBeenCalled();
      }
    } finally {
      for (const method of methods) {
        method.mockRestore();
      }
    }
    addSessionMember(scope, { identityId: "bob", addedBy: "owner", addedAt: 4 });
    expect(await listSessionMembersInWorker(scope)).toEqual([
      { identityId: "alice", addedBy: "actor-evidence:unattributed", addedAt: 3 },
      { identityId: "bob", addedBy: "owner", addedAt: 4 },
      { identityId: "zoe", addedBy: "actor-evidence:unknown", addedAt: 2 },
    ]);
    const missing = { agentId: "missing", sessionKey: "agent:missing:main" };
    expect(await listSessionMembersInWorker(missing)).toEqual([]);
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "missing" }))).toBe(false);
  });
});

it("retains the physical owner and logical partition of a shared member store", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: state.statePath("shared-members.sqlite"),
    });
    const scope = { agentId: "other", sessionKey: "agent:other:members", storePath: database.path };
    await upsertSessionEntryCore(scope, { sessionId: "other-members", updatedAt: 1 });
    addSessionMember(scope, { identityId: "other-guest", addedBy: "other-owner", addedAt: 2 });
    const sibling = { ...scope, agentId: "main", sessionKey: "agent:main:members" };
    await upsertSessionEntryCore(sibling, { sessionId: "main-members", updatedAt: 1 });
    addSessionMember(sibling, { identityId: "main-guest", addedBy: "main-owner", addedAt: 3 });
    expect(await listSessionMembersInWorker(scope)).toEqual([
      { identityId: "other-guest", addedBy: "other-owner", addedAt: 2 },
    ]);
    expect(database.agentId).toBe("main");
  });
});

it("keeps process-local incognito membership with its native owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:dashboard:incognito-members" };
    expect(await listSessionMembersInWorker(scope)).toEqual([]);
    await upsertSessionEntryCore(scope, {
      sessionId: "incognito-members",
      updatedAt: 1,
      incognito: true,
    });
    addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 });
    expect(await listSessionMembersInWorker(scope)).toEqual([
      { identityId: "guest", addedBy: "owner", addedAt: 2 },
    ]);
  });
});

async function call(
  method: "session.members.list" | "session.members.listEvidence",
  params: Record<string, unknown>,
  requestContext: GatewayRequestContext,
  client: GatewayClient = soloClient(),
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionSharingHandlers[method]?.({
    req: { type: "req", id: "members-worker-test", method },
    isWebchatConnect: () => false,
    params,
    client,
    context: requestContext,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  });
  return responses;
}

it.each(["session.members.list", "session.members.listEvidence"] as const)(
  "%s reads full member rows off the Gateway thread, including cached statements",
  async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:worker-members" };
      await upsertSessionEntryCore(scope, { sessionId: "worker-members", updatedAt: 1 });
      addSessionMember(scope, { identityId: "zoe", addedBy: "owner", addedAt: 2 });
      addSessionMember(scope, { identityId: "alice", addedBy: "owner", addedAt: 3 });
      const requestContext = context(vi.fn());
      await initializeSessionReadContext(requestContext);
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
      // Observe native execution, including statements prepared before the request.
      const all = vi.spyOn(prototype, "all");
      const iterate = vi.spyOn(prototype, "iterate");
      try {
        for (let round = 0; round < 2; round++) {
          const result = await call(method, { sessionKey: scope.sessionKey }, requestContext);
          expect(result[0]?.[1]).toMatchObject({
            members: [
              { identityId: "alice", addedBy: "owner", addedAt: 3 },
              { identityId: "zoe", addedBy: "owner", addedAt: 2 },
            ],
          });
        }
        expect(
          [...all.mock.contexts, ...iterate.mock.contexts]
            .map((statement) => (statement as StatementSync).sourceSQL)
            .filter((sql) => /from ["`]?session_members["`]?/i.test(sql)),
        ).toEqual([]);
      } finally {
        all.mockRestore();
        iterate.mockRestore();
      }
    });
  },
);

it("rechecks the current manager after the membership read yields", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:member-reader-authority" };
    await upsertSessionEntryCore(scope, {
      sessionId: "member-reader-authority",
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: "owner" },
    });
    addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 });
    const client = identifiedClient("owner");
    const requestContext = context(vi.fn());
    await initializeSessionReadContext(requestContext);
    const pending = call(
      "session.members.listEvidence",
      { sessionKey: scope.sessionKey },
      requestContext,
      client,
    );
    client.authenticatedUserProfile = identifiedClient("other").authenticatedUserProfile;
    await expect(pending).rejects.toThrow("session ownership changed before sharing read");
  });
});
