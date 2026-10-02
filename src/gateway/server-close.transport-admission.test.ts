import { randomUUID } from "node:crypto";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectOk,
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });
await import("./server.js");

type UpgradeAttempt = { status: number; body: string } | "upgraded";

async function requestUpgrade(port: number): Promise<UpgradeAttempt> {
  return await new Promise<UpgradeAttempt>((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve("upgraded");
    });
    req.on("error", () => resolve({ status: 0, body: "socket error" }));
    req.end();
  });
}

describe("directly closed Gateway generation", () => {
  it("refuses new transport work while close waits on an owner", async () => {
    const kernelModule = await import("./server-kernel.js");
    const createKernel = kernelModule.createGatewayKernel;
    let kernel: Awaited<ReturnType<typeof createKernel>> | undefined;
    const factory = vi
      .spyOn(kernelModule, "createGatewayKernel")
      .mockImplementation(async (...args) => {
        kernel = await createKernel(...args);
        return kernel;
      });
    const harness = await createGatewaySuiteHarness({
      serverOptions: { openAiChatCompletionsEnabled: true },
    });
    factory.mockRestore();
    if (!kernel) {
      throw new Error("expected the real Gateway kernel");
    }
    const connected = await harness.openWs();
    await connectOk(connected, { scopes: ["operator.admin"] });
    // Upgraded before close and still pre-auth: the connect frame arrives while closing.
    const preauth = await harness.openWs();

    const gate = createDeferredCore();
    const closeOwnerReached = createDeferredCore();
    vi.spyOn(kernel.runtimeState.configReloader, "stop").mockImplementation(() => {
      closeOwnerReached.resolve();
      return gate.promise as Promise<void>;
    });
    let closing: Promise<void> | undefined;
    try {
      closing = harness.server.close({ reason: "close transport admission proof" });
      await closeOwnerReached.promise;
      expect(kernel.lifecycle.closePreludeStarted).toBe(true);

      // Readiness reports draining, but the retired generation must refuse its own listeners.
      await expect(requestUpgrade(harness.port)).resolves.toEqual({
        status: 503,
        body: "Gateway websocket admission closed",
      });

      const token = (testState.gatewayAuth as { token?: string } | undefined)?.token ?? "";
      const chat = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: "openclaw", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(chat.status).toBe(503);
      await expect(chat.json()).resolves.toMatchObject({
        error: { code: "gateway_unavailable" },
      });

      const refusedConnect = await connectReq(preauth, { scopes: ["operator.admin"] });
      expect(refusedConnect.ok).toBe(false);
      expect(refusedConnect.error).toMatchObject({
        code: "UNAVAILABLE",
        details: { method: "connect", reason: "gateway-closing" },
      });

      const rpcId = randomUUID();
      const rpcReply = onceMessage<{
        type: string;
        id: string;
        ok: boolean;
        error?: { code?: string; details?: unknown };
      }>(connected, (frame) => frame.type === "res" && frame.id === rpcId);
      connected.send(JSON.stringify({ type: "req", id: rpcId, method: "status", params: {} }));
      await expect(rpcReply).resolves.toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          details: { method: "status", reason: "gateway-closing" },
        },
      });

      // Probes stay reachable so operators can still observe the retiring generation.
      const healthz = await fetch(`http://127.0.0.1:${harness.port}/healthz`);
      expect(healthz.status).toBe(200);
      const readyz = await fetch(`http://127.0.0.1:${harness.port}/readyz`);
      expect(readyz.status).toBe(503);
      await expect(readyz.json()).resolves.toMatchObject({ failing: ["gateway-draining"] });
    } finally {
      gate.resolve();
      await closing?.catch(() => {});
      connected.terminate();
      preauth.terminate();
      await harness.close().catch(() => {});
    }
  });
});
