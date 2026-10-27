import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { MISSING_REPLY_NOTICE_TEXT } from "../../agents/reply-completion.js";
import * as configSnapshot from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as plugins from "../../plugins/runtime.js";
import {
  getSessionControllerOperation,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import * as channels from "../../test-utils/channel-plugins.js";
import * as testState from "../../test-utils/openclaw-test-state.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import type { ReplyPayload } from "../types.js";
import type * as CommandsStatus from "./commands-status.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { createReplyAgentDefaults } from "./get-reply-config.test-support.js";
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
let state: testState.OpenClawTestState;
let cfg: OpenClawConfig;

beforeEach(async ({ onTestFinished }) => {
  const previous = plugins.captureActivePluginRegistrySnapshot();
  onTestFinished(() => {
    plugins.rollbackStagedPluginRegistry(previous);
  });
  plugins.stageActivePluginRegistry(
    channels.createTestRegistry([
      {
        pluginId: channel,
        source: `/tmp/${channel}/index.js`,
        plugin: channels.createChannelTestPluginBase({
          id: channel,
          capabilities: { chatTypes: ["group"], nativeCommands: true },
        }),
      },
    ]),
    null,
    "default",
  );
  state = await testState.createOpenClawTestState({
    label: "command-refusal",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  cfg = withFullRuntimeReplyConfig({
    agents: {
      defaults: createReplyAgentDefaults(state.workspaceDir),
    },
    commands: { ownerAllowFrom: [`${channel}:owner`] },
    plugins: { enabled: false },
  });
  await persistConfig();
  vi.mocked(runEmbeddedAgent).mockReset().mockResolvedValue(modelReply);
});

afterEach(async () => {
  statusReply.outcome = "real";
  await state?.cleanup();
  configSnapshot.clearRuntimeConfigSnapshot();
  resetInboundDedupe();
});

async function persistConfig(allowMember = false) {
  if (allowMember) {
    cfg.commands = { ...cfg.commands, ownerAllowFrom: [`${channel}:owner`, `${channel}:member`] };
  }
  await state.writeConfig(cfg);
  configSnapshot.setRuntimeConfigSnapshot(cfg);
}

// Ingress has admitted the member; command authorization is the boundary under test.
async function send(
  sender: string,
  body: string,
  native = true,
  options: {
    replyOptions?: DispatchFromConfigParams["replyOptions"];
    onDelivery?: (payload: ReplyPayload) => void;
  } = {},
) {
  const texts: Array<ReplyPayload["text"]> = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      texts.push(payload.text);
      options.onDelivery?.(payload);
    },
  });
  const result = await withReplyDispatcher({
    dispatcher,
    run: () =>
      dispatchReplyFromConfig({
        ctx: {
          Provider: channel,
          Surface: channel,
          OriginatingChannel: channel,
          OriginatingTo: `${channel}:room`,
          From: `${channel}:group:room`,
          To: `${channel}:room`,
          ChatType: "group",
          SessionKey: native ? `agent:main:${channel}:slash:${sender}` : targetKey,
          ...(native ? { CommandTargetSessionKey: targetKey } : {}),
          SenderId: sender,
          MessageSid: `${sender}-${body}`,
          Body: body,
          RawBody: body,
          CommandBody: body,
          BotUsername: "bot",
          CommandSource: native ? "native" : "text",
          CommandAuthorized: true,
          InboundAccessAuthorized: true,
          InboundEventKind: "user_request",
          InputProvenance: { kind: "external_user", sourceChannel: channel },
        },
        cfg,
        dispatcher,
        replyOptions: options.replyOptions,
        replyResolver: getReplyFromConfig,
      }),
  });
  return { result, texts };
}

type RunParams = Parameters<typeof runEmbeddedAgent>[0];
function holdAgentRun(
  sender: string,
  onStart: (params: RunParams, op: ReplyOperation) => void | Promise<void>,
) {
  const entered = createDeferred<ReplyOperation>();
  const release = createDeferred();
  let operation: ReplyOperation | undefined;
  vi.mocked(runEmbeddedAgent).mockImplementationOnce(async (params) => {
    operation = getSessionControllerOperation(targetKey);
    if (!operation) {
      throw new Error(`Expected ${sender}'s admitted operation`);
    }
    expect(operation.requesterPrincipalKey).toBe(JSON.stringify([channel, "default", sender]));
    await onStart(params, operation);
    entered.resolve(operation);
    await release.promise;
    return modelReply;
  });
  return {
    entered,
    release,
    async finish(running: Promise<unknown>) {
      release.resolve();
      await running;
      await operation?.ownerSettlement;
    },
  };
}

it.each<
  [string, string, boolean, typeof statusReply.outcome, "silent" | "notice" | "throw" | RegExp]
>([
  ["member", "/tell hi", false, "real", "silent"],
  ["member", "/status", true, "real", "silent"],
  ["owner", "/status", true, "real", /OpenClaw/u],
  ["member", "/new@bot", true, "real", /New session started/u],
  ["member", "/new", true, "real", /New session started/u],
  ["owner", "/status", true, "empty", "notice"],
  ["owner", "/status", true, "throw", "throw"],
])("delivers %s %s (%s, %s)", async (sender, body, native, outcome, expected) => {
  statusReply.outcome = outcome;
  const response = send(sender, body, native);
  if (expected === "throw") {
    await expect(response).rejects.toThrow("status renderer unavailable");
    return;
  }
  const { result, texts } = await response;
  if (expected instanceof RegExp) {
    expect(texts).toEqual([expect.stringMatching(expected)]);
  } else {
    expect(texts).toEqual(expected === "silent" ? [] : [MISSING_REPLY_NOTICE_TEXT]);
    expect(result.noVisibleReplyFallbackDelivered).toBe(expected === "notice" ? true : undefined);
    if (expected === "silent") {
      expect(result.deliberateSilentTerminalReply).toBe(true);
    }
  }
});

