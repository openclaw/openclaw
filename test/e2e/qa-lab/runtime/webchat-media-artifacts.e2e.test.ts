import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { GatewayClient } from "../../../../src/gateway/client.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import { useChannelProductProof } from "./channel-product-proof.test-support.js";

const SESSION_KEY = "agent:qa:main";
const userEventIdentitySchema = z.object({ messageId: z.string().min(1) });
const proof = useChannelProductProof();

it("WebChat keeps one user identity across media reply events", { timeout: 180_000 }, async () => {
  const { gateway, transport } = await proof.start({
    controlUiAllowedOrigins: ["http://127.0.0.1"],
  });
  await transport.waitReady({ gateway });
  await fs.writeFile(path.join(gateway.workspaceDir, "artifact.json"), '{"status":"ready"}\n');
  const events: Array<{ event: string; payload?: unknown }> = [];
  const client = await new Promise<GatewayClient>((resolve, reject) => {
    const connecting = new GatewayClient({
      url: gateway.wsUrl,
      origin: new URL(gateway.wsUrl.replace(/^ws/u, "http")).origin,
      token: gateway.token,
      clientName: GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      platform: "qa",
      onEvent: (event) => events.push(event),
      onHelloOk: () => resolve(connecting),
      onConnectError: reject,
      onClose: (code, reason) => reject(new Error(`Gateway closed ${code}: ${reason}`)),
    });
    connecting.start();
  });
  proof.cleanup(() => client.stop());
  await client.request("sessions.subscribe", {});
  const runId = randomUUID();
  const started = await client.request<{ runId?: string }>("chat.send", {
    sessionKey: SESSION_KEY,
    message: "Reply exactly `Artifacts ready\nMEDIA:./artifact.json`",
    deliver: false,
    idempotencyKey: runId,
  });
  await client.request(
    "agent.wait",
    { runId: started.runId ?? runId, timeoutMs: 120_000 },
    { timeoutMs: 125_000 },
  );
  const history = await client.request<{
    messages?: Array<{ role?: string; content?: unknown }>;
  }>("chat.history", { sessionKey: SESSION_KEY, limit: 20 });
  const content = history.messages?.findLast((message) => message.role === "assistant")?.content;
  expect(content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "attachment",
        attachment: expect.objectContaining({
          label: "artifact.json",
          mimeType: "application/json",
        }),
      }),
    ]),
  );
  const sessionEvents = events.filter(
    ({ event, payload }) =>
      (event === "chat" || event === "session.message") &&
      (payload as { sessionKey?: unknown } | undefined)?.sessionKey === SESSION_KEY,
  );
  const userEvents = sessionEvents.filter(
    (event) =>
      (event.payload as { message?: { role?: string } } | undefined)?.message?.role === "user",
  );
  const userMessageIds = userEvents.map(
    (event) => userEventIdentitySchema.parse(event.payload).messageId,
  );
  expect(userMessageIds.length).toBeGreaterThan(0);
  expect(new Set(userMessageIds).size, JSON.stringify(userMessageIds)).toBe(1);
  expect(history.messages?.filter((message) => message.role === "user")).toHaveLength(1);
  expect(JSON.stringify(userEvents)).toContain("MEDIA:./artifact.json");
  const displayEvents = sessionEvents.filter((event) => !userEvents.includes(event));
  expect(displayEvents).toContainEqual(
    expect.objectContaining({
      event: "session.message",
      payload: expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
    }),
  );
  expect(JSON.stringify({ content, displayEvents })).not.toContain("MEDIA:./");
});
