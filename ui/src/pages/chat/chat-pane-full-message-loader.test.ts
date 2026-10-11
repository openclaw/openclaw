/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { createSidebarFullMessageLoader } from "./chat-pane-sidebar-layout.ts";
import { createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";

const messageRequest = { sessionKey: "agent:main:example", messageId: "answer" };
const result = { ok: true, message: { role: "assistant", content: "The full answer" } };

function fixture(request = vi.fn().mockResolvedValue(result)) {
  const client = createGatewayBrowserClientFixture({
    request: (method, params) => (method === "chat.message.get" ? request(method, params) : {}),
  });
  const { state, context } = createRefreshChatPane(client);
  state.sessionKey = messageRequest.sessionKey;
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
  const load = () => createSidebarFullMessageLoader(state, context.gateway)!;
  return { state, context, session, load, request };
}

describe("explicit full-message reads", () => {
  it.each(["sharing or config", "role", "scopes"] as const)(
    "rechecks full-message reads after current %s authority changes without rerendering",
    async (change) => {
      const full = { ok: true, message: { role: "assistant", content: "Authorized answer" } };
      const read = vi.fn().mockResolvedValue(full);
      const client = createGatewayBrowserClientFixture({
        request: (method) => (method === "chat.message.get" ? read() : Promise.resolve({})),
      });
      const { pane, state, context } = createRefreshChatPane(client);
      context.gateway.snapshot.hello = gatewayHelloForMethods(
        ["chat.message.get"],
        ["operator.read", "operator.write"],
      );
      state.sessionKey = "agent:main:full-cache";
      state.currentSessionId = "same-session";
      state.sessionsResult = {
        ts: 1,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: state.sessionKey,
            kind: "direct",
            updatedAt: 1,
            sessionId: "same-session",
            lifecycleRevision: "same-revision",
          },
        ],
      };
      pane.render();
      const load = pane.chatProps!.loadFullAssistantMessage!;
      const request = { sessionKey: state.sessionKey, messageId: "answer" };
      expect(await load(request)).toEqual(full);
      state.connectionEpoch += 1;
      context.gateway.snapshot.hello.auth!.scopes!.reverse();
      expect(await load(request)).toEqual(full);
      expect(read).toHaveBeenCalledTimes(1);

      if (change === "sharing or config") {
        state.mediaPolicyEpoch = (state.mediaPolicyEpoch ?? 0) + 1;
      } else if (change === "role") {
        context.gateway.snapshot.hello.auth!.role = "node";
      } else {
        context.gateway.snapshot.hello.auth!.scopes = [];
      }
      const denied = { ok: false, unavailableReason: "not_found" };
      read.mockResolvedValue(denied);
      expect(await load(request)).toEqual(denied);
      expect(read).toHaveBeenCalledTimes(2);
    },
  );

  it("retains successful reads across reconnects and scopes the result to the requested content", async () => {
    const { state, context, load, request } = fixture();
    expect(await load()(messageRequest)).toEqual(result);
    state.connected = false;
    expect(createSidebarFullMessageLoader(state, context.gateway)).toBeNull();
    state.connectionEpoch += 1;
    state.connected = true;
    expect(await load()(messageRequest)).toEqual(result);
    expect(request).toHaveBeenCalledExactlyOnceWith("chat.message.get", {
      ...messageRequest,
      maxChars: 500_000,
    });

    await load()({ ...messageRequest, sessionKey: "agent:MAIN:example", agentId: "MAIN" });
    expect(request).toHaveBeenCalledTimes(1);
    await load()({ ...messageRequest, maxChars: 2_000_000 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([{ sessionKey: "agent:main:other" }, { agentId: "research" }])(
    "re-reads foreign requests whose lifecycle is not owned by the pane: %j",
    async (target) => {
      const { load, request } = fixture();
      const foreignRequest = { ...messageRequest, ...target };
      expect(await load()(foreignRequest)).toEqual(result);
      const afterReset = {
        ...result,
        message: { role: "assistant", content: "Other session after reset" },
      };
      request.mockResolvedValue(afterReset);
      expect(await load()(foreignRequest)).toEqual(afterReset);
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("retrieves retained references from the displayed physical session after the live session advances", async () => {
    const { state, session, load, request } = fixture();
    await load()(messageRequest);
    session.sessionId = "successor-session";
    await load()(messageRequest);
    expect(request).toHaveBeenLastCalledWith("chat.message.get", {
      ...messageRequest,
      sessionId: "physical-session",
      maxChars: 500_000,
    });

    for (const input of [
      { ...messageRequest, sessionKey: "agent:main:other" },
      { ...messageRequest, messageId: "pending:input-1" },
    ]) {
      await load()(input);
      expect(request).toHaveBeenLastCalledWith("chat.message.get", {
        ...input,
        maxChars: 500_000,
      });
    }

    state.currentSessionId = session.sessionId;
    await load()(messageRequest);
    expect(request).toHaveBeenLastCalledWith("chat.message.get", {
      ...messageRequest,
      maxChars: 500_000,
    });
    const explicitSource = { ...messageRequest, sessionId: "physical-session" };
    const reads = request.mock.calls.length;
    await load()(explicitSource);
    expect(request).toHaveBeenCalledTimes(reads + 1);
    expect(request).toHaveBeenLastCalledWith("chat.message.get", {
      ...explicitSource,
      maxChars: 500_000,
    });
  });

  it("does not borrow the selected global agent for a request that omitted its agent", async () => {
    const { state, session, load, request } = fixture();
    state.sessionKey = "global";
    state.assistantAgentId = "research";
    state.sessionsResultAgentId = "research";
    session.key = "global";
    const owned = { ...messageRequest, sessionKey: "global", agentId: "research" };
    expect(await load()(owned)).toEqual(result);
    expect(await load()(owned)).toEqual(result);
    expect(request).toHaveBeenCalledTimes(1);

    const unqualified = { ...messageRequest, sessionKey: "global" };
    expect(await load()(unqualified)).toEqual(result);
    const afterReset = {
      ...result,
      message: { role: "assistant", content: "Default agent after reset" },
    };
    request.mockResolvedValue(afterReset);
    expect(await load()(unqualified)).toEqual(afterReset);
    expect(request).toHaveBeenCalledTimes(3);
    expect(await load()(owned)).toEqual(result);
  });

  it.each([
    "principal",
    "session key",
    "physical session",
    "successor row",
    "lifecycle",
    "policy",
  ] as const)("invalidates cached content when the %s changes", async (change) => {
    const { state, context, session, load, request } = fixture();
    await load()(messageRequest);
    if (change === "principal") {
      context.gateway.snapshot.selfUser = { id: "bob", name: "Bob" };
    } else if (change === "session key") {
      state.sessionKey = "agent:main:replacement";
    } else if (change === "physical session") {
      state.currentSessionId = "replacement";
    } else if (change === "successor row") {
      session.sessionId = "next-physical-session";
    } else if (change === "lifecycle") {
      session.lifecycleRevision = "revision-2";
    } else {
      state.mediaPolicyEpoch = (state.mediaPolicyEpoch ?? 0) + 1;
    }
    const replacement = { ...result, message: { role: "assistant", content: "New answer" } };
    request.mockResolvedValue(replacement);
    expect(await load()(messageRequest)).toEqual(replacement);
    expect(request).toHaveBeenCalledTimes(2);
    if (change === "successor row") {
      request.mockResolvedValue({ ok: false, unavailableReason: "not_found" });
      expect(await load()(messageRequest)).toMatchObject({ ok: false });
      expect(request).toHaveBeenCalledTimes(3);
    }
  });

  it.each(["connection", "lifecycle", "authorization"] as const)(
    "does not publish or cache a read superseded by a %s change",
    async (change) => {
      const response = createDeferred<typeof result>();
      const { state, session, load, request } = fixture(
        vi.fn().mockReturnValueOnce(response.promise),
      );
      const pending = load()(messageRequest);
      if (change === "connection") {
        state.connectionEpoch += 1;
      } else if (change === "authorization") {
        state.mediaPolicyEpoch = (state.mediaPolicyEpoch ?? 0) + 1;
      } else {
        session.lifecycleRevision = "revision-2";
      }
      response.resolve(result);
      expect(await pending).toBeNull();
      request.mockResolvedValue(result);
      expect(await load()(messageRequest)).toEqual(result);
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    {
      name: "mutable CLI import",
      messageId: "answer",
      message: {
        role: "assistant",
        content: "Imported before edit",
        __openclaw: { id: "answer", importedFrom: "claude-cli" },
      },
      next: {
        ok: true,
        message: {
          role: "assistant",
          content: "Imported after edit",
          __openclaw: { id: "answer", importedFrom: "claude-cli" },
        },
      },
    },
    {
      name: "pending input whose custody ended",
      messageId: "pending:input-1",
      message: { role: "user", content: "Queued input", __openclaw: { id: "pending:input-1" } },
      next: { ok: false, unavailableReason: "not_found" },
    },
    {
      name: "assistant error hidden after successful retry",
      messageId: "answer",
      message: {
        role: "assistant",
        content: "Temporary provider error",
        stopReason: "error",
        __openclaw: { id: "answer" },
      },
      next: { ok: false, unavailableReason: "not_visible" },
    },
  ])("re-reads a $name without a lifecycle change", async ({ messageId, message, next }) => {
    const first = { ok: true, message };
    const { load, request } = fixture(vi.fn().mockResolvedValueOnce(first).mockResolvedValue(next));
    const input = { ...messageRequest, messageId };
    expect(await load()(input)).toEqual(first);
    expect(await load()(input)).toEqual(next);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries an unavailable original when explicitly opened again", async () => {
    const { load, request } = fixture(
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, unavailableReason: "not_found" })
        .mockResolvedValue(result),
    );
    expect(await load()(messageRequest)).toMatchObject({ ok: false });
    expect(await load()(messageRequest)).toEqual(result);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
