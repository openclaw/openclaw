import { describe, expect, it, vi } from "vitest";
import {
  destinations,
  discordGuild,
  discordGuildOwner,
  discordMessage,
  type McpMessageResponse,
  useMcpMessageActions,
} from "./mcp-http.message-actions.test-support.js";

// Device inventory is unrelated to the real grant, message tool, and provider boundary.
vi.mock("../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

// Use the existing plugin-context consumer pattern; delivery creation stays real.
vi.mock("../plugins/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/tools.js")>();
  const { Type } = await import("typebox");
  return {
    ...actual,
    resolvePluginTools: (params: Parameters<typeof actual.resolvePluginTools>[0]) => {
      const tools = actual.resolvePluginTools(params);
      if (!params.toolAllowlist?.includes("mcp_delivery_probe")) {
        return tools;
      }
      const result = { ok: true, deliveryAvailable: params.context.delivery !== undefined };
      return [
        ...tools,
        {
          name: "mcp_delivery_probe",
          label: "Delivery probe",
          description: "Report whether this plugin received delivery authority.",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          }),
        },
      ];
    },
  };
});

function expectSuccess(response: McpMessageResponse) {
  expect(response.error).toBeUndefined();
  expect(response.result?.isError, JSON.stringify(response)).not.toBe(true);
  const text = response.result?.content?.find((item) => item.type === "text")?.text;
  const result: unknown = JSON.parse(text ?? "null");
  expect(result).toMatchObject({ ok: true });
  return result;
}

function expectDenied(response: McpMessageResponse, reason: RegExp) {
  expect(response.error).toBeUndefined();
  expect(response.result?.isError).toBe(true);
  expect(response.result?.content?.map((item) => item.text).join("\n")).toMatch(reason);
}

