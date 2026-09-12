import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { writeAgentRunTerminalReceipt } from "../../state/agent-run-terminal-receipts.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { resetAgentJobStateForTest } from "../agent-turn/agent-job.js";
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
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(() => {
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  resetAgentJobStateForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function profileClient(profileId: string) {
  return {
    authenticatedUserProfile: { profileId },
    connect: { scopes: ["operator.read"] },
  } as never;
}

function restrictedProfileConfig() {
  return {
    gateway: {
      roles: {
        default: "limited",
        definitions: {
          limited: {
            sessions: { others: "none" },
            agents: ["main"],
            scopes: ["operator.read"],
          },
        },
      },
    },
  };
}

async function seedRecoveredRun(params: {
  createdProfileId: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
}): Promise<void> {
  const agentId = "main";
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  await replaceSessionEntry(
    { agentId, sessionKey: params.sessionKey, storePath },
    {
      sessionId: params.sessionId,
      updatedAt: 42,
      createdActor: { type: "human", source: "profile", id: params.createdProfileId },
    },
  );
  writeAgentRunTerminalReceipt({
    runId: params.runId,
    owner: { agentId, sessionKey: params.sessionKey, sessionId: params.sessionId },
    terminalJson: JSON.stringify({ status: "ok", startedAt: 10, endedAt: 20 }),
  });
  resetAgentJobStateForTest();
  closeOpenClawStateDatabaseForTest();
}

async function configureFixedSessionStore(label = "default"): Promise<string> {
  const storePath = path.join(requireStateDir(), `shared-abort-sessions-${label}`, "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, "{}\n", "utf8");
  testState.sessionStorePath = storePath;
  testState.agentsConfig = { list: [{ id: "main", default: true }] };
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
    chatAbortControllers: new Map([[runId, activeRun]]),
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
  expect(activeRun.controller.signal.aborted).toBe(true);
});

test("sessions.abort aborts an exact active run for an unconfigured agent without a store", async () => {
  const agentId = "active-only";
  const sessionKey = `agent:${agentId}:running`;
  const runId = "run-active-only";
  const activeRun = createActiveRun(sessionKey, { agentId });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    chatAbortControllers: new Map([[runId, activeRun]]),
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
  expect(activeRun.controller.signal.aborted).toBe(true);
  const env = { OPENCLAW_STATE_DIR: requireStateDir() };
  expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "agents", agentId))).toBe(false);
  expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId, env }))).toBe(false);
  expect(listOpenClawRegisteredAgentDatabases({ env }).map((entry) => entry.agentId)).not.toContain(
    agentId,
  );
});

test("sessions.abort reports an exact active configured run", async () => {
  const agentId = "main";
  const sessionKey = "agent:main:exact-active";
  const runId = "run-exact-active";
  const activeRun = createActiveRun(sessionKey, { agentId });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    chatAbortControllers: new Map([[runId, activeRun]]),
  });

  const result = await directSessionReq(
    "sessions.abort",
    { key: sessionKey, runId },
    { context: abortContext },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: {
      ok: true,
      abortedRunId: runId,
      status: "aborted",
      runState: "active",
    },
  });
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
    chatAbortControllers: new Map([[runId, activeRun]]),
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
  expect(activeRun.controller.signal.aborted).toBe(true);
});

test("sessions.abort rejects an unconfigured agent found only in a fixed legacy store", async () => {
  const storePath = await configureFixedSessionStore("legacy");
  const sessionKey = "agent:retired:legacy";
  fs.writeFileSync(
    storePath,
    JSON.stringify({ [sessionKey]: { sessionId: "session-retired-legacy", updatedAt: 42 } }),
    "utf8",
  );

  const result = await directSessionReq("sessions.abort", { key: sessionKey });

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: 'agent "retired" not found' },
  });
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "retired",
  }).path;
  expect(sqlitePath).toBeDefined();
  expect(fs.existsSync(sqlitePath!)).toBe(false);
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
  testState.agentsConfig = { list: [{ id: "main", default: true }] };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
  const activeRun = createActiveRun(sessionKey, { agentId, sessionId });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    chatAbortControllers: new Map([[runId, activeRun]]),
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
  expect(activeRun.controller.signal.aborted).toBe(true);
});

test.each(["main", "work"])("sessions.abort still resolves the %s agent store", async (agentId) => {
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
  ).toBe(true);
});

test("agent.wait recovers an authorized terminal result through real storage and session boundaries", async () => {
  const runId = "run-wait-authorized-restart";
  const sessionKey = "agent:main:wait-authorized-restart";
  const owner = ensureProfileForEmail("wait-authorized-owner@example.test");
  await seedRecoveredRun({
    createdProfileId: owner.id,
    runId,
    sessionId: "session-wait-authorized-restart",
    sessionKey,
  });

  const result = await directSessionReq(
    "agent.wait",
    { runId, timeoutMs: 0 },
    {
      client: profileClient(owner.id),
      context: { getRuntimeConfig: () => restrictedProfileConfig() },
    },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: { runId, status: "ok", startedAt: 10, endedAt: 20 },
  });
});

