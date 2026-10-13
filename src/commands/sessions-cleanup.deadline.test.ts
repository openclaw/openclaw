import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { sessionsCleanupCommand } from "./sessions-cleanup.js";

it("waits for delegated cleanup beyond the ordinary ten-second Gateway deadline", async () => {
  await withOpenClawTestState({ layout: "home" }, async () => {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    const server = new WebSocketServer({ host: "127.0.0.1", port: claim.port });
    let replyTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupRequests: unknown[] = [];
    const result = { allAgents: true, mode: "warn", dryRun: false, stores: [] };
    server.on("connection", (socket) => {
      sendMinimalGatewayConnectChallenge(socket);
      socket.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        if (!frame.id) {
          return;
        }
        const requestId = frame.id;
        if (frame.method === "connect") {
          sendMinimalGatewayResponse(
            socket,
            frame.id,
            buildMinimalGatewayHelloOkPayload({
              connId: "cleanup-deadline",
              methods: ["health", "sessions.cleanup"],
              snapshot: {
                presence: [],
                health: {},
                stateVersion: { presence: 0, health: 0 },
                uptimeMs: 0,
              },
              policy: {
                maxPayload: 1_048_576,
                maxBufferedBytes: 1_048_576,
                tickIntervalMs: 60_000,
              },
            }),
          );
        } else if (frame.method === "health") {
          sendMinimalGatewayResponse(socket, requestId, { ok: true });
        } else if (frame.method === "sessions.cleanup") {
          cleanupRequests.push(frame.params);
          // Advance the actual client's timers after its request reaches the wire fixture.
          replyTimer = setTimeout(
            () => sendMinimalGatewayResponse(socket, requestId, result),
            11_000,
          );
        }
      });
    });
    try {
      await once(server, "listening");
      setRuntimeConfigSnapshot({
        plugins: { enabled: false },
        gateway: {
          mode: "local",
          port: claim.port,
          auth: { mode: "token", token: "fixture-token" },
        },
        agents: { entries: { main: {} } },
      });
      const log = vi.fn();
      const error = vi.fn();
      const exit = vi.fn();
      // Admit the isolated credential/database fixtures before controlling request time.
      await callGateway({ method: "health" });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let settled = false;
      let failure: unknown;
      const outcome = sessionsCleanupCommand(
        { allAgents: true, json: true },
        { log, error, exit },
      ).then(
        () => {
          settled = true;
        },
        (caught: unknown) => {
          settled = true;
          failure = caught;
        },
      );
      await vi.waitFor(() => expect(cleanupRequests).toHaveLength(1), { timeout: 5_000 });
      await vi.advanceTimersByTimeAsync(11_000);
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
      await outcome;
      expect(failure).toBeUndefined();
      expect(cleanupRequests).toEqual([expect.objectContaining({ allAgents: true })]);
      expect(JSON.parse(log.mock.calls[0]?.[0])).toEqual(result);
      expect(error).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      clearTimeout(replyTimer);
      vi.useRealTimers();
      resetConfigRuntimeState();
      try {
        await closeMinimalGatewayServer(server);
      } finally {
        await claim.release();
      }
    }
  });
}, 25_000);
