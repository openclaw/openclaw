import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { getReplyFromConfig as getActualReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { clearConfigCache, writeConfigFile } from "../config/config.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { clearPluginCommands } from "../plugins/commands.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";
import {
  connectReq,
  connectOk,
  getReplyFromConfig,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  resetTestPluginRegistry,
  setTestPluginRegistry,
  startServerWithClient,
  testState,
  trackConnectChallengeNonce,
  writeSessionStore,
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

async function withMainSessionStore<T>(run: () => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
  testState.sessionStorePath = path.join(dir, "sessions.json");
  try {
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });
    return await run();
  } finally {
    testState.sessionStorePath = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function loadRealDevicePairRegistry() {
  const actualLoader = await vi.importActual<typeof import("../plugins/loader.js")>(
    "../plugins/loader.js",
  );
  const env = {
    ...process.env,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
  };
  actualLoader.clearPluginLoaderCache();
  const registry = actualLoader.loadOpenClawPlugins({
    cache: false,
    env,
    workspaceDir: process.cwd(),
    onlyPluginIds: ["device-pair"],
    config: {
      plugins: {
        enabled: true,
        entries: {
          "device-pair": {
            enabled: true,
          },
        },
        slots: {
          memory: "none",
        },
      },
    },
  });
  setTestPluginRegistry(registry);
  return {
    registry,
    clearLoaderCache: actualLoader.clearPluginLoaderCache,
    bundledPluginsDir: env.OPENCLAW_BUNDLED_PLUGINS_DIR,
  };
}

describe("gateway chat.send /pair approve admin scope", () => {
  it("does not let operator.write plus operator.pairing approve an operator.admin device via /pair approve", async () => {
    getReplyFromConfig.mockImplementation(getActualReplyFromConfig);
    clearPluginCommands();
    clearConfigCache();
    const testConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
          workspace: path.join(process.env.HOME ?? ".", "openclaw"),
        },
      },
      commands: {
        text: true,
      },
      plugins: {
        enabled: true,
        entries: {
          "device-pair": {
            enabled: true,
          },
        },
        slots: {
          memory: "none",
        },
      },
    };
    const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(process.cwd(), "extensions");
    await writeConfigFile(testConfig);
    clearConfigCache();
    const { registry, clearLoaderCache } = await loadRealDevicePairRegistry();

    try {
      await withMainSessionStore(async () => {
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
          expect(registry.plugins.find((entry) => entry.id === "device-pair")?.status).toBe(
            "loaded",
          );
          expect(registry.commands.map((entry) => entry.command.name)).toContain("pair");

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
          expect(extractFirstTextBlock(finalEvent.payload?.message)).toBe(
            "⚠️ Cannot approve a request requiring operator.admin.",
          );

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
      });
    } finally {
      if (previousBundledPluginsDir === undefined) {
        delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
      } else {
        process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
      }
      clearLoaderCache();
      resetTestPluginRegistry();
      getReplyFromConfig.mockReset().mockResolvedValue(undefined);
      clearPluginCommands();
      clearConfigCache();
    }
  });
});
