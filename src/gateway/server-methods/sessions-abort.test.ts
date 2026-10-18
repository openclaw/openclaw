import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { resolveActiveEmbeddedRunOwnerByRunId } from "../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  registerTestEmbeddedRun,
  clearTestEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as lifecyclePersistence from "../session-lifecycle-state.js";
import { testState } from "../test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { createActiveRun, createChatAbortContext } from "./chat.abort.test-helpers.js";

setupGatewaySessionsHandlerTestHarness();

function requireStateDir(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required");
  }
  return stateDir;
}

beforeEach(async () => {
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.agentsConfig = { entries: { main: {}, work: {} } };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(() => {
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function configureFixedSessionStore(label = "default"): Promise<string> {
  const storePath = path.join(requireStateDir(), `shared-abort-sessions-${label}`, "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, "{}\n", "utf8");
  testState.sessionStorePath = storePath;
  testState.agentsConfig = { entries: { main: {} } };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  expect(getRuntimeConfig().session?.store).toBe(storePath);
  return storePath;
}

test("sessions.abort rejects an unknown agent without provisioning its store", async () => {
  const result = await directSessionReq("sessions.abort", { key: "agent:ghost:zzz" });

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: 'agent "ghost" not found' },
  });
  const env = { OPENCLAW_STATE_DIR: requireStateDir() };
  expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "agents", "ghost"))).toBe(false);
  expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "ghost", env }))).toBe(false);
  expect(listOpenClawRegisteredAgentDatabases({ env }).map((entry) => entry.agentId)).not.toContain(
    "ghost",
  );
});

test("sessions.abort aborts a pre-existing session after its agent is removed from config", async () => {
  const agentId = "retired";
  const sessionKey = `agent:${agentId}:existing`;
  const sessionId = "session-retired";
  const runId = "run-retired";
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
  const activeRun = createActiveRun(sessionKey, { agentId, sessionId });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    sources: new Map([[runId, activeRun]]),
  });

  const result = await directSessionReq(
    "sessions.abort",
    { key: sessionKey },
    {
      context: abortContext,
    },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: runId, status: "aborted" },
  });
  expect(activeRun.input.abortSignal.aborted).toBe(true);
});

test("sessions.abort aborts an exact active run for an unconfigured agent without a store", async () => {
  const agentId = "active-only";
  const sessionKey = `agent:${agentId}:running`;
  const runId = "run-active-only";
  const activeRun = createActiveRun(sessionKey, { agentId });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    sources: new Map([[runId, activeRun]]),
  });

  const result = await directSessionReq(
    "sessions.abort",
    { key: sessionKey },
    { context: abortContext },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: runId, status: "aborted" },
  });
  expect(activeRun.input.abortSignal.aborted).toBe(true);
  const env = { OPENCLAW_STATE_DIR: requireStateDir() };
  expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "agents", agentId))).toBe(false);
  expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId, env }))).toBe(false);
  expect(listOpenClawRegisteredAgentDatabases({ env }).map((entry) => entry.agentId)).not.toContain(
    agentId,
  );
});

