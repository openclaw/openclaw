import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "../../../../src/gateway/server-constants.js";
import {
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
} from "../../../../src/gateway/test-helpers.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../../../src/infra/diagnostic-events.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

installGatewayTestHooks({ scope: "suite" });

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function withConnection(check: (ws: WebSocket) => Promise<void>, cleanup = () => {}) {
  const harness = await createGatewaySuiteHarness({ serverOptions: { auth: { mode: "none" } } });
  await runQaGatewayFixture(
    async () => check(await harness.openWs()),
    cleanup,
    () => harness.close(),
  );
}

afterEach(resetDiagnosticEventsForTest);

describe("Gateway event and protocol authorization", () => {
  it.each([
    ["malformed request frame", JSON.stringify({ unexpected: true }), "invalid request frame"],
    [
      "non-connect first request",
      JSON.stringify({ type: "req", id: "health-before-connect", method: "health" }),
      "first request must be connect",
    ],
  ])("closes a %s with policy code 1008", async (_name, frame, expectedReason) => {
    await withConnection(async (ws) => {
      const closed = waitForClose(ws);
      const response = frame.includes("health-before-connect")
        ? onceMessage(ws, (message) => message.id === "health-before-connect")
        : undefined;

      ws.send(frame);

      if (response) {
        await expect(response).resolves.toMatchObject({
          type: "res",
          id: "health-before-connect",
          ok: false,
        });
      }
      await expect(closed).resolves.toMatchObject({
        code: 1008,
        reason: expect.stringContaining(expectedReason),
      });
    });
  });

  it("closes oversized pre-auth frames with 1009 and emits only redacted diagnostics", async () => {
    resetDiagnosticEventsForTest();
    const events: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onDiagnosticEvent((event) => events.push(event));
    const secretMarker = "sensitive-preauth-marker";
    await withConnection(async (ws) => {
      const closed = waitForClose(ws);
      ws.send(
        JSON.stringify({
          type: "req",
          id: "oversized-connect",
          method: "connect",
          params: {
            pathEnv: `${secretMarker}${"x".repeat(MAX_PREAUTH_PAYLOAD_BYTES + 1024)}`,
          },
        }),
      );

      await expect(closed).resolves.toMatchObject({ code: 1009 });
      const event = events.find((candidate) => candidate.type === "payload.large");
      expect(event).toMatchObject({
        type: "payload.large",
        action: "rejected",
        surface: "gateway.ws.preauth",
        limitBytes: MAX_PREAUTH_PAYLOAD_BYTES,
        reason: "preauth_frame_limit",
      });
      expect(JSON.stringify(event)).not.toContain(secretMarker);
      expect(event).not.toHaveProperty("payload");
    }, stopDiagnostics);
  });
});
