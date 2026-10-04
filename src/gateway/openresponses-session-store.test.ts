import { existsSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "../plugin-state/plugin-state-store.test-helpers.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { lookupResponseSession, rememberResponseSession } from "./openresponses-session-store.js";
import {
  MAX_RESPONSE_SESSION_ENTRIES,
  RESPONSE_SESSION_RETENTION_MS,
  type ResponseSessionScope,
} from "./openresponses-session-store.types.js";

const scope = {
  authSubject: "synthetic-subject",
  agentId: "main",
  requestedSessionKey: "explicit-session",
};
const storeOptions = {
  ownerId: "core:openresponses",
  namespace: "response-sessions",
  maxEntries: MAX_RESPONSE_SESSION_ENTRIES,
  defaultTtlMs: RESPONSE_SESSION_RETENTION_MS,
} as const;
const current = () => {};

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

it("keeps reads and Incognito noncreating, and scoped continuity survives reopen until expiry", async () => {
  await withOpenClawTestState({ label: "openresponses-reopen" }, async ({ env }) => {
    const input = { ...scope, responseId: "resp_reopen" };
    expect(await lookupResponseSession(input, env)).toBeUndefined();
    for (const privateKeys of [
      { sessionKey: "agent:main:dashboard:incognito-private" },
      { sessionKey: "dashboard:incognito-private" },
      { sessionKey: "ordinary", requestedSessionKey: "agent:main:dashboard:incognito-private" },
      { sessionKey: "ordinary", requestedSessionKey: "dashboard:incognito-private" },
    ]) {
      await rememberResponseSession({ ...input, ...privateKeys }, current, env);
    }
    expect(existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);

    const sessionKey = "agent:main:openresponses:retained";
    await rememberResponseSession({ ...input, sessionKey }, current, env);
    await closeOpenClawStateDatabaseAsync();
    expect(await lookupResponseSession(input, env)).toBe(sessionKey);
    for (const mismatch of [
      { responseId: "unknown" },
      { authSubject: "other-subject" },
      { agentId: "other-agent" },
      { requestedSessionKey: "other-session" },
      { requestedSessionKey: undefined },
    ]) {
      expect(await lookupResponseSession({ ...input, ...mismatch }, env)).toBeUndefined();
    }
    const store = createCorePluginStateKeyedStore<ResponseSessionScope & { sessionKey: string }>({
      ...storeOptions,
      env,
    });
    const [entry] = await store.entries();
    expect(entry).toMatchObject({ key: input.responseId, value: { ...scope, sessionKey } });
    expect(entry!.expiresAt).toBe(entry!.createdAt + RESPONSE_SESSION_RETENTION_MS);
    const expiredAt = Date.now() - 1;
    seedPluginStateEntriesForTests([
      {
        pluginId: storeOptions.ownerId,
        namespace: storeOptions.namespace,
        key: input.responseId,
        value: entry!.value,
        createdAt: expiredAt - RESPONSE_SESSION_RETENTION_MS,
        expiresAt: expiredAt,
      },
    ]);
    await closeOpenClawStateDatabaseAsync();
    expect(await lookupResponseSession(input, env)).toBeUndefined();
  });
});

it("rolls back when caller authority expires before commit", async () => {
  await withOpenClawTestState({ label: "openresponses-authority" }, async ({ env }) => {
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let authorized = true;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            authorized = false;
          }
          admit(request, grant);
        }, attachment),
    );
    const input = { ...scope, responseId: "resp_revoked" };
    await expect(
      rememberResponseSession(
        { ...input, sessionKey: "revoked-session" },
        () => {
          if (!authorized) {
            throw new Error("synthetic requester revoked");
          }
        },
        env,
      ),
    ).rejects.toThrow(/plugin state/);
    expect(authorized).toBe(false);
    expect(await lookupResponseSession(input, env)).toBeUndefined();
  });
});
