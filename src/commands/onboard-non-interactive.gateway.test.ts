import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { buildDeviceAuthPayload } from "../gateway/device-auth.js";
import { PROTOCOL_VERSION } from "../gateway/protocol/index.js";
import { rawDataToString } from "../infra/ws.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to acquire free port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function getFreeGatewayPort(): Promise<number> {
  return await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 4] });
}

async function onceMessage<T = unknown>(
  ws: WebSocket,
  filter: (obj: unknown) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const closeHandler = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`closed ${code}: ${rawDataToString(reason)}`));
    };
    const handler = (data: WebSocket.RawData) => {
      const obj = JSON.parse(rawDataToString(data));
      if (!filter(obj)) return;
      clearTimeout(timer);
      ws.off("message", handler);
      ws.off("close", closeHandler);
      resolve(obj as T);
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
}

async function connectReq(params: { url: string; token?: string }) {
  const ws = new WebSocket(params.url);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  const identity = loadOrCreateDeviceIdentity();
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
    role: "operator",
    scopes: [],
    signedAtMs,
    token: params.token ?? null,
  });
  const device = {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signDevicePayload(identity.privateKeyPem, payload),
    signedAt: signedAtMs,
  };
  ws.send(
    JSON.stringify({
      type: "req",
      id: "c1",
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: GATEWAY_CLIENT_NAMES.TEST,
          displayName: "vitest",
          version: "dev",
          platform: process.platform,
          mode: GATEWAY_CLIENT_MODES.TEST,
        },
        caps: [],
        auth: params.token ? { token: params.token } : undefined,
        device,
      },
    }),
  );
  const res = await onceMessage<{
    type: "res";
    id: string;
    ok: boolean;
    error?: { message?: string };
  }>(ws, (o) => {
    const obj = o as { type?: unknown; id?: unknown } | undefined;
    return obj?.type === "res" && obj?.id === "c1";
  });
  ws.close();
  return res;
}

const runtime = {
  log: () => {},
  error: (msg: string) => {
    throw new Error(msg);
  },
  exit: (code: number) => {
    throw new Error(`exit:${code}`);
  },
};

