import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectWebchatClient,
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks();

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("deferred Gateway activation", () => {
  it("starts in activation-pending state without exposing the active lifecycle", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port, { activationMode: "deferred" } as never);
    try {
      const deferredServer = server as typeof server & {
        activationState?: () => string;
      };

      expect(typeof deferredServer.activationState).toBe("function");
      expect(deferredServer.activationState?.()).toBe("deferred");
    } finally {
      await server.close();
    }
  });

  it("rejects normal webchat connections before activation", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port, { activationMode: "deferred" } as never);
    try {
      await expect(connectWebchatClient({ port })).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it("does not promote config last-known-good before activation", async () => {
    const port = await getFreePort();
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    expect(stateDir).toBeTruthy();
    const lastGoodPath = path.join(stateDir!, "openclaw.json.last-good");
    await fs.rm(lastGoodPath, { force: true });

    const server = await startGatewayServer(port, { activationMode: "deferred" } as never);
    try {
      expect(await pathExists(lastGoodPath)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("exposes a control port that activates the real Gateway on demand", async () => {
    const port = await getFreePort();
    const controlPort = await getFreePort();
    const server = await startGatewayServer(port, {
      activationControlPort: controlPort,
      activationMode: "deferred",
    } as never);
    try {
      const pending = await fetch(`http://127.0.0.1:${controlPort}/readyz`);
      expect(pending.status).toBe(503);
      expect(await pending.json()).toMatchObject({ state: "deferred" });

      const activated = await fetch(`http://127.0.0.1:${controlPort}/activate`, {
        method: "POST",
        body: JSON.stringify({ activationId: "control" }),
      });
      expect(activated.status).toBe(200);
      expect(await activated.json()).toMatchObject({ state: "active" });

      const ws = await connectWebchatClient({ port });
      ws.close();
    } finally {
      await server.close();
    }
  });

  it("activates exactly once and then allows normal webchat connections", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port, { activationMode: "deferred" } as never);
    try {
      const deferredServer = server as typeof server & {
        activate?: (input: { activationId: string }) => Promise<void>;
        activationState: () => string;
      };

      expect(typeof deferredServer.activate).toBe("function");
      await deferredServer.activate?.({ activationId: "first" });
      expect(deferredServer.activationState()).toBe("active");

      const ws = await connectWebchatClient({ port });
      ws.close();

      await expect(deferredServer.activate?.({ activationId: "second" })).rejects.toThrow(
        /already activated/i,
      );
    } finally {
      await server.close();
    }
  });
});
