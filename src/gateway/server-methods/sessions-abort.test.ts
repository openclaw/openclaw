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

function requireStateDir() {
  const value = process.env.OPENCLAW_STATE_DIR;
  return expectDefined(value || undefined, "OPENCLAW_STATE_DIR is required");
}

async function configureStore(storePath?: string) {
  testState.sessionStorePath = storePath;
  const config = await getGatewayConfigModule();
  config.clearRuntimeConfigSnapshot();
  config.clearConfigCache();
  return config;
}

beforeEach(async () => {
  testState.sessionConfig = undefined;
  testState.agentsConfig = { entries: { main: {}, work: {} } };
  await configureStore();
});

afterEach(() => {
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function configureFixedSessionStore(): Promise<string> {
  const storePath = path.join(requireStateDir(), "shared-abort-sessions-default", "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, "{}\n", "utf8");
  testState.agentsConfig = { entries: { main: {} } };
  expect((await configureStore(storePath)).getRuntimeConfig().session?.store).toBe(storePath);
  return storePath;
}

function agentSqlitePath(agentId: string) {
  return resolveOpenClawAgentSqlitePath({
    agentId,
    env: { OPENCLAW_STATE_DIR: requireStateDir() },
  });
}

function expectNoAgentStore(agentId: string) {
  const env = { OPENCLAW_STATE_DIR: requireStateDir() };
  expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "agents", agentId))).toBe(false);
  expect(fs.existsSync(agentSqlitePath(agentId))).toBe(false);
  expect(listOpenClawRegisteredAgentDatabases({ env }).map((entry) => entry.agentId)).not.toContain(
    agentId,
  );
}

function detachedAbortContext(
  sources?: NonNullable<Parameters<typeof createChatAbortContext>[0]>["sources"],
) {
  const { getRuntimeConfig: _getRuntimeConfig, ...context } = createChatAbortContext({ sources });
  return context;
}

test.each([false, true])(
  "rejects an unknown agent without provisioning (fixed store: %s)",
  async (fixed) => {
    const storePath = fixed ? await configureFixedSessionStore() : undefined;
    const result = await directSessionReq("sessions.abort", { key: "agent:ghost:missing" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: 'agent "ghost" not found' },
    });
    if (storePath) {
      const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "ghost",
      }).path;
      expect(sqlitePath).toBeDefined();
      expect(fs.existsSync(sqlitePath!)).toBe(false);
    } else {
      expectNoAgentStore("ghost");
    }
  },
);

test.each(["default", "fixed", "template", "absent"] as const)(
  "aborts a retired agent with a %s store",
  async (layout) => {
    const agentId =
      layout === "absent" ? "active-only" : layout === "template" ? "template-retired" : "retired";
    const fixtureId = layout === "fixed" ? "retired-fixed" : agentId;
    const sessionKey = `agent:${agentId}:${layout === "absent" ? "running" : "existing"}`;
    const sessionId = layout === "absent" ? undefined : `session-${fixtureId}`;
    const runId = `run-${fixtureId}`;
    let storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
    if (layout === "fixed") {
      storePath = await configureFixedSessionStore();
    } else if (layout === "template") {
      const template = path.join(
        requireStateDir(),
        "external-abort-stores",
        "sessions-{agentId}.json",
      );
      testState.agentsConfig = { entries: { main: {} } };
      await configureStore(template);
      storePath = template.replace("{agentId}", agentId);
    }
    if (sessionId) {
      await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
    }
    const activeRun = createActiveRun(sessionKey, { agentId, ...(sessionId ? { sessionId } : {}) });
    const result = await directSessionReq(
      "sessions.abort",
      { key: sessionKey },
      { context: detachedAbortContext(new Map([[runId, activeRun]])) },
    );

    expect(result).toMatchObject({
      ok: true,
      payload: { ok: true, abortedRunId: runId, status: "aborted" },
    });
    expect(activeRun.input.abortSignal.aborted).toBe(true);
    if (layout === "absent") {
      expectNoAgentStore(agentId);
    }
  },
);

test("native Stop persists before ACK and fences its successor until cleanup", async ({
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
    expect({ finished, nativeSettled }).toEqual({ finished: false, nativeSettled: false });
    successor = withSessionTurn({ sessionKey, sessionId, agentId, storePath }, async () => {
      successorStarted = true;
    });
    publish.resolve();
    await expect(withinTest(request, signal)).resolves.toMatchObject({
      ok: true,
      payload: { ok: true, abortedRunId: runId, status: "aborted" },
    });
    expect([nativeSettled, successorStarted]).toEqual([false, false]);
    const env = { OPENCLAW_STATE_DIR: requireStateDir() };
    expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "agents", agentId))).toBe(false);
    expect(fs.existsSync(agentSqlitePath(agentId))).toBe(false);
    clearTestEmbeddedRun(sessionId, handle, sessionKey);
    await withinTest(Promise.all([nativeSettlement, successor]), signal);
    expect([nativeSettled, successorStarted]).toEqual([true, true]);
  } finally {
    publish.resolve();
    clearTestEmbeddedRun(sessionId, handle, sessionKey);
    await Promise.allSettled([request, nativeSettlement, successor]);
    persistence.mockRestore();
  }
});

test("sessions.abort does not provision a configured agent store when no run exists", async () => {
  const agentId = "main";
  const result = await directSessionReq("sessions.abort", {
    key: `agent:${agentId}:missing`,
  });

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: null, status: "no-active-run" },
  });
  expect(fs.existsSync(agentSqlitePath(agentId))).toBe(false);
});
