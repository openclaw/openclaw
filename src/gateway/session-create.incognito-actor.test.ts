import "../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
let childActor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
const cfg = { agents: { ownership: "explicit" as const, entries: { main: {}, other: {} } } };
const authority = { assertCurrent() {} };
const common = {
  cfg,
  incognito: true,
  commandSource: "test",
  operatorRoleActor: { kind: "system" as const },
};
const key = (name: string, agentId = "main") => `agent:${agentId}:dashboard:incognito-${name}`;

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "actor-session-create" });
  await state.writeConfig(cfg);
  actor = await openIncognitoTestActor(state.env, authority);
  childActor = await openIncognitoTestActor(state.env, authority, "other");
});
afterAll(async () => {
  await Promise.all([actor?.close(), childActor?.close()]);
  await state?.cleanup();
});

it("creates only at persistence and publishes actor facts before observers without host SQL", async () => {
  const sessionKey = key("first");
  const preparing = createDeferredCore();
  const proceed = createDeferredCore();
  const published: string[] = [];
  const stop = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === sessionKey) {
      published.push(actor.sessions.readSharing(sessionKey)?.entry?.sessionId ?? "missing");
    }
  });
  const sql = observeHostDataSql();
  try {
    const creation = withIncognitoSessionActor(actor, () =>
      createGatewaySession({
        ...common,
        key: sessionKey,
        prepareLifecycle: async () => {
          preparing.resolve();
          await proceed.promise;
          return { ok: true, value: {} };
        },
      }),
    );
    await preparing.promise;
    expect((await actor.sessions.read(authority, { sessionKey })).entry).toBeUndefined();
    proceed.resolve();
    const created = await creation;
    expect(created).toMatchObject({
      ok: true,
      entry: { incognito: true },
      postCommit: { status: "completed" },
    });
    if (!created.ok) throw new Error(created.error.message);
    expect(published).toEqual([created.entry.sessionId]);
    expect(sql.queries).toEqual([]);
  } finally {
    proceed.resolve();
    stop();
    sql.restore();
  }
});

it("inherits from a retained parent actor in another agent namespace", async () => {
  const parent = await withIncognitoSessionActor(actor, () =>
    createGatewaySession({
      ...common,
      key: key("parent"),
      communication: { receive: "always" },
    }),
  );
  if (!parent.ok) throw new Error(parent.error.message);
  const sql = observeHostDataSql();
  try {
    const created = await withIncognitoSessionActor(childActor, () =>
      createGatewaySession({
        ...common,
        agentId: "other",
        parentSessionKey: parent.key,
      }),
    );
    expect(created).toMatchObject({ ok: true, agentId: "other", entry: { incognito: true } });
    if (!created.ok) throw new Error(created.error.message);
    const stored = await childActor.sessions.read(authority, { sessionKey: created.key });
    expect(stored.entry?.parentSessionKey).toBe(parent.key);
    expect(stored.entry?.communication).toEqual({ receive: "always" });
    const staleChildKey = key("stale-parent", "other");
    await expect(
      withIncognitoSessionActor(childActor, () =>
        createGatewaySession({
          ...common,
          agentId: "other",
          key: staleChildKey,
          parentSessionKey: parent.key,
          prepareLifecycle: async () => {
            await withIncognitoSessionActor(actor, () =>
              patchSessionEntryCore({ agentId: "main", sessionKey: parent.key }, () => ({
                communication: { receive: "never" },
              })),
            );
            return { ok: true, value: {} };
          },
        }),
      ),
    ).rejects.toThrow("Parent session changed before child creation");
    expect(
      (await childActor.sessions.read(authority, { sessionKey: staleChildKey })).entry,
    ).toBeUndefined();
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("refuses revoked preparation without creating a session", async () => {
  const sessionKey = key("revoked");
  let current = true;
  await expect(
    withIncognitoSessionActor(actor, () =>
      createGatewaySession({
        ...common,
        key: sessionKey,
        commitGuard() {
          if (!current) throw new Error("creation revoked");
        },
        prepareLifecycle: async () => {
          current = false;
          return { ok: true, value: {} };
        },
      }),
    ),
  ).rejects.toThrow("creation revoked");
  expect((await actor.sessions.read(authority, { sessionKey })).entry).toBeUndefined();
});

it("keeps unbound incognito native and does not resurrect explicitly absent actors", async () => {
  const actorsBefore = captureOpenClawAgentDatabaseExecution.listIncognito(state.env);
  const created = await createGatewaySession({ ...common, key: key("native") });
  expect(created).toMatchObject({ ok: true, entry: { incognito: true } });
  expect(await readSessionEntryReadOnlyInWorker({ sessionKey: key("native") })).toBeDefined();
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(state.env)).toEqual(actorsBefore);
  await expect(
    withIncognitoSessionBinding(
      {
        kind: "absent",
        agentId: "absent",
        env: state.env,
        authority,
      },
      () =>
        createGatewaySession({
          ...common,
          cfg: { agents: { ownership: "explicit", entries: { absent: {} } } },
          agentId: "absent",
          key: key("absent", "absent"),
        }),
    ),
  ).rejects.toThrow(/missing|unavailable|absent/i);
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(state.env)).toEqual(actorsBefore);
});
