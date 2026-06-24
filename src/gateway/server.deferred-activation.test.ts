import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  connectWebchatClient,
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks();

async function expectResolvesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function openHangingControlRequest(port: number): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(
        "POST /activate HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\nx-openclaw-activation-token: test-token\r\n\r\n",
      );
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

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

  it("keeps Gateway-port healthz live while deferred but not ready", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port, { activationMode: "deferred" } as never);
    try {
      for (const path of ["/health", "/healthz"]) {
        const health = await fetch(`http://127.0.0.1:${port}${path}`);
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ state: "deferred" });
      }

      const healthHead = await fetch(`http://127.0.0.1:${port}/healthz`, { method: "HEAD" });
      expect(healthHead.status).toBe(200);
      expect(await healthHead.text()).toBe("");

      const healthPost = await fetch(`http://127.0.0.1:${port}/healthz`, { method: "POST" });
      expect(healthPost.status).toBe(405);
      expect(healthPost.headers.get("allow")).toBe("GET, HEAD");
      expect(await healthPost.text()).toBe("Method Not Allowed");

      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ state: "deferred" });
    } finally {
      await server.close();
    }
  });

  it("rejects a deferred control port that equals the Gateway port", async () => {
    const port = await getFreePort();
    await expect(
      startGatewayServer(port, {
        activationControlPort: port,
        activationControlToken: "test-token",
        activationMode: "deferred",
      } as never),
    ).rejects.toThrow(/activation control port must differ/i);

    const probe = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", () => resolve());
      });
    } finally {
      if (probe.listening) {
        await new Promise<void>((resolve) => probe.close(() => resolve()));
      }
    }
  });

  it("does not carry a pre-activation startup config snapshot into activation", async () => {
    const source = await fs.readFile(new URL("./server.impl.ts", import.meta.url), "utf8");
    expect(source).toContain("delete activeOpts.startupConfigSnapshotRead");
  });

  it("closes promptly when a control-port request body never finishes", async () => {
    const port = await getFreePort();
    const controlPort = await getFreePort();
    const server = await startGatewayServer(port, {
      activationControlPort: controlPort,
      activationControlToken: "test-token",
      activationMode: "deferred",
    } as never);
    const socket = await openHangingControlRequest(controlPort);
    try {
      await expectResolvesWithin(server.close({ reason: "hanging control request" }), 1500);
      expect(server.activationState()).toBe("closed");
    } finally {
      socket.destroy();
      await server.close({ reason: "test cleanup" }).catch(() => undefined);
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

  it("rejects stale control-port tokens when a refreshed token provider returns empty", async () => {
    const port = await getFreePort();
    const controlPort = await getFreePort();
    const server = await startGatewayServer(port, {
      activationControlPort: controlPort,
      activationControlToken: "old-token",
      activationMode: "deferred",
      refreshActivationControlToken: async () => undefined,
    } as never);
    try {
      const withoutToken = await fetch(`http://127.0.0.1:${controlPort}/activate`, {
        method: "POST",
        body: JSON.stringify({ activationId: "revoked" }),
      });
      expect(withoutToken.status).toBe(401);

      const blankToken = await fetch(`http://127.0.0.1:${controlPort}/activate`, {
        method: "POST",
        body: JSON.stringify({ activationId: "revoked" }),
        headers: { "x-openclaw-activation-token": "" },
      });
      expect(blankToken.status).toBe(401);

      const stale = await fetch(`http://127.0.0.1:${controlPort}/activate`, {
        method: "POST",
        body: JSON.stringify({ activationId: "revoked" }),
        headers: { "x-openclaw-activation-token": "old-token" },
      });
      expect(stale.status).toBe(401);
      expect(server.activationState()).toBe("deferred");
    } finally {
      await server.close();
    }
  });

  it("authorizes control-port activation with a refreshed token provider", async () => {
    const port = await getFreePort();
    const controlPort = await getFreePort();
    const server = await startGatewayServer(port, {
      activationControlPort: controlPort,
      activationControlToken: "old-token",
      activationMode: "deferred",
      refreshActivationControlToken: async () => "new-token",
    } as never);
    try {
      const stale = await fetch(`http://127.0.0.1:${controlPort}/activate`, {
        method: "POST",
        body: JSON.stringify({ activationId: "stale" }),
        headers: { "x-openclaw-activation-token": "old-token" },
      });
      expect(stale.status).toBe(401);

      const activated = await fetch(`http://127.0.0.1:${controlPort}/activate`, {
        method: "POST",
        body: JSON.stringify({ activationId: "fresh" }),
        headers: { "x-openclaw-activation-token": "new-token" },
      });
      expect(activated.status).toBe(200);
      expect(await activated.json()).toMatchObject({ state: "active" });
    } finally {
      await server.close();
    }
  });

  it("exposes a control port that activates the real Gateway on demand", async () => {
    const port = await getFreePort();
    const controlPort = await getFreePort();
    const server = await startGatewayServer(port, {
      activationControlPort: controlPort,
      activationControlToken: "test-token",
      activationMode: "deferred",
    } as never);
    try {
      const health = await fetch(`http://127.0.0.1:${controlPort}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ state: "deferred" });

      const pending = await fetch(`http://127.0.0.1:${controlPort}/readyz`);
      expect(pending.status).toBe(503);
      expect(await pending.json()).toMatchObject({ state: "deferred" });

      const rejected = await fetch(`http://127.0.0.1:${controlPort}/activate`, {
        method: "POST",
        body: JSON.stringify({ activationId: "control" }),
      });
      expect(rejected.status).toBe(401);

      const activated = await fetch(`http://127.0.0.1:${controlPort}/activate`, {
        method: "POST",
        body: JSON.stringify({ activationId: "control" }),
        headers: { "x-openclaw-activation-token": "test-token" },
      });
      expect(activated.status).toBe(200);
      expect(await activated.json()).toMatchObject({ state: "active" });

      const ws = await connectWebchatClient({ port });
      ws.close();
    } finally {
      await server.close();
    }
  });

  it("does not leak an active Gateway when closed during activation", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port, { activationMode: "deferred" } as never);
    try {
      const deferredServer = server as typeof server & {
        activate: (input: { activationId: string }) => Promise<void>;
        activationState: () => string;
      };
      const activation = deferredServer.activate({ activationId: "race" });
      await server.close({ reason: "race close" });
      await activation.catch(() => undefined);

      expect(deferredServer.activationState()).toBe("closed");
      await expect(connectWebchatClient({ port })).rejects.toThrow();
    } finally {
      await server.close({ reason: "test cleanup" }).catch(() => undefined);
    }
  });

  it("runs activation guard before promoting the real Gateway", async () => {
    const port = await getFreePort();
    const beforeActivationStart = vi.fn(async () => {
      throw new Error("activation blocked by fresh config guard");
    });
    const server = await startGatewayServer(port, {
      activationMode: "deferred",
      beforeActivationStart,
    } as never);
    try {
      await expect(server.activate({ activationId: "guarded" })).rejects.toThrow(
        /activation blocked by fresh config guard/,
      );
      expect(beforeActivationStart).toHaveBeenCalledTimes(1);
      await expect(connectWebchatClient({ port })).rejects.toThrow();
    } finally {
      await server.close({ reason: "test cleanup" });
    }
  });

  it("waits for a completing in-flight activation before close returns", async () => {
    const port = await getFreePort();
    let releaseActivation: (() => void) | undefined;
    let markHookStarted: (() => void) | undefined;
    const hookStarted = new Promise<void>((resolve) => {
      markHookStarted = resolve;
    });
    const activationReleased = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const server = await startGatewayServer(port, {
      activationMode: "deferred",
      beforeActivationStart: async () => {
        markHookStarted?.();
        await activationReleased;
      },
    } as never);
    const activation = server.activate({ activationId: "close-waits" });
    try {
      await expectResolvesWithin(hookStarted, 1000);
      let closed = false;
      const closing = server.close({ reason: "wait for activation completion" }).then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(closed).toBe(false);
      releaseActivation?.();
      await expectResolvesWithin(closing, 1000);
      await activation.catch(() => undefined);
      expect(server.activationState()).toBe("closed");
      await expect(connectWebchatClient({ port })).rejects.toThrow();
    } finally {
      releaseActivation?.();
      activation.catch(() => undefined);
      await server.close({ reason: "test cleanup" }).catch(() => undefined);
    }
  });

  it("does not wait for a stuck activation startup before closing deferred listeners", async () => {
    const port = await getFreePort();
    let markHookStarted: (() => void) | undefined;
    const hookStarted = new Promise<void>((resolve) => {
      markHookStarted = resolve;
    });
    const server = await startGatewayServer(port, {
      activationMode: "deferred",
      beforeActivationStart: async () => {
        markHookStarted?.();
        await new Promise<never>(() => undefined);
      },
    } as never);
    const activation = server.activate({ activationId: "slow" });
    try {
      await expectResolvesWithin(hookStarted, 1000);
      await expectResolvesWithin(server.close({ reason: "shutdown during activation" }), 1200);
      expect(server.activationState()).toBe("closed");
      await expect(connectWebchatClient({ port })).rejects.toThrow();
    } finally {
      activation.catch(() => undefined);
      await server.close({ reason: "test cleanup" }).catch(() => undefined);
    }
  });

  it("does not make failed activation unretryable with a sticky activation id", async () => {
    const source = await fs.readFile(new URL("./server.impl.ts", import.meta.url), "utf8");
    expect(source).not.toContain("activationId: string | null");
    expect(source).not.toContain("activationId !== null");
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
