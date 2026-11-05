/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-startup.test/"} */

import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { requestChatSend } from "./chat-send-request.ts";
import { startupAdmissionResponse } from "./chat-startup-response.test-support.ts";

afterEach(() => vi.useRealTimers());

async function submitWhilePreparing() {
  let ready = false;
  const attempts: string[] = [];
  const writes: RequestFrame[] = [];
  const issued = Promise.withResolvers<void>();
  const pending = new GatewayPendingRequests({ createRequestId: () => "startup", nowMs: Date.now });
  onTestFinished(() => pending.flush(new Error("test request owner disposed")));
  const wire = {
    send(raw: string) {
      // SAFETY: GatewayPendingRequests serializes the request frame supplied to this wire.
      const request = JSON.parse(raw) as RequestFrame;
      attempts.push(raw);
      if (ready) {
        writes.push(request);
      }
      pending.handleResponse(startupAdmissionResponse(request, ready));
      issued.resolve();
    },
  };
  const client = createGatewayBrowserClientFixture({
    request: (method, params, options) =>
      method === "chat.send"
        ? pending.request(wire, method, params, options)
        : { messages: [], sessions: [] },
  });
  const { pane, state } = createTestChatPane({ client });
  pane.chatState.attach(state);
  vi.useFakeTimers();
  const sending = requestChatSend(state, {
    message: "Keep this submitted message",
    runId: "submitted-run",
  });
  void sending.catch(() => {});
  await issued.promise;
  return { pane, state, pending, attempts, writes, sending, ready: () => (ready = true) };
}

it("delivers a submitted send once after its retained pane is parked", async () => {
  const fixture = await submitWhilePreparing();
  fixture.pane.presented = false;
  await vi.advanceTimersByTimeAsync(45_000);
  expect(fixture.pending.hasPending).toBe(true);
  expect(fixture.writes).toHaveLength(0);

  fixture.ready();
  await vi.advanceTimersByTimeAsync(8_000);
  await fixture.sending;
  expect(fixture.writes).toHaveLength(1);
  expect(new Set(fixture.attempts).size).toBe(1);
  await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.pending.hasPending).toBe(false);
});

it("retires a submitted startup send when its pane is disposed", async () => {
  const fixture = await submitWhilePreparing();
  const stopped = expect(fixture.sending).rejects.toThrow("aborted");
  fixture.pane.disconnectedCallback();
  await stopped;
  fixture.ready();
  await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
  expect(fixture.pending.hasPending).toBe(false);
  expect(fixture.writes).toHaveLength(0);
});
