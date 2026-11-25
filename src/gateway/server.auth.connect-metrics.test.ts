import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { tryBeginGatewaySuspendAdmission } from "../process/gateway-work-admission.js";
import {
  connectReq,
  BROWSER_ORIGIN as origin,
  configureBrowserAuth,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import * as wsLog from "./ws-log.js";

installGatewayTestHooks({ scope: "suite" });

test("measures connect delivery and closed admission without payloads", async () => {
  await configureBrowserAuth();
  await withGatewayServer(async ({ port }) => {
    const connect = (socket: WebSocket) =>
      connectReq(socket, {
        skipDefaultAuth: true,
        prePairDevice: true,
        client: { ...CONTROL_UI_CLIENT, instanceId: "private-instance" },
        scopes: ["operator.read"],
        browserOrigin: origin,
      });
    const events: Extract<DiagnosticEventPayload, { type: "gateway.rpc" }>[] = [];
    let responseLog: Record<string, unknown> | undefined;
    const originalLogWs = wsLog.logWs;
    const logSpy = vi.spyOn(wsLog, "logWs").mockImplementation((direction, kind, metaInput) => {
      const meta = typeof metaInput === "function" ? metaInput() : metaInput;
      if (direction === "out" && kind === "res" && meta?.method === "connect") {
        responseLog = meta;
      }
      originalLogWs(direction, kind, meta);
    });
    setDiagnosticsEnabledForProcess(true);
    const unsubscribe = onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "gateway.rpc" && event.method === "connect") {
          events.push(event);
        }
      },
      { include: ["gateway.rpc"] },
    );
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      logSpy.mockRestore();
      unsubscribe();
      setDiagnosticsEnabledForProcess(false);
    });
    const ms = expect.any(Number);
    for (const { outcome, rejected } of [
      { outcome: "ok", rejected: false },
      { outcome: "error", rejected: true },
      { outcome: "unavailable", rejected: false },
      { outcome: "unavailable", rejected: true },
    ] as const) {
      events.length = 0;
      responseLog = undefined;
      const socket = await openWs(port, {
        origin,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        ...(rejected ? {} : { "x-forwarded-user": "private-user@example.com" }),
      });
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below preserves the intercepted socket receiver.
      const originalSend = WebSocket.prototype.send;
      const pendingWrite = createDeferred<() => void>();
      const spy =
        outcome === "unavailable"
          ? vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
              this: WebSocket,
              ...args: Parameters<WebSocket["send"]>
            ) {
              if (
                typeof args[0] === "string" &&
                (rejected
                  ? args[0].includes('"type":"res"') && args[0].includes('"ok":false')
                  : args[0].includes('"hello-ok"'))
              ) {
                const callback = args.findLast((arg) => typeof arg === "function");
                pendingWrite.resolve(() => {
                  if (typeof callback === "function") {
                    callback(new Error("synthetic delivery failure"));
                  }
                });
                return;
              }
              Reflect.apply(originalSend, this, args);
            })
          : undefined;
      let releaseWrite: (() => void) | undefined;
      try {
        const closed = outcome === "unavailable" ? once(socket, "close") : undefined;
        const response = connect(socket);
        if (closed) {
          void response.catch(() => {});
          releaseWrite = await pendingWrite.promise;
          await waitForDiagnosticEventsDrained();
          expect(events.filter((event) => event.phase === "response")).toEqual([]);
          releaseWrite();
          releaseWrite = undefined;
          await closed;
        } else {
          const result = await response;
          expect(result.ok, JSON.stringify(result.error)).toBe(outcome === "ok");
        }
        await waitForDiagnosticEventsDrained();
        expect(events).toMatchObject([
          { phase: "received" },
          {
            phase: "response",
            outcome,
            durationMs: ms,
            ...(outcome === "ok" ? { responseBytes: ms, firstResponse: true } : {}),
          },
          { phase: "handler", outcome: "returned", durationMs: ms, admissionMs: ms },
          {
            phase: "dispatch",
            outcome: "returned",
            response: outcome === "unavailable" ? "unavailable" : "sent",
          },
        ]);
        expect(JSON.stringify(events)).not.toContain("private-");
        if (outcome !== "unavailable") {
          expect(responseLog).toBeDefined();
          if (rejected) {
            expect(responseLog).toMatchObject({
              failurePhase: "auth",
              failureCause: "unauthorized",
            });
            expect(responseLog).not.toHaveProperty("identityMs");
            expect(responseLog).not.toHaveProperty("deviceAuthorizationMs");
          } else {
            expect(responseLog).toMatchObject({
              authMs: ms,
              attachMs: ms,
              deviceAuthorizationMs: ms,
              deviceLookupMs: ms,
              deviceTokensMs: ms,
              nodePreparationMs: ms,
              identityMs: ms,
              profileEnsureMs: ms,
              profileAuthorityMs: ms,
              scopeGrantMs: ms,
              operatorDeviceMs: ms,
              sessionRegistrationMs: ms,
            });
          }
        }
      } finally {
        releaseWrite?.();
        spy?.mockRestore();
        socket.close();
      }
    }
    events.length = 0;
    const socket = await openWs(port, { origin });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    try {
      const result = await connect(socket);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", retryable: true },
      });
      await waitForDiagnosticEventsDrained();
      expect(events).toMatchObject([
        { phase: "received" },
        { phase: "response", outcome: "error", firstResponse: true, responseBytes: ms },
        { phase: "dispatch", outcome: "rejected", response: "sent" },
      ]);
    } finally {
      suspension?.rollback();
      socket.close();
    }
  });
});
