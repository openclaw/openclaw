/* @vitest-environment jsdom */
import { expect, type TestAPI } from "vitest";
import type { MockGatewayWindow } from "./control-ui-e2e-contract.ts";
import {
  createControlUiMockGatewayInitScript,
  type ControlUiMockGatewayScenario,
} from "./control-ui-e2e.ts";
import { flushMockTimers, mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

type GatewayPage = typeof it extends TestAPI<{ gatewayPage: infer Page }> ? Page : never;
const sessionKey = "agent:main:main";
const input = (id: string) => ({ sessionKey, message: id, idempotencyKey: id });
async function connect(page: GatewayPage, scenario: ControlUiMockGatewayScenario = {}) {
  page.execute(createControlUiMockGatewayInitScript(scenario));
  const socket = page.connect();
  await flushMockTimers();
  const gateway = (page.window as MockGatewayWindow).openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Mock Gateway was not installed");
  }
  const readHistory = (id: string, inputRunIds?: string[], key = sessionKey) =>
    socket.request(id, "chat.history", { sessionKey: key, inputRunIds });
  return { ...socket, gateway, readHistory };
}

it.for([false, true])(
  "commits input before execution (%s)",
  async (attachment, { gatewayPage }) => {
    const { request, frames, readHistory } = await connect(gatewayPage, {
      historyMessages: [
        { role: "assistant", content: "Ready", __openclaw: { id: "ready", seq: 4 } },
      ],
    });
    const file = { type: "file", fileName: "a.txt", mimeType: "text/plain", content: "aA==" };
    const media = {
      fileName: "a.txt",
      contentType: "text/plain",
      url: "data:text/plain;base64,aA==",
    };
    const params = {
      ...input("source-run"),
      ...(attachment ? { attachments: [file] } : {}),
    };
    const ack = await request("send", "chat.send", params);
    const history = await readHistory("history", ["source-run", "unknown"]);
    expect(history.messages).toEqual([
      expect.objectContaining({ role: "assistant", content: "Ready" }),
      expect.objectContaining({
        role: "user",
        content: params.message,
        idempotencyKey: "source-run:user",
        __openclaw: expect.objectContaining({
          id: "mock-user:source-run",
          seq: 5,
          ...(attachment ? { media: [expect.objectContaining(media)] } : {}),
        }),
      }),
    ]);
    expect(history.inputReceipts).toEqual([
      { runId: "source-run", state: "consumed", consumedByEventId: "mock-user:source-run" },
    ]);
    expect(ack.status).toBe("started");
    if (attachment) {
      expect(ack).not.toHaveProperty("messageSeq");
      const event = frames.findIndex(
        (frame) => frame.type === "event" && frame.event === "session.message",
      );
      expect(event).toBeGreaterThan(frames.findIndex((frame) => frame.id === "send"));
    } else {
      expect(ack.messageSeq).toBe(5);
    }
    await request("retry", "chat.send", params);
    expect((await readHistory("again")).messages).toEqual(history.messages);
    const other = await readHistory("other", ["source-run"], "agent:main:other");
    expect(other.inputReceipts).toEqual([]);
    expect(other.messages).toHaveLength(1);
  },
);

it("does not consume held, resolved or raw terminal input", async ({ gatewayPage }) => {
  const { gateway, send, readHistory } = await connect(gatewayPage, {
    deferredMethods: ["chat.send"],
  });
  send("held", "chat.send", input("held-run"));
  const empty = { messages: [], inputReceipts: [] };
  expect(await readHistory("before", ["held-run"])).toMatchObject(empty);
  gateway.resolveDeferred("chat.send", { runId: "held-run", status: "started" });
  gateway.emit("chat", { sessionKey, runId: "held-run", state: "final" });
  expect(await readHistory("after", ["held-run"])).toMatchObject(empty);
});

it("separates display snapshots from durable receipts", async ({ gatewayPage }) => {
  const { gateway, request, readHistory } = await connect(gatewayPage);
  await request("send", "chat.send", input("committed-run"));
  const messages = [{ role: "assistant", content: "Old snapshot" }];
  gateway.setHistoryMessages(messages);
  expect(await readHistory("history", ["committed-run"])).toMatchObject({
    messages,
    inputReceipts: [
      { runId: "committed-run", state: "consumed", consumedByEventId: "mock-user:committed-run" },
    ],
  });
  const next = await request("next", "chat.send", input("next-run"));
  expect(next.messageSeq).toBe(2);
});
