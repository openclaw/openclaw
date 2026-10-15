import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";
import { writeConfigFile } from "../config/config.js";
import {
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

test("measures trusted-proxy connect success, rejection, and failed hello delivery without payloads", async () => {
  const origin = "https://control.example.com";
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile({
    gateway: { auth, trustedProxies: ["127.0.0.1"], controlUi: { allowedOrigins: [origin] } },
  });
  await withGatewayServer(async ({ port }) => {
    const events: Extract<DiagnosticEventPayload, { type: "gateway.rpc" }>[] = [];
    setDiagnosticsEnabledForProcess(true);
    const unsubscribe = onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "gateway.rpc" && event.method === "connect") events.push(event);
      },
      { include: ["gateway.rpc"] },
    );
    try {
      for (const outcome of ["ok", "error", "unavailable"] as const) {
        events.length = 0;
        const socket = await openWs(port, {
          origin,
          "x-forwarded-for": "203.0.113.50",
          "x-forwarded-proto": "https",
          ...(outcome === "error" ? {} : { "x-forwarded-user": "private-user@example.com" }),
        });
        const originalSend = WebSocket.prototype.send;
        const spy =
          outcome === "unavailable"
            ? vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
                this: WebSocket,
                ...args: Parameters<WebSocket["send"]>
              ) {
                if (typeof args[0] === "string" && args[0].includes('"hello-ok"')) {
                  const callback = args.findLast((arg) => typeof arg === "function");
                  if (typeof callback !== "function") throw new Error("missing send callback");
                  callback(new Error("synthetic delivery failure"));
                  return;
                }
                Reflect.apply(originalSend, this, args);
              })
            : undefined;
        try {
          const closed = outcome === "unavailable" ? once(socket, "close") : undefined;
          const response = connectReq(socket, {
            skipDefaultAuth: true,
            prePairDevice: true,
            client: { ...CONTROL_UI_CLIENT, instanceId: "private-instance" },
            scopes: ["operator.read"],
            browserOrigin: origin,
          });
          if (closed) {
            void response.catch(() => {});
            await closed;
          } else {
            const result = await response;
            expect(result.ok, JSON.stringify(result.error)).toBe(outcome === "ok");
          }
          await waitForDiagnosticEventsDrained();
          expect(events.map((event) => event.phase)).toEqual([
            "received",
            "response",
            "handler",
            "dispatch",
          ]);
          expect(events[1]).toMatchObject({
            outcome,
            durationMs: expect.any(Number),
            ...(outcome === "ok" ? { responseBytes: expect.any(Number), firstResponse: true } : {}),
          });
          expect(events[2]).toMatchObject({
            outcome: "returned",
            durationMs: expect.any(Number),
            admissionMs: expect.any(Number),
          });
          expect(events[3]).toMatchObject({
            outcome: "returned",
            response: outcome === "unavailable" ? "unavailable" : "sent",
          });
          expect(JSON.stringify(events)).not.toContain("private-");
        } finally {
          spy?.mockRestore();
          socket.close();
        }
      }
    } finally {
      unsubscribe();
      setDiagnosticsEnabledForProcess(false);
    }
  });
});
