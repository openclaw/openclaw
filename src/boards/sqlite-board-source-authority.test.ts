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

type Declared = Parameters<SqliteBoardStore["putWidget"]>[0]["declared"];

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
  const options = { assertCurrent: authorization.assertCurrent };
  const write = (name: string, declared?: Declared) =>
    store.putWidget({ ...target, name, content: { kind: "html", html: name }, declared }, options);
  return { source, target, store, memberId, authorize, authorization, options, write };
}

function withFixture(run: (context: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = await fixture();
    using _ = { [Symbol.dispose]: () => context.authorization.release?.() };
    await run(context);
  });
}

it("uses retained source facts for every Board mutation and agrees with cold authorization after revocation", () =>
  withFixture(async ({ source, target, store, memberId, authorize, options, write }) => {
    {
      const host = observeHostDataSql();
      using _ = { [Symbol.dispose]: host.restore };
      const put = await write("allowed", { tools: ["health"] });
      await store.applyOps(
        target,
        [{ kind: "widget_resize", name: "allowed", sizeW: 8, sizeH: 6 }],
        options,
      );
      await store.grant(target, "allowed", "granted", 1, put.widgets[0]?.instanceId, options);
      expect(host.queries).toEqual([]);
    }
    await removeSessionMember(source, memberId);
    await expect(write("denied")).rejects.toThrow();
    {
      const cold = await authorize();
      using _ = { [Symbol.dispose]: () => cold.authorization?.release?.() };
      expect(cold.error).not.toBeNull();
    }
    expect((await store.getSnapshot(target)).widgets).toMatchObject([
      { name: "allowed", sizeW: 8, sizeH: 6, grantState: "granted" },
    ]);
  }));

it("finishes an admitted cross-database write after source revocation and denies the next write", () =>
  withFixture(async ({ source, target, store, memberId, write }) => {
    let revoked = false;
    using interception = probe.admission(admission, (request, grant, admit) => {
      if (request.stage === "transaction" && !revoked) {
        revoked = true;
        removeSessionMemberSync(source, memberId);
      }
      admit(request, grant);
    });
    await expect(write("in-flight")).resolves.toMatchObject({ revision: 1 });
    interception.mockRestore();
    await expect(write("denied")).rejects.toThrow();
    expect((await store.getSnapshot(target)).widgets).toMatchObject([{ name: "in-flight" }]);
  }));

it("denies new Board admissions while a source revocation is pending and after unknown settlement", () =>
  withFixture(async ({ source, target, store, write }) => {
    const database = openOpenClawAgentDatabase({ agentId: source.agentId });
    const publication = retainSessionEntryWorkerPublication({
      agentId: source.agentId,
      storePath: database.path,
      databaseIdentity: readOpenClawAgentDatabaseIdentity(database).identity,
    });
    using _ = { [Symbol.dispose]: () => publication.settle(undefined, false) };
    publication.begin([source.sessionKey], [source.sessionKey], []);
    await expect(write("pending")).rejects.toThrow();
    publication.settle(undefined, true);
    await expect(write("unknown")).rejects.toThrow();
    expect((await store.getSnapshot(target)).widgets).toEqual([]);
  }));
