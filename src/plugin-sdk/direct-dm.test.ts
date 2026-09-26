/**
 * Tests direct-message guard policy helpers exposed through the SDK.
 */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveImplicitMessageActionTarget } from "../infra/outbound/message-action-normalization.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  createDirectDmPreCryptoGuardPolicy,
  createPreCryptoDirectDmAuthorizer,
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
} from "./channel-inbound.js";
import { resolveStableChannelMessageIngress } from "./channel-ingress-runtime.js";

const baseCfg = {
  commands: { useAccessGroups: true },
} as unknown as OpenClawConfig;

function createDirectDmRuntime() {
  const channel = {
    routing: {
      resolveAgentRoute: vi.fn().mockReturnValue({
        agentId: "agent-main",
        accountId: "default",
        sessionKey: "dm:clawstudio",
      }),
    },
    session: {
      resolveStorePath: vi.fn().mockReturnValue("/tmp/direct-dm-session-store"),
      readSessionUpdatedAt: vi.fn().mockReturnValue(1234),
    },
    reply: {
      resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({ mode: "agent" }),
      formatAgentEnvelope: vi.fn().mockReturnValue("env:hello world"),
      finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => ctx),
    },
    inbound: {
      run: vi.fn<PluginRuntime["channel"]["inbound"]["run"]>().mockResolvedValue({
        admission: { kind: "handled", reason: "captured adapter" },
        dispatched: false,
      }),
    },
  };
  return { channel, runtime: { channel } as unknown as PluginRuntime };
}

