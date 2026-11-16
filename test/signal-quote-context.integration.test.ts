import { createServer, type ServerResponse } from "node:http";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  buildReplyRouteThreadingToolContext,
  buildThreadingToolContext,
} from "../src/auto-reply/reply/agent-runner-utils.js";
import { prepareCliReplyPayload } from "../src/auto-reply/reply/cli-reply-payload.js";
import { buildInboundUserContextPrefix } from "../src/auto-reply/reply/inbound-meta.js";
import { createPreparationRun } from "../src/auto-reply/reply/reply-agent-turn-preparation.test-support.js";
import { resolveAndApplyOutboundReplyToId } from "../src/infra/outbound/message-action-threading.js";
import { createPluginRuntimeMock } from "../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { createTempDirTracker } from "./helpers/temp-dir.js";

const capture = vi.hoisted(() => ({
  dispatch: async (_plan: ChannelInboundTurnPlan): Promise<void> => {},
}));

// Exercise receive/context/delivery; substitute model dispatch and session recording only.
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    resolveInboundSessionEnvelopeContextAsync: async () => ({
      storePath: "/tmp/signal-quote-sessions.json",
      envelopeOptions: {},
      previousTimestamp: undefined,
    }),
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) =>
      actual.runChannelInboundEvent({
        ...params,
        adapter: {
          ...params.adapter,
          resolveTurn: async (...args) => {
            const plan = await params.adapter.resolveTurn(...args);
            if (!("route" in plan) || !("delivery" in plan)) {
              throw new Error("Expected Signal turn plan");
            }
            return {
              channel: plan.channel,
              accountId: plan.accountId,
              routeSessionKey: plan.route.sessionKey,
              storePath: "/tmp/signal-quote-sessions.json",
              ctxPayload: plan.ctxPayload,
              recordInboundSession: async () => {},
              runDispatch: async () => {
                await plan.replyOptions?.turnAdoptionLifecycle?.onAdopted();
                await capture.dispatch(plan);
                return { queuedFinal: false, counts: { tool: 0, block: 1, final: 0 } };
              },
              runDispatchLifecycle: {
                turnAdoptionLifecycle: plan.replyOptions?.turnAdoptionLifecycle,
                onDispatchSkipped: () => {},
              },
            };
          },
        },
      }),
  };
});

const { monitorSignalProvider, signalPlugin } = await import("../extensions/signal/api.js");
const { setSignalRuntime } = await import("../extensions/signal/runtime-api.js");
const temp = createTempDirTracker();
const currentId = 1700000001001;
const quoteId = 1700000000007;
const author = "b2345678-90ab-4cde-8f01-23456789abcd";
let eventStream: ServerResponse | undefined;
let input: unknown;
const wires: Record<string, unknown>[] = [];
let listener: Awaited<ReturnType<typeof reserveTestPortListener>>;

beforeAll(async () => {
  listener = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((req, res) => {
        void (async () => {
          if (req.method === "GET") {
            eventStream = res;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`event: receive\ndata: ${JSON.stringify(input)}\n\n`);
            return;
          }
          const chunks = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
          if (body.method === "send") {
            wires.push(body.params as Record<string, unknown>);
          }
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { timestamp: 1700000002002 } }),
          );
        })().catch((error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      }),
  });
});

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "signal", source: "test", plugin: signalPlugin }]),
  );
});

afterAll(async () => {
  eventStream?.destroy();
  await listener.releaseListener();
  await listener.claim.release();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  temp.cleanup();
  setActivePluginRegistry(createTestRegistry([]));
});

