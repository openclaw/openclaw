import { describe, expect, it, vi } from "vitest";
import {
  validateSessionsDescribeParams,
  validateSessionsListParams,
} from "../../packages/gateway-protocol/src/index.js";
import { GatewayClient } from "../gateway/client.js";
import { GatewayChatClient } from "./gateway-chat.js";
import type { TuiSessionList } from "./tui-backend.js";
import {
  createBaseState,
  createTestSessionActions,
  makeTuiSessionList,
} from "./tui-session-actions-test-support.js";

describe("GatewayChatClient session description", () => {
  it("refreshes an exact session behind more than five newer prefix and label matches", async () => {
    const sessionKey = "agent:work:notes";
    const selected = { key: sessionKey, sessionId: "selected-session", model: "selected-model" };
    const rows: TuiSessionList["sessions"] = [
      ...Array.from({ length: 3 }, (_, index) => ({
        key: `${sessionKey}-${index}`,
        sessionId: `prefix-${index}`,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        key: `agent:work:other-${index}`,
        label: `${sessionKey} label ${index}`,
        sessionId: `label-${index}`,
      })),
      selected,
    ];
    const defaults = { model: "default-model", modelProvider: "openai", contextTokens: 16000 };
    const request = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method, params) => {
        if (method === "sessions.describe" && validateSessionsDescribeParams(params)) {
          return { session: rows.find((row) => row.key === params.key) ?? null };
        }
        if (method === "sessions.list" && validateSessionsListParams(params)) {
          const search = params.search ?? "";
          const matches = rows.filter(
            (row) => row.key.includes(search) || row.label?.includes(search),
          );
          return makeTuiSessionList({
            sessions: matches.slice(params.offset ?? 0, params.limit),
            defaults,
          });
        }
        throw new Error(`Unexpected request: ${method}`);
      });
    try {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      const state = createBaseState({ currentSessionKey: sessionKey, currentAgentId: "work" });
      const { refreshSessionInfo } = createTestSessionActions({ client, state });

      await refreshSessionInfo();

      expect(state.currentSessionId).toBe("selected-session");
      expect(state.sessionInfo).toMatchObject({
        model: "selected-model",
        modelProvider: "openai",
        contextTokens: 16000,
      });
    } finally {
      request.mockRestore();
    }
  });

  it.each([
    { kind: "ordinary", key: "agent:work:notes", sessionId: "empty-transcript", visible: true },
    { kind: "archived", key: "agent:work:notes", archived: true, visible: false },
    { kind: "incognito row", key: "agent:work:notes", incognito: true, visible: false },
    { kind: "incognito key", key: "agent:work:dashboard:incognito-private", visible: false },
    { kind: "cron run", key: "agent:work:cron:job:run:run-id", visible: false },
    { kind: "phantom", key: "agent:work:sessions", sessionId: " ", visible: false },
    {
      kind: "materialized sessions key",
      key: "agent:work:sessions",
      sessionId: "real",
      visible: true,
    },
  ])(
    "preserves $kind discovery eligibility in exact metadata reads",
    async ({ kind: _kind, visible, ...session }) => {
      const defaults = { model: "work-default" };
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (method) => {
          if (method === "sessions.describe") {
            return { session };
          }
          if (method === "sessions.list") {
            return makeTuiSessionList({ defaults });
          }
          throw new Error(`Unexpected request: ${method}`);
        });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        await expect(client.describeSession({ sessionKey: session.key })).resolves.toEqual({
          session: visible ? session : null,
          defaults,
        });
        expect(request).toHaveBeenCalledWith(
          "sessions.describe",
          { key: session.key },
          { signal: expect.any(AbortSignal) },
        );
        expect(request).toHaveBeenCalledWith(
          "sessions.list",
          { agentId: "work", limit: 1 },
          { signal: expect.any(AbortSignal) },
        );
      } finally {
        request.mockRestore();
      }
    },
  );
});
