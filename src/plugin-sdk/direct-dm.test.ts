import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveImplicitMessageActionTarget } from "../infra/outbound/message-action-normalization.js";
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

function resolveAccess(
  overrides: Partial<Parameters<typeof resolveInboundDirectDmAccessWithRuntime>[0]>,
) {
  return resolveInboundDirectDmAccessWithRuntime({
    cfg: baseCfg,
    channel: "nostr",
    accountId: "default",
    dmPolicy: "pairing",
    allowFrom: [],
    senderId: "paired-user",
    rawBody: "/status",
    isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
    runtime: {
      shouldComputeCommandAuthorized: () => true,
      resolveCommandAuthorizedFromAuthorizers: ({ authorizers }) =>
        authorizers.some((entry) => entry.configured && entry.allowed),
    },
    ...overrides,
  });
}

function createDirectDmRuntime() {
  const runInbound = vi.fn(async ({ adapter, raw }) => {
    const input = await adapter.ingest(raw);
    const turn = await adapter.resolveTurn(input, {
      kind: "message",
      canStartAgentTurn: true,
    });
    await turn.delivery.deliver({ text: "reply text" });
    return { admission: { kind: "dispatch" }, dispatched: true };
  });
  return {
    runInbound,
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(({ accountId, peer }) => ({
            agentId: "agent-main",
            accountId,
            sessionKey: `dm:${peer.id}`,
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/direct-dm-session-store"),
          readSessionUpdatedAt: vi.fn(() => 1234),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({ mode: "agent" })),
          formatAgentEnvelope: vi.fn(({ body }) => `env:${body}`),
          finalizeInboundContext: vi.fn((ctx) => ctx),
        },
        inbound: { run: runInbound },
      },
    } as never,
  };
}

describe("channel-inbound direct-message helpers", () => {
  it("resolves inbound DM access and command auth through one helper", async () => {
    const result = await resolveAccess({
      readStoreAllowFrom: async () => ["paired-user"],
      modeWhenAccessGroupsOff: "configured",
    });
    expect(result).toMatchObject({
      access: { decision: "allow", effectiveAllowFrom: ["paired-user"] },
      senderAllowedForCommands: true,
      commandAuthorized: true,
    });
  });

  it("blocks open DMs unless the effective allowlist matches", async () => {
    const result = await resolveAccess({
      dmPolicy: "open",
      senderId: "random-user",
      rawBody: "hello",
      readStoreAllowFrom: async () => ["random-user"],
      runtime: {
        shouldComputeCommandAuthorized: () => false,
        resolveCommandAuthorizedFromAuthorizers: () => true,
      },
    });

    expect(result.access).toMatchObject({
      decision: "block",
      reason: "dmPolicy=open (not allowlisted)",
      effectiveAllowFrom: [],
    });
    expect(result.commandAuthorized).toBeUndefined();
  });

  it("resolves generic message sender access groups for direct DMs", async () => {
    const result = await resolveAccess({
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
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:owners"],
      senderId: "owner-pubkey",
    });

    expect(result).toMatchObject({
      access: { decision: "allow", effectiveAllowFrom: ["accessGroup:owners", "owner-pubkey"] },
      commandAuthorized: true,
    });
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
        authorizer({ senderId: "pair-me", reply: async () => {} }),
        authorizer({ senderId: "blocked", reply: async () => {} }),
      ]),
    ).resolves.toEqual(["pairing", "block"]);

    expect(issuePairingChallenge).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith({
      senderId: "blocked",
      reason: "dmPolicy=disabled",
      reasonCode: "dm_policy_disabled",
    });
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

    expect(policy).toEqual({
      allowedKinds: [4],
      maxFutureSkewSec: 120,
      maxCiphertextBytes: 16 * 1024,
      maxPlaintextBytes: 8 * 1024,
      rateLimit: {
        windowMs: 60_000,
        maxPerSenderPerWindow: 20,
        maxGlobalPerWindow: 200,
        maxTrackedSenderKeys: 4096,
      },
    });
  });

  it("routes a targetless contextual reply to the inbound Reef peer", async () => {
    const { runInbound, runtime } = createDirectDmRuntime();
    const deliver = vi.fn(async () => {});
    const channelIngress = await resolveStableChannelMessageIngress({
      channelId: "reef",
      accountId: "default",
      subject: { stableId: "clawstudio" },
      conversation: { kind: "direct", id: "clawstudio" },
      dmPolicy: "allowlist",
    });

    const result = await dispatchInboundDirectDmWithRuntime({
      channelIngress,
      cfg: {
        session: { store: { type: "jsonl" } },
      } as never,
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
      onRecordError: () => {},
      onDispatchError: () => {},
    });

    expect(result).toMatchObject({
      route: { agentId: "agent-main", accountId: "default", sessionKey: "dm:clawstudio" },
      storePath: "/tmp/direct-dm-session-store",
      ctxPayload: {
        Body: "env:hello world",
        BodyForAgent: "hello world",
        From: "reef:clawstudio",
        To: "reef:roboclaw",
        SenderId: "clawstudio",
        MessageSid: "event-123",
        ReplyToId: "event-parent",
        MessageThreadId: "thread-7",
        NativeDirectUserId: "clawstudio",
        OriginatingTo: "reef:clawstudio",
        CommandAuthorized: true,
      },
    });
    const currentChannelId = result.ctxPayload.OriginatingTo ?? result.ctxPayload.To;
    expect(
      resolveImplicitMessageActionTarget({ currentChannelId, currentChannelProvider: "reef" }),
    ).toBe("reef:clawstudio");
    expect(runInbound).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ text: "reply text" });
  });
});
