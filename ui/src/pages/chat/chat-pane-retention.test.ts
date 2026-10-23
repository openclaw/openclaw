/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { createSidebarFullMessageLoader } from "./chat-pane-sidebar-layout.ts";
import { createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";

describe("chat pane retained full messages", () => {
  it.each(["session lifecycle", "authenticated owner"] as const)(
    "releases cached full messages when the %s changes",
    async (boundary) => {
      class FullMessage {
        role = "assistant";
        content = "The retained full answer";
      }
      let retained: WeakRef<FullMessage> | undefined;
      let requests = 0;
      const client = createGatewayBrowserClientFixture({
        request: async (method) => {
          if (method !== "chat.message.get") {
            return {};
          }
          requests += 1;
          const message = new FullMessage();
          retained ??= new WeakRef(message);
          return { ok: true, message };
        },
      });
      const { state, context } = createRefreshChatPane(client);
      state.sessionKey = "agent:main:example";
      state.currentSessionId = "physical-session";
      const session = {
        key: state.sessionKey,
        kind: "direct" as const,
        updatedAt: 1,
        sessionId: state.currentSessionId,
        lifecycleRevision: "revision-1",
      };
      state.sessionsResult = {
        ts: 1,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [session],
      };
      context.gateway.snapshot.selfUser = { id: "alice", name: "Alice" };
      const load = createSidebarFullMessageLoader(state, context.gateway)!;
      const request = { sessionKey: "agent:main:example", messageId: "answer" };
      await load(request);
      state.connectionEpoch += 1;
      await load(request);
      const retainedControl = new WeakRef({ unowned: true });
      await collectGarbageForTest();
      expect(retainedControl.deref()).toBeUndefined();
      expect(retained!.deref()).toBeDefined();
      expect(requests).toBe(1);

      if (boundary === "session lifecycle") {
        session.lifecycleRevision = "revision-2";
      } else {
        context.gateway.snapshot.selfUser = { id: "bob", name: "Bob" };
      }
      await load(request);
      const retiredControl = new WeakRef({ unowned: true });
      await collectGarbageForTest();
      expect(retiredControl.deref()).toBeUndefined();
      expect(retained!.deref()).toBeUndefined();
      expect(requests).toBe(2);
    },
  );
});
