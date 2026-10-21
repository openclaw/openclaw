import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import {
  coerceNodeInvokePayload,
  coerceNodeInvokeCancelPayload,
} from "../node-host/invoke-payload.js";
import type { NodeInvokeRequestPayload } from "../node-host/invoke-types.js";
import { prepareNodeHostRuntime } from "../node-host/runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceBrowserSessionCreateRequest } from "../talk/provider-types.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

// Use the signed CLI/native runtime, not fabricated plans, approvals or result frames.
export async function createTalkParityNodeFixture(
  config: OpenClawConfig,
  port: number,
  token: string,
) {
  const prepared = await prepareNodeHostRuntime({
    config,
    commands: expectDefined(config.gateway?.nodes?.commands?.allow, "parity node commands"),
    enableAgentRuns: false,
    installedAppsSharingEnabled: false,
    desktopSharingEnabled: false,
  });
  const nodeMeta = { clientId: "node-host", clientMode: "node", platform: "linux" } as const;
  const { caps, commands } = prepared.manifest;
  const identity = await pairDeviceIdentity({
    ...nodeMeta,
    name: "talk-parity-node",
    role: "node",
    scopes: [],
  });
  const nodeId = identity.identity.deviceId;
  const pairing = await requestNodePairing({ ...nodeMeta, nodeId, caps, commands });
  const approved = await approveNodePairing(pairing.request.requestId, {
    callerScopes: ["operator.admin"],
  });
  expect(approved).toHaveProperty("node");
  const tasks: Promise<void>[] = [];
  const invokes: NodeInvokeRequestPayload[] = [];
  const url = "ws://127.0.0.1:" + port;
  const client = await connectGatewayClient({
    url,
    token,
    deviceIdentity: identity.identity,
    role: "node",
    scopes: [],
    clientName: nodeMeta.clientId,
    mode: nodeMeta.clientMode,
    platform: nodeMeta.platform,
    caps,
    commands,
    onEvent: (event) => {
      if (event.event === "node.invoke.cancel") {
        const cancel = coerceNodeInvokeCancelPayload(event.payload);
        if (cancel) {
          active?.cancel(cancel.invokeId);
        }
      }
      if (event.event === "node.invoke.request") {
        const frame = coerceNodeInvokePayload(event.payload);
        if (!frame || !active) {
          throw new Error("Node invocation arrived outside its owner");
        }
        invokes.push(frame);
        const task = active.invoke(frame);
        void task.catch(() => {});
        tasks.push(task);
      }
    },
  });
  const active = prepared.start({ client });
  active.updateGatewayConnection({ url });
  return {
    nodeId,
    invokes,
    async close() {
      try {
        await active?.close();
        await Promise.all(tasks);
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  };
}

// Replace only voice transport; the registered handler retains admission and ownership.
export async function installTalkParityProviderFixture(publicOnly = false) {
  const plugins = await import("../plugins/runtime.js");
  const snapshot = plugins.captureActivePluginRegistrySnapshot();
  const registry = plugins.getActivePluginRegistry();
  if (!registry) {
    throw new Error("Missing suite plugin registry");
  }
  let request: RealtimeVoiceBrowserSessionCreateRequest | undefined;
  const provider: RealtimeVoiceProviderPlugin = {
    id: "openai",
    label: "Synthetic browser transport",
    isConfigured: () => publicOnly,
    createBridge: () => {
      throw new Error("Fixture supports browser creation only");
    },
    capabilities: {
      transports: ["webrtc"],
      inputAudioFormats: [],
      outputAudioFormats: [],
      supportsBrowserSession: true,
    },
    createBrowserSession: async (next) => {
      request = next;
      next.gatewayControl?.bindControl?.({ sendUserMessage: () => {} });
      next.gatewayControl?.onReady?.();
      return {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "synthetic-offer",
        offerUrl: "/fixture/voice",
      };
    },
  };
  if (!publicOnly) {
    Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
      value: {
        isBrowserSessionConfigured: () => true,
        resolveBrowserSessionCapabilities: () => ({
          ...provider.capabilities,
          handlesAgentConsult: true,
          supportsToolCalls: false,
        }),
        cancelBrowserSession: async () => {},
      },
    });
  }
  plugins.setActivePluginRegistry({
    ...registry,
    realtimeVoiceProviders: [
      ...registry.realtimeVoiceProviders.filter((entry) => entry.provider.id !== "openai"),
      { pluginId: "openai", source: "test", provider },
    ],
  });
  return {
    run(prompt: string) {
      if (!request?.runAgentConsult) {
        throw new Error("Registered direct consult is unavailable");
      }
      return request.runAgentConsult({ prompt });
    },
    restore() {
      plugins.restoreActivePluginRegistrySnapshot(snapshot);
    },
  };
}