describe("channel-inbound direct-message helpers", () => {
  it("resolves inbound DM access and command auth through one helper", async () => {
    const result = await resolveInboundDirectDmAccessWithRuntime({
      cfg: baseCfg,
      channel: "nostr",
      accountId: "default",
      dmPolicy: "pairing",
      allowFrom: [],
      senderId: "paired-user",
      rawBody: "/status",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      readStoreAllowFrom: async () => ["paired-user"],
      runtime: {
        shouldComputeCommandAuthorized: () => true,
        resolveCommandAuthorizedFromAuthorizers: ({ authorizers }) =>
          authorizers.some((entry) => entry.configured && entry.allowed),
      },
      modeWhenAccessGroupsOff: "configured",
    });

    expect(result.access.decision).toBe("allow");
    expect(result.access.effectiveAllowFrom).toEqual(["paired-user"]);
    expect(result.senderAllowedForCommands).toBe(true);
    expect(result.commandAuthorized).toBe(true);
  });

  it("blocks open DMs unless the effective allowlist matches", async () => {
    const result = await resolveInboundDirectDmAccessWithRuntime({
      cfg: baseCfg,
      channel: "nostr",
      accountId: "default",
      dmPolicy: "open",
      allowFrom: [],
      senderId: "random-user",
      rawBody: "hello",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      readStoreAllowFrom: async () => ["random-user"],
      runtime: {
        shouldComputeCommandAuthorized: () => false,
        resolveCommandAuthorizedFromAuthorizers: () => true,
      },
    });

    expect(result.access.decision).toBe("block");
    expect(result.access.reason).toBe("dmPolicy=open (not allowlisted)");
    expect(result.access.effectiveAllowFrom).toStrictEqual([]);
    expect(result.commandAuthorized).toBeUndefined();
  });

  it("resolves generic message sender access groups for direct DMs", async () => {
    const result = await resolveInboundDirectDmAccessWithRuntime({
      cfg: {
        ...baseCfg,
        accessGroups: {
          owners: {
            type: "message.senders",
            members: {
              nostr: ["owner-pubkey"],
              telegram: ["12345"],
            },
          },
        },
      } as OpenClawConfig,
      channel: "nostr",
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:owners"],
      senderId: "owner-pubkey",
      rawBody: "/status",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      runtime: {
        shouldComputeCommandAuthorized: () => true,
        resolveCommandAuthorizedFromAuthorizers: ({ authorizers }) =>
          authorizers.some((entry) => entry.configured && entry.allowed),
      },
    });

    expect(result.access.decision).toBe("allow");
    expect(result.access.effectiveAllowFrom).toEqual(["accessGroup:owners", "owner-pubkey"]);
    expect(result.commandAuthorized).toBe(true);
  });

  it("creates a pre-crypto authorizer that issues pairing and blocks unknown senders", async () => {
    const issuePairingChallenge = vi.fn(async () => {});
    const onBlocked = vi.fn();
    const authorizer = createPreCryptoDirectDmAuthorizer({
      resolveAccess: async (senderId) => ({
        access:
          senderId === "pair-me"
            ? {
                decision: "pairing" as const,
                reasonCode: "dm_policy_pairing_required",
                reason: "dmPolicy=pairing (not allowlisted)",
                effectiveAllowFrom: [],
              }
            : {
                decision: "block" as const,
                reasonCode: "dm_policy_disabled",
                reason: "dmPolicy=disabled",
                effectiveAllowFrom: [],
              },
      }),
      issuePairingChallenge,
      onBlocked,
    });

    await expect(
      Promise.all([
        authorizer({
          senderId: "pair-me",
          reply: async () => {},
        }),
        authorizer({
          senderId: "blocked",
          reply: async () => {},
        }),
      ]),
    ).resolves.toEqual(["pairing", "block"]);

    expect(issuePairingChallenge).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith({
      senderId: "blocked",
      reason: "dmPolicy=disabled",
      reasonCode: "dm_policy_disabled",
    });
  });

  it("builds a shared pre-crypto guard policy with partial overrides", () => {
    const policy = createDirectDmPreCryptoGuardPolicy({
      maxFutureSkewSec: 30,
      rateLimit: {
        maxPerSenderPerWindow: 5,
      },
    });

    expect(policy.allowedKinds).toEqual([4]);
    expect(policy.maxFutureSkewSec).toBe(30);
    expect(policy.maxCiphertextBytes).toBe(16 * 1024);
    expect(policy.rateLimit.maxPerSenderPerWindow).toBe(5);
    expect(policy.rateLimit.maxGlobalPerWindow).toBe(200);
  });

  it("defaults non-finite shared pre-crypto guard numeric overrides", () => {
    const policy = createDirectDmPreCryptoGuardPolicy({
      maxFutureSkewSec: Number.NaN,
      maxCiphertextBytes: Number.POSITIVE_INFINITY,
      maxPlaintextBytes: Number.NEGATIVE_INFINITY,
      rateLimit: {
        windowMs: Number.NaN,
        maxPerSenderPerWindow: Number.POSITIVE_INFINITY,
        maxGlobalPerWindow: Number.NEGATIVE_INFINITY,
        maxTrackedSenderKeys: Number.NaN,
      },
    });

    expect(policy.maxFutureSkewSec).toBe(120);
    expect(policy.maxCiphertextBytes).toBe(16 * 1024);
    expect(policy.maxPlaintextBytes).toBe(8 * 1024);
    expect(policy.rateLimit).toEqual({
      windowMs: 60_000,
      maxPerSenderPerWindow: 20,
      maxGlobalPerWindow: 200,
      maxTrackedSenderKeys: 4096,
    });
  });

  it("routes a targetless contextual reply to the inbound Reef peer", async () => {
    const { channel, runtime } = createDirectDmRuntime();
    const cfg = { session: { store: "/tmp/direct-dm-session-store" } } satisfies OpenClawConfig;
    const deliver = vi
      .fn<Parameters<typeof dispatchInboundDirectDmWithRuntime>[0]["deliver"]>()
      .mockResolvedValue(undefined);
    const onRecordError = vi.fn();
    const onDispatchError = vi.fn();
    const channelIngress = await resolveStableChannelMessageIngress({
      channelId: "reef",
      accountId: "default",
      subject: { stableId: "clawstudio" },
      conversation: { kind: "direct", id: "clawstudio" },
      dmPolicy: "allowlist",
    });

    const result = await dispatchInboundDirectDmWithRuntime({
      channelIngress,
      cfg,
      runtime,
      channel: "reef",
      channelLabel: "Reef",
      accountId: "default",
      peer: { kind: "direct", id: "clawstudio" },
      senderId: "clawstudio",
      senderAddress: "reef:clawstudio",
      recipientAddress: "reef:roboclaw",
      conversationLabel: "@clawstudio's agent",
      rawBody: "hello world",
      messageId: "event-123",
      extraContext: {
        ReplyToId: "event-parent",
        ReplyToIdFull: "event-parent",
        MessageThreadId: "thread-7",
      },
      timestamp: 1_710_000_000_000,
      commandAuthorized: true,
      deliver,
      onRecordError,
      onDispatchError,
    });

    const expectedContext = {
      Body: "env:hello world",
      BodyForAgent: "hello world",
      RawBody: "hello world",
      CommandBody: "hello world",
      From: "reef:clawstudio",
      To: "reef:roboclaw",
      SessionKey: "dm:clawstudio",
      AccountId: "default",
      ChatType: "direct",
      ConversationLabel: "@clawstudio's agent",
      SenderId: "clawstudio",
      Provider: "reef",
      Surface: "reef",
      MessageSid: "event-123",
      MessageSidFull: "event-123",
      Timestamp: 1_710_000_000_000,
      CommandAuthorized: true,
      ConversationRoutePeerId: "clawstudio",
      OriginatingChannel: "reef",
      OriginatingTo: "reef:clawstudio",
      NativeDirectUserId: "clawstudio",
      ReplyToId: "event-parent",
      ReplyToIdFull: "event-parent",
      MessageThreadId: "thread-7",
    };
    expect(result).toEqual({
      route: { agentId: "agent-main", accountId: "default", sessionKey: "dm:clawstudio" },
      storePath: "/tmp/direct-dm-session-store",
      ctxPayload: expectedContext,
    });
    expect(channel.routing.resolveAgentRoute).toHaveBeenCalledExactlyOnceWith({
      cfg,
      channel: "reef",
      accountId: "default",
      peer: { kind: "direct", id: "clawstudio" },
    });
    expect(channel.session.resolveStorePath).toHaveBeenCalledExactlyOnceWith(
      "/tmp/direct-dm-session-store",
      { agentId: "agent-main" },
    );
    expect(channel.session.readSessionUpdatedAt).toHaveBeenCalledExactlyOnceWith({
      storePath: "/tmp/direct-dm-session-store",
      sessionKey: "dm:clawstudio",
    });
    expect(channel.reply.resolveEnvelopeFormatOptions).toHaveBeenCalledExactlyOnceWith(cfg);
    expect(channel.reply.formatAgentEnvelope).toHaveBeenCalledExactlyOnceWith({
      channel: "Reef",
      from: "@clawstudio's agent",
      body: "hello world",
      timestamp: 1_710_000_000_000,
      previousTimestamp: 1234,
      envelope: { mode: "agent" },
    });
    expect(channel.reply.finalizeInboundContext).toHaveBeenCalledExactlyOnceWith(expectedContext);
    const currentChannelId = result.ctxPayload.OriginatingTo ?? result.ctxPayload.To;
    expect(
      resolveImplicitMessageActionTarget({ currentChannelId, currentChannelProvider: "reef" }),
    ).toBe("reef:clawstudio");
    expect(channel.inbound.run).toHaveBeenCalledOnce();
    const inbound = channel.inbound.run.mock.calls[0]?.[0];
    if (!inbound) {
      throw new Error("expected captured inbound adapter");
    }
    expect(inbound).toEqual({
      channel: "reef",
      accountId: "default",
      raw: expectedContext,
      adapter: { ingest: expect.any(Function), resolveTurn: expect.any(Function) },
    });
    const input = await inbound.adapter.ingest(inbound.raw);
    expect(input).toStrictEqual({
      id: "event-123",
      timestamp: 1_710_000_000_000,
      rawText: "hello world",
      textForAgent: undefined,
      textForCommands: undefined,
      raw: expectedContext,
    });
    if (!input) {
      throw new Error("expected normalized input");
    }
    const plan = await inbound.adapter.resolveTurn(
      input,
      { kind: "message", canStartAgentTurn: true },
      {},
    );
    if (!("delivery" in plan)) {
      throw new Error("expected delivery plan");
    }
    expect(plan).toMatchObject({
      cfg,
      channel: "reef",
      accountId: "default",
      route: { agentId: "agent-main", sessionKey: "dm:clawstudio" },
      ctxPayload: expectedContext,
      record: { onRecordError },
      delivery: { deliver: expect.any(Function), onError: onDispatchError },
      replyOptions: { onModelSelected: expect.any(Function) },
    });
    expect(plan.cfg).toBe(cfg);
    expect(plan.ctxPayload).toBe(result.ctxPayload);
    await plan.delivery.deliver(
      {
        text: "reply text",
        mediaUrls: ["media://reply", ""],
        replyToId: "event-parent",
        isError: true,
      },
      { kind: "final" },
    );
    expect(deliver.mock.calls).toStrictEqual([
      [
        {
          text: "reply text",
          mediaUrls: ["media://reply"],
          mediaUrl: undefined,
          presentation: undefined,
          interactive: undefined,
          channelData: undefined,
          sensitiveMedia: undefined,
          replyToId: "event-parent",
        },
      ],
    ]);
    const error = new Error("delivery failed");
    plan.record?.onRecordError?.(error);
    plan.delivery.onError?.(error, { kind: "final" });
    expect(onRecordError).toHaveBeenCalledExactlyOnceWith(error);
    expect(onDispatchError).toHaveBeenCalledExactlyOnceWith(error, { kind: "final" });
  });
});
