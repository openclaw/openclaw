import "../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { environmentsSessionHandlers } from "./server-methods/environments.session.js";
import { sessionActivitySummaryHandlers } from "./server-methods/session-activity-summary.js";
import { sessionProviderReviewHandlers } from "./server-methods/sessions-provider-review.js";
import { soloClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import type { SessionActivitySummaryService } from "./session-activity-summaries.js";
import * as sharing from "./session-sharing.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {}, authorize() {} };
const cfg = { agents: { entries: { main: {}, absent: {} } } };
const sessionKey = "agent:main:dashboard:incognito-preflight";
const sessionId = "private-preflight";
let env: NodeJS.ProcessEnv;
const location = (agentId = "main") => ({
  agentId,
  path: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }),
});
let sql: ReturnType<typeof observeMainThreadSql>;

beforeEach(() => {
  sql = observeMainThreadSql();
});
afterEach(() => {
  sql.restore();
  vi.restoreAllMocks();
});

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-control-preflights-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  setRuntimeConfigSnapshot(cfg, cfg);
  const entry = { sessionId, updatedAt: 1, incognito: true as const };
  const created = await withSessionActorStorage(
    { agentId: "main", sessionKey, storePath: location().path, env },
    { create: true, authority, lifetime: { assertCurrent() {}, assertReadable() {} } },
    ({ actor }) =>
      actor.storage.mutate({ type: "session.entry.create", input: { entry } }, authority),
  );
  expect(created?.kind).toBe("committed");
});
afterAll(() => {
  memorySessionActorOwners.closeDatabase(location());
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

function request(method: string, params: Record<string, unknown>): GatewayRequestHandlerOptions {
  const client = soloClient();
  client.connect.client.mode = "ui";
  return {
    req: { type: "req", id: "private-preflight", method, params },
    params,
    client,
    respond: vi.fn(),
    context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
    isWebchatConnect: () => true,
  };
}

const paramsByAction = {
  provider: { sessionId, reviewId: "private-review", idempotencyKey: "private-run" },
  create: { profileId: "development", idempotencyKey: "private-environment" },
  status: {},
  destroy: { environmentId: "private-environment" },
};
const handlers = { ...sessionProviderReviewHandlers, ...environmentsSessionHandlers };
it.each([
  ["provider", "main"],
  ["provider", "absent"],
  ["create", "main"],
  ["status", "main"],
  ["destroy", "main"],
] as const)("refuses private %s for %s before acquisition or SQL", async (action, agentId) => {
  const target = vi.spyOn(sharing, "resolveSessionSharingTargetAsync");
  const method =
    action === "provider" ? "sessions.providerReview.continue" : `environments.session.${action}`;
  const options = request(method, {
    sessionKey: `agent:${agentId}:dashboard:incognito-preflight`,
    ...paramsByAction[action],
  });
  await handlers[method]!(options);
  const message =
    action === "provider"
      ? "Could not continue this chat. Refresh its current findings before trying again."
      : "A persistent conversation is required for an attached environment";
  expect(options.respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST", message }),
  );
  expect(target).not.toHaveBeenCalled();
  expect(memorySessionActorOwners.read(location("absent"))).toBeUndefined();
  sql.expectIdle();
});

it("reports private activity recaps unavailable without acquiring a source or scheduling work", async () => {
  const ensure = vi.fn<SessionActivitySummaryService["ensure"]>();
  const service: SessionActivitySummaryService = {
    beginCompletion: () => undefined,
    ensure,
    handleEvent() {},
    handleTranscript() {},
    handleLifecycle() {},
    async dispose() {},
  };
  const target = vi.spyOn(sharing, "resolveSessionSharingTargetAsync");
  const options = request("sessions.activitySummary.ensure", {
    sessions: [{ key: sessionKey }],
  });
  options.context.sessionActivitySummaries = service;
  await sessionActivitySummaryHandlers[options.req.method]!(options);
  const activitySummary = { state: "unavailable", canEnsure: true };
  expect(options.respond).toHaveBeenCalledWith(true, {
    sessions: [{ key: sessionKey, agentId: "main", activitySummary }],
  });
  expect(ensure).not.toHaveBeenCalled();
  expect(target).not.toHaveBeenCalled();
  sql.expectIdle();
});
