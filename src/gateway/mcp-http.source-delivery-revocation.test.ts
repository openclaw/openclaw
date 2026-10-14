// A current-source `message` send made through a bound CLI grant is addressed from the grant's
// server-minted source context (native conversation id plus the routable target that keys the
// send budget and the caller's turnSourceTo). When the grant is revoked, or replaced by the
// next turn's grant on the same bearer, while that send is still preparing, the old source
// must not receive it. This drives the real MCP loopback
// entry, real Gateway tool resolution, and the real message tool and outbound path; only the
// channel transport is a test double, and its awaited payload preparation is the pause point.
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { ChannelOutboundContext } from "../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer } from "./mcp-http.js";
import {
  readOkMcpPayload,
  sendLoopbackToolCall,
  startLoopbackServerForTest,
} from "./mcp-http.test-support.js";

const sessionKey = "agent:main:gatewaychat:direct:alice";
const config: OpenClawConfig = {
  tools: { profile: "minimal" },
  channels: { gatewaychat: { enabled: true } },
};

let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot> | undefined;
const admissions: Array<ReturnType<typeof prepareAgentRunAdmission>> = [];

beforeEach(async () => {
  state = await createOpenClawTestState();
  registrySnapshot = captureActivePluginRegistrySnapshot();
  setRuntimeConfigSnapshot(config, config);
});

afterEach(async () => {
  await closeMcpLoopbackServer();
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  if (registrySnapshot) {
    restoreActivePluginRegistrySnapshot(registrySnapshot);
  }
  clearRuntimeConfigSnapshot();
  await state?.cleanup();
});

// A direct-delivery channel whose payload preparation can be held open. Every transport send
// is recorded with the target it was addressed to.
function registerPausableChannel() {
  const sends: Array<{ to: string; text: string }> = [];
  let pause: { entered: () => void; release: Promise<void> } | undefined;
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "gatewaychat",
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
    }),
    messaging: { targetResolver: { looksLikeId: () => true } },
    outbound: {
      deliveryMode: "direct",
      sendText: async ({ to, text }: ChannelOutboundContext) => {
        sends.push({ to, text });
        return { channel: "gatewaychat", messageId: `m${sends.length}` };
      },
    },
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
      prepareSendPayload: async ({ payload }) => {
        const current = pause;
        pause = undefined;
        if (current) {
          current.entered();
          await current.release;
        }
        return payload;
      },
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
  return {
    sends,
    // Holds the next send inside payload preparation, before the transport handoff.
    pauseNextSend() {
      const entered = createDeferred();
      const release = createDeferred();
      pause = { entered: () => entered.resolve(), release: release.promise };
      return { entered: entered.promise, release: () => release.resolve() };
    },
  };
}

async function mintBoundGrant(params: { runtimeOwnerToken: string; runId: string; turn: 1 | 2 }) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId: params.runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "mcp-http-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(params.runId),
  });
  admissions.push(admission);
  return mintMcpLoopbackClientGrant({
    context: {
      sessionKey,
      agentId: "main",
      runId: params.runId,
      senderIsOwner: true,
      messageProvider: "gatewaychat",
      accountId: "default",
      // The native conversation id and the routable target differ, and each turn's source
      // is distinct so a send that escaped the fence would be attributable.
      currentChannelId: `native-conversation-${params.turn}`,
      currentMessagingTarget: `user:alice-${params.turn}`,
      inboundEventKind: "user_request",
      sourceReplyDeliveryMode: "message_tool_only",
      toolsAllow: ["message"],
    },
    runtimeOwnerToken: params.runtimeOwnerToken,
    admittedRunContext: await admission.admit("gateway", `gateway-${params.runId}`),
  });
}

async function sendToCurrentSource(token: string, captureKey: string, message: string) {
  return await sendLoopbackToolCall({
    token,
    name: "message",
    args: { action: "send", channel: "gatewaychat", message },
    headers: { "x-openclaw-cli-capture-key": captureKey },
  });
}

it.each(["revoked", "replaced"] as const)(
  "does not deliver a pending current-source send to the old source once the grant is %s",
  async (change) => {
    const channel = registerPausableChannel();
    const { runtime } = await startLoopbackServerForTest();
    const runtimeOwnerToken = runtime.ownerToken;
    const captureKey = "capture-source";
    const grant = await mintBoundGrant({
      runtimeOwnerToken,
      runId: "run-turn-1",
      turn: 1,
    });
    expect(
      activateMcpLoopbackClientGrantCapture({ token: grant.token, runtimeOwnerToken, captureKey }),
    ).toBeTruthy();

    // Positive control: the bound grant's current-source send reaches its own source.
    const control = await readOkMcpPayload(
      await sendToCurrentSource(grant.token, captureKey, "control"),
    );
    expect(control.result?.isError).not.toBe(true);
    expect(channel.sends).toEqual([{ to: "native-conversation-1", text: "control" }]);

    // The delayed send is held in payload preparation while the grant changes.
    const paused = channel.pauseNextSend();
    const pending = sendToCurrentSource(grant.token, captureKey, "delayed");
    await paused.entered;
    if (change === "revoked") {
      expect(revokeMcpLoopbackClientGrant(grant.token)).toBe(true);
    } else {
      // The next CLI turn keeps the child's bearer: its fresh grant moves onto the old token
      // (cli-runner/prepare.ts) with a different source, then captures it.
      const next = await mintBoundGrant({
        runtimeOwnerToken,
        runId: "run-turn-2",
        turn: 2,
      });
      expect(
        transferMcpLoopbackClientGrant({
          sourceToken: next.token,
          targetToken: grant.token,
          runtimeOwnerToken,
        }),
      ).toBe(true);
      expect(
        activateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken,
          captureKey,
        }),
      ).toBeTruthy();
    }
    paused.release();
    const delayed = await readOkMcpPayload(await pending);
    expect(delayed.result?.isError).toBe(true);
    expect(channel.sends).toEqual([{ to: "native-conversation-1", text: "control" }]);

    if (change === "replaced") {
      // The replacement turn still sends, and only to its own source.
      const fresh = await readOkMcpPayload(
        await sendToCurrentSource(grant.token, captureKey, "fresh"),
      );
      expect(fresh.result?.isError).not.toBe(true);
      expect(channel.sends).toEqual([
        { to: "native-conversation-1", text: "control" },
        { to: "native-conversation-2", text: "fresh" },
      ]);
    }
  },
  30_000,
);
