import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionActor,
} from "../config/sessions/session-incognito-binding.js";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { prepareSessionSharingSource } from "./session-sharing-source.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let foreignActor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
const cfg = { agents: { entries: { main: {}, native: {} } } };
const context = createGatewayRequestContext(makeContextParams());
context.getRuntimeConfig = () => cfg;
context.getCommittedRuntimeConfig = () => cfg;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-sharing-source-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
  const foreign = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("incognito-sharing-foreign-") },
    authority,
  });
  assert(foreign);
  foreignActor = foreign;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await Promise.all([actor?.close(), foreignActor?.close()]);
  await closeOpenClawAgentDatabasesAsync();
  vi.unstubAllEnvs();
});

it("carries actor sharing authority through admission and synchronous transaction grants", async () => {
  const sessionKey = "agent:main:dashboard:incognito-sharing-grants";
  const sessionId = "sharing-grants";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId, updatedAt: 1, lifecycleRevision: "initial", incognito: true },
  });
  const host = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      const client = sharingPolicyClient({ scopes: ["operator.admin"] });
      const request = {
        client,
        method: "chat.send",
        requestParams: { sessionKey, agentId: "main" },
        context,
      };
      const initial = resolveSessionMutationAuthorization(request);
      expect(initial.error).toBeNull();
      initial.authorization!.assertCurrent();
      const result = await resolveSessionMutationAuthorizationAsync(request);
      expect(result.error).toBeNull();
      const authorization = result.authorization!;
      const prepared = await prepareSessionSourceAuthority(authorization.assertCurrent);
      try {
        expect(prepared.nativeSource).not.toBe(true);
        expect(prepared.checks).toEqual([]);
        await authorization.admittedInputAuthority!.withCurrent((facts, assertCurrent) => {
          expect(facts.entry?.sessionId).toBe(sessionId);
          expect(facts.readSource?.databaseIdentity).toBe(actor.identity.incarnation);
          assertCurrent();
          authorization.assertCurrent();
        });
        const appended = await actor.sessions.transcript(
          { assertCurrent: prepared.assertCurrent },
          {
            type: "session.message.append",
            input: {
              sessionKey,
              sessionId,
              fence: { expectedLifecycleRevision: "initial" },
              message: { role: "assistant", content: "Synthetic reply", timestamp: 1 },
            },
          },
        );
        expect(appended.ok).toBe(true);
        prepared.assertCurrent();
        client.connect.scopes = [];
        client.authenticatedUserId = "different-person";
        client.authenticatedUserProfile = {
          profileId: "different-person",
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        };
        expect(() => prepared.assertCurrent()).toThrow();
      } finally {
        await prepared.release?.();
      }
      expect(() => prepared.assertCurrent()).toThrow("no longer retained");
    });
    expect(host.queries).toEqual([]);
  } finally {
    host.restore();
  }
});

it.each(["sessions.move", "sessions.dispatch"] as const)(
  "prepares bound actor %s grants without changing incognito access policy",
  async (method) => {
    const sessionKey = `agent:main:dashboard:incognito-sharing-${method}`;
    const sessionId = `sharing-${method}`;
    await actor.sessions.create(authority, {
      sessionKey,
      entry: { sessionId, updatedAt: 1, lifecycleRevision: "initial", incognito: true },
    });
    const host = observeHostDataSql();
    try {
      await withIncognitoSessionActor(actor, async () => {
        const request = {
          method,
          requestParams: { key: sessionKey, agentId: "main" },
          expectedTarget: { agentId: "main", sessionKey, sessionId, storePath: actor.path },
          context,
        };
        const denied = resolveSessionMutationAuthorization({
          ...request,
          client: sharingPolicyClient({ user: "different-person" }),
        });
        expect(denied.error).not.toBeNull();
        expect(denied.authorization).toBeUndefined();
        const client = sharingPolicyClient({ scopes: ["operator.admin"] });
        const result = resolveSessionMutationAuthorization({ ...request, client });
        expect(result.error).toBeNull();
        const grant = await result.authorization!.prepareWorkerGrant!();
        try {
          grant.assertCurrent();
          const appended = await actor.sessions.transcript(
            { assertCurrent: grant.assertCurrent },
            {
              type: "session.message.append",
              input: {
                sessionKey,
                sessionId,
                fence: { expectedLifecycleRevision: "initial" },
                message: { role: "assistant", content: "Synthetic placement reply", timestamp: 1 },
              },
            },
          );
          expect(appended.ok).toBe(true);
          grant.assertCurrent();
          client.connect.scopes = [];
          client.authenticatedUserProfile = {
            profileId: "different-person",
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          };
          expect(() => grant.assertCurrent()).toThrow();
        } finally {
          await grant.release();
        }
        expect(() => grant.assertLifetimeCurrent()).toThrow();
      });
      expect(host.queries).toEqual([]);
    } finally {
      host.restore();
    }
  },
);

