/* @vitest-environment jsdom */

import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import * as uuid from "../../lib/uuid.ts";
import { QUICK_ACTIONS_QUESTION } from "../../test-helpers/custodian-quick-actions.ts";
import { suspendingGatewayError as unavailable } from "../../test-helpers/gateway-errors.test-support.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

type Page = Awaited<ReturnType<typeof mountPage>>["page"];
const initialCalls = ["openclaw.chat.history", "openclaw.chat"];
const chatReply = (
  reply = "Ready",
  patch: Partial<SystemAgentChatResult> = {},
): SystemAgentChatResult => ({ sessionId: "custodian-session", reply, action: "none", ...patch });
function historyRequest(
  read: (call: number, options?: { timeoutMs?: number }) => unknown,
  chat: (params?: { message?: string }) => unknown = () => chatReply(),
) {
  let calls = 0;
  const request = vi.fn(
    async (method: string, params?: { message?: string }, options?: { timeoutMs?: number }) =>
      method === "openclaw.chat.history" ? read(++calls, options) : chat(params),
  );
  return { request, historyCalls: () => calls };
}

const history = (text: string) => ({ turns: [{ role: "assistant", text, at: 1 }] });
function reopen(set: ReturnType<typeof createContext>["setGatewaySnapshot"]) {
  set({ suspensionPhase: "draining" });
  set({ suspensionPhase: "accepting" });
}
async function mountTranscript(request: Parameters<typeof createContext>[0]) {
  const harness = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
  return { ...harness, ...(await mountPage(harness.context)) };
}
const expectNoStatus = (page: Page) =>
  expect(page.querySelector(".custodian__transcript-status")).toBeNull();

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "recovers history after welcome (lifecycle=%s)",
  async (lifecycleFailure) => {
    const { request } = historyRequest(
      (call, options) => {
        expect(options).toEqual({ timeoutMs: 15_000 });
        if (call === 1) {
          throw lifecycleFailure ? unavailable() : new Error("history request timed out");
        }
        return history("Recovered history.");
      },
      () =>
        chatReply("Welcome without history.", {
          question: QUICK_ACTIONS_QUESTION,
        }),
    );
    const { page, setGatewaySnapshot } = await mountTranscript(request);
    await waitForFast(() => expect(page.textContent).toContain("Welcome without history."));
    const historyAlert = Array.from(page.querySelectorAll<HTMLElement>('[role="alert"]')).find(
      (alert) => alert.textContent?.includes("history request timed out"),
    );
    if (lifecycleFailure) {
      expect(page.querySelector(".custodian__transcript-status")).toBeNull();
    } else {
      expect(historyAlert).toBeDefined();
      expect(historyAlert?.querySelector("button")).toBeNull();
    }
    reopen(setGatewaySnapshot);
    setGatewaySnapshot({ suspensionPhase: "accepting" });
    await waitForFast(() => expect(page.textContent).toContain("Recovered history."));
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...initialCalls,
      "openclaw.chat.history",
    ]);
  },
);

it("waits for pending history failure before recovery", async () => {
  const pending = deferred<never>();
  const { request, historyCalls } = historyRequest((call) => {
    return call === 2
      ? pending.promise
      : history(call === 1 ? "Earlier history" : "Recovered history");
  });
  const { page, setGatewaySnapshot } = await mountTranscript(request);
  await waitForFast(() => expect(page.textContent).toContain("Ready"));
  const refresh = page.store.refreshTranscriptIfIdle();
  reopen(setGatewaySnapshot);
  reopen(setGatewaySnapshot);
  expect(historyCalls()).toBe(2);
  pending.reject(unavailable("Gateway was suspending"));
  await refresh;
  await waitForFast(() => expect(page.textContent).toContain("Recovered history"));
  expect(page.querySelector(".custodian__transcript-status")).toBeNull();
  expect(historyCalls()).toBe(3);
});

it("releases a retired history read before its transport settles", async () => {
  const pending = deferred<ReturnType<typeof history>>();
  const { request } = historyRequest(
    (call) => (call === 1 ? history("Earlier history") : pending.promise),
    (params) => chatReply(params?.message ? "New turn completed" : "Ready"),
  );
  const { page } = await mountTranscript(request);
  await waitForFast(() => expect(page.textContent).toContain("Ready"));
  const refresh = page.store.refreshTranscriptIfIdle();
  await waitForFast(() => expect(page.store.transcript.refreshing).toBe(true));
  const input = page.querySelector<HTMLTextAreaElement>("textarea")!;
  input.value = "Continue while history is pending";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
  await waitForFast(() => expect(page.textContent).toContain("New turn completed"));
  expect(page.store.transcript.refreshing).toBe(false);
  pending.resolve(history("Retired history"));
  await refresh;
  await page.updateComplete;
  expect(page.textContent).not.toContain("Retired history");
});

