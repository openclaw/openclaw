/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";

type Page = Awaited<ReturnType<typeof mountPage>>["page"];

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("custodian page owner receipts", () => {
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
