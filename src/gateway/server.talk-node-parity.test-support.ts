import { expect } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import {
  coerceNodeInvokePayload,
  coerceNodeInvokeCancelPayload,
} from "../node-host/invoke-payload.js";
import type { NodeInvokeRequestPayload } from "../node-host/invoke-types.js";
import { prepareNodeHostRuntime } from "../node-host/runtime.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

// One signed node transport runs the same source runtime as CLI/native nodes.
// No fabricated prepare plans, approval verdicts or node.invoke.result frames.
export async function createTalkParityNodeFixture(
  config: OpenClawConfig,
  port: number,
  token: string,
) {
  const commands = [
    "system.run",
    "system.run.prepare",
    "system.which",
    "system.execApprovals.get",
    "system.execApprovals.set",
  ];
  const prepared = await prepareNodeHostRuntime({
    config,
    commands,
    enableAgentRuns: false,
    enableWorkerRuns: false,
    installedAppsSharingEnabled: false,
    desktopSharingEnabled: false,
  });
  const identity = await pairDeviceIdentity({
    name: "talk-parity-node",
    role: "node",
    scopes: [],
    clientId: "node-host",
    clientMode: "node",
    platform: "linux",
  });
  const pairing = await requestNodePairing({
    nodeId: identity.identity.deviceId,
    clientId: "node-host",
    clientMode: "node",
    platform: "linux",
    caps: prepared.manifest.caps,
    commands: prepared.manifest.commands,
  });
  const approved = await approveNodePairing(pairing.request.requestId, {
    callerScopes: ["operator.admin"],
  });
  expect(approved).toHaveProperty("node");
  const tasks: Promise<void>[] = [];
  const invokes: NodeInvokeRequestPayload[] = [];
  const client = await connectGatewayClient({
    url: "ws://127.0.0.1:" + port,
    token,
    deviceIdentity: identity.identity,
    role: "node",
    scopes: [],
    clientName: "node-host",
    mode: "node",
    platform: "linux",
    caps: prepared.manifest.caps,
    commands: prepared.manifest.commands,
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
  active.updateGatewayConnection({ url: "ws://127.0.0.1:" + port });
  return {
    nodeId: identity.identity.deviceId,
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

// Only the external voice transport is replaced. The registered create handler
// still owns caller retention, voice binding, readiness and consult admission.
export async function installTalkParityProviderFixture(publicOnly = false) {
  const {
    captureActivePluginRegistrySnapshot,
    getActivePluginRegistry,
    restoreActivePluginRegistrySnapshot,
    setActivePluginRegistry,
  } = await import("../plugins/runtime.js");
  const snapshot = captureActivePluginRegistrySnapshot();
  const registry = getActivePluginRegistry();
  if (!registry) {
    throw new Error("Missing suite plugin registry");
  }
  let request:
    | import("../talk/provider-types.js").RealtimeVoiceBrowserSessionCreateRequest
    | undefined;
  const provider: import("../plugins/types.js").RealtimeVoiceProviderPlugin = {
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
  setActivePluginRegistry({
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
      restoreActivePluginRegistrySnapshot(snapshot);
    },
  };
}
