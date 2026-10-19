import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

type Suite = ReturnType<typeof createChatFlowE2eSuite>;
type Scenario = Parameters<typeof installMockGateway>[1];

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
  const { context, page } = await newChatPage(suite, options);
  const gateway = await installMockGateway(page, scenario);
  return { context, page, gateway };
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
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  text: string,
  button = "Send message",
) {
  await sendMessage(page, text, button);
  return requireRecord((await gateway.waitForRequest("chat.send")).params);
}

export function textMessage(role: string, text: string, fields: Record<string, unknown> = {}) {
  return { role, content: [{ type: "text", text }], ...fields };
}

export function timedText(role: string, text: string, fields: Record<string, unknown> = {}) {
  return textMessage(role, text, { timestamp: Date.now(), ...fields });
}

export function persistedText(role: string, text: string, metadata: Record<string, unknown>) {
  return timedText(role, text, { __openclaw: metadata });
}

export function sessionMessage(
  message: unknown,
  messageId: string,
  messageSeq: number,
  session: ReturnType<typeof sessionState>,
  fields: Record<string, unknown> = {},
) {
  return {
    activeRunIds: session.activeRunIds,
    hasActiveRun: session.hasActiveRun,
    message,
    messageId,
    messageSeq,
    session,
    sessionKey: session.key,
    ...fields,
  };
}

export function chatEvent(
  runId: string,
  sessionKey: string,
  state: string,
  fields: Record<string, unknown> = {},
) {
  return { runId, sessionKey, state, ...fields };
}

export function chatDelta(
  runId: string,
  text: string,
  sessionKey: string,
  fields: Record<string, unknown> = {},
) {
  return chatEvent(runId, sessionKey, "delta", {
    deltaText: text,
    message: textMessage("assistant", text, { timestamp: Date.now() }),
    ...fields,
  });
}

export function agentEvent(
  runId: string,
  sessionKey: string,
  stream: string,
  data: Record<string, unknown>,
  seq: number,
  ts: number,
) {
  return { runId, sessionKey, stream, data, seq, ts };
}

export function sessionState(activeRunIds: string[], hasActiveRun: boolean, status: string) {
  return {
    activeRunIds,
    hasActiveRun,
    key: "agent:main:main",
    kind: "direct",
    status,
    updatedAt: Date.now(),
  };
}

export function configResponse(runtimeConfig: Record<string, unknown>, hash: string) {
  return {
    config: runtimeConfig,
    hash,
    issues: [],
    raw: JSON.stringify(runtimeConfig),
    runtimeConfig,
    valid: true,
  };
}

export function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  fields: Record<string, unknown> = {},
) {
  return { key, kind: "direct", label, updatedAt, ...fields };
}
