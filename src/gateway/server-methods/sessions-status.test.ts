import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  type SessionsStatusResult,
  validateSessionsStatusParams,
  validateSessionsStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_INPUT_RUN_ID_MAX_CHARS } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../../packages/gateway-protocol/src/schema/primitives.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { registerChatAbortController } from "../chat-abort.js";
import { handleGatewayRequest } from "../server-methods.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import { setupGatewaySessionsHandlerTestHarness } from "../test/server-sessions.test-helpers.js";
import { identifiedClient, requestContext } from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

setupGatewaySessionsHandlerTestHarness();
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

const key = "agent:main:status";
const sessionId = "status-session";
const scope = { agentId: "main", sessionKey: key };
const cfg: OpenClawConfig = {
  agents: { list: [{ id: "main", default: true }, { id: "work" }] },
};

async function seed(overrides: Partial<InternalSessionEntry> = {}) {
  await replaceSessionEntry(scope, {
    sessionId,
    updatedAt: 30,
    ...overrides,
  });
}

async function request(
  params: Record<string, unknown> = { key },
  options: { client?: GatewayClient; context?: GatewayRequestContext } = {},
) {
  const responses: Parameters<RespondFn>[] = [];
  await handleGatewayRequest({
    req: { type: "req", id: "status-request", method: "sessions.status", params },
    client: options.client ?? identifiedClient("status-reader"),
    context: options.context ?? requestContext(cfg),
    isWebchatConnect: () => false,
    respond: (...args) => responses.push(args),
  });
  expect(responses).toHaveLength(1);
  const [ok, payload, error] = responses[0]!;
  if (ok) {
    expect(validateSessionsStatusResult(payload)).toBe(true);
  }
  return { ok, payload: payload as SessionsStatusResult | undefined, error };
}

test.each(["done", "failed", "killed", "timeout"] as const)(
  "returns only the selected stored %s fact while a successor is active",
  async (status) => {
    await seed({
      status,
      lastRunId: "public-run",
      lifecycleRunId: "provider-run",
      startedAt: 10,
      endedAt: 20,
      label: "private title",
      lastRunError: "private failure detail",
      authProfileOverride: "private-auth-profile",
    });
    const before = loadSessionEntry(scope);
    const context = requestContext(cfg);
    const successor = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: "successor-run",
      sessionId,
      sessionKey: key,
      agentId: "main",
      timeoutMs: 60_000,
      kind: "agent",
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const transcriptRead = vi
      .spyOn(transcriptReaders, "readRecentSessionUsageFromTranscript")
      .mockImplementation(() => {
        throw new Error("status must not inspect transcripts");
      });
    try {
      const result = await request({ key, sessionId, expectedRunId: "public-run" }, { context });
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({
        observedAt: 1_000,
        session: {
          key,
          agentId: "main",
          sessionId,
          status: "running",
          hasActiveRun: true,
          updatedAt: before?.updatedAt,
          matchedRun: { runId: "public-run", status, endedAt: 20 },
        },
      });
      for (const selection of [{ expectedRunId: "provider-run", sessionId }, {}]) {
        const unselected = await request({ key, ...selection }, { context });
        expect(unselected.payload?.session?.matchedRun).toBeNull();
      }
      clock.mockReturnValue(2_000);
      const refreshed = await request({ key, sessionId, expectedRunId: "public-run" }, { context });
      expect(refreshed.payload).toEqual({ ...result.payload, observedAt: 2_000 });
      expect(loadSessionEntry(scope)).toEqual(before);
      expect(transcriptRead).not.toHaveBeenCalled();
    } finally {
      successor.cleanup();
    }
  },
);

test.each([
  { name: "running", status: "running" as const, lastRunId: "public-run" },
  { name: "queued", status: "queued" as const, lastRunId: "public-run" },
  { name: "restart interruption", status: "running" as const, lifecycleRunId: "provider-run" },
  { name: "unknown" },
  { name: "unidentifiable terminal", status: "done" as const },
  { name: "replaced terminal", status: "done" as const, lastRunId: "successor-run" },
])("does not invent selected-run truth for $name", async ({ name: _name, ...entry }) => {
  await seed(entry);
  const result = await request({ key, sessionId, expectedRunId: "public-run" });
  expect(result.ok).toBe(true);
  expect(result.payload?.session).toMatchObject({ hasActiveRun: false, matchedRun: null });
  expect(result.payload?.session?.status).toBe(entry.status);
});

