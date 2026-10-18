// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { projectSidebarSession } from "../../components/app-sidebar-session-navigation.test-support.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { agentRosterCards } from "../agents/roster-activity.ts";
import { sessionRowAttention } from "../session-attention.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

afterEach(() => vi.useRealTimers());

it.each(["complete", "omitted"])(
  "updates roster, sidebar unread and previews without refetching a %s message body",
  async (body) => {
    vi.useFakeTimers();
    const initial: GatewaySessionRow = {
      key: "agent:main:main",
      agentId: "main",
      sessionId: "roster-session",
      kind: "direct",
      updatedAt: 100,
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["roster-run"],
      unread: false,
      lastMessagePreview: "Before",
    };
    const request = createGatewayRequestMock(async (method) => {
      expect(method).toBe("sessions.list");
      return sessionsResult([initial], 100);
    });
    const { gateway, emitEvent } = createGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const updated: GatewaySessionRow = {
      ...initial,
      updatedAt: 200,
      unread: true,
      lastMessagePreview: "Review is ready",
      lastAssistantMessage: { text: "Review is ready", timestamp: 200 },
      agentStatus: { note: "Review needed", attention: "hand", expiresAt: 1_000 },
    };
    emitEvent({
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: initial.key,
        agentId: "main",
        messageId: "message-2",
        messageSeq: 2,
        runId: "roster-run",
        session: updated,
        ancestorSessions: [],
        ...(body === "complete"
          ? { message: { role: "assistant", content: "Review is ready" } }
          : {}),
      },
    });
    expect(sessions.state.result?.sessions).toEqual([updated]);
    const row = sessions.state.result!.sessions[0]!;
    expect(projectSidebarSession(row)).toMatchObject({
      unread: true,
      lastMessagePreview: "Review is ready",
      status: "running",
    });
    expect(sessionRowAttention(row, 200)).toEqual({
      kind: "agent",
      note: "Review needed",
      icon: "hand",
      sourceSessionKey: initial.key,
    });
    expect(
      agentRosterCards(
        { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
        sessions.state.result!.sessions,
      ),
    ).toMatchObject([
      { unreadCount: 1, preview: "Review is ready", assistantPreview: "Review is ready" },
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(1);
  },
);