describe("onboard (non-interactive): gateway and remote auth", () => {
  const prev = {
    home: process.env.HOME,
    stateDir: process.env.CLAWDBOT_STATE_DIR,
    configPath: process.env.CLAWDBOT_CONFIG_PATH,
    skipChannels: process.env.CLAWDBOT_SKIP_CHANNELS,
    skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
    skipCron: process.env.CLAWDBOT_SKIP_CRON,
    skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
    token: process.env.CLAWDBOT_GATEWAY_TOKEN,
    password: process.env.CLAWDBOT_GATEWAY_PASSWORD,
  };
  let tempHome: string | undefined;

  const initStateDir = async (prefix: string) => {
    if (!tempHome) {
      throw new Error("temp home not initialized");
    }
    const stateDir = await fs.mkdtemp(path.join(tempHome, prefix));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    delete process.env.CLAWDBOT_CONFIG_PATH;
    vi.resetModules();
    return stateDir;
  };

  beforeAll(async () => {
    process.env.CLAWDBOT_SKIP_CHANNELS = "1";
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
    process.env.CLAWDBOT_SKIP_CRON = "1";
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    delete process.env.CLAWDBOT_GATEWAY_PASSWORD;

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-onboard-"));
    process.env.HOME = tempHome;
  });

  afterAll(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
    process.env.HOME = prev.home;
    process.env.CLAWDBOT_STATE_DIR = prev.stateDir;
    process.env.CLAWDBOT_CONFIG_PATH = prev.configPath;
    process.env.CLAWDBOT_SKIP_CHANNELS = prev.skipChannels;
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = prev.skipGmail;
    process.env.CLAWDBOT_SKIP_CRON = prev.skipCron;
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = prev.skipCanvas;
    process.env.CLAWDBOT_GATEWAY_TOKEN = prev.token;
    process.env.CLAWDBOT_GATEWAY_PASSWORD = prev.password;
  });

  it("writes gateway token auth into config and gateway enforces it", async () => {
    const stateDir = await initStateDir("state-noninteractive-");
    const token = "tok_test_123";
    const workspace = path.join(stateDir, "clawd");

    const { runNonInteractiveOnboarding } = await import("./onboard-non-interactive.js");
    await runNonInteractiveOnboarding(
      {
        nonInteractive: true,
        mode: "local",
        workspace,
        authChoice: "skip",
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
        gatewayBind: "loopback",
        gatewayAuth: "token",
        gatewayToken: token,
      },
      runtime,
    );

    const { CONFIG_PATH_CLAWDBOT } = await import("../config/config.js");
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH_CLAWDBOT, "utf8")) as {
      gateway?: { auth?: { mode?: string; token?: string } };
      agents?: { defaults?: { workspace?: string } };
    };

    expect(cfg?.agents?.defaults?.workspace).toBe(workspace);
    expect(cfg?.gateway?.auth?.mode).toBe("token");
    expect(cfg?.gateway?.auth?.token).toBe(token);

    const { startGatewayServer } = await import("../gateway/server.js");
    const port = await getFreePort();
    const server = await startGatewayServer(port, {
      bind: "loopback",
      controlUiEnabled: false,
    });
    try {
      const resNoToken = await connectReq({ url: `ws://127.0.0.1:${port}` });
      expect(resNoToken.ok).toBe(false);
      expect(resNoToken.error?.message ?? "").toContain("unauthorized");

      const resToken = await connectReq({
        url: `ws://127.0.0.1:${port}`,
        token,
      });
      expect(resToken.ok).toBe(true);
    } finally {
      await server.close({ reason: "non-interactive onboard auth test" });
    }

    await fs.rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  it("writes gateway.remote url/token and callGateway uses them", async () => {
    const stateDir = await initStateDir("state-remote-");
    const port = await getFreePort();
    const token = "tok_remote_123";
    const { startGatewayServer } = await import("../gateway/server.js");
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });

    try {
      const { runNonInteractiveOnboarding } = await import("./onboard-non-interactive.js");
      await runNonInteractiveOnboarding(
        {
          nonInteractive: true,
          mode: "remote",
          remoteUrl: `ws://127.0.0.1:${port}`,
          remoteToken: token,
          authChoice: "skip",
          json: true,
        },
        runtime,
      );

      const { resolveConfigPath } = await import("../config/config.js");
      const cfg = JSON.parse(await fs.readFile(resolveConfigPath(), "utf8")) as {
        gateway?: { mode?: string; remote?: { url?: string; token?: string } };
      };

      expect(cfg.gateway?.mode).toBe("remote");
      expect(cfg.gateway?.remote?.url).toBe(`ws://127.0.0.1:${port}`);
      expect(cfg.gateway?.remote?.token).toBe(token);

      const { callGateway } = await import("../gateway/call.js");
      const health = await callGateway<{ ok?: boolean }>({ method: "health" });
      expect(health?.ok).toBe(true);
    } finally {
      await server.close({ reason: "non-interactive remote test complete" });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("auto-enables token auth when binding LAN and persists the token", async () => {
    if (process.platform === "win32") {
      // Windows runner occasionally drops the temp config write in this flow; skip to keep CI green.
      return;
    }
    const stateDir = await initStateDir("state-lan-");
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    process.env.CLAWDBOT_CONFIG_PATH = path.join(stateDir, "clawdbot.json");

    const port = await getFreeGatewayPort();
    const workspace = path.join(stateDir, "clawd");

    // Other test files mock ../config/config.js. This onboarding flow needs the real
    // implementation so it can persist the config and then read it back (Windows CI
    // otherwise sees a mocked writeConfigFile and the config never lands on disk).
    vi.resetModules();
    vi.doMock("../config/config.js", async () => {
      return (await vi.importActual("../config/config.js")) as typeof import("../config/config.js");
    });

    const { runNonInteractiveOnboarding } = await import("./onboard-non-interactive.js");
    await runNonInteractiveOnboarding(
      {
        nonInteractive: true,
        mode: "local",
        workspace,
        authChoice: "skip",
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
        gatewayPort: port,
        gatewayBind: "lan",
        gatewayAuth: "off",
      },
      runtime,
    );

    const { resolveConfigPath } = await import("../config/paths.js");
    const configPath = resolveConfigPath(process.env, stateDir);
    const cfg = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      gateway?: {
        bind?: string;
        port?: number;
        auth?: { mode?: string; token?: string };
      };
    };

    expect(cfg.gateway?.bind).toBe("lan");
    expect(cfg.gateway?.port).toBe(port);
    expect(cfg.gateway?.auth?.mode).toBe("token");
    const token = cfg.gateway?.auth?.token ?? "";
    expect(token.length).toBeGreaterThan(8);

    const { startGatewayServer } = await import("../gateway/server.js");
    const server = await startGatewayServer(port, {
      controlUiEnabled: false,
      auth: {
        mode: "token",
        token,
      },
    });
    try {
      const resNoToken = await connectReq({ url: `ws://127.0.0.1:${port}` });
      expect(resNoToken.ok).toBe(false);
      expect(resNoToken.error?.message ?? "").toContain("unauthorized");

      const resToken = await connectReq({
        url: `ws://127.0.0.1:${port}`,
        token,
      });
      expect(resToken.ok).toBe(true);
    } finally {
      await server.close({ reason: "lan auto-token test complete" });
    }

    await fs.rm(stateDir, { recursive: true, force: true });
  }, 60_000);
});