it.each([false, true])(
  "restores an authorized archived native source before /new (send denied=%s)",
  async (sendDenied) => {
    if (sendDenied) {
      cfg.session = { sendPolicy: { default: "deny" } };
      await persistConfig();
    }
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const source = { storePath, sessionKey: `agent:main:${channel}:slash:owner` };
    const target = { storePath, sessionKey: targetKey };
    await replaceSessionEntry(source, {
      sessionId: "archived-command-source",
      updatedAt: 1,
      archivedAt: 2,
    });
    await replaceSessionEntry(target, { sessionId: "active-target", updatedAt: Date.now() });
    const { result, texts } = await send("owner", "/new");
    const restoredSource = loadSessionEntry(source);
    const resetTarget = loadSessionEntry(target);
    expect(restoredSource?.sessionId).toBe("archived-command-source");
    expect(restoredSource?.archivedAt).toBeUndefined();
    expect(resetTarget?.sessionId).toEqual(expect.any(String));
    expect(resetTarget?.sessionId).not.toBe("active-target");
    expect(texts).toEqual(sendDenied ? [] : [expect.stringMatching(/New session started/u)]);
    expect(result.sendPolicyDenied).toBe(sendDenied ? true : undefined);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  },
);

it.for(["queue", "reject"] as const)(
  "handles a native cross-human steer with fallback=%s",
  async (fallback, { signal }) => {
    cfg.messages = {
      queue: {
        mode: "steer",
        allowCollaborativeSteering: false,
        collaborativeSteeringFallback: fallback,
      },
    };
    await persistConfig(true);
    const injected = vi.fn(async () => {});
    const followed = createDeferred<{ params: RunParams; operation: ReplyOperation | undefined }>();
    vi.mocked(runEmbeddedAgent).mockImplementation(async (params) => {
      followed.resolve({ params, operation: getSessionControllerOperation(targetKey) });
      return modelReply;
    });
    const run = holdAgentRun("owner", (_params, operation) => {
      operation.attachBackend({
        kind: "embedded",
        cancel() {},
        toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
        messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage: injected },
      });
      operation.setPhase("running");
    });
    const incumbent = send("owner", "Keep working on Alice's task", false);
    try {
      const operation = await withinTest(
        awaitGateBeforeSettlement(run.entered.promise, incumbent, "Incumbent never started"),
        signal,
      );
      const { texts, result } = await withinTest(
        send("member", "/steer stop and use Bob's instructions"),
        signal,
      );
      expect(texts).toEqual(
        fallback === "reject"
          ? [
              "Someone else’s turn is still running, and collaborative steering is disabled. Your message wasn’t queued. Resend it as /followup <message> to run it afterward.\n\nAdmins can enable collaborative steering with messages.queue.allowCollaborativeSteering: true.",
            ]
          : [],
      );
      expect(result.collaborativeSteeringRefused).toBe(fallback === "reject" ? true : undefined);
      expect(operation.result).toBeNull();
      expect(injected).not.toHaveBeenCalled();
      expect(getFollowupQueueDepth(targetKey)).toBe(fallback === "reject" ? 0 : 1);
    } finally {
      await run.finish(incumbent);
    }
    if (fallback === "queue") {
      const queuedRun = await withinTest(followed.promise, signal);
      expect(queuedRun.params).toMatchObject({ senderId: "member", sessionKey: targetKey });
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
      expect(queuedRun.operation).toBeDefined();
      await withinTest(queuedRun.operation!.ownerSettlement, signal);
    } else {
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(getSessionControllerOperation(targetKey)).toBeUndefined();
    }
  },
);

it.for([false, true])(
  "settles idle native followup final delivery (cancelled=%s)",
  async (cancelled, { signal }) => {
    await persistConfig(true);
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
    const started = createDeferred();
    const upstream = new AbortController();
    const run = holdAgentRun("member", async (params) => {
      expect(params).toMatchObject({ senderId: "member", sessionKey: targetKey });
      await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    });
    const dispatch = send("member", "/followup return the synthetic answer", true, {
      replyOptions: { abortSignal: upstream.signal },
      onDelivery: (payload) => {
        if (payload.text === "Your followup has started.") {
          started.resolve();
        }
      },
    });
    try {
      const [operation] = await withinTest(
        awaitGateBeforeSettlement(
          Promise.all([run.entered.promise, started.promise]),
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
        run.release.resolve();
        await withinTest(dispatch, signal);
      }
      expect(loadSessionEntry(address)?.queueMode).toBe("collect");
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    } finally {
      await run.finish(dispatch);
    }
    expect((await dispatch).texts).toEqual(
      cancelled
        ? ["Your followup has started."]
        : ["Your followup has started.", "Synthetic final answer."],
    );
    expect(getSessionControllerOperation(targetKey)).toBeUndefined();
  },
);