it.each([undefined, "agent:main:dashboard:incognito-captured-root"])(
  "retains an explicit actor root and rejects another enclosing actor (key: %s)",
  async (sessionKey) => {
    const target = { agentId: "main", storePath: actor.path, sessionKey };
    const before = captureOpenClawAgentDatabaseExecution.listIncognito(env);
    expect(captureIncognitoSessionBinding(target)).toBeUndefined();
    await withIncognitoSessionActor(actor, async () => {
      vi.stubEnv("OPENCLAW_STATE_DIR", "synthetic-unrelated-root");
      try {
        expect(captureIncognitoSessionBinding(target)?.actor).toBe(actor);
        await withIncognitoSessionActor(foreignActor, async () => {
          expect(() => captureIncognitoSessionBinding(target)).toThrow(
            "does not match its agent and state root",
          );
        });
      } finally {
        vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      }
    });
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual(before);
  },
);

it.each(["synchronous", "prepared"] as const)(
  "refuses %s sharing authorization redirected by a configured physical root",
  async (mode) => {
    const sessionKey = `agent:main:dashboard:incognito-configured-root-${mode}`;
    await actor.sessions.create(authority, {
      sessionKey,
      entry: { sessionId: `configured-root-${mode}`, updatedAt: 1, incognito: true },
    });
    await withIncognitoSessionActor(actor, async () => {
      let storePath = actor.path;
      const getRuntimeConfig = () => ({ ...cfg, session: { store: storePath } });
      const request = {
        client: sharingPolicyClient({ scopes: ["operator.admin"] }),
        method: "chat.send",
        requestParams: { sessionKey, agentId: "main" },
        context: {
          ...context,
          getRuntimeConfig,
          getCommittedRuntimeConfig: getRuntimeConfig,
        },
      };
      const resolve = () =>
        mode === "synchronous"
          ? resolveSessionMutationAuthorization(request)
          : resolveSessionMutationAuthorizationAsync(request);
      expect((await resolve()).error).toBeNull();
      storePath = foreignActor.path;
      await expect(Promise.resolve().then(resolve)).rejects.toThrow(
        "does not match its agent and state root",
      );
      storePath = "ordinary-logical-store/sessions.json";
      expect((await resolve()).error).toBeNull();
    });
  },
);

it("revokes a retained sharing source after session replacement", async () => {
  const sessionKey = "agent:main:dashboard:incognito-sharing-replacement";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: "original", updatedAt: 1, incognito: true },
  });
  await withIncognitoSessionActor(actor, async () => {
    const prepared = await prepareSessionSharingSource(
      { agentId: "main", canonicalKey: sessionKey, storeKey: sessionKey, storePath: actor.path },
      () => authority.assertCurrent(),
    );
    try {
      expect(prepared.target?.entry.sessionId).toBe("original");
      await replaceSessionEntry(
        { agentId: "main", env, sessionKey },
        { sessionId: "replacement", updatedAt: 2, incognito: true },
      );
      expect(() => prepared.assertCurrent()).toThrow("generation is no longer current");
    } finally {
      await prepared.release();
    }
  });
});

it("keeps ordinary unbound incognito authorization on the native owner", async () => {
  const sessionKey = "agent:native:dashboard:incognito-native-sharing";
  const before = captureOpenClawAgentDatabaseExecution.listIncognito(env);
  replaceSessionEntrySync(
    { agentId: "native", env, sessionKey },
    { sessionId: "native", updatedAt: 1, incognito: true },
  );
  const result = await resolveSessionMutationAuthorizationAsync({
    client: sharingPolicyClient({ scopes: ["operator.admin"] }),
    method: "chat.send",
    requestParams: { sessionKey, agentId: "native" },
    context,
  });
  expect(result.error).toBeNull();
  const prepared = await prepareSessionSourceAuthority(result.authorization!.assertCurrent);
  try {
    expect(prepared.nativeSource).toBe(true);
    expect(result.authorization!.admittedInputAuthority).toBeUndefined();
    prepared.assertCurrent();
  } finally {
    await prepared.release?.();
  }
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual(before);
});
