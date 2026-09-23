/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import * as deviceIdentity from "../../lib/nodes/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createModelSetupVerifyTask } from "./rpc.ts";

type RequestFrame = { id: string; method: string; params?: unknown };
const sockets: VerificationSocket[] = [];

class VerificationSocket extends EventTarget {
  static readonly OPEN = 1;
  readyState = VerificationSocket.OPEN;
  readonly sent: RequestFrame[] = [];

  constructor(_url: string) {
    super();
    sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as RequestFrame);
  }

  close(): void {
    this.readyState = 3;
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("WebSocket", VerificationSocket);
  vi.spyOn(deviceIdentity, "loadOrCreateDeviceIdentity").mockResolvedValue({
    deviceId: "test-device",
    privateKey: "test-private-key", // pragma: allowlist secret
    publicKey: "test-public-key",
  });
  vi.spyOn(deviceIdentity, "signDevicePayload").mockResolvedValue("test-signature");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { outcome: "reply", modelTarget: undefined },
  { outcome: "reply", modelTarget: "utility" },
  { outcome: "abort", modelTarget: "utility" },
  { outcome: "deadline", modelTarget: undefined },
] as const)(
  "keeps verification through a healthy slow model response while preserving $outcome settlement for target $modelTarget",
  async ({ outcome, modelTarget }) => {
    const client = new GatewayBrowserClient({ url: "ws://localhost", token: "test-token" });
    try {
      client.start();
      const socket = sockets[0]!;
      socket.dispatchEvent(new Event("open"));
      socket.receive({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "test-nonce", ts: Date.now() },
      });
      await vi.waitFor(() =>
        expect(socket.sent.some((frame) => frame.method === "connect")).toBe(true),
      );
      const connect = socket.sent.find((frame) => frame.method === "connect")!;
      expect(connect).toBeDefined();
      socket.receive({
        type: "res",
        id: connect.id,
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          auth: { role: "operator", scopes: ["operator.admin"] },
          policy: { tickIntervalMs: 10_000 },
        },
      });
      const task = createModelSetupVerifyTask({
        addController: () => undefined,
        removeController: () => undefined,
        requestUpdate: () => undefined,
        updateComplete: Promise.resolve(true),
      });
      const settled = vi.fn();
      void task.run([client, "main", modelTarget]);
      const verification = task.taskComplete;
      void verification.then(settled, settled);
      const request = socket.sent.at(-1)!;
      expect(request).toMatchObject({
        method: "openclaw.setup.verify",
      });
      expect(request.params).toEqual(
        modelTarget ? { agentId: "main", modelTarget: "utility" } : { agentId: "main" },
      );
      let tick = 0;
      const advanceHealthy = async (durationMs: number) => {
        for (let remaining = durationMs; remaining > 0; remaining -= 5_000) {
          await vi.advanceTimersByTimeAsync(Math.min(remaining, 5_000));
          socket.receive({ type: "event", event: "tick", seq: ++tick, payload: {} });
        }
      };
      // A healthy model may still be executing inside the Gateway's 90-second probe.
      await advanceHealthy(45_000);
      expect(client.connected).toBe(true);
      expect(settled).not.toHaveBeenCalled();
      const result = { ok: true, modelRef: "provider/local-model", latencyMs: 45_000 };
      if (outcome === "abort") {
        task.abort();
        await expect(verification).resolves.toEqual({
          client,
          error: expect.objectContaining({ message: expect.stringContaining("aborted") }),
        });
      } else if (outcome === "deadline") {
        await advanceHealthy(105_000);
        await expect(verification).resolves.toEqual({
          client,
          error: expect.objectContaining({ message: expect.stringContaining("timed out") }),
        });
      }
      socket.receive({ type: "res", id: request.id, ok: true, payload: result });
      if (outcome === "reply") {
        await expect(verification).resolves.toEqual({ client, value: result });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledOnce();
      expect(task.value).toEqual(settled.mock.calls[0]?.[0]);
    } finally {
      client.stop();
    }
  },
);
