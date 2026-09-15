import { channel } from "node:diagnostics_channel";
import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { emitUserProfilesChanged } from "../../state/user-profile-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
  seedSessions,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("invalidates a live page when committed visibility changes hide a row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const config = await seedSessions();
    const context = requestContext(config);
    const client = identifiedClient("viewer@example.com");
    const request = { agentId: "main", archived: "all" as const, limit: 100 };
    const sessionKey = "agent:main:active";
    const runId = "live-reuse-visibility";
    registerAgentRunContext(runId, {
      agentId: "main",
      sessionId: "main-active",
      sessionKey,
      projectSessionActive: true,
    });
    try {
      const shared = await listSessions({ client, context, request });
      expect(shared.sessions.find((row) => row.key === sessionKey)?.hasActiveRun).toBe(true);
      clock.mockReturnValue(now + 100);
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, { visibility: "draft" });
      emitSessionsChanged(context, { reason: "patch", sessionKey }, { accessChanged: true });
      const hidden = await listSessions({ client, context, request });
      expect(hidden.sessions.map((row) => row.key)).not.toContain(sessionKey);
    } finally {
      clearAgentRunContext(runId);
    }
  });
});

it.each(["unchanged", "transcript", "user-profile"])(
  "reuses live lists for one second with a %s fence",
  async (mutation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const now = 1_800_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const config = await seedSessions();
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 100 };
      const target = { agentId: "main", sessionId: "main-active", sessionKey: "agent:main:active" };
      const runId = "live-reuse-window";
      registerAgentRunContext(runId, { ...target, projectSessionActive: true });
      const events: unknown[] = [];
      const diagnostics = channel("openclaw.session.list");
      const collect = (event: unknown) => events.push(event);
      diagnostics.subscribe(collect);
      try {
        const first = await listSessions({ client, context, request });
        expect(first.sessions.find((row) => row.key === target.sessionKey)?.hasActiveRun).toBe(
          true,
        );
        expect(events.at(-1)).toMatchObject({ cacheRole: "projection-owner" });
        clock.mockReturnValue(now + 100);
        if (mutation === "transcript") {
          emitSessionTranscriptUpdate({ target });
        } else if (mutation === "user-profile") {
          emitUserProfilesChanged();
        }
        const second = await listSessions({ client, context, request });
        const hardChange = mutation === "user-profile";
        if (hardChange) {
          expect(second).not.toBe(first);
        } else {
          expect(second).toBe(first);
        }
        expect(events.at(-1)).toMatchObject({
          cacheRole: hardChange ? "projection-owner" : "completed-hit",
        });

        clearAgentRunContext(runId);
        const deadline = now + (hardChange ? 100 : 0) + 1_000;
        clock.mockReturnValue(deadline - 1);
        expect(await listSessions({ client, context, request })).toBe(second);
        expect(events.at(-1)).toMatchObject({ cacheRole: "completed-hit" });

        clock.mockReturnValue(deadline);
        const expired = await listSessions({ client, context, request });
        expect(expired).not.toBe(second);
        expect(expired.sessions.find((row) => row.key === target.sessionKey)?.hasActiveRun).toBe(
          false,
        );
        expect(events.at(-1)).toMatchObject({ cacheRole: "projection-owner" });
      } finally {
        diagnostics.unsubscribe(collect);
        clearAgentRunContext(runId);
      }
    });
  },
);

it.each(["active", "draft"])(
  "expires a live list at the shorter agent-status deadline on the %s row",
  async (name) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const now = 1_800_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const config = await seedSessions();
      const statusKey = `agent:main:${name}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: statusKey },
        { agentStatus: { note: "Temporary status", expiresAt: now + 250 } },
      );
      const context = requestContext(config);
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 100 };
      const runId = "live-reuse-status";
      registerAgentRunContext(runId, {
        agentId: "main",
        sessionId: "main-active",
        sessionKey: "agent:main:active",
        projectSessionActive: true,
      });
      try {
        const first = await listSessions({ client, context, request });
        expect(first.sessions.find((row) => row.key === statusKey)?.agentStatus).toBeDefined();
        clock.mockReturnValue(now + 249);
        expect(await listSessions({ client, context, request })).toBe(first);
        clock.mockReturnValue(now + 250);
        const expired = await listSessions({ client, context, request });
        expect(expired).not.toBe(first);
        expect(expired.sessions.find((row) => row.key === statusKey)?.agentStatus).toBeUndefined();
        expect(expired.sessions.find((row) => row.key === "agent:main:active")?.hasActiveRun).toBe(
          true,
        );
      } finally {
        clearAgentRunContext(runId);
      }
    });
  },
);
