// Command authorization and queue outcomes through the real resolver and final delivery.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { MISSING_REPLY_NOTICE_TEXT } from "../../agents/reply-completion.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  getSessionControllerOperation,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { ReplyPayload } from "../types.js";
import type * as CommandsStatus from "./commands-status.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import type {
  DispatchFromConfigParams,
  DispatchFromConfigResult,
} from "./dispatch-from-config.types.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { getFollowupQueueDepth } from "./queue/enqueue.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

const statusReply = vi.hoisted(() => ({ outcome: "real" as "real" | "throw" | "empty" }));
vi.mock("./commands-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CommandsStatus>();
  return {
    ...actual,
    buildStatusReply: async (...args: Parameters<typeof actual.buildStatusReply>) => {
      if (statusReply.outcome === "throw") {
        throw new Error("status renderer unavailable");
      }
      return statusReply.outcome === "empty" ? undefined : await actual.buildStatusReply(...args);
    },
  };
});

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(),
}));

const channel = "groupchat";
const targetKey = `agent:main:${channel}:group:room`;
const modelReply = { payloads: [{ text: "Synthetic final answer." }], meta: { durationMs: 1 } };
let state: OpenClawTestState;
let cfg: OpenClawConfig;

beforeEach(async ({ onTestFinished }) => {
  const previous = captureActivePluginRegistrySnapshot();
  onTestFinished(() => {
    rollbackStagedPluginRegistry(previous);
  });
  stageActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: channel,
        source: `/tmp/${channel}/index.js`,
        plugin: createChannelTestPluginBase({
          id: channel,
          capabilities: { chatTypes: ["group"], nativeCommands: true },
        }),
      },
    ]),
    null,
    "default",
  );
  state = await createOpenClawTestState({
    label: "command-refusal",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  cfg = withFullRuntimeReplyConfig({
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    commands: { ownerAllowFrom: [`${channel}:owner`] },
    plugins: { enabled: false },
  });
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  vi.mocked(runEmbeddedAgent).mockReset().mockResolvedValue(modelReply);
});

afterEach(async () => {
  statusReply.outcome = "real";
  await state?.cleanup();
  clearRuntimeConfigSnapshot();
  resetInboundDedupe();
});

// The channel admitted this group member, so every command turn is explicit and authorized at
// ingress. Telegram sends registered names like /status and /new as native commands.
async function send(params: {
  sender: string;
  body: string;
  native: boolean;
  replyOptions?: DispatchFromConfigParams["replyOptions"];
  onDelivery?: (payload: ReplyPayload) => void;
}) {
  const replies: ReplyPayload[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      replies.push(payload);
      params.onDelivery?.(payload);
    },
  });
  let result: DispatchFromConfigResult;
  try {
    result = await dispatchReplyFromConfig({
      ctx: {
        Provider: channel,
        Surface: channel,
        OriginatingChannel: channel,
        OriginatingTo: `${channel}:room`,
        From: `${channel}:group:room`,
        To: `${channel}:room`,
        ChatType: "group",
        SessionKey: params.native ? `agent:main:${channel}:slash:${params.sender}` : targetKey,
        ...(params.native ? { CommandTargetSessionKey: targetKey } : {}),
        SenderId: params.sender,
        MessageSid: `${params.sender}-${params.body}`,
        Body: params.body,
        RawBody: params.body,
        CommandBody: params.body,
        BotUsername: "bot",
        CommandSource: params.native ? "native" : "text",
        CommandAuthorized: true,
      },
      cfg,
      dispatcher,
      replyOptions: params.replyOptions,
      replyResolver: getReplyFromConfig,
    });
  } finally {
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  }
  return { result, texts: replies.map((reply) => reply.text) };
}

it.each([
  { body: "/tell hi", native: false },
  { body: "/status", native: true },
])("stays silent when a group member's $body is refused", async ({ body, native }) => {
  const { result, texts } = await send({ sender: "member", body, native });

  expect(texts).toEqual([]);
  expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  expect(result.deliberateSilentTerminalReply).toBe(true);
});

