import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeSqliteReadSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptEvent,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  CRON_RUN_ENDED_ERROR,
  cronRunAcceptance,
} from "../../infra/agent-run-registry.automation.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { buildAgentSessionPatch } from "../server-methods/agent-session-patch.js";
import { prepareAgentSession } from "../server-methods/agent-session-prepare.js";
import type { RespondFn } from "../server-methods/response-types.js";
import { prepareAgentRequestRouting } from "./agent-request-routing.js";

it("prepares active/failed sessions and rejects archives without host row reads", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {};
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    for (const kind of ["ordinary", "failed-present", "failed-missing", "archived"] as const) {
      const sessionKey = `agent:main:preparation-${kind}`;
      const scope = { agentId: "main", sessionKey, sessionId: kind };
      await upsertSessionEntryCore(scope, {
        sessionId: kind,
        updatedAt: Date.now(),
        sessionStartedAt: Date.now(),
        ...(kind.startsWith("failed") ? { status: "failed" as const } : {}),
        ...(kind === "archived" ? { archivedAt: Date.now() } : {}),
      });
      if (kind === "failed-present") {
        await appendTranscriptEvent(scope, { type: "session", id: kind, version: 3 });
      }
      const respond = vi.fn();
      const bindDedupeSessionTarget = vi.fn();
      const request = { sessionKey, message: "continue", idempotencyKey: kind };
      const common = { cfg, request, respond };
      const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      using _ = { [Symbol.dispose]: observation.restore };
      const routing = await prepareAgentRequestRouting({
        ...common,
        isRawModelRun: false,
        runId: kind,
        agentDedupeKeys: [kind],
        context,
        reserveDedupe: vi.fn(),
        bindDedupeSessionTarget,
        clearDedupe: vi.fn(),
        ...(kind === "ordinary" && {
          execApprovalFollowupApprovalId: "followup",
          request: { ...request, execApprovalFollowupExpectedSessionId: kind },
        }),
      });
      if (kind === "archived") {
        expect(routing).toBeUndefined();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
      } else {
        expect(routing?.preAttachmentSession).toEqual({
          canonicalKey: sessionKey,
          sessionId: kind,
        });
        expect(bindDedupeSessionTarget).toHaveBeenCalledWith(scope);
        const prepared = await prepareAgentSession({
          ...common,
          requestedSessionKey: sessionKey,
          preAttachmentSession: routing?.preAttachmentSession,
        });
        assert(prepared, "Session preparation did not return a candidate");
        const patch = await buildAgentSessionPatch({
          ...prepared,
          freshEntry: prepared.entry,
          initialEntry: prepared.entry,
          sessionAgentId: prepared.canonicalSessionAgentId,
          canonicalSessionKey: prepared.canonicalKey,
          normalizedSpawned: {},
          requestDeliveryHint: undefined,
        });
        expect(patch.patch.sessionId === kind).toBe(kind !== "failed-missing");
        expect(respond).not.toHaveBeenCalled();
      }
      expect(observation.queries.filter(isSessionEntryDataSql)).toEqual([]);
    }
  }));

it("admits a cron run turn only while its executor owns the run", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {};
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:cron:nightly:run:one-shot";
    const scope = { agentId: "main", sessionKey, sessionId: "cron-run-session" };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
    const prepare = (respond: RespondFn) =>
      prepareAgentSession({
        cfg,
        request: { sessionKey, message: "late result", idempotencyKey: "late" },
        respond,
        requestedSessionKey: sessionKey,
      });

    const claim = claimAgentRunContext(
      "cron-executor",
      { ...scope, cronRunsByJobId: new Map([["nightly", { nextCheckEnabled: false }]]) },
      { trackOwner: true },
    );
    const live = vi.fn<RespondFn>();
    expect(await prepare(live)).toMatchObject({ canonicalKey: sessionKey });
    expect(live).not.toHaveBeenCalled();
    // A caller that has not resolved the physical session id still sees the live executor.
    expect(() => cronRunAcceptance(sessionKey, undefined)).not.toThrow();

    // An accepted follow-up turn on the same session must not keep the ended origin alive.
    const followup = claimAgentRunContext("accepted-followup", scope, { trackOwner: true });
    releaseAgentRunContext("cron-executor", claim);
    const ended = vi.fn<RespondFn>();
    expect(await prepare(ended)).toBeUndefined();
    releaseAgentRunContext("accepted-followup", followup);
    expect(ended).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: CRON_RUN_ENDED_ERROR }),
    );
  }));