it("retries reconnect hydration once per availability edge", async () => {
  const { request, historyCalls } = historyRequest((call) => {
    if (call === 2) {
      throw unavailable();
    }
    return history("Recovered reconnect history");
  });
  const { page, setGatewaySnapshot } = await mountTranscript(request);
  await waitForFast(() => expect(page.textContent).toContain("Ready"));
  setGatewaySnapshot({ phase: "stopped" });
  setGatewaySnapshot({ phase: "connected" });
  await waitForFast(() => {
    expect(page.store.transcript.refreshing).toBe(false);
    expect(page.store.transcript.status.awaitingGateway).toBe(true);
  });
  expect(historyCalls()).toBe(2);
  reopen(setGatewaySnapshot);
  await waitForFast(() => expect(page.store.transcript.status.awaitingGateway).toBe(false));
  expect(historyCalls()).toBe(3);
  expect(page.textContent).toContain("Recovered reconnect history");
});

it("recovers parked history once after an in-flight send settles", async () => {
  const reply = deferred<SystemAgentChatResult>();
  const { request, historyCalls } = historyRequest(
    (call) => {
      if (call === 1) {
        throw unavailable();
      }
      return history("Recovered after send");
    },
    (params) => (params?.message ? reply.promise : chatReply()),
  );
  const { page, setGatewaySnapshot } = await mountTranscript(request);
  await waitForFast(() => expect(page.store.canSend).toBe(true));
  expect(page.store.transcript.status.awaitingGateway).toBe(true);

  const send = page.store.send("Continue");
  reopen(setGatewaySnapshot);
  reopen(setGatewaySnapshot);
  await page.updateComplete;
  expect(page.store.sending).toBe(true);
  expect(historyCalls()).toBe(1);
  expectNoStatus(page);

  reply.resolve(chatReply("Done"));
  await send;
  await waitForFast(() => expect(page.textContent).toContain("Recovered after send"));
  setGatewaySnapshot({ suspensionPhase: "accepting" });
  await page.updateComplete;
  expect(historyCalls()).toBe(2);
  expectNoStatus(page);
});

it("parks history recovery until welcome and wizard settle", async () => {
  const welcome = deferred<SystemAgentChatResult>();
  const answer = deferred<SystemAgentChatResult>();
  let chatCalls = 0;
  const { request, historyCalls } = historyRequest(
    (call) => {
      if (call === 1) {
        throw new Error("history unavailable");
      }
      return history("Recovered after wizard");
    },
    () => (++chatCalls === 1 ? welcome.promise : answer.promise),
  );
  const { page, setGatewaySnapshot } = await mountTranscript(request);
  await waitForFast(() =>
    expect(page.querySelector(".custodian__transcript-status")?.textContent).toContain(
      "history unavailable",
    ),
  );
  expect(page.querySelector(".custodian__transcript-status button")).toBeNull();
  reopen(setGatewaySnapshot);
  await page.updateComplete;
  await waitForFast(() =>
    expect(request.mock.calls.map(([method]) => method)).toEqual(initialCalls),
  );

  welcome.resolve(
    chatReply("Choose one.", {
      wizardInputPending: true,
      step: { id: "choice", type: "text", message: "Continue?" },
    }),
  );
  await waitForFast(() => expect(page.querySelector(".custodian__wizard-step")).not.toBeNull());

  reopen(setGatewaySnapshot);
  await page.updateComplete;
  expect(page.querySelector(".custodian__transcript-status button")).toBeNull();
  expect(request.mock.calls.map(([method]) => method)).toEqual(initialCalls);

  const wizardMessage = page.store.messages.find((message) => message.step);
  expect(wizardMessage).toBeDefined();
  const answering = page.store.answerWizardStep(wizardMessage!, "Continue");
  await page.updateComplete;
  expect(page.store.sending).toBe(true);
  expect(historyCalls()).toBe(1);
  answer.resolve(chatReply("Wizard complete", { wizardInputPending: false }));
  await answering;
  await waitForFast(() => expect(page.textContent).toContain("Recovered after wizard"));
  expect(historyCalls()).toBe(2);
  expectNoStatus(page);
});
