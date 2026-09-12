// Tests queued implicit reply-target injection and channel-owned exclusions.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelId, ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";
import { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import {
  resolveFollowupImplicitReplyCurrentMessageId,
  type AdmittedFollowupTurn,
} from "./followup-turn-admission.js";

const baseConfig = {} as OpenClawConfig;

describe("queued implicit reply targets", () => {
  it("injects the queued current message as the implicit reply target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "queued answer" }],
        originatingChannel: "telegram",
        originatingReplyToMode: "all",
        currentMessageId: "tg-msg-2",
      }),
    ).toMatchObject([{ text: "queued answer", replyToId: "tg-msg-2" }]);
  });

  it("keeps implicit injection on the first payload when replyToMode is first", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "first" }, { text: "second" }],
        originatingChannel: "telegram",
        originatingReplyToMode: "first",
        currentMessageId: "tg-msg-2",
      }),
    ).toMatchObject([{ text: "first", replyToId: "tg-msg-2" }, { text: "second" }]);
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "first" }, { text: "second" }],
        originatingChannel: "telegram",
        originatingReplyToMode: "first",
        currentMessageId: "tg-msg-2",
      })[1]?.replyToId,
    ).toBeUndefined();
  });

  it("does not inject an implicit reply target when replyToMode is off", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "queued answer" }],
        originatingChannel: "telegram",
        originatingReplyToMode: "off",
        currentMessageId: "tg-msg-2",
      }),
    ).toMatchObject([{ text: "queued answer" }]);
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "queued answer" }],
        originatingChannel: "telegram",
        originatingReplyToMode: "off",
        currentMessageId: "tg-msg-2",
      })[0]?.replyToId,
    ).toBeUndefined();
  });

  it("preserves an explicit replyToId over the implicit current message", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "queued answer", replyToId: "explicit-1" }],
        originatingChannel: "telegram",
        originatingReplyToMode: "all",
        currentMessageId: "tg-msg-2",
      }),
    ).toMatchObject([{ text: "queued answer", replyToId: "explicit-1" }]);
  });

  it("uses originatingReplyToId as the current message for restart-sentinel followups", () => {
    expect(
      resolveFollowupImplicitReplyCurrentMessageId({
        messageId: "new-msg",
        originatingReplyToId: "orig-msg",
        originatingChannel: "telegram",
        run: {
          messageProvider: "telegram",
          inputProvenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
        },
      } as never),
    ).toBe("orig-msg");
    expect(
      resolveFollowupImplicitReplyCurrentMessageId({
        messageId: "new-msg",
        originatingReplyToId: "orig-msg",
        originatingChannel: "telegram",
        run: { messageProvider: "telegram", inputProvenance: { kind: "external_user" } },
      } as never),
    ).toBe("new-msg");
  });

  it("withholds implicit reply IDs for foreign channels and internal provenance", () => {
    expect(
      resolveFollowupImplicitReplyCurrentMessageId({
        messageId: "tg-msg-2",
        originatingChannel: "telegram",
        run: {
          messageProvider: "telegram",
          inputProvenance: { kind: "external_user" },
        },
      } as never),
    ).toBe("tg-msg-2");
    expect(
      resolveFollowupImplicitReplyCurrentMessageId({
        messageId: "discord-msg-2",
        originatingChannel: "slack",
        run: {
          messageProvider: "discord",
          inputProvenance: { kind: "external_user" },
        },
      } as never),
    ).toBeUndefined();
    expect(
      resolveFollowupImplicitReplyCurrentMessageId({
        messageId: "child-announce",
        originatingChannel: "telegram",
        run: {
          messageProvider: "telegram",
          inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        },
      } as never),
    ).toBeUndefined();
    expect(
      resolveFollowupImplicitReplyCurrentMessageId({
        messageId: "new-msg",
        originatingReplyToId: "orig-msg",
        originatingChannel: "telegram",
        run: {
          messageProvider: "telegram",
          inputProvenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
        },
      } as never),
    ).toBe("orig-msg");
  });
});

