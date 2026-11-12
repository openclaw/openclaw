/* @vitest-environment jsdom */
import type { Page } from "playwright";
import { expect } from "vitest";
import { nativeHistoryMessageSourceIdentity } from "../lib/chat/history-message-identity.ts";
import { createMockGatewayControls } from "./control-ui-e2e-controls.ts";
import { createMockHistoryMaterializer, normalizeScenario } from "./control-ui-mock-scenario.ts";
import { connectMockGateway, mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

it("materializes distinct declared sources without rewriting supplied identity or metadata", () => {
  const native = { role: "assistant", __openclaw: { id: "mock-history:1", seq: 42 } };
  const sequenceOnly = { role: "assistant", __openclaw: { seq: 7 } };
  const imported = {
    role: "assistant",
    __openclaw: { importedFrom: "cli", cliSessionId: "session", externalId: "message" },
  };
  const incompleteImport = { role: "assistant", __openclaw: { importedFrom: "cli" } };
  const plain = {
    role: "user",
    content: "same",
    __openclaw: { idempotencyKey: "send", media: [] },
  };
  const supplied = [native, sequenceOnly, imported, incompleteImport, null, "wire marker"];
  const materialize = createMockHistoryMaterializer(supplied);
  const messages = materialize([...supplied, plain, plain]);
  supplied.forEach((message, index) => expect(messages[index]).toBe(message));
  expect(messages.slice(-2)).toEqual([
    { ...plain, __openclaw: { ...plain["__openclaw"], id: "mock-history:2" } },
    { ...plain, __openclaw: { ...plain["__openclaw"], id: "mock-history:3" } },
  ]);
  expect(materialize(messages)).toEqual(messages);
  expect(materialize([plain])).toEqual([
    { ...plain, __openclaw: { ...plain["__openclaw"], id: "mock-history:4" } },
  ]);
  expect(plain["__openclaw"]).not.toHaveProperty("id");
  expect(messages.slice(-2).map(nativeHistoryMessageSourceIdentity)).toEqual([
    "id:mock-history:2",
    "id:mock-history:3",
  ]);
});

it("rereads stable global and per-session sources while preserving explicit wire and live input", async ({
  gatewayPage,
}) => {
  const global = { role: "assistant", content: "Global" };
  const local = { role: "assistant", content: "Local" };
  const key = "agent:main:notes";
  const scenario = normalizeScenario({
    historyMessages: [global],
    sessions: [{ key, sessionId: "notes" }],
    sessionTranscripts: { [key]: { messages: [local] } },
  });
  const { request, frames, gateway } = await connectMockGateway(gatewayPage, scenario);
  for (const method of ["chat.history", "chat.startup"]) {
    expect((await request(`${method}-local`, method, { sessionKey: key })).messages).toEqual(
      scenario.sessionTranscripts[key]!.messages,
    );
    expect(
      (await request(`${method}-global`, method, { sessionKey: "agent:main:main" })).messages,
    ).toEqual(scenario.historyMessages);
  }
  expect(scenario.historyMessages).toEqual([{ ...global, __openclaw: { id: "mock-history:1" } }]);
  expect(scenario.sessionTranscripts[key]!.messages).toEqual([
    { ...local, __openclaw: { id: "mock-history:2" } },
  ]);
  const raw = { messages: [global], hasMore: false };
  gateway.setMethodResponse("chat.history", raw);
  expect(await request("raw", "chat.history", { sessionKey: key })).toEqual(raw);
  gateway.emit("chat", { state: "final", sessionKey: key, message: global });
  expect(frames.at(-1)).toMatchObject({ event: "chat", payload: { message: global } });
  expect(global).not.toHaveProperty("__openclaw");
});

it("materializes Node-side replacements once and mirrors the same sources into static reads", async ({
  gatewayPage,
}) => {
  const message = { role: "assistant", content: "Same text" };
  const stale = { messages: [message], hasMore: false };
  const scenario = normalizeScenario({
    historyMessages: [message],
    sessionTranscripts: { "agent:main:notes": { messages: [message] } },
    methodResponses: { "chat.history": stale, "chat.startup": stale },
  });
  const { request, gateway } = await connectMockGateway(gatewayPage, scenario);
  const page = {
    async evaluate(_callback: unknown, operation: { method: string; args: unknown[] }) {
      return Reflect.apply(Reflect.get(gateway, operation.method), gateway, operation.args);
    },
  } as unknown as Page;
  const controls = createMockGatewayControls(page, scenario, []);
  await controls.setHistoryMessages([message]);
  const first = [{ ...message, __openclaw: { id: "mock-history:3" } }];
  for (const method of ["chat.startup", "chat.history"]) {
    expect(await request(method, method, { sessionKey: scenario.sessionKey })).toEqual({
      messages: first,
      hasMore: false,
    });
  }
  await controls.setHistoryMessages([message]);
  expect(
    (await request("replacement", "chat.history", { sessionKey: scenario.sessionKey })).messages,
  ).toEqual([{ ...message, __openclaw: { id: "mock-history:4" } }]);
});
