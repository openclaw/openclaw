/* @vitest-environment jsdom */

import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";

type Page = Awaited<ReturnType<typeof mountPage>>["page"];

type Reply = SystemAgentChatResult;
function chatReply(reply: string, patch: Partial<Reply> = {}): Reply {
  return { sessionId: "custodian-session", reply, action: "none", ...patch };
}

async function element<T extends HTMLElement>(page: HTMLElement, selector: string): Promise<T> {
  return waitForFast(() => {
    const found = page.querySelector<T>(selector);
    expect(found, `Missing element: ${selector}`).not.toBeNull();
    return found!;
  });
}

async function fill(page: Page, selector: string, value: string) {
  const field = await element<HTMLInputElement | HTMLTextAreaElement>(page, selector);
  field.value = value;
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await page.updateComplete;
  return field;
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("custodian page owner receipts", () => {
  it("keeps loaded transcript rows while retrying the welcome without reloading history", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        turns: [{ role: "assistant", text: "Loaded transcript row", at: 1 }],
      })
      .mockRejectedValueOnce(new Error("temporary welcome failure"))
      .mockResolvedValueOnce(
        chatReply("Recovered welcome.", { sessionId: "engine-session-after-retry" }),
      );
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector('[role="alert"] button')).not.toBeNull());
    const retainedRow = await element(page, '[data-chat-row-key="msg-1"]');

    page.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await waitForFast(() => expect(page.textContent).toContain("Recovered welcome."));

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
      "openclaw.chat",
    ]);
    expect(page.textContent).toContain("Loaded transcript row");
    expect(page.querySelector('[data-chat-row-key="msg-1"]')).toBe(retainedRow);
  });

  it("keeps the composer draft while the initial greeting is pending", async () => {
    const greeting = createDeferred<Reply>();
    const request = vi.fn(() => greeting.promise);
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    const input = await fill(page, "textarea", "Keep this draft");
    expect(request).toHaveBeenCalledOnce();
    expect(input.disabled).toBe(false);
    expect(page.querySelector(".chat-send-btn")?.hasAttribute("disabled")).toBe(true);

    greeting.resolve(chatReply("I am **ready** to help."));
    await waitForFast(() =>
      expect(page.querySelector(".chat-text strong")?.textContent).toBe("ready"),
    );

    expect(page.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("Keep this draft");
    expect(page.querySelector(".chat-send-btn")?.hasAttribute("disabled")).toBe(false);
  });

  it("enhances a Markdown table added after the initial greeting", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(chatReply("Ready to help."))
      .mockResolvedValueOnce(chatReply("| Channel | Status |\n| --- | --- |\n| Discord | Ready |"));
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Ready to help."));
    await fill(page, "textarea", "Show channel status");
    page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    await waitForFast(() => {
      expect(page.querySelector(".markdown-table__expand")?.textContent).toBe("Expand table");
      expect(page.querySelector(".markdown-table__copy svg")).not.toBeNull();
    });
  });

  it("refreshes a connected session on mount and follows a replacement store", async () => {
    let historyCalls = 0;
    const request = vi.fn(async (method: string) =>
      method === "openclaw.chat.history"
        ? {
            turns: [{ role: "assistant", text: `History receipt ${++historyCalls}`, at: 1 }],
          }
        : { sessionId: "custodian-session", reply: "Ready.", action: "none" },
    );
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    const first = new CustodianSessionStore();
    first.connect(context, "caretaker");
    await waitForFast(() => expect(first.canSend).toBe(true));

    const provider = createApplicationContextProvider(context);
    const page = document.createElement("openclaw-custodian-page") as Page;
    page.store = first;
    page.onboarding = false;
    provider.append(page);
    document.body.append(provider);
    await waitForFast(() => expect(page.textContent).toContain("History receipt 2"));

    const replacement = new CustodianSessionStore();
    replacement.connect(context, "caretaker");
    await waitForFast(() => expect(replacement.canSend).toBe(true));
    page.store = replacement;
    await waitForFast(() => expect(page.textContent).toContain("History receipt 4"));
    expect(page.textContent).not.toContain("History receipt 2");

    first.setInput("Retired owner draft");
    replacement.setInput("Current owner draft");
    await page.updateComplete;
    expect(page.querySelector("textarea")?.value).toBe("Current owner draft");
    page.store = replacement;
    await page.updateComplete;
    expect(historyCalls).toBe(4);
  });

  it("admits onboarding inventory from current owners and retires subscriptions on disposal", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "custodian-session",
      reply: "Ready.",
      action: "none",
    });
    const harness = createContext(request);
    const { context } = harness;
    const { page } = await mountPage(context, { onboarding: false });
    expect(context.acquireChannels(createChannelCapability).refresh).not.toHaveBeenCalled();

    page.onboarding = true;
    await page.updateComplete;
    expect(context.acquireChannels(createChannelCapability).refresh).toHaveBeenCalledOnce();
    harness.setChannelsError("Status unavailable");
    page.store.setInput("Keep this draft");
    page.onboarding = false;
    page.onboarding = true;
    await page.updateComplete;
    expect(context.acquireChannels(createChannelCapability).refresh).toHaveBeenCalledOnce();
    await waitForFast(() =>
      expect(page.querySelector<HTMLButtonElement>(".custodian__nudge-cta")?.disabled).toBe(false),
    );
    page.querySelector<HTMLButtonElement>(".custodian__nudge-cta")!.click();
    expect(context.acquireChannels(createChannelCapability).refresh).toHaveBeenCalledTimes(2);

    page.store.dismissChannelOnboardingNudge();
    harness.setChannelsError(null);
    expect(context.acquireChannels(createChannelCapability).refresh).toHaveBeenCalledTimes(2);
    const replacement = new CustodianSessionStore();
    page.store = replacement;
    await page.updateComplete;
    expect(context.acquireChannels(createChannelCapability).refresh).toHaveBeenCalledTimes(3);

    page.remove();
    await page.updateComplete;
    harness.setChannelsError(null);
    replacement.setInput("Detached owner draft");
    page.onboarding = false;
    page.onboarding = true;
    await page.updateComplete;
    expect(context.acquireChannels(createChannelCapability).refresh).toHaveBeenCalledTimes(3);
  });
});
