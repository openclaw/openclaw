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
import { testState } from "../test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { createActiveRun, createChatAbortContext } from "./chat.abort.test-helpers.js";

setupGatewaySessionsHandlerTestHarness();

function statePath(...parts: string[]) {
  const value = process.env.OPENCLAW_STATE_DIR;
  return path.join(expectDefined(value || undefined, "OPENCLAW_STATE_DIR is required"), ...parts);
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
  const storePath = statePath("shared-abort-sessions-default", "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, "{}\n", "utf8");
  testState.agentsConfig = { entries: { main: {} } };
  expect((await configureStore(storePath)).getRuntimeConfig().session?.store).toBe(storePath);
  return storePath;
}

function agentSqlitePath(agentId: string) {
  return resolveOpenClawAgentSqlitePath({
    agentId,
    env: { OPENCLAW_STATE_DIR: statePath() },
  });
}

function expectNoAgentStore(agentId: string) {
  const env = { OPENCLAW_STATE_DIR: statePath() };
  expect(fs.existsSync(statePath("agents", agentId))).toBe(false);
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

function expectAborted(result: Awaited<ReturnType<typeof directSessionReq>>, runId: string) {
  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: runId, status: "aborted" },
  });
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
    const agentId = `retired-${layout}`;
    const sessionKey = `agent:${agentId}:${layout === "absent" ? "running" : "existing"}`;
    const sessionId = layout === "absent" ? undefined : `session-${agentId}`;
    const runId = `run-${agentId}`;
    let storePath = statePath("agents", agentId, "sessions", "sessions.json");
    if (layout === "fixed") {
      storePath = await configureFixedSessionStore();
    } else if (layout === "template") {
      const template = statePath("external-abort-stores", "sessions-{agentId}.json");
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

    expectAborted(result, runId);
    expect(activeRun.input.abortSignal.aborted).toBe(true);
    if (layout === "absent") {
      expectNoAgentStore(agentId);
    }
  },
);

test("native Stop ACK precedes cleanup without provisioning or admitting a successor", async ({
  signal,
}) => {
  const agentId = "native-active-only";
  const sessionKey = "agent:" + agentId + ":running";
  const sessionId = "native-active-only-session";
  const runId = "native-active-only-run";
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const storePath = resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId });
  const aborted = createDeferred();
  const abort = vi.fn(() => aborted.resolve());
  const handle = createEmbeddedRunHandle({ runId, abort });
  registerTestEmbeddedRun(sessionId, handle, sessionKey, undefined, agentId);
  const native = expectDefined(resolveActiveEmbeddedRunOwnerByRunId(runId), "native owner");
  let nativeSettled = false;
  const nativeSettlement = native.waitForSettlement().then(() => {
    nativeSettled = true;
  });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    getSessionEventSubscriberConnIds: () => new Set(),
  });
  const request = directSessionReq(
    "sessions.abort",
    { key: sessionKey, runId },
    { context: abortContext },
  );
  let successor: Promise<void> | undefined;
  let successorStarted = false;
  try {
    await withinTest(aborted.promise, signal);
    expect(abort).toHaveBeenCalledOnce();
    expect(nativeSettled).toBe(false);
    successor = withSessionTurn({ sessionKey, sessionId, agentId, storePath }, async () => {
      successorStarted = true;
    });
    expectAborted(await withinTest(request, signal), runId);
    expect([nativeSettled, successorStarted]).toEqual([false, false]);
    expect(fs.existsSync(statePath("agents", agentId))).toBe(false);
    expect(fs.existsSync(agentSqlitePath(agentId))).toBe(false);
    clearTestEmbeddedRun(sessionId, handle, sessionKey);
    await withinTest(Promise.all([nativeSettlement, successor]), signal);
    expect([nativeSettled, successorStarted]).toEqual([true, true]);
  } finally {
    clearTestEmbeddedRun(sessionId, handle, sessionKey);
    await Promise.allSettled([request, nativeSettlement, successor]);
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
