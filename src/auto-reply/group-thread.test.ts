import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareAgentRunTerminalReply } from "../agents/agent-run-terminal-reply.js";
import * as outcome from "../channels/turn/agent-run-terminal-outcome.js";
import type { OpenClawConfig as Config } from "../config/types.openclaw.js";
import * as payloads from "../infra/outbound/payloads.js";
import * as bindings from "../infra/outbound/session-binding-service.js";
import type { PluginHookReplyPayloadSendingEvent } from "../plugins/hook-types.js";
import { dispatchInboundMessage } from "./dispatch.js";
import { resolveGroupThreadConfig } from "./group-thread-config.js";
import { buildThreadingToolContext } from "./reply/agent-runner-utils.js";
import { createReplyTurnLedger } from "./reply/dispatch-from-config.turn-ledger.js";
import type {
  DispatchFromConfigParams as Turn,
  DispatchFromConfigResult as Result,
} from "./reply/dispatch-from-config.types.js";
import { createReplyDispatcher } from "./reply/reply-dispatcher.js";
import type { ReplyDispatchRuntimeInfo } from "./reply/reply-dispatcher.types.js";
import * as sourceIds from "./reply/source-turn-id.js";
import type { MsgContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

vi.mock("./reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: () => {
    throw new Error("The fixture must provide its participant reply resolver");
  },
}));

const replyHooks = vi.hoisted(() => {
  const state: {
    enabled: boolean;
    events: PluginHookReplyPayloadSendingEvent[];
    rewriteText?: string;
  } = { enabled: false, events: [] };
  return state;
});
afterEach(() => {
  replyHooks.enabled = false;
  replyHooks.rewriteText = undefined;
  replyHooks.events.length = 0;
});

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (name: string) => replyHooks.enabled && name === "reply_payload_sending",
    runReplyPayloadSending: async (event: PluginHookReplyPayloadSendingEvent) => {
      replyHooks.events.push(event);
      return replyHooks.rewriteText === undefined
        ? undefined
        : { payload: { ...event.payload, text: replyHooks.rewriteText } };
    },
  }),
}));

const roster: Config["agents"] = {
  entries: {
    alice: { identity: { name: "Alice", emoji: "🦉" } },
    bob: { identity: { name: "Bob" } },
    carol: { identity: { name: "Carol" } },
  },
};

function config(entry: NonNullable<Config["broadcast"]>[string] = ["alice", "bob"]): Config {
  return { agents: roster, broadcast: { "telegram:-100123": entry } };
}

const continuationConfig = () => config({ agents: ["alice", "bob"], maxRounds: 2, maxTurns: 4 });

function dispatch(
  params: {
    cfg?: Config;
    enableHooks?: boolean;
    prepared?: boolean;
    deliveryFinalization?: Promise<{ visibleReplySent: true }>;
    text?: string;
    context?: Partial<MsgContext>;
    replyOptions?: Turn["replyOptions"];
    reply?: (turn: Turn, index: number) => string[] | Promise<string[]>;
    result?: (turn: Turn, result: Result) => Result;
  } = {},
) {
  const turns: Turn[] = [];
  const delivered: {
    text: string | undefined;
    participant: ReplyDispatchRuntimeInfo["participant"];
  }[] = [];
  const deliveredPayloads: ReplyPayload[] = [];
  const deliver = async (payload: ReplyPayload, info: ReplyDispatchRuntimeInfo) => {
    delivered.push({ text: payload.text, participant: info.participant });
    deliveredPayloads.push(payload);
    return params.deliveryFinalization
      ? { visibleReplySent: false, finalization: params.deliveryFinalization }
      : undefined;
  };
  const dispatcher = createReplyDispatcher({
    deliver: async (payload, info) => {
      const [plan] = payloads.createOutboundPayloadPlan([payload]);
      return plan ? deliver(plan.payload, info) : { visibleReplySent: false };
    },
    deliverPrepared: (plan, info) => deliver(plan.payload, info),
  });
  const text = params.text ?? "Discuss the proposal.";
  const done = dispatchInboundMessage({
    cfg: params.cfg ?? config(),
    ctx: {
      Body: text,
      BodyForAgent: text,
      CommandBody: text,
      CommandSource: "text",
      ChatType: "group",
      SessionKey: "agent:routed:telegram:group:-100123",
      AgentId: "routed",
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-100123",
      NativeChannelId: "-100123",
      From: "telegram:group:-100123",
      To: "telegram:-100123",
      MessageSid: "physical-1",
      ...params.context,
    },
    dispatcher,
    outboundHooks: params.enableHooks ? "enabled" : "disabled",
    replyOptions: params.replyOptions,
    dispatchReplyFromConfig: async (turn) => {
      const index = turns.push(turn) - 1;
      const replies = await (params.reply?.(turn, index) ?? ["A useful answer."]);
      const ledger = createReplyTurnLedger(turn.dispatcher);
      let final = 0;
      for (const replyText of replies) {
        const payload = { text: prepareAgentRunTerminalReply({ rawText: replyText }).text };
        if (!payload.text) {
          continue;
        }
        const delivery = params.prepared
          ? ledger.sendPreparedQueued(
              "final",
              expectDefined(
                payloads.createStructuredOutboundPayloadPlan([payload])[0],
                "expected reply plan",
              ),
            )
          : ledger.sendQueued("final", payload);
        final += Number(delivery.queued);
      }
      const result = { queuedFinal: final > 0, counts: { tool: 0, block: 0, final } };
      return params.result?.(turn, result) ?? result;
    },
  });
  return { done, turns, delivered, deliveredPayloads };
}

