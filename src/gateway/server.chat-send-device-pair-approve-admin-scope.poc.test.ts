import os from "node:os";
import path from "node:path";
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import registerDevicePair from "../../extensions/device-pair/index.js";
import { getReplyFromConfig as getActualReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { clearConfigCache, writeConfigFile } from "../config/config.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { buildPluginApi } from "../plugins/api-builder.js";
import { clearPluginCommands, registerPluginCommand } from "../plugins/commands.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  connectReq,
  connectOk,
  getReplyFromConfig,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

function resolveDeviceIdentityPath(name: string): string {
  const root = process.env.OPENCLAW_STATE_DIR ?? process.env.HOME ?? os.tmpdir();
  return path.join(root, "test-device-identities", `${name}.json`);
}

function loadDeviceIdentity(name: string) {
  const identityPath = resolveDeviceIdentityPath(name);
  const identity = loadOrCreateDeviceIdentity(identityPath);
  return {
    identityPath,
    identity,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
  };
}

function createDevicePairApi(params: {
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
}): OpenClawPluginApi {
  return buildPluginApi({
    id: "device-pair",
    name: "device-pair",
    source: "test",
    registrationMode: "full",
    config: {},
    pluginConfig: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolvePath(input: string) {
      return input;
    },
    handlers: {
      registerCommand: params.registerCommand,
    },
  });
}

async function openWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws open")), 5_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return ws;
}

describe("gateway chat.send /pair approve admin scope", () => {
  it("does not let operator.write plus operator.pairing approve an operator.admin device via /pair approve", async () => {
    getReplyFromConfig.mockImplementation(getActualReplyFromConfig);
    clearPluginCommands();
    clearConfigCache();
    await writeConfigFile({
      agents: {
        defaults: {
          model: "gpt-5.4",
          workspace: path.join(process.env.HOME ?? ".", "openclaw"),
        },
      },
      commands: {
        text: true,
      },
    });
    clearConfigCache();
    await registerDevicePair.register(
      createDevicePairApi({
        registerCommand: (command) => {
          const registered = registerPluginCommand("device-pair", command, {
            pluginName: "Device Pair",
          });
          if (!registered.ok) {
            throw new Error(registered.error ?? "failed to register device-pair command");
          }
        },
      }),
    );

    try {
      const started = await startServerWithClient("secret");
      let adminWs: WebSocket | undefined;

      try {
        await connectOk(started.ws, {
          token: "secret",
          scopes: ["operator.write", "operator.pairing"],
        });

        const pendingAdmin = loadDeviceIdentity("chat-send-device-pair-admin-target");
        const request = await requestDevicePairing({
          deviceId: pendingAdmin.identity.deviceId,
          publicKey: pendingAdmin.publicKey,
          role: "operator",
          scopes: ["operator.admin"],
          clientId: GATEWAY_CLIENT_NAMES.TEST,
          clientMode: GATEWAY_CLIENT_MODES.TEST,
        });

        const directApprove = await rpcReq(started.ws, "device.pair.approve", {
          requestId: request.request.requestId,
        });
        expect(directApprove.ok).toBe(false);
        expect(directApprove.error?.message).toBe("missing scope: operator.admin");

        const runId = "idem-chat-send-device-pair-approve-admin-scope-poc";
        const finalEventPromise = onceMessage(
          started.ws,
          (o) =>
            o.type === "event" &&
            o.event === "chat" &&
            o.payload?.state === "final" &&
            o.payload?.runId === runId,
          8000,
        );
        const viaChatSend = await rpcReq(started.ws, "chat.send", {
          sessionKey: "main",
          message: "/pair approve latest",
          idempotencyKey: runId,
        });
        expect(viaChatSend.ok).toBe(true);
        expect(viaChatSend.payload).toMatchObject({ runId, status: "started" });

        const finalEvent = await finalEventPromise;
        expect(extractFirstTextBlock(finalEvent.payload?.message)).toEqual(expect.any(String));

        const paired = await getPairedDevice(pendingAdmin.identity.deviceId);
        expect(paired).toBeNull();

        adminWs = await openWs(started.port);
        const adminReconnect = await connectReq(adminWs, {
          token: "secret",
          deviceIdentityPath: pendingAdmin.identityPath,
          scopes: ["operator.admin"],
        });
        expect(adminReconnect.ok).toBe(false);

        const pairedAfter = await getPairedDevice(pendingAdmin.identity.deviceId);
        expect(pairedAfter).toBeNull();
      } finally {
        adminWs?.close();
        started.ws.close();
        await started.server.close();
        started.envSnapshot.restore();
      }
    } finally {
      getReplyFromConfig.mockReset().mockResolvedValue(undefined);
      clearPluginCommands();
      clearConfigCache();
    }
  });
});