test("agent.wait rejects an unrelated caller before exposing a recovered result", async () => {
  const runId = "run-wait-unrelated-restart";
  const owner = ensureProfileForEmail("wait-unrelated-owner@example.test");
  const other = ensureProfileForEmail("wait-unrelated-other@example.test");
  await seedRecoveredRun({
    createdProfileId: owner.id,
    runId,
    sessionId: "session-wait-unrelated-restart",
    sessionKey: "agent:main:wait-unrelated-restart",
  });

  const result = await directSessionReq(
    "agent.wait",
    { runId, timeoutMs: 0 },
    {
      client: profileClient(other.id),
      context: { getRuntimeConfig: () => restrictedProfileConfig() },
    },
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "agent run was not found" },
  });
  expect(result.payload).toBeUndefined();
});

test("agent.wait rejects a revoked caller before exposing a recovered result", async () => {
  const runId = "run-wait-revoked-restart";
  const sessionKey = "agent:main:wait-revoked-restart";
  const sessionId = "session-wait-revoked-restart";
  const owner = ensureProfileForEmail("wait-revoked-owner@example.test");
  const replacementOwner = ensureProfileForEmail("wait-revoked-new-owner@example.test");
  await seedRecoveredRun({
    createdProfileId: owner.id,
    runId,
    sessionId,
    sessionKey,
  });
  const storePath = path.join(requireStateDir(), "agents", "main", "sessions", "sessions.json");
  await deleteSessionEntryLifecycle({
    storePath,
    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    archiveTranscript: false,
  });
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    {
      sessionId,
      updatedAt: 43,
      createdActor: { type: "human", source: "profile", id: replacementOwner.id },
    },
  );

  const result = await directSessionReq(
    "agent.wait",
    { runId, timeoutMs: 0 },
    {
      client: profileClient(owner.id),
      context: { getRuntimeConfig: () => restrictedProfileConfig() },
    },
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "agent run was not found" },
  });
  expect(result.payload).toBeUndefined();
});

test("agent.wait rejects a replacement session before exposing a recovered result", async () => {
  const runId = "run-wait-replacement-restart";
  const sessionKey = "agent:main:wait-replacement-restart";
  const owner = ensureProfileForEmail("wait-replacement-owner@example.test");
  await seedRecoveredRun({
    createdProfileId: owner.id,
    runId,
    sessionId: "session-wait-retained",
    sessionKey,
  });
  const storePath = path.join(requireStateDir(), "agents", "main", "sessions", "sessions.json");
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    {
      sessionId: "session-wait-replacement",
      updatedAt: 43,
      createdActor: { type: "human", source: "profile", id: owner.id },
    },
  );

  const result = await directSessionReq(
    "agent.wait",
    { runId, timeoutMs: 0 },
    {
      client: profileClient(owner.id),
      context: { getRuntimeConfig: () => restrictedProfileConfig() },
    },
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "agent run was not found" },
  });
  expect(result.payload).toBeUndefined();
});

test("sessions.abort reports an authorized exact completed run after hot state is lost", async () => {
  const agentId = "main";
  const sessionKey = "agent:main:durable-completed";
  const sessionId = "session-durable-completed";
  const runId = "run-durable-completed";
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
  writeAgentRunTerminalReceipt({
    runId,
    owner: { agentId, sessionKey, sessionId },
    terminalJson: JSON.stringify({ status: "ok", startedAt: 10, endedAt: 20 }),
  });

  const result = await directSessionReq("sessions.abort", { runId });

  expect(result).toMatchObject({
    ok: true,
    payload: {
      ok: true,
      abortedRunId: null,
      status: "no-active-run",
      runState: "completed",
      terminalStatus: "ok",
    },
  });
});

test("sessions.abort rejects a recovered run after its session key is reused", async () => {
  const agentId = "main";
  const sessionKey = "agent:main:durable-reused";
  const retainedSessionId = "session-durable-retained";
  const runId = "run-durable-reused";
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  await replaceSessionEntry(
    { agentId, sessionKey, storePath },
    { sessionId: "session-durable-replacement", updatedAt: 43 },
  );
  writeAgentRunTerminalReceipt({
    runId,
    owner: { agentId, sessionKey, sessionId: retainedSessionId },
    terminalJson: JSON.stringify({ status: "ok", startedAt: 10, endedAt: 20 }),
  });

  const result = await directSessionReq("sessions.abort", { runId });

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "unauthorized" },
  });
  expect(result).not.toHaveProperty("payload.terminalStatus");
});

test("sessions.abort reports an exact unknown run without changing legacy status", async () => {
  const result = await directSessionReq("sessions.abort", { runId: "run-unknown-durable" });

  expect(result).toMatchObject({
    ok: true,
    payload: {
      ok: true,
      abortedRunId: null,
      status: "no-active-run",
      runState: "unknown",
    },
  });
  expect(result.payload).not.toHaveProperty("terminalStatus");
});

test("sessions.abort fails closed when durable ownership conflicts with the request", async () => {
  const agentId = "main";
  const sessionKey = "agent:main:durable-private";
  const sessionId = "session-durable-private";
  const runId = "run-durable-private";
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
  writeAgentRunTerminalReceipt({
    runId,
    owner: { agentId, sessionKey, sessionId },
    terminalJson: JSON.stringify({ status: "error", endedAt: 20 }),
  });

  const result = await directSessionReq("sessions.abort", { runId, agentId: "work" });

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "unauthorized" },
  });
  expect(result).not.toHaveProperty("payload.terminalStatus");
});