test("leaves an absent terminal timestamp unknown", async () => {
  await seed({ status: "done", lastRunId: "public-run" });
  const result = await request({ key, sessionId, expectedRunId: "public-run" });
  expect(result.payload?.session?.matchedRun).toEqual({ runId: "public-run", status: "done" });
});

test("does not attribute a previous run's start to a later persisted terminal run", async () => {
  await seed();
  for (const event of [
    { runId: "run-a", ts: 100, data: { phase: "start", startedAt: 100 } },
    { runId: "run-a", ts: 200, data: { phase: "end", startedAt: 100, endedAt: 200 } },
    { runId: "run-b", ts: 300, data: { phase: "start" } },
    { runId: "run-b", ts: 400, data: { phase: "end", endedAt: 400 } },
  ]) {
    await persistGatewaySessionLifecycleEvent({ ...scope, event: { ...event, sessionId } });
  }
  const before = loadSessionEntry(scope);
  expect(before).toMatchObject({
    status: "done",
    lastRunId: "run-b",
    startedAt: 100,
    endedAt: 400,
  });
  const result = await request({ key, sessionId, expectedRunId: "run-b" });
  expect(result.ok).toBe(true);
  expect(result.payload?.session?.matchedRun).toEqual({
    runId: "run-b",
    status: "done",
    endedAt: 400,
  });
  expect(loadSessionEntry(scope)).toEqual(before);
});

test("keeps global session facts agent-scoped and rejects mismatched agent routing", async () => {
  const context = requestContext({ ...cfg, session: { scope: "global" } });
  for (const agentId of ["main", "work"]) {
    await replaceSessionEntry(
      { agentId, sessionKey: "global" },
      {
        sessionId: `${agentId}-session`,
        updatedAt: 30,
        status: "done",
        lastRunId: `${agentId}-run`,
      },
    );
  }
  const selected = await request(
    { key: "global", agentId: "work", sessionId: "work-session", expectedRunId: "work-run" },
    { context },
  );
  expect(selected.payload?.session).toMatchObject({
    key: "global",
    agentId: "work",
    sessionId: "work-session",
    matchedRun: { runId: "work-run", status: "done" },
  });
  const foreignGeneration = await request(
    { key: "global", agentId: "work", sessionId: "main-session", expectedRunId: "main-run" },
    { context },
  );
  expect(foreignGeneration.payload?.session).toBeNull();
  const mismatch = await request({ key, agentId: "work" });
  expect(mismatch).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
});

test.each(["reset", "draft", "incognito"] as const)(
  "reads current ownership after awaited profile resolution: %s",
  async (change) => {
    await seed({ status: "done", lastRunId: "public-run" });
    const client = identifiedClient(ensureProfileForEmail("status-reader@example.test").id);
    const profile = client.authenticatedUserProfile!;
    delete client.authenticatedUserProfile;
    const context = requestContext({
      ...cfg,
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
          },
        },
      },
    });
    client.authenticatedGitHubIdentitySync = async () => {
      await seed({
        status: "done",
        lastRunId: "public-run",
        ...(change === "reset" ? { sessionId: "replacement-session" } : {}),
        ...(change === "draft"
          ? { visibility: "draft", createdActor: { type: "human", source: "profile", id: "other" } }
          : {}),
        ...(change === "incognito" ? { incognito: true } : {}),
      });
      client.authenticatedUserProfile = profile;
      return { profileId: profile.profileId, updatedAt: profile.updatedAt };
    };
    const result = await request(
      { key, sessionId, expectedRunId: "public-run" },
      { client, context },
    );
    expect(result.ok).toBe(true);
    expect(result.payload?.session).toBeNull();
  },
);

test("requires read scope through real dispatch", async () => {
  await seed();
  const client = identifiedClient("status-reader");
  client.connect.scopes = [];
  const result = await request({ key }, { client });
  expect(result).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", details: { code: "MISSING_SCOPE", missingScope: "operator.read" } },
  });
});

test("retains the pre-dispatch incognito denial without disclosing the stored run", async () => {
  const incognitoKey = "agent:main:dashboard:incognito-status";
  await replaceSessionEntry(
    { agentId: "main", sessionKey: incognitoKey },
    { sessionId, updatedAt: 30, status: "done", lastRunId: "private-run", incognito: true },
  );
  const result = await request({ key: incognitoKey, sessionId, expectedRunId: "private-run" });
  expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(result.payload).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("private-run");
});