async function receive(options: { id?: number; quote?: boolean; edit?: boolean } = {}) {
  const stateDir = temp.make("signal-quote-");
  setSignalRuntime(
    createPluginRuntimeMock({
      state: {
        openChannelIngressQueue: (params) =>
          createChannelIngressQueueForTests({ ...params, channelId: "signal", stateDir }),
      },
    }),
  );
  const cfg = {
    messages: { inbound: { debounceMs: 0 } },
    channels: {
      signal: {
        account: "+15550009999",
        dmPolicy: "open" as const,
        allowFrom: ["*"],
        replyToMode: "all" as const,
        transport: {
          kind: "external-native" as const,
          url: `http://127.0.0.1:${listener.claim.port}`,
        },
      },
    },
  };
  const message = {
    timestamp: currentId,
    message: "How is the task going?",
    attachments: [],
    ...(options.quote === false
      ? {}
      : {
          quote: {
            id: options.id ?? quoteId,
            author,
            authorNumber: null,
            authorUuid: author,
            text: "Prepare the fictional report.",
            attachments: [],
          },
        }),
  };
  input = {
    envelope: {
      sourceNumber: "+15550001111",
      sourceName: "Fictional requester",
      timestamp: currentId,
      ...(options.edit
        ? { editMessage: { targetSentTimestamp: 1700000000002, dataMessage: message } }
        : { dataMessage: message }),
    },
  };
  const abort = new AbortController();
  const firstWire = wires.length;
  const dispatched = Promise.withResolvers<ChannelInboundTurnPlan>();
  capture.dispatch = async (plan) => {
    try {
      await plan.delivery.deliver({ text: "Fictional status" }, { kind: "block" });
      const prepareDurable = plan.delivery.durable;
      if (typeof prepareDurable !== "function") {
        throw new Error("Expected Signal final planner");
      }
      const durable = await prepareDurable({ text: "Final fictional status" }, { kind: "final" });
      const send = signalPlugin.message?.send?.text;
      const to = plan.ctxPayload.To;
      if (!durable || !send || !to) {
        throw new Error("Expected Signal durable final adapter");
      }
      await send({
        cfg,
        to,
        text: "Final fictional status",
        accountId: "default",
        deps: durable.deps,
        replyToId: durable.replyToId,
      });
      dispatched.resolve(plan);
    } catch (error) {
      dispatched.reject(error);
    }
  };
  const monitor = monitorSignalProvider({
    config: cfg,
    abortSignal: abort.signal,
    autoStart: false,
    runtime: {
      log: () => {},
      exit: (code) => {
        throw new Error(`Unexpected exit ${code}`);
      },
      error: (error) => dispatched.reject(new Error(String(error))),
    },
  });
  try {
    const plan = await dispatched.promise;
    const context = plan.ctxPayload;
    const tool = buildThreadingToolContext({
      sessionCtx: context,
      config: cfg,
      hasRepliedRef: { value: false },
    });
    const action: Record<string, unknown> = { target: context.To };
    resolveAndApplyOutboundReplyToId(action, {
      channel: "signal",
      toolContext: tool,
      matchesToolContextTarget: signalPlugin.threading?.matchesToolContextTarget,
    });
    const followup = createPreparationRun({
      run: { config: cfg },
      originatingChannel: "signal",
      originatingTo: context.To,
      originatingReplyToId: context.ReplyToId,
    });
    const cliContext = buildReplyRouteThreadingToolContext({
      run: followup.run,
      replyRoute: followup,
      sessionCtx: context,
      hasRepliedRef: { value: false },
    });
    const cli = prepareCliReplyPayload(
      "[[reply_to_current]] Status",
      String(cliContext.currentMessageId),
    );
    return {
      prefix: buildInboundUserContextPrefix(context),
      context,
      action,
      cli,
      wires: wires.slice(firstWire),
    };
  } finally {
    abort.abort();
    eventStream?.destroy();
    await monitor;
  }
}

function renderedQuote(prefix: string): unknown {
  const section = prefix.split("Reply chain of current user message (nearest first):")[1];
  const json = section?.match(/```json\n([^]*?)\n```/)?.[1];
  return json ? JSON.parse(json) : undefined;
}

it("renders the actual quoted ID and UUID author while native, tool and CLI replies target the current message", async () => {
  const first = await receive();
  const second = await receive({ id: quoteId + 1 });
  for (const [result, id] of [
    [first, quoteId],
    [second, quoteId + 1],
  ] as const) {
    expect(renderedQuote(result.prefix)).toEqual([
      {
        message_id: String(id),
        sender: `uuid:${author}`,
        body: "Prepare the fictional report.",
        is_quote: true,
      },
    ]);
    expect(result.action.replyTo).toBe(String(currentId));
    expect(result.cli.replyToId).toBe(String(currentId));
    expect(result.wires).toHaveLength(2);
    for (const wire of result.wires) {
      expect(wire).toMatchObject({
        quoteTimestamp: currentId,
        quoteAuthor: "+15550001111",
        quoteMessage: "How is the task going?",
      });
    }
  }
  expect(first.prefix).not.toBe(second.prefix);
});

it("keeps edited-event identity separate from quoted identity and the original native target", async () => {
  const result = await receive({ edit: true });
  expect(result.context.MessageSid).toBe(String(currentId));
  expect(renderedQuote(result.prefix)).toMatchObject([{ message_id: String(quoteId) }]);
  expect(result.action.replyTo).toBe("1700000000002");
  expect(result.cli.replyToId).toBe("1700000000002");
  for (const wire of result.wires) {
    expect(wire).toMatchObject({
      quoteTimestamp: 1700000000002,
      quoteMessage: "How is the task going?",
    });
  }
});

it("does not fabricate a quoted body or author when the current message has no quote", async () => {
  const result = await receive({ quote: false });
  expect(result.prefix).not.toContain("Prepare the fictional report.");
  expect(result.prefix).not.toContain(author);
  expect(result.action.replyTo).toBe(String(currentId));
});
