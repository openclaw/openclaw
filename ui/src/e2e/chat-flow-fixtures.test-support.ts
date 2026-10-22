import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect } from "vitest";
import {
  chatMessage as textMessage,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

export { textMessage };

type Suite = ReturnType<typeof createChatFlowE2eSuite>;
type Scenario = Parameters<typeof installMockGateway>[1];
type Fields = Record<string, unknown>;
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;

export async function newChatPage(suite: Suite, options: BrowserContextOptions = {}) {
  const context = await suite.newBrowserContext({
    ...createControlUiE2eContextOptions(),
    ...options,
  });
  return { context, page: await context.newPage() };
}

export async function chatFixture(
  suite: Suite,
  scenario?: Scenario,
  options?: BrowserContextOptions,
) {
  const fixture = await newChatPage(suite, options);
  return { ...fixture, gateway: await installMockGateway(fixture.page, scenario) };
}

export const composer = (page: Page) => page.locator(".agent-chat__composer-combobox textarea");
export const transcript = (page: Page) => page.locator(".chat-thread-inner");

export const expectCount = (locator: Locator, count: number, options?: { timeout: number }) =>
  expect.poll(() => locator.count(), options).toBe(count);
export const expectText = (locator: Locator, text: string, options?: { timeout: number }) =>
  expect.poll(() => locator.textContent(), options).toBe(text);
export const expectTextContains = (locator: Locator, text: string) =>
  expect.poll(() => locator.textContent()).toContain(text);

export async function sendMessage(page: Page, text: string, button = "Send message") {
  await composer(page).fill(text);
  await page.getByRole("button", { name: button }).click();
}

export async function sendChat(
  page: Page,
  gateway: Gateway,
  text: string,
  button = "Send message",
) {
  await sendMessage(page, text, button);
  return requireRecord((await gateway.waitForRequest("chat.send")).params);
}

export const timedText = (role: string, text: string, fields: Fields = {}) =>
  textMessage(role, text, { timestamp: Date.now(), ...fields });

export const persistedText = (role: string, text: string, metadata: Fields) =>
  timedText(role, text, { __openclaw: metadata });

export const sessionMessage = (
  message: unknown,
  messageId: string,
  messageSeq: number,
  session: ReturnType<typeof sessionState>,
  fields: Fields = {},
) => ({
  activeRunIds: session.activeRunIds,
  hasActiveRun: session.hasActiveRun,
  message,
  messageId,
  messageSeq,
  session,
  sessionKey: session.key,
  ...fields,
});

export const chatEvent = (
  runId: string,
  sessionKey: string,
  state: string,
  fields: Fields = {},
) => ({ runId, sessionKey, state, ...fields });

export const chatDelta = (runId: string, text: string, sessionKey: string, fields: Fields = {}) =>
  chatEvent(runId, sessionKey, "delta", {
    deltaText: text,
    message: timedText("assistant", text),
    ...fields,
  });

export const agentEvent = (
  runId: string,
  sessionKey: string,
  stream: string,
  data: Fields,
  seq: number,
  ts: number,
) => ({ runId, sessionKey, stream, data, seq, ts });

export const sessionState = (activeRunIds: string[], hasActiveRun: boolean, status: string) => ({
  activeRunIds,
  hasActiveRun,
  key: "agent:main:main",
  kind: "direct",
  status,
  updatedAt: Date.now(),
});

export const configResponse = (runtimeConfig: Fields, hash: string) => ({
  config: runtimeConfig,
  hash,
  issues: [],
  raw: JSON.stringify(runtimeConfig),
  runtimeConfig,
  valid: true,
});

export const sessionRow = (key: string, label: string, updatedAt: number, fields: Fields = {}) => ({
  key,
  kind: "direct",
  label,
  updatedAt,
  ...fields,
});