it("delivers a native cross-human steering refusal after consuming its source", async ({
  signal,
}) => {
  cfg.messages = { queue: { mode: "steer", allowCollaborativeSteering: false } };
  cfg.commands = { ...cfg.commands, ownerAllowFrom: [`${channel}:owner`, `${channel}:member`] };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const entered = createDeferred<ReplyOperation>();
  const release = createDeferred();
  const injected = vi.fn(async () => {});
  vi.mocked(runEmbeddedAgent).mockImplementationOnce(async () => {
    const operation = getSessionControllerOperation(targetKey);
    if (!operation) {
      throw new Error("Expected Alice's admitted operation");
    }
    expect(operation.requesterPrincipalKey).toBe(JSON.stringify([channel, "default", "owner"]));
    operation.attachBackend({
      kind: "embedded",
      cancel() {},
      toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
      messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage: injected },
    });
    operation.setPhase("running");
    entered.resolve(operation);
    await release.promise;
    return modelReply;
  });
  const incumbent = send({ sender: "owner", body: "Keep working on Alice's task", native: false });
  let operation: ReplyOperation | undefined;
  try {
    operation = await withinTest(
      awaitGateBeforeSettlement(entered.promise, incumbent, "Incumbent never started"),
      signal,
    );
    const { texts, result } = await withinTest(
      send({ sender: "member", body: "/steer stop and use Bob's instructions", native: true }),
      signal,
    );
    expect(texts).toEqual([
      "Someone else’s turn is still running, and collaborative steering is disabled. Your message wasn’t queued. Resend it as /followup <message> to run it afterward.\n\nAdmins can enable collaborative steering with messages.queue.allowCollaborativeSteering: true.",
    ]);
    expect(result.collaborativeSteeringRefused).toBe(true);
    expect(operation.result).toBeNull();
    expect(injected).not.toHaveBeenCalled();
    expect(getFollowupQueueDepth(targetKey)).toBe(0);
  } finally {
    release.resolve();
    await incumbent;
    await operation?.ownerSettlement;
  }
  expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  expect(getSessionControllerOperation(targetKey)).toBeUndefined();
});

it.for([false, true])(
  "settles idle native followup final delivery (cancelled=%s)",
  async (cancelled, { signal }) => {
    cfg.commands = { ...cfg.commands, ownerAllowFrom: [`${channel}:owner`, `${channel}:member`] };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const address = {
      agentId: "main",
      sessionKey: targetKey,
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    await replaceSessionEntry(address, {
      sessionId: "native-followup",
      updatedAt: Date.now(),
      queueMode: "collect",
    });
    const entered = createDeferred<ReplyOperation>();
    const started = createDeferred();
    const release = createDeferred();
    const upstream = new AbortController();
    const deliveredTexts: Array<string | undefined> = [];
    vi.mocked(runEmbeddedAgent).mockImplementationOnce(async (params) => {
      expect(params.senderId).toBe("member");
      expect(params.sessionKey).toBe(targetKey);
      const operation = getSessionControllerOperation(targetKey);
      if (!operation) {
        throw new Error("Expected Bob's admitted followup operation");
      }
      expect(operation.requesterPrincipalKey).toBe(JSON.stringify([channel, "default", "member"]));
      await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
      entered.resolve(operation);
      await release.promise;
      return modelReply;
    });
    const dispatch = send({
      sender: "member",
      body: "/followup return the synthetic answer",
      native: true,
      replyOptions: { abortSignal: upstream.signal },
      onDelivery: (payload) => {
        deliveredTexts.push(payload.text);
        if (payload.text === "Your followup has started.") {
          started.resolve();
        }
      },
    });
    let operation: ReplyOperation | undefined;
    try {
      [operation] = await withinTest(
        awaitGateBeforeSettlement(
          Promise.all([entered.promise, started.promise]),
          dispatch,
          "Followup never started",
        ),
        signal,
      );
      if (cancelled) {
        upstream.abort();
        await withinTest(dispatch, signal);
        expect(operation.abortSignal.aborted).toBe(true);
        expect(getSessionControllerOperation(targetKey)).toBe(operation);
      } else {
        release.resolve();
        await withinTest(dispatch, signal);
      }
      expect(loadSessionEntry(address)?.queueMode).toBe("collect");
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await dispatch;
      await operation?.ownerSettlement;
    }
    expect(deliveredTexts).toEqual(
      cancelled
        ? ["Your followup has started."]
        : ["Your followup has started.", "Synthetic final answer."],
    );
    expect(getSessionControllerOperation(targetKey)).toBeUndefined();
  },
);

it("lets an authorized command's failure reach the channel", async () => {
  statusReply.outcome = "throw";

  await expect(send({ sender: "owner", body: "/status", native: true })).rejects.toThrow(
    "status renderer unavailable",
  );
});

// Only a refusal waives the reply; an authorized command that ends empty (for example after its
// streamed blocks failed to send) still owes one.
it("keeps the notice when an authorized command ends without a reply", async () => {
  statusReply.outcome = "empty";
  const { result, texts } = await send({ sender: "owner", body: "/status", native: true });

  expect(texts).toEqual([MISSING_REPLY_NOTICE_TEXT]);
  expect(result.noVisibleReplyFallbackDelivered).toBe(true);
});

it.each([
  { sender: "owner", body: "/status", expected: /OpenClaw/u },
  { sender: "member", body: "/new@bot", expected: /New session started/u },
  { sender: "member", body: "/new", expected: /New session started/u },
])("still answers $sender $body", async ({ sender, body, expected }) => {
  const { texts } = await send({ sender, body, native: true });

  expect(texts).toHaveLength(1);
  expect(texts[0]).toMatch(expected);
});