describe.each(["discord", "slack"] as const)("CLI MCP %s message authority", (channel) => {
  const fixture = useMcpMessageActions(channel);
  const { current, sibling, sender } = destinations[channel];
  const otherChannel = channel === "discord" ? "slack" : "discord";

  it("reads the current and an allowed sibling conversation through the live grant", async () => {
    const turn = await fixture.createTurn();
    for (const target of [current, sibling]) {
      expectSuccess(
        await turn.call({ action: "read", channel, target: `channel:${target}`, limit: 1 }),
      );
      expect(fixture.requests).toContainEqual(
        expect.objectContaining(
          channel === "discord"
            ? { method: "GET", path: `/api/v10/channels/${target}/messages` }
            : {
                method: "POST",
                path: "/api/conversations.history",
                fields: expect.objectContaining({ channel: target }),
              },
        ),
      );
    }
  });

  it("uses a policy-bound capability for a shared durable session", async () => {
    const turn = await fixture.createTurn({ splitSession: true });
    expect(turn.sessionKey).not.toBe(turn.policySessionKey);
    expectSuccess(
      await turn.call({ action: "read", channel, target: `channel:${current}`, limit: 1 }),
    );
  });

  it("rejects another provider or account despite forged child context", async () => {
    const turn = await fixture.createTurn();
    for (const args of [
      {
        action: "read",
        channel: otherChannel,
        target: `channel:${destinations[otherChannel].current}`,
      },
      { action: "read", channel, accountId: "other", target: `channel:${current}` },
    ]) {
      expectDenied(
        await turn.call(args, {
          "x-openclaw-message-channel": String(args.channel),
          "x-openclaw-account-id": "other",
          "x-openclaw-current-channel-id": String(args.target),
        }),
        /requires current provider and account context|Explicit account does not match the trusted current account/,
      );
    }
    expect(fixture.requests).toEqual([]);
  });

  if (channel === "slack") {
    it("uses the admitted requester for targetless metadata and rejects a forged requester", async () => {
      const turn = await fixture.createTurn();
      expectSuccess(await turn.call({ action: "member-info", channel }));
      expect(fixture.requests).toContainEqual(
        expect.objectContaining({
          path: "/api/users.info",
          fields: expect.objectContaining({ user: sender }),
        }),
      );
      const before = fixture.requests.length;
      expectDenied(
        await turn.call(
          {
            action: "member-info",
            channel,
            userId: "U9999999999",
            requesterSenderId: "U9999999999",
            conversationReadOrigin: "direct-operator",
            toolContext: { currentChannelProvider: channel, requesterSenderId: "U9999999999" },
          },
          { "x-openclaw-sender-id": "U9999999999" },
        ),
        /limited to the current requester/,
      );
      expect(fixture.requests).toHaveLength(before);
    });
  }

  if (channel === "discord") {
    const react = { action: "react", channel, messageId: discordMessage, emoji: "✅" };

    it("keeps CLI message authority out of the plugin delivery context", async () => {
      const turn = await fixture.createTurn({ deliveryProbe: true });
      expect(turn.isCurrent()).toBe(true);
      const probe = expectSuccess(await turn.callDeliveryProbe());
      expect(probe).toEqual({ ok: true, deliveryAvailable: false });
      expect(fixture.requests).toEqual([]);
      expectSuccess(
        await turn.call({ action: "read", channel, target: `channel:${current}`, limit: 1 }),
      );
      expect(fixture.requests).toContainEqual(
        expect.objectContaining({ method: "GET", path: `/api/v10/channels/${current}/messages` }),
      );
    });

    it("reacts in the current conversation with explicit and default targets", async () => {
      const turn = await fixture.createTurn();
      for (const target of [`channel:${current}`, undefined]) {
        expectSuccess(await turn.call({ ...react, ...(target ? { target } : {}) }));
      }
      expect(fixture.requests.filter((request) => request.method === "PUT")).toEqual([
        expect.objectContaining({
          path: `/api/v10/channels/${current}/messages/${discordMessage}/reactions/%E2%9C%85/@me`,
        }),
        expect.objectContaining({
          path: `/api/v10/channels/${current}/messages/${discordMessage}/reactions/%E2%9C%85/@me`,
        }),
      ]);
    });

    it.each(["missing", "forged", "expired", "revoked", "other-run"] as const)(
      "denies %s turn authority on an otherwise live CLI grant",
      async (capability) => {
        const turn = await fixture.createTurn({ capability });
        expect(turn.isCurrent()).toBe(true);
        expectDenied(
          await turn.call(
            {
              action: "read",
              channel,
              target: `channel:${current}`,
              messageActionTurnCapability: turn.capability ?? "forged",
              requesterAccountId: "default",
              requesterSenderId: sender,
              conversationReadOrigin: "direct-operator",
              toolContext: { currentChannelProvider: channel, currentChannelId: current },
            },
            {
              "x-openclaw-message-action-turn-capability": turn.capability ?? "forged",
              "x-openclaw-message-channel": channel,
              "x-openclaw-account-id": "default",
              "x-openclaw-current-channel-id": current,
            },
          ),
          /current provider and account|turn capability.*no longer active/,
        );
        expect(fixture.requests).toEqual([]);
      },
    );

    it("keeps ordinary reactions bound to the current conversation", async () => {
      const turn = await fixture.createTurn();
      expectDenied(
        await turn.call(
          { ...react, target: `channel:${sibling}` },
          {
            "x-openclaw-current-channel-id": sibling,
          },
        ),
        /exact current conversation and account/,
      );
      expect(fixture.requests).toEqual([]);
    });

    it("requires the admitted sender's channel management permission", async () => {
      const turn = await fixture.createTurn();
      expectDenied(
        await turn.call(
          {
            action: "channel-edit",
            channel,
            target: `channel:${current}`,
            topic: "changed topic",
            senderUserId: discordGuildOwner,
            senderIsOwner: true,
          },
          { "x-openclaw-sender-id": discordGuildOwner },
        ),
        /Sender does not have required permissions/,
      );
      expect(fixture.requests).toContainEqual(
        expect.objectContaining({
          method: "GET",
          path: `/api/v10/guilds/${discordGuild}/members/${sender}`,
        }),
      );
      expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
    });

    it("cancels an in-flight provider lookup before a reaction can be written", async () => {
      const turn = await fixture.createTurn();
      const lookup = fixture.holdNextMetadata();
      const response = turn.call({ ...react, target: `channel:${current}` });
      try {
        await lookup.entered();
        turn.source.abort();
      } finally {
        lookup.release();
      }
      expectDenied(await response, /abort|cancel|no longer active/i);
      expect(fixture.requests).toContainEqual(
        expect.objectContaining({
          method: "GET",
          path: `/api/v10/channels/${current}`,
        }),
      );
      expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
    });

    it("keeps message-only completions restricted to a source reply", async () => {
      const turn = await fixture.createTurn({ sourceReplyOnly: true });
      expectDenied(
        await turn.call({ ...react, target: `channel:${current}` }),
        /Completion source replies permit only action "send"/,
      );
      expect(fixture.requests).toEqual([]);
    });
  }
});
