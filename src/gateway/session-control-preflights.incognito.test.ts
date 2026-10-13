import "../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
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
let location: { agentId: string; path: string };
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-control-preflights-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  setRuntimeConfigSnapshot(cfg, cfg);
  location = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const created = await withSessionActorStorage(
    { agentId: "main", sessionKey, storePath: location.path, env },
    { create: true, authority, lifetime: { assertCurrent() {}, assertReadable() {} } },
    ({ actor }) =>
      actor.storage.mutate(
        {
          type: "session.entry.create",
          input: { entry: { sessionId: "private-preflight", updatedAt: 1, incognito: true } },
        },
        authority,
      ),
  );
  expect(created?.kind).toBe("committed");
});
afterAll(() => {
  memorySessionActorOwners.closeDatabase(location);
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

it.each(["main", "absent"] as const)(
  "refuses private provider continuation before session acquisition (%s)",
  async (agentId) => {
    const target = vi.spyOn(sharing, "resolveSessionSharingTarget");
    const sql = observeMainThreadSql();
    try {
      const options = request("sessions.providerReview.continue", {
        sessionKey: `agent:${agentId}:dashboard:incognito-preflight`,
        sessionId: "private-preflight",
        reviewId: "private-review",
        idempotencyKey: "private-run",
      });
      await sessionProviderReviewHandlers[options.req.method]!(options);
      expect(options.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message:
            "Could not continue this chat. Refresh its current findings before trying again.",
        }),
      );
      expect(target).not.toHaveBeenCalled();
      expect(
        memorySessionActorOwners.read({
          agentId: "absent",
          path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "absent", env }),
        }),
      ).toBeUndefined();
      sql.expectIdle();
    } finally {
      target.mockRestore();
      sql.restore();
    }
  },
);

it.each(["create", "status", "destroy"] as const)(
  "refuses private attached-environment %s without SQL",
  async (action) => {
    const sql = observeMainThreadSql();
    try {
      const options = request(`environments.session.${action}`, {
        sessionKey,
        ...(action === "create"
          ? { profileId: "development", idempotencyKey: "private-environment" }
          : {}),
        ...(action === "destroy" ? { environmentId: "private-environment" } : {}),
      });
      await environmentsSessionHandlers[options.req.method]!(options);
      expect(options.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: "A persistent conversation is required for an attached environment",
        }),
      );
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  },
);

it("reports private activity recaps unavailable without acquiring a source or scheduling work", async () => {
  const ensure = vi.fn<SessionActivitySummaryService["ensure"]>();
  const service: SessionActivitySummaryService = {
    ensure,
    handleEvent() {},
    handleTranscript() {},
    handleLifecycle() {},
    async dispose() {},
  };
  const target = vi.spyOn(sharing, "resolveSessionSharingTarget");
  const sql = observeMainThreadSql();
  try {
    const options = request("sessions.activitySummary.ensure", {
      sessions: [{ key: sessionKey }],
    });
    options.context.sessionActivitySummaries = service;
    await sessionActivitySummaryHandlers[options.req.method]!(options);
    expect(options.respond).toHaveBeenCalledWith(true, {
      sessions: [
        {
          key: sessionKey,
          agentId: "main",
          activitySummary: { state: "unavailable", canEnsure: true },
        },
      ],
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(target).not.toHaveBeenCalled();
    sql.expectIdle();
  } finally {
    target.mockRestore();
    sql.restore();
  }
});
