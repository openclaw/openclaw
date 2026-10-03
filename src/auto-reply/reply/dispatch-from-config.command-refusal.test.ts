// Command turns through the real dispatcher and reply resolver: a refused command stays silent.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
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
import { buildNoVisibleReplyFallbackText } from "./dispatch-from-config.payloads.js";
import type { DispatchFromConfigResult } from "./dispatch-from-config.types.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfigInternal } from "./get-reply.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
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

const channel = "groupchat";
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
});

afterEach(async () => {
  statusReply.outcome = "real";
  await state?.cleanup();
  resetInboundDedupe();
});

// The channel admitted this group member, so every command turn is explicit and authorized at
// ingress. Telegram sends registered names like /status and /new as native commands.
async function send(params: { sender: string; body: string; native: boolean }) {
  const replies: ReplyPayload[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      replies.push(payload);
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
        SessionKey: `agent:main:${channel}:group:room`,
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
      replyResolver: getReplyFromConfigInternal,
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

  expect(texts).toEqual([buildNoVisibleReplyFallbackText()]);
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
