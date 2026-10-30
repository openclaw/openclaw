// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { validateChatSendParams } from "../../../../packages/gateway-protocol/src/validators/conversations.js";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import { resolveControlUiReconnectResumeParams } from "../../../../src/gateway/server-methods/chat-server-timing.js";
import { startConnect, useHandshakeHarness } from "../../api/gateway-handshake.test-support.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { requestChatSend } from "./chat-send-request.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

const createClient = useHandshakeHarness();
useChatSendBrowserFixture();

it.each([
  "openclaw-control-ui",
  "openclaw-macos",
  "openclaw-linux",
  "openclaw-ios",
  "openclaw-android",
] as const)("preserves the accepted reconnect envelope for %s", async (id) => {
  const browser = id === "openclaw-control-ui";
  // Native challenge auth replaces these browser defaults in the real connect plan.
  const client = createClient(
    browser
      ? {}
      : {
          nativeConnectAuth: async ({ nonce, signedAt }) => ({
            client: { id, mode: "ui", version: "test", platform: "test" },
            scopes: ["operator.admin", "operator.read", "operator.write"],
            auth: { deviceToken: "native-test-token" },
            device: {
              id: "native-test-device",
              publicKey: "test",
              signature: "test",
              nonce,
              signedAt,
            },
          }),
        },
  );
  const { ws, connectFrame } = await startConnect(client);
  expect(connectFrame.params.client.id).toBe(id);
  ws.emitMessage({
    type: "res",
    id: connectFrame.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: PROTOCOL_VERSION,
      auth: { role: "operator", scopes: ["operator.admin"], recoveryScope: "test-recovery" },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  const host = makeChatHost({
    client,
    currentSessionId: "reconnected-session",
    reconnectResumeSessionId: "reconnected-session",
  });
  const sending = requestChatSend(host, {
    message: "Fresh input after reconnect",
    runId: "reconnect-send",
    isFreshSubmission: true,
  });
  const frame = JSON.parse(ws.sent.at(-1)!) as RequestFrame;
  expect(frame.method).toBe("chat.send");
  const normalized = resolveControlUiReconnectResumeParams(
    frame.params,
    connectFrame.params.client,
  );
  ws.emitMessage({ type: "res", id: frame.id, ok: true, payload: { status: "started" } });
  await sending;

  expect(validateChatSendParams(normalized.params)).toBe(true);
  expect(frame.params).toHaveProperty("__controlUiReconnectResume", browser ? "fresh" : true);
  expect(normalized.resumeRequested).toBe(true);
  expect(normalized.freshInput).toBe(browser ? true : undefined);
  expect(normalized.params).not.toHaveProperty("__controlUiReconnectResume");
  expect(host.reconnectResumeSessionId).toBeNull();
});