test("missing reads create neither an agent store nor transcripts", async () => {
  const agentId = "status-empty";
  const stateDir = process.env.OPENCLAW_STATE_DIR!;
  const agentDir = path.join(stateDir, "agents", agentId);
  const database = resolveOpenClawAgentSqlitePath({ agentId });
  expect(fs.existsSync(agentDir)).toBe(false);
  const result = await request(
    { key: `agent:${agentId}:missing`, agentId },
    { context: requestContext({ agents: { list: [{ id: agentId, default: true }] } }) },
  );
  expect(result.ok).toBe(true);
  expect(result.payload?.session).toBeNull();
  expect(fs.existsSync(agentDir)).toBe(false);
  expect(fs.existsSync(database)).toBe(false);
});

test.each([
  { expectedRunId: "public-run" },
  { key: "" },
  { key: " " },
  { key: "x".repeat(CHAT_SEND_SESSION_KEY_MAX_LENGTH + 1) },
  { agentId: "x".repeat(65) },
  { agentId: "not an agent" },
  { agentId: "main\n" },
  { sessionId: "x".repeat(129) },
  { sessionId, expectedRunId: "x".repeat(CHAT_INPUT_RUN_ID_MAX_CHARS + 1) },
  { sessionId, expectedRunId: " " },
  { includeLastMessage: true },
])("rejects invalid or unbounded status request %j", async (invalid) => {
  const result = await request({ key, ...invalid });
  expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
});

test.each([
  { field: "key", maxLength: CHAT_SEND_SESSION_KEY_MAX_LENGTH },
  { field: "sessionId", maxLength: 128 },
  { field: "expectedRunId", maxLength: CHAT_INPUT_RUN_ID_MAX_CHARS },
] as const)("bounds $field by code points in params and results", ({ field, maxLength }) => {
  for (const [name, value, valid] of [
    ["oversized combining cluster", `a${"\u0301".repeat(100_000)}`, false],
    ["combining boundary", `a${"\u0301".repeat(maxLength - 1)}`, true],
    ["combining overflow", `a${"\u0301".repeat(maxLength)}`, false],
    ["non-BMP boundary", "\u{1f600}".repeat(maxLength), true],
    ["non-BMP overflow", "\u{1f600}".repeat(maxLength + 1), false],
    ["ASCII boundary", "x".repeat(maxLength), true],
    ["newline within boundary", `${"x".repeat(maxLength - 1)}\n`, true],
    ["newline beyond boundary", `${"x".repeat(maxLength)}\n`, false],
  ] as const) {
    const params = { key, sessionId, expectedRunId: "public-run", [field]: value };
    expect(validateSessionsStatusParams(params), `${name}: params`).toBe(valid);
    const result = {
      observedAt: 30,
      session: {
        key: params.key,
        agentId: "main",
        sessionId: params.sessionId,
        hasActiveRun: false,
        matchedRun: { runId: params.expectedRunId, status: "done" },
      },
    } satisfies SessionsStatusResult;
    expect(validateSessionsStatusResult(result), `${name}: result`).toBe(valid);
  }
});

test.each([
  { name: "maximum length", agentId: "a".repeat(64), valid: true },
  { name: "oversized", agentId: "a".repeat(65), valid: false },
  { name: "final newline", agentId: "main\n", valid: false },
])("validates the complete $name agent ID in params and results", ({ agentId, valid }) => {
  expect(validateSessionsStatusParams({ key, agentId })).toBe(valid);
  expect(
    validateSessionsStatusResult({
      observedAt: 30,
      session: { key, agentId, sessionId, hasActiveRun: false, matchedRun: null },
    }),
  ).toBe(valid);
});

test("preserves bounded identifiers and rejects unrepresentable recorded timestamps", async () => {
  const boundedKey = `agent:main:${"x".repeat(CHAT_SEND_SESSION_KEY_MAX_LENGTH - "agent:main:".length)}`;
  const boundedSessionId = "s".repeat(128);
  const runId = "r".repeat(CHAT_INPUT_RUN_ID_MAX_CHARS);
  await replaceSessionEntry(
    { agentId: "main", sessionKey: boundedKey },
    { sessionId: boundedSessionId, updatedAt: 30, status: "done", lastRunId: runId },
  );
  const accepted = await request({
    key: boundedKey,
    sessionId: boundedSessionId,
    expectedRunId: runId,
  });
  expect(accepted.payload?.session).toMatchObject({
    key: boundedKey,
    sessionId: boundedSessionId,
    matchedRun: { runId, status: "done" },
  });
  await seed({
    status: "done",
    lastRunId: "public-run",
    endedAt: Number.MAX_SAFE_INTEGER + 1,
  });
  const oversized = await request({ key, sessionId, expectedRunId: "public-run" });
  expect(oversized).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  expect(oversized.payload).toBeUndefined();
});