async function completed(params: Parameters<typeof dispatch>[0]) {
  const run = dispatch(params);
  await run.done;
  return run;
}

// Release blocked participants and drain delivery even if the interleaving assertion fails.
async function held(
  params: NonNullable<Parameters<typeof dispatch>[0]> & { initialTurns?: number },
  inspect?: (run: ReturnType<typeof dispatch>) => void | Promise<void>,
) {
  const gate = createDeferred();
  const run = dispatch({
    ...params,
    reply: async (turn, index) => {
      const replies = await (params.reply?.(turn, index) ?? ["Done."]);
      await gate.promise;
      return replies;
    },
  });
  try {
    await vi.waitFor(() => expect(run.turns).toHaveLength(params.initialTurns ?? 2));
    await inspect?.(run);
  } finally {
    gate.resolve();
    await run.done;
  }
  return run;
}

describe("agent group thread dispatch", () => {
  it.each([false, true])("shares settled post-hook finals (prepared: %s)", async (prepared) => {
    replyHooks.enabled = true;
    const publicFinal = "Bob, final. [[reply_to:999]]";
    replyHooks.rewriteText = publicFinal;
    const deliveryFinalization = createDeferred<{ visibleReplySent: true }>();
    const run = dispatch({
      cfg: continuationConfig(),
      enableHooks: true,
      prepared,
      deliveryFinalization: deliveryFinalization.promise,
      reply: (_turn, index) => (index === 0 ? ["Bob, draft."] : ["NO_REPLY"]),
    });
    try {
      await vi.waitFor(() => expect(run.deliveredPayloads).toHaveLength(1));
      expect(run.turns).toHaveLength(2);
      expect(run.deliveredPayloads[0]?.text).toBe(prepared ? publicFinal : "Bob, final.");
      expect(run.deliveredPayloads[0]?.replyToId).toBe(prepared ? undefined : "999");
      deliveryFinalization.resolve({ visibleReplySent: true });
      await run.done;
      expect(run.turns).toHaveLength(4);
      const continuation = expectDefined(run.turns[3], "expected Bob's continuation");
      expect(continuation.ctx.BodyForAgent).toContain(publicFinal);
      expect(continuation.ctx.BodyForAgent).not.toContain("draft");
    } finally {
      deliveryFinalization.resolve({ visibleReplySent: true });
      await run.done;
    }
  });

  it.each<[string, Parameters<typeof dispatch>[0], string[], boolean]>([
    ["operator UI", { context: { Provider: "webchat", Surface: "webchat" } }, ["routed"], false],
    ["internal event", { context: { InternalTurnSource: "heartbeat" } }, ["routed"], false],
    ["single mention", { text: "@Bob, review this." }, ["bob"], true],
    ["two mentions", { text: "@Alice and @Bob, review this." }, ["alice", "bob"], true],
    [
      "mention gating disabled",
      { cfg: config({ agents: ["alice", "bob"], mentionGating: false }), text: "@Bob" },
      ["alice", "bob"],
      true,
    ],
    ["single participant", { cfg: config(["bob"]) }, ["bob"], false],
  ])("routes and labels %s", async (_name, params, agents, labeled) => {
    const run = await completed(params);
    expect(run.turns.map(({ ctx }) => ctx.AgentId)).toEqual(agents);
    const expected = agents.map((agentId) => ({
      text: "A useful answer.",
      participant: labeled ? { agentId, name: agentId === "alice" ? "Alice" : "Bob" } : undefined,
    }));
    if (labeled) {
      expect(run.delivered).toMatchObject(expected);
    } else {
      expect(run.delivered).toEqual(expected);
    }
  });

  it.each(["group", "direct"] as const)("isolates %s account/topic namespaces", async (kind) => {
    const keys = new Set<string>();
    for (const accountId of ["work", "personal"]) {
      for (const peerId of kind === "group" ? [7, 8] : ["42", "43"]) {
        const sessionSuffix =
          kind === "group"
            ? `telegram:group:-100123:thread:telegram-account-${accountId}:thread:${peerId}`
            : `telegram:${accountId}:direct:${peerId}:thread:${peerId}:7`;
        const run = await completed(
          kind === "group"
            ? {
                context: { AccountId: accountId, MessageThreadId: peerId },
              }
            : {
                cfg: { agents: roster, broadcast: { [`telegram:${peerId}`]: ["alice", "bob"] } },
                context: {
                  ChatType: "direct",
                  DmScope: "main",
                  AccountId: accountId,
                  NativeChannelId: String(peerId),
                  MessageThreadId: 7,
                  SessionKey: `agent:routed:${sessionSuffix}`,
                },
              },
        );
        for (const { ctx } of run.turns) {
          expect(ctx.SessionKey).toBe(`agent:${ctx.AgentId}:${sessionSuffix}`);
          if (kind === "direct") {
            expect(ctx.RuntimePolicySessionKey).toBe(ctx.SessionKey);
          }
          keys.add(expectDefined(ctx.SessionKey, "expected participant session"));
        }
      }
    }
    expect(keys.size).toBe(8);
  });

  it("preserves shared main DM sessions", async () => {
    const shared = await completed({
      context: { ChatType: "direct", DmScope: "main", SessionKey: "agent:routed:main" },
    });
    expect(shared.turns.map(({ ctx }) => ctx.SessionKey)).toEqual([
      "agent:alice:main",
      "agent:bob:main",
    ]);
  });

  it("continues from delivered streamed answers without sharing supplemental blocks", async () => {
    const run = await completed({
      cfg: continuationConfig(),
      reply: (turn, index) => {
        if (index === 0) {
          turn.dispatcher.sendBlockReply({ text: "Private reasoning", isReasoning: true });
          turn.dispatcher.sendBlockReply({ text: "Working on it", isCommentary: true });
          turn.dispatcher.sendBlockReply({ text: "Bob, the streamed answer is ready." });
        }
        return [];
      },
    });
    expect(run.turns).toHaveLength(4);
    const digest = run.turns[3]?.ctx.BodyForAgent;
    expect(digest).toContain("Bob, the streamed answer is ready.");
    expect(digest).not.toContain("Private reasoning");
    expect(digest).not.toContain("Working on it");
  });

  it("keeps continuation reply targets physical and transcript identities distinct", async () => {
    const context: Partial<MsgContext> = {
      AccountId: "work",
      MessageThreadId: 7,
      MessageSidFull: undefined,
      MessageSidFirst: "physical-first",
      MessageSidLast: "physical-last",
    };
    const originalSourceId = sourceIds.buildChannelSourceTurnId({
      provider: "telegram",
      accountId: "work",
      conversationId: "telegram:-100123",
      messageId: "physical-1",
    });
    sourceIds.setChannelSourceTurnId(context, originalSourceId);
    const run = await completed({ cfg: continuationConfig(), context });
    const continuations = run.turns.slice(2).map((turn) => turn.ctx);
    expect(continuations).toHaveLength(2);
    for (const ctx of continuations) {
      const threading = buildThreadingToolContext({
        sessionCtx: ctx,
        config: undefined,
        hasRepliedRef: undefined,
      });
      expect(threading.currentMessageId).toBe("physical-1");
      expect(ctx.MessageSid).not.toBe("physical-1");
      expect(ctx).toMatchObject({
        MessageSidFirst: "physical-first",
        MessageSidLast: "physical-last",
      });
    }
    expect(new Set(continuations.map((ctx) => ctx.MessageSid)).size).toBe(2);
    const ids = continuations.map(sourceIds.readChannelSourceTurnId);
    expect(ids.every(Boolean)).toBe(true);
    expect(ids).not.toContain(originalSourceId);
    expect(new Set(ids).size).toBe(2);
  });

  it.each([2, 4])("reserves maxTurns=%i before parallel launch", async (maxTurns) => {
    const run = await held({
      initialTurns: Math.min(3, maxTurns),
      cfg: config({ agents: ["alice", "bob", "carol"], maxRounds: 4, maxTurns }),
      reply: () => ["First delivery.", "Second delivery."],
    });
    expect(run.turns).toHaveLength(maxTurns);
    expect(run.delivered).toHaveLength(maxTurns * 2);
  });

  it.each([
    { beforeStart: true, source: "ordinary" },
    { beforeStart: false, source: "ordinary" },
    { beforeStart: true, source: "lifecycle" },
    { beforeStart: false, source: "lifecycle" },
  ])("$source cancellation (before start: $beforeStart)", async ({ beforeStart, source }) => {
    const controller = new AbortController();
    if (beforeStart) {
      controller.abort();
    }
    const cfg = config({ agents: ["alice", "bob"], maxRounds: 4, maxTurns: 8 });
    cfg.broadcast = { ...cfg.broadcast, strategy: "sequential" };
    const abortSignal = controller.signal;
    const lifecycle = { abortSignal, onAdopted: async () => {} };
    const participantSignals: (AbortSignal | undefined)[] = [];
    const run = await completed({
      cfg,
      replyOptions: source === "ordinary" ? { abortSignal } : { turnAdoptionLifecycle: lifecycle },
      reply: ({ replyOptions }) => {
        participantSignals.push(replyOptions?.abortSignal);
        controller.abort();
        return ["This turn completed."];
      },
    });
    expect(run.turns).toHaveLength(beforeStart ? 0 : 1);
    expect(participantSignals.every((signal) => signal?.aborted)).toBe(true);
  });

  it("adopts the inbound once before participants and settles once after all participants", async () => {
    const events: string[] = [];
    await completed({
      replyOptions: {
        turnAdoptionLifecycle: {
          onAdopted: async () => void events.push("adopted"),
          onSettled: () => void events.push("settled"),
        },
      },
      reply: async ({ ctx }) => {
        events.push(`${ctx.AgentId}:started`);
        await Promise.resolve();
        events.push(`${ctx.AgentId}:completed`);
        return ["Done."];
      },
    });
    expect(events[0]).toBe("adopted");
    expect(events.at(-1)).toBe("settled");
    expect(events.filter((event) => event === "adopted")).toHaveLength(1);
    expect(events.filter((event) => event === "settled")).toHaveLength(1);
    const finished = events.filter((event) => event.endsWith(":completed"));
    expect(finished).toEqual(["alice:completed", "bob:completed"]);
  });

  it("shares an in-flight root budget across equivalent thread ids, while isolating accounts and other threads", async () => {
    const first = await held({ context: { AccountId: "work", MessageThreadId: 7 } }, async () => {
      const duplicate = dispatch({ context: { AccountId: "work", MessageThreadId: "7" } });
      const otherAccount = dispatch({ context: { AccountId: "personal", MessageThreadId: 7 } });
      const otherThread = dispatch({ context: { AccountId: "work", MessageThreadId: 8 } });
      await Promise.all([duplicate.done, otherAccount.done, otherThread.done]);
      expect(duplicate.turns).toHaveLength(0);
      expect(duplicate.delivered).toHaveLength(0);
      expect(otherAccount.turns).toHaveLength(2);
      expect(otherThread.turns).toHaveLength(2);
    });
    expect(first.turns).toHaveLength(2);
  });

  it.each(["session", "native command", "conversation binding"])(
    "keeps an ACP %s exclusive",
    async (source) => {
      const targetSessionKey = "agent:routed:acp:bound";
      const binding: bindings.SessionBindingRecord = {
        bindingId: "group-thread-acp-binding",
        targetSessionKey,
        targetKind: "session",
        conversation: { channel: "telegram", accountId: "default", conversationId: "-100123" },
        status: "active",
        boundAt: 1,
      };
      const adapter: bindings.SessionBindingAdapter = {
        channel: "telegram",
        accountId: "default",
        listBySession: (key) => (key === targetSessionKey ? [binding] : []),
        resolveByConversation: (ref) => (ref.conversationId === "-100123" ? binding : null),
      };
      if (source === "conversation binding") {
        bindings.registerSessionBindingAdapter(adapter);
      }
      try {
        const context: Partial<MsgContext> =
          source === "session"
            ? { SessionKey: targetSessionKey }
            : source === "native command"
              ? {
                  CommandSource: "native",
                  CommandTargetSessionKey: targetSessionKey,
                  CommandBody: "/status",
                }
              : {};
        const run = await completed({ context });
        expect(run.turns).toHaveLength(1);
        const dispatched = expectDefined(run.turns[0], "expected exclusive ACP dispatch");
        expect(dispatched.ctx.AgentId).toBe("routed");
        expect(dispatched.ctx.SessionKey).toBe(
          context.SessionKey ?? "agent:routed:telegram:group:-100123",
        );
        if (source === "native command") {
          expect(dispatched.ctx.CommandTargetSessionKey).toBe(targetSessionKey);
        }
        expect(expectDefined(run.delivered[0], "expected ACP reply").participant).toBeUndefined();
      } finally {
        if (source === "conversation binding") {
          bindings.unregisterSessionBindingAdapter({
            channel: "telegram",
            accountId: "default",
            adapter,
          });
        }
      }
    },
  );

  it("attributes parallel reply hooks to each participant's own run and session", async () => {
    replyHooks.enabled = true;
    await held({
      enableHooks: true,
      reply: ({ ctx, replyOptions }) => {
        replyOptions?.onAgentRunStart?.(`run-${ctx.AgentId}`);
        return [`Answer from ${ctx.AgentId}.`];
      },
    });
    expect(replyHooks.events).toMatchObject(
      ["alice", "bob"].map((id) => ({
        payload: { text: `Answer from ${id}.` },
        runId: `run-${id}`,
        sessionKey: `agent:${id}:telegram:group:-100123`,
      })),
    );
  });

  it("preserves message-tool-only silence without follow-up rounds", async () => {
    const run = dispatch({
      cfg: config({ agents: ["alice", "bob"], maxRounds: 4, maxTurns: 8 }),
      reply: () => ["NO_REPLY"],
      result: (_turn, result) => ({
        ...result,
        sourceReplyDeliveryMode: "message_tool_only",
        deliberateSilentTerminalReply: true,
      }),
    });
    expect(await run.done).toMatchObject({
      queuedFinal: false,
      sourceReplyDeliveryMode: "message_tool_only",
      deliberateSilentTerminalReply: true,
    });
    expect(run.turns).toHaveLength(2);
    expect(run.delivered).toHaveLength(0);
  });

  it("reports a failed participant while delivering its sibling's reply", async () => {
    const run = dispatch({
      reply: ({ ctx }) => {
        if (ctx.AgentId === "alice") {
          throw new Error("Participant run failed.");
        }
        return ["Bob completed the review."];
      },
      result: ({ ctx }, result) =>
        outcome.recordAgentRunTerminalOutcome(
          result,
          ctx.AgentId === "alice" ? "failed" : "completed",
        ),
    });
    const result = await run.done;
    expect(outcome.readAgentRunTerminalOutcome(result)).toBe("failed");
    expect(result.queuedFinal).toBe(true);
    expect(run.turns).toHaveLength(2);
    expect(run.delivered).toEqual([
      { text: "Bob completed the review.", participant: { agentId: "bob", name: "Bob" } },
    ]);
  });
});
describe("group thread entry compatibility", () => {
  it("prefers a qualified WhatsApp entry and keeps unqualified arrays single-pass and WhatsApp-only", () => {
    const legacy: Config = { agents: roster, broadcast: { "1203@g.us": ["alice", "bob"] } };
    const cfg: Config = {
      ...legacy,
      broadcast: {
        ...legacy.broadcast,
        "whatsapp:1203@g.us": { agents: ["carol"], maxRounds: 3, maxTurns: 8 },
      },
    };
    const resolve = (value: Config, channel = "whatsapp") =>
      resolveGroupThreadConfig({ cfg: value, channel, peerId: "1203@g.us" });
    const qualified = { agents: ["carol"], qualified: true, maxRounds: 3, maxTurns: 8 };
    const singlePass = { qualified: false, mentionGating: false, maxRounds: 1, maxTurns: 2 };
    expect(resolve(cfg)).toMatchObject(qualified);
    expect(resolve(legacy)).toMatchObject({ agents: ["alice", "bob"], ...singlePass });
    expect(resolve(legacy, "telegram")).toBeUndefined();
  });
});
