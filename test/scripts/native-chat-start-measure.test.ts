import assert from "node:assert/strict";
import { createServer } from "node:http";
import { expect, it, onTestFinished } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  createNativeChatStartConfig,
  measureNativeChatStart,
} from "../../scripts/perf/native-chat-start-measure.ts";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.ts";

// The driver only accepts ports 30000-65534, but Linux test pools can allocate lower ones.
it.each(
  [
    "local mock",
    "external provider",
    "wrong runtime",
    "missing mock receipt",
    "rejected ACK",
    "wrong stop PID",
    "released materialized main",
    "main runtime override",
    "main model override",
    "additional agent",
  ].map((kind, index) => [kind, 31840 + index] as const),
)("validates the %s fixture before recording native-identity receipts", async (kind, port) => {
  let providerRequests = 0;
  const reservation = await reserveTestPortListener({
    port,
    offsets: [0],
    createListener: () =>
      createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            requests: {
              id: "synthetic-mock-instance",
              ingress: { responses: providerRequests, embeddings: 0 },
              accounting: { version: 1 },
            },
          }),
        );
      }),
  });
  const server = new WebSocketServer({ server: reservation.listener });
  onTestFinished(async () => {
    for (const peer of server.clients) {
      peer.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await reservation.releaseListener();
    await reservation.claim.release();
  });
  const mockUrl = `http://127.0.0.1:${port}/v1`;
  const methods: string[] = [];
  server.on("connection", (peer) => {
    peer.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "synthetic-challenge", ts: Date.now() },
      }),
    );
    peer.on("message", (raw) => {
      const frame: unknown = JSON.parse(rawDataToString(raw));
      assert(isRecord(frame) && typeof frame.method === "string" && isRecord(frame.params));
      methods.push(frame.method);
      let payload: unknown;
      if (frame.method === "connect") {
        expect(frame.params.client).toMatchObject({ id: "gateway-client", mode: "ui" });
        expect(frame.params.device).toMatchObject({ nonce: "synthetic-challenge" });
        payload = { type: "hello-ok", policy: { maxPayload: 1048576, tickIntervalMs: 30000 } };
      } else if (frame.method === "config.get") {
        const config = createNativeChatStartConfig(port + 1, port);

        assert(config.models?.providers?.openai);
        config.models.providers.openai.apiKey = "__OPENCLAW_REDACTED__";
        assert(config.agents);
        if (kind === "released materialized main") {
          config.agents.entries = { main: {} };
        } else if (kind === "main runtime override") {
          config.agents.entries = {
            main: { models: { "openai/gpt-4.1": { agentRuntime: { id: "codex" } } } },
          };
        } else if (kind === "main model override") {
          config.agents.entries = { main: { model: { primary: "openai/other" } } };
        } else if (kind === "additional agent") {
          config.agents.entries = { main: {}, other: {} };
        }
        if (kind === "external provider") {
          config.models.providers.openai.baseUrl = "https://api.openai.com/v1";
        }
        if (kind === "wrong runtime") {
          assert(config.agents?.defaults?.models?.["openai/gpt-4.1"]);
          config.agents.defaults.models["openai/gpt-4.1"].agentRuntime = { id: "codex" };
        }
        payload = { config };
      } else if (frame.method === "chat.abort") {
        payload = { aborted: true };
      } else if (frame.method === "health") {
        payload = { ok: true };
      } else if (frame.method === "status") {
        payload = { pid: kind === "wrong stop PID" ? 456 : 123 };
      } else if (frame.method === "gateway.stop.request") {
        expect(frame.params.target).toEqual({ pid: 123, ownerId: "synthetic-owner", port });

        payload = { ok: true, pid: 123, status: "scheduled" };
      } else {
        expect(frame.method).toBe("chat.send");
        if (kind === "rejected ACK") {
          peer.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "UNAVAILABLE", message: "Synthetic dispatch failure" },
            }),
          );
          return;
        }
        assert(typeof frame.params.message === "string");
        const marker = frame.params.message.match(/OPENCLAW_E2E_NATIVE_[A-F0-9]+/)?.[0];
        assert(marker);
        if (kind !== "missing mock receipt") {
          providerRequests++;
        }
        const event = {
          type: "event",
          event: "chat",
          payload: {
            sessionKey: frame.params.sessionKey,
            runId: frame.params.idempotencyKey,
            state: "delta",
            message: { role: "assistant", content: [{ type: "text", text: marker }] },
          },
        };
        peer.send(JSON.stringify(event));
        peer.send(JSON.stringify({ ...event, payload: { ...event.payload, state: "final" } }));
        payload = { runId: frame.params.idempotencyKey, status: "started" };
      }
      peer.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    });
  });
  const measurement = measureNativeChatStart({
    url: `ws://127.0.0.1:${port}`,
    mockUrl,
    samples: 2,
    timeoutMs: 5000,
    stopTarget: { pid: 123, ownerId: "synthetic-owner", port },
  });
  if (["main runtime override", "main model override", "additional agent"].includes(kind)) {
    await expect(measurement).rejects.toThrow("agent overrides are not this fixture");
    expect(methods).toEqual(["connect", "config.get"]);
  } else if (kind === "external provider" || kind === "wrong runtime") {
    await expect(measurement).rejects.toThrow();
    expect(methods).toEqual(["connect", "config.get"]);
  } else if (kind === "missing mock receipt") {
    await expect(measurement).rejects.toThrow("No matching mock-provider request");
    expect(methods).toEqual(["connect", "config.get", "chat.send"]);
  } else if (kind === "rejected ACK") {
    await expect(measurement).rejects.toThrow(/cleanup unconfirmed.*sessionKey=.*runId=/);
    expect(methods).toEqual(["connect", "config.get", "chat.send", "chat.abort"]);
  } else if (kind === "wrong stop PID") {
    const result = await measurement;
    expect(result.outcome).toBe("shutdown-unconfirmed");
    expect(result.shutdownFailure).toContain("Connected process no longer matches the task lock");
    expect(result.samples).toHaveLength(2);
    expect(methods).toEqual(["connect", "config.get", "chat.send", "chat.send", "status"]);
  } else {
    const result = await measurement;
    expect(methods).toEqual([
      "connect",
      "config.get",
      "chat.send",
      "chat.send",
      "status",
      "gateway.stop.request",
    ]);
    expect(result.samples).toHaveLength(2);
    expect(result.shutdownRequest).toEqual({ status: "scheduled", pid: 123 });
    for (const sample of result.samples) {
      expect(sample.firstAssistantDeltaMs).toBeLessThanOrEqual(sample.acknowledgedMs);
      expect(sample.completedMs).toBeLessThanOrEqual(sample.acknowledgedMs);
    }
  }
});