function createTurn(overrides: Partial<AdmittedFollowupTurn> = {}): AdmittedFollowupTurn {
  return {
    runId: "run-1",
    queued: {
      prompt: "queued",
      enqueuedAt: 1,
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: "main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        provider: "anthropic",
        model: "claude",
        messageProvider: "discord",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {} as AdmittedFollowupTurn["operation"],
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => undefined,
      publish: () => undefined,
      adopt: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
    ...overrides,
  };
}

function createSettledExecution(finalText = ""): AgentTurnExecutionResult {
  return {
    runId: "run-1",
    outcome: {
      kind: "settled",
      status: "ok",
      result: {
        payloads: finalText ? [{ text: finalText }] : [],
        meta: { durationMs: 0, finalAssistantVisibleText: finalText },
      },
      resolved: { provider: "anthropic", model: "claude" },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    },
  };
}

function createAccounting(
  payloadArray: ReplyPayload[] = [],
  overrides: Record<string, unknown> = {},
) {
  return {
    payloadArray,
    providerUsed: "anthropic",
    modelUsed: "claude",
    preserveUserFacingSessionState: false,
    replyUsageState: {},
    usage: undefined,
    terminalFailurePayload: undefined,
    ...overrides,
  } as never;
}

describe("resolveFollowupDeliveryDecision implicit reply targets", () => {
  it("does not inject a foreign-channel message id as the implicit reply target", () => {
    const turn = createTurn({
      queued: {
        prompt: "queued",
        enqueuedAt: 1,
        originatingChannel: "slack",
        originatingTo: "channel:C1",
        originatingReplyToMode: "all",
        messageId: "discord-msg-2",
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session",
          sessionKey: "main",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp",
          config: {},
          provider: "anthropic",
          model: "claude",
          messageProvider: "discord",
          timeoutMs: 1_000,
          blockReplyBreak: "message_end",
          inputProvenance: { kind: "external_user" },
        },
      },
    } as never);
    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution("queued answer"),
      accounting: createAccounting([{ text: "queued answer" }]),
    });
    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "queued answer" }],
    });
    expect(
      decision.kind === "deliver" ? decision.payloads[0]?.replyToId : "missing",
    ).toBeUndefined();
  });

  it("does not inject an inter-session announcement id as the implicit reply target", () => {
    const turn = createTurn({
      queued: {
        prompt: "queued",
        enqueuedAt: 1,
        originatingChannel: "telegram",
        originatingTo: "268300329",
        originatingReplyToMode: "all",
        messageId: "child-announce",
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session",
          sessionKey: "main",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp",
          config: {},
          provider: "anthropic",
          model: "claude",
          messageProvider: "telegram",
          timeoutMs: 1_000,
          blockReplyBreak: "message_end",
          inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        },
      },
    } as never);
    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution("queued answer"),
      accounting: createAccounting([{ text: "queued answer" }]),
    });
    expect(
      decision.kind === "deliver" ? decision.payloads[0]?.replyToId : "missing",
    ).toBeUndefined();
  });

  it("keeps the restart-sentinel originating reply target through decision", () => {
    const turn = createTurn({
      queued: {
        prompt: "queued",
        enqueuedAt: 1,
        originatingChannel: "telegram",
        originatingTo: "268300329",
        originatingReplyToMode: "all",
        messageId: "new-msg",
        originatingReplyToId: "orig-msg",
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session",
          sessionKey: "main",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp",
          config: {},
          provider: "anthropic",
          model: "claude",
          messageProvider: "telegram",
          timeoutMs: 1_000,
          blockReplyBreak: "message_end",
          inputProvenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
        },
      },
    } as never);
    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution("queued answer"),
      accounting: createAccounting([{ text: "queued answer" }]),
    });
    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "queued answer", replyToId: "orig-msg" }],
    });
  });

  it("preserves an explicit reply target even when implicit injection is excluded", () => {
    const turn = createTurn({
      queued: {
        prompt: "queued",
        enqueuedAt: 1,
        originatingChannel: "slack",
        originatingTo: "channel:C1",
        originatingReplyToMode: "all",
        messageId: "discord-msg-2",
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session",
          sessionKey: "main",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp",
          config: {},
          provider: "anthropic",
          model: "claude",
          messageProvider: "discord",
          timeoutMs: 1_000,
          blockReplyBreak: "message_end",
          inputProvenance: { kind: "external_user" },
        },
      },
    } as never);
    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution("queued answer"),
      accounting: createAccounting([{ text: "queued answer", replyToId: "explicit-target" }]),
    });
    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "queued answer", replyToId: "explicit-target" }],
    });
  });
});

function createOwnedCorrelationPlugin(): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "owned-correlation" as ChannelId,
      label: "owned-correlation",
      config: { listAccountIds: () => [], resolveAccount: () => ({}) },
    }),
    threading: {
      resolveReplyTransport: () => {
        throw new Error("decision must not resolve channel-owned correlation");
      },
    },
  };
}

describe("channel-owned implicit reply policy", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "owned-correlation", plugin: createOwnedCorrelationPlugin(), source: "test" },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("does not inject when the channel owns correlation", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "queued answer" }],
        originatingChannel: "owned-correlation",
        originatingReplyToMode: "all",
        currentMessageId: "inbound-2",
      })[0]?.replyToId,
    ).toBeUndefined();
  });

  it("preserves an empty replyToId opt-out when the channel owns correlation", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "queued answer", replyToId: "" }],
        originatingChannel: "owned-correlation",
        originatingReplyToMode: "all",
        currentMessageId: "inbound-2",
      }),
    ).toMatchObject([{ text: "queued answer", replyToId: "" }]);
  });

  it("keeps first-mode unthreaded at decision when the channel owns correlation", () => {
    const turn = createTurn({
      queued: {
        prompt: "queued",
        enqueuedAt: 1,
        originatingChannel: "owned-correlation",
        originatingTo: "dm:qa-peer",
        originatingReplyToMode: "first",
        originatingChatType: "direct",
        messageId: "inbound-2",
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session",
          sessionKey: "main",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp",
          config: {},
          provider: "anthropic",
          model: "claude",
          messageProvider: "owned-correlation",
          timeoutMs: 1_000,
          blockReplyBreak: "message_end",
          inputProvenance: { kind: "external_user" },
        },
      },
    } as never);
    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution("queued answer"),
      accounting: createAccounting([{ text: "queued answer" }]),
    });
    expect(
      decision.kind === "deliver" ? decision.payloads[0]?.replyToId : "missing",
    ).toBeUndefined();
  });
});
