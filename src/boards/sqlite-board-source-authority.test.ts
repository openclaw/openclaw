import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import { retainSessionEntryWorkerPublication } from "../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { removeSessionMember as removeSessionMemberSync } from "../config/sessions/session-sharing-store.native.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "../gateway/session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "../gateway/session-sharing.test-utils.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

async function fixture() {
  const cfg = rolePolicyConfig();
  const client = roleClient("view", "board-member");
  const memberId = client.authenticatedUserId!;
  const source = { agentId: "main", sessionKey: "agent:main:board-source" };
  replaceSessionEntrySync(source, {
    sessionId: "source-session",
    updatedAt: 1,
    visibility: "read-only",
    createdActor: { type: "human", source: "profile", id: "creator" },
  });
  await addSessionMember(source, { identityId: memberId, addedBy: "creator" });
  const target = { agentId: "target", sessionKey: "agent:target:board" };
  replaceSessionEntrySync(target, { sessionId: "target-session", updatedAt: 1 });
  const store = new SqliteBoardStore({ resolveSession: () => target });
  const authorize = () =>
    resolveSessionMutationAuthorizationAsync({
      client,
      method: "board.widget.put",
      requestParams: source,
      context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
    });
  const result = await authorize();
  expect(result.error).toBeNull();
  const authorization = result.authorization!;
  const write = (name: string) =>
    store.putWidget(
      { ...target, name, content: { kind: "html", html: name } },
      { assertCurrent: authorization.assertCurrent },
    );
  return { source, target, store, memberId, authorize, authorization, write };
}

it("uses retained source facts for every Board mutation and agrees with cold authorization after revocation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { source, target, store, memberId, authorize, authorization, write } = await fixture();
    try {
      const host = observeHostDataSql();
      try {
        const put = await store.putWidget(
          {
            ...target,
            name: "allowed",
            content: { kind: "html", html: "allowed" },
            declared: { tools: ["health"] },
          },
          { assertCurrent: authorization.assertCurrent },
        );
        await store.applyOps(
          target,
          [{ kind: "widget_resize", name: "allowed", sizeW: 8, sizeH: 6 }],
          { assertCurrent: authorization.assertCurrent },
        );
        await store.grant(target, "allowed", "granted", 1, put.widgets[0]?.instanceId, {
          assertCurrent: authorization.assertCurrent,
        });
        expect(host.queries).toEqual([]);
      } finally {
        host.restore();
      }
      await removeSessionMember(source, memberId);
      await expect(write("denied")).rejects.toThrow();
      const cold = await authorize();
      try {
        expect(cold.error).not.toBeNull();
      } finally {
        cold.authorization?.release?.();
      }
      expect((await store.getSnapshot(target)).widgets).toMatchObject([
        { name: "allowed", sizeW: 8, sizeH: 6, grantState: "granted" },
      ]);
    } finally {
      authorization.release?.();
    }
  });
});

it("finishes an admitted cross-database write after source revocation and denies the next write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { source, target, store, memberId, authorization, write } = await fixture();
    let revoked = false;
    const interception = probe.admission(admission, (request, grant, admit) => {
      if (request.stage === "transaction" && !revoked) {
        revoked = true;
        removeSessionMemberSync(source, memberId);
      }
      admit(request, grant);
    });
    try {
      await expect(write("in-flight")).resolves.toMatchObject({ revision: 1 });
      expect(revoked).toBe(true);
      interception.mockRestore();
      await expect(write("denied")).rejects.toThrow();
      expect((await store.getSnapshot(target)).widgets).toMatchObject([{ name: "in-flight" }]);
    } finally {
      interception.mockRestore();
      authorization.release?.();
    }
  });
});

it("denies new Board admissions while a source revocation is pending and after unknown settlement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { source, target, store, authorization, write } = await fixture();
    const database = openOpenClawAgentDatabase({ agentId: source.agentId });
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected a durable source");
    }
    const publication = retainSessionEntryWorkerPublication({
      agentId: source.agentId,
      storePath: database.path,
      databaseIdentity: identity,
    });
    try {
      publication.begin([source.sessionKey], [source.sessionKey], []);
      await expect(write("pending")).rejects.toThrow();
      publication.settle(undefined, true);
      await expect(write("unknown")).rejects.toThrow();
      expect((await store.getSnapshot(target)).widgets).toEqual([]);
    } finally {
      publication.settle(undefined, false);
      authorization.release?.();
    }
  });
});
