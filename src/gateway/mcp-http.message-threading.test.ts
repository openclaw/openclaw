import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  buildCliMcpGrantContext,
  finalizeCliMcpGrant,
} from "../agents/cli-runner/mcp-grant-context.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer } from "./mcp-http.js";
import {
  readOkMcpPayload,
  sendLoopbackToolCall,
  startLoopbackServerForTest,
} from "./mcp-http.test-support.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "./message-action-turn-capability.js";

const runtimeConfig = vi.hoisted(() => ({ value: {} as OpenClawConfig }));
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => runtimeConfig.value,
}));

const topic = "Current topic";
const identity = {
  agentId: "main",
  runId: "cli-message-threading",
  sessionKey: "agent:main:test:threading",
  sessionId: "cli-message-threading-session",
};
const sendText = vi.fn(async () => ({ channel: "zulip" as const, messageId: "sent" }));
// A third-party stream adapter's public contract, without loading its transport.
const plugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "zulip",
    capabilities: { chatTypes: ["channel"], threads: true },
  }),
  messaging: {
    normalizeTarget: (target) => target,
    targetResolver: {
      looksLikeId: (target) => target.startsWith("stream:"),
      hint: "stream:<id or name>",
    },
  },
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => ({
      currentChannelId: context.To,
      currentMessagingTarget: `stream:team:${context.MessageThreadId}`,
      currentThreadTs: String(context.MessageThreadId),
      currentMessageId: context.CurrentMessageId,
      replyToMode: "off",
      hasRepliedRef,
    }),
    resolveAutoThreadId: ({ to, toolContext }) => {
      if (toolContext?.currentChannelProvider !== "zulip") {
        return undefined;
      }
      return [toolContext.currentChannelId, toolContext.currentMessagingTarget].some(
        (current) => current === `${to}:${toolContext.currentThreadTs}`,
      )
        ? toolContext.currentThreadTs
        : undefined;
    },
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => ({ ok: true, to: to ?? "" }),
    sendText,
  },
};
let state: OpenClawTestState;
let admission: PreparedAgentRunAdmission;
let capability: string;
let grantToken: string;
let registry: ReturnType<typeof captureActivePluginRegistrySnapshot>;
const captureKey = "cli-message-threading-capture";

beforeAll(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-cli-message-threading-",
    layout: "state-only",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  runtimeConfig.value = {
    agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
    tools: { allow: ["message"] },
  };
  registry = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(createTestRegistry([{ pluginId: "zulip", plugin, source: "test" }]));
  const { runtime } = await startLoopbackServerForTest();
  const toolContext = {
    ...plugin.threading!.buildToolContext!({
      cfg: runtimeConfig.value,
      context: {
        To: `stream:18:${topic}`,
        MessageThreadId: topic,
        ThreadLabel: `#team > ${topic}`,
      },
      hasRepliedRef: { value: false },
    }),
    currentChannelProvider: "zulip",
  };
  capability = mintMessageActionTurnCapability({ ...identity, toolContext });
  admission = prepareAgentRunAdmission({
    cfg: runtimeConfig.value,
    operationalRunInstance: createOperationalRunInstanceRef(identity.runId),
    facts: {
      runId: identity.runId,
      agentId: identity.agentId,
      ingress: { kind: "system", boundary: "cli-message-threading-test", state: "present" },
    },
  });
  const admittedRunContext = await admission.admit("gateway");
  const context = buildCliMcpGrantContext({
    run: {
      ...identity,
      sessionFile: state.path("session.jsonl"),
      workspaceDir: state.workspaceDir,
      provider: "claude-cli",
      prompt: "Send an update",
      timeoutMs: 1000,
      messageProvider: "zulip",
      currentChannelId: toolContext.currentChannelId,
      currentThreadTs: topic,
    },
    config: runtimeConfig.value,
    requireExplicitMessageTarget: false,
    agentId: "main",
    modelProvider: "claude-cli",
    modelId: "test",
  });
  const prepared = finalizeCliMcpGrant(context, ["message"], false, {
    admittedRunContext,
    messageActionTurnCapability: capability,
  });
  if (!prepared) {
    throw new Error("Expected CLI grant");
  }
  const grant = mintMcpLoopbackClientGrant({ ...prepared, runtimeOwnerToken: runtime.ownerToken });
  grantToken = grant.token;
  activateMcpLoopbackClientGrantCapture({
    token: grantToken,
    runtimeOwnerToken: runtime.ownerToken,
    captureKey,
  });
});
beforeEach(() => {
  setActivePluginRegistry(createTestRegistry([{ pluginId: "zulip", plugin, source: "test" }]));
});
afterAll(async () => {
  revokeMcpLoopbackClientGrant(grantToken);
  revokeMessageActionTurnCapability(capability);
  admission?.close();
  await closeMcpLoopbackServer();
  restoreActivePluginRegistrySnapshot(registry);
  await state?.cleanup();
});

it.each([
  ["named alias", { target: "stream:team" }, topic],
  ["numeric stream", { target: "stream:18" }, topic],
  ["different named stream", { target: "stream:other" }, undefined],
  ["different numeric stream", { target: "stream:19" }, undefined],
  ["explicit thread", { target: "stream:team", threadId: "Chosen topic" }, "Chosen topic"],
  ["explicit top level", { target: "stream:team", topLevel: true }, undefined],
  ["explicit null thread", { target: "stream:team", threadId: null }, undefined],
])("preserves %s across CLI MCP delivery", async (_name, args, expectedThread) => {
  sendText.mockClear();
  const payload = await readOkMcpPayload(
    await sendLoopbackToolCall({
      token: grantToken,
      name: "message",
      args: { action: "send", channel: "zulip", message: "Update", ...args },
      headers: { "x-openclaw-cli-capture-key": captureKey },
    }),
  );
  expect(payload.result?.isError, JSON.stringify(payload)).not.toBe(true);
  expect(sendText).toHaveBeenCalledOnce();
  expect(sendText).toHaveBeenCalledWith(
    expect.objectContaining({ to: args.target, threadId: expectedThread }),
  );
});

it("rejects a revoked capability instead of using the projected fallback", async () => {
  revokeMessageActionTurnCapability(capability);
  sendText.mockClear();
  const payload = await readOkMcpPayload(
    await sendLoopbackToolCall({
      token: grantToken,
      name: "message",
      args: { action: "send", channel: "zulip", target: "stream:18", message: "Do not send" },
      headers: { "x-openclaw-cli-capture-key": captureKey },
    }),
  );
  expect(payload.result?.isError).toBe(true);
  expect(payload.result?.content?.[0]?.text).toContain(
    "message action turn capability is no longer active",
  );
  expect(sendText).not.toHaveBeenCalled();
});