test("sessions.abort acknowledges native Stop after persistence while cleanup fences its successor", async ({
  signal,
}) => {
  const agentId = "native-active-only";
  const sessionKey = "agent:" + agentId + ":running";
  const sessionId = "native-active-only-session";
  const runId = "native-active-only-run";
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const storePath = resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId });
  const abort = vi.fn();
  const handle = createEmbeddedRunHandle({ runId, abort });
  registerTestEmbeddedRun(sessionId, handle, sessionKey, undefined, agentId);
  const native = expectDefined(resolveActiveEmbeddedRunOwnerByRunId(runId), "native owner");
  let nativeSettled = false;
  const nativeSettlement = native.waitForSettlement().then(() => {
    nativeSettled = true;
  });
  const persisted = createDeferred();
  const publish = createDeferred();
  const persist = lifecyclePersistence.persistGatewaySessionLifecycleEvent;
  const persistence = vi
    .spyOn(lifecyclePersistence, "persistGatewaySessionLifecycleEvent")
    .mockImplementation(async (params) => {
      const result = await persist(params);
      persisted.resolve();
      await publish.promise;
      return result;
    });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  let finished = false;
  const request = directSessionReq(
    "sessions.abort",
    { key: sessionKey, runId },
    { context: abortContext },
  ).then((result) => {
    finished = true;
    return result;
  });
  let successor: Promise<void> | undefined;
  let successorStarted = false;
  try {
    await withinTest(persisted.promise, signal);
    expect(abort).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    expect(nativeSettled).toBe(false);
    successor = withSessionTurn({ sessionKey, sessionId, agentId, storePath }, async () => {
      successorStarted = true;
    });
    publish.resolve();
    await expect(withinTest(request, signal)).resolves.toMatchObject({
      ok: true,
      payload: { ok: true, abortedRunId: runId, status: "aborted" },
    });
    expect(nativeSettled).toBe(false);
    expect(successorStarted).toBe(false);
    const env = { OPENCLAW_STATE_DIR: requireStateDir() };
    expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "agents", agentId))).toBe(false);
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId, env }))).toBe(false);
    clearTestEmbeddedRun(sessionId, handle, sessionKey);
    await withinTest(Promise.all([nativeSettlement, successor]), signal);
    expect(nativeSettled).toBe(true);
    expect(successorStarted).toBe(true);
  } finally {
    publish.resolve();
    clearTestEmbeddedRun(sessionId, handle, sessionKey);
    await Promise.allSettled([request, nativeSettlement, successor]);
    persistence.mockRestore();
  }
});

test("sessions.abort rejects an unknown agent when only the fixed store file exists", async () => {
  const storePath = await configureFixedSessionStore();

  const result = await directSessionReq("sessions.abort", { key: "agent:ghost:missing" });

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: 'agent "ghost" not found' },
  });
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "ghost",
  }).path;
  expect(sqlitePath).toBeDefined();
  expect(fs.existsSync(sqlitePath!)).toBe(false);
});

test("sessions.abort aborts an unconfigured agent with rows in a fixed store", async () => {
  const storePath = await configureFixedSessionStore();
  const agentId = "retired";
  const sessionKey = `agent:${agentId}:existing`;
  const sessionId = "session-retired-fixed";
  const runId = "run-retired-fixed";
  await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
  const activeRun = createActiveRun(sessionKey, { agentId, sessionId });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    sources: new Map([[runId, activeRun]]),
  });

  const result = await directSessionReq(
    "sessions.abort",
    { key: sessionKey },
    { context: abortContext },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: runId, status: "aborted" },
  });
  expect(activeRun.input.abortSignal.aborted).toBe(true);
});

test("sessions.abort finds a retired store only reachable through its deterministic template", async () => {
  const agentId = "template-retired";
  const sessionKey = `agent:${agentId}:existing`;
  const sessionId = "session-template-retired";
  const runId = "run-template-retired";
  const storeTemplate = path.join(
    requireStateDir(),
    "external-abort-stores",
    "sessions-{agentId}.json",
  );
  const storePath = storeTemplate.replace("{agentId}", agentId);
  testState.sessionStorePath = storeTemplate;
  testState.agentsConfig = { entries: { main: {} } };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
  const activeRun = createActiveRun(sessionKey, { agentId, sessionId });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    sources: new Map([[runId, activeRun]]),
  });

  const result = await directSessionReq(
    "sessions.abort",
    { key: sessionKey },
    { context: abortContext },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: runId, status: "aborted" },
  });
  expect(activeRun.input.abortSignal.aborted).toBe(true);
});

test.each(["main"])(
  "sessions.abort does not provision the %s agent store when no run exists",
  async (agentId) => {
    const result = await directSessionReq("sessions.abort", {
      key: `agent:${agentId}:missing`,
    });

    expect(result).toMatchObject({
      ok: true,
      payload: { ok: true, abortedRunId: null, status: "no-active-run" },
    });
    expect(
      fs.existsSync(
        resolveOpenClawAgentSqlitePath({
          agentId,
          env: { OPENCLAW_STATE_DIR: requireStateDir() },
        }),
      ),
    ).toBe(false);
  },
);
