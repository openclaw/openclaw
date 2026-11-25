/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createTestChatPane, runPaneHeaderAction } from "./chat-pane.test-support.ts";
import { createSessionCapabilityFixture } from "./chat-session-capability.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

describe("scoped chat header appearance", () => {
  it.each([
    { action: { kind: "set-icon", icon: "book" }, patch: { icon: "book" } },
    { action: { kind: "set-color", color: "blue" }, patch: { color: "blue" } },
    { action: { kind: "reset-appearance" }, patch: { icon: null, color: null } },
  ] as const)(
    "dispatches scoped header $action.kind for an owned session",
    async ({ action, patch: expectedPatch }) => {
      const row: GatewaySessionRow = {
        key: "agent:main:current",
        sessionId: "current-session",
        kind: "direct",
        sharingRole: "owner",
      };
      const patch = vi.fn(async () => ({}));
      const { pane, state } = createTestChatPane({
        sessions: createSessionCapabilityFixture({
          patch,
          state: { result: sessionsResult([row], 1) },
        }),
      });
      state.sessionKey = row.key;
      state.sessionsResult = sessionsResult([row], 1);
      pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
        ["sessions.patch"],
        ["operator.sessions.write"],
      );
      await runPaneHeaderAction(pane, action, row);
      expect(patch).toHaveBeenCalledExactlyOnceWith(row.key, expectedPatch, {
        agentId: "main",
        expectedSessionId: row.sessionId,
      });
      expect(state.chatError).toBeNull();
    },
  );

  it.each([
    { scopes: ["operator.sessions.write"], sharingRole: "viewer" },
    { scopes: ["operator.sessions.read"], sharingRole: "owner" },
    { scopes: ["operator.sessions.write"], sharingRole: undefined },
  ] as const)(
    "denies unowned or read-only header appearance ($sharingRole, $scopes)",
    async ({ scopes, sharingRole }) => {
      const row: GatewaySessionRow = {
        key: "agent:main:current",
        sessionId: "current-session",
        kind: "direct",
        sharingRole,
      };
      const patch = vi.fn(async () => ({}));
      const { pane, state } = createTestChatPane({
        sessions: createSessionCapabilityFixture({
          patch,
          state: { result: sessionsResult([row], 1) },
        }),
      });
      state.sessionKey = row.key;
      state.sessionsResult = sessionsResult([row], 1);
      pane.context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.patch"], scopes);
      for (const action of [
        { kind: "set-icon", icon: "book" },
        { kind: "set-color", color: "blue" },
        { kind: "reset-appearance" },
      ] as const) {
        await runPaneHeaderAction(pane, action, row);
        expect(state.chatError).toBeTruthy();
      }
      expect(patch).not.toHaveBeenCalled();
    },
  );

  it("keeps header communication changes unavailable to a scoped writer", async () => {
    const row: GatewaySessionRow = {
      key: "agent:main:current",
      sessionId: "current-session",
      kind: "direct",
      sharingRole: "owner",
    };
    const patch = vi.fn(async () => ({}));
    const { pane, state } = createTestChatPane({
      sessions: createSessionCapabilityFixture({
        patch,
        state: { result: sessionsResult([row], 1) },
      }),
    });
    state.sessionKey = row.key;
    state.sessionsResult = sessionsResult([row], 1);
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["sessions.patch"],
      ["operator.sessions.write"],
    );
    await runPaneHeaderAction(
      pane,
      { kind: "set-communication", communication: { send: "never" } },
      row,
    );
    expect(patch).not.toHaveBeenCalled();
    expect(state.chatError).toBeTruthy();
  });
});
