import { afterEach, expect, it } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ModelAccountUsageElement } from "./account-usage.tsx";
import "./account-usage.tsx";

registerSettingsEnglish();

let element: ModelAccountUsageElement | undefined;
afterEach(async () => {
  element?.remove();
  await Promise.resolve();
  element = undefined;
});
const snapshot = {
  updatedAt: 1,
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      plan: "Pro",
      windows: [{ label: "5h", usedPercent: 25 }],
      billing: [{ type: "balance", amount: 12, unit: "credits" }],
    },
  ],
};

async function mount(request: ReturnType<typeof createGatewayRequestMock>) {
  element = document.createElement("openclaw-model-account-usage");
  element.client = createTestGatewayClient(request);
  element.agentId = "main";
  element.profileId = "openai:account";
  mountSolid(() => element);
  await element.updateComplete;
  return element;
}

it("loads automatically, renders remaining quota and balance, and refreshes that account", async () => {
  const request = createGatewayRequestMock(async () => snapshot);
  const view = await mount(request);
  await waitForSolid(() => expect(view.textContent).toContain("12 credits"));
  expect(view.textContent).toContain("Pro");
  expect(view.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("75");
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "codex.accountUsage",
    {
      agentId: "main",
      profileId: "openai:account",
    },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  // Reordering keyed account rows moves the existing custom element.
  view.parentElement!.append(view);
  await view.updateComplete;
  expect(view.textContent).toContain("12 credits");
  view.querySelector<HTMLButtonElement>("button")!.click();
  await waitForSolid(() => expect(request.mock.calls.length).toBe(2));
  expect(request.mock.lastCall?.[1]).toEqual({
    agentId: "main",
    profileId: "openai:account",
  });
  await waitForSolid(() => expect(view.textContent).toContain("12 credits"));
  view.refreshUsage();
  await waitForSolid(() => expect(request.mock.calls.length).toBe(3));
});

it("drops a pending response when the selected agent changes and shows the current error", async () => {
  const stale = createDeferredCore();
  const request = createGatewayRequestMock(async (_method, params) => {
    if ((params as { agentId: string }).agentId === "main") {
      await stale.promise;
      return snapshot;
    }
    throw new Error("Account usage unavailable");
  });
  const view = await mount(request);
  await waitForSolid(() => expect(request.mock.calls.length).toBe(1));
  expect(view.textContent).toContain("Loading");
  expect(view.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  view.agentId = "other";
  await waitForSolid(() => expect(view.textContent).toContain("Account usage unavailable"));
  stale.resolve();
  await stale.promise;
  flush();
  await view.updateComplete;
  expect(view.textContent).toContain("Account usage unavailable");
  expect(view.textContent).not.toContain("12 credits");
  expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  view.client = null;
  await view.updateComplete;
  expect(view.textContent?.trim()).toBe("");
});

it("retries failed reads through the refresh button and native refresh method", async () => {
  let attempt = 0;
  const retry = createDeferredCore();
  const request = createGatewayRequestMock(async () => {
    if (++attempt < 3) {
      if (attempt === 2) {
        await retry.promise;
      }
      throw new Error(`Usage attempt ${attempt} failed`);
    }
    return snapshot;
  });
  const view = await mount(request);
  await waitForSolid(() => expect(view.textContent).toContain("Usage attempt 1 failed"));
  const button = view.querySelector<HTMLButtonElement>("button")!;
  button.focus();
  button.click();
  expect(request).toHaveBeenCalledTimes(2);
  await waitForSolid(() => expect(view.textContent).toContain("Loading"));
  expect(view.querySelector("button")).toBe(button);
  expect(button.disabled).toBe(true);
  retry.resolve();
  await waitForSolid(() => expect(view.textContent).toContain("Usage attempt 2 failed"));
  expect(view.querySelector("button")).toBe(button);
  expect(document.activeElement).toBe(button);
  view.refreshUsage();
  await waitForSolid(() => expect(view.textContent).toContain("12 credits"));
  expect(request).toHaveBeenCalledTimes(3);
  expect(view.querySelector(".provider-usage-error")).toBeNull();
  expect(view.querySelector("button")).toBe(button);
});

it("handles synchronously failed receipts replaced before Solid observes them", async () => {
  const request = createGatewayRequestMock(async () => snapshot);
  const view = await mount(request);
  await waitForSolid(() => expect(view.textContent).toContain("12 credits"));
  let attempt = 0;
  const client = createTestGatewayClient(request);
  client.request = () => {
    throw new Error(`Synchronous usage failure ${++attempt}`);
  };
  view.client = client;
  view.refreshUsage();
  view.refreshUsage();
  await waitForSolid(() => expect(view.textContent).toContain("Synchronous usage failure 2"));
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(attempt).toBe(2);
});

it("retires native scope changes immediately and coalesces them across explicit refresh", async () => {
  const stale = createDeferredCore();
  const previous = createGatewayRequestMock(async () => {
    await stale.promise;
    return snapshot;
  });
  const view = await mount(previous);
  await waitForSolid(() => expect(previous).toHaveBeenCalledOnce());
  const current = createGatewayRequestMock(async (_method, params) => ({
    ...snapshot,
    providers: [{ ...snapshot.providers[0], plan: (params as { profileId: string }).profileId }],
  }));

  view.client = createTestGatewayClient(current);
  expect(previous.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  view.agentId = "other";
  view.profileId = "openai:current";
  expect(current).not.toHaveBeenCalled();
  await waitForSolid(() => expect(current).toHaveBeenCalledOnce());
  expect(current.mock.calls[0]?.[1]).toEqual({
    agentId: "other",
    profileId: "openai:current",
  });
  await waitForSolid(() => expect(view.textContent).toContain("openai:current"));

  view.agentId = "third";
  view.refreshUsage();
  expect(current).toHaveBeenCalledTimes(2);
  view.profileId = "openai:final";
  expect(current.mock.calls[1]?.[2]?.signal?.aborted).toBe(true);
  await waitForSolid(() => expect(current).toHaveBeenCalledTimes(3));
  expect(current.mock.calls[2]?.[1]).toEqual({
    agentId: "third",
    profileId: "openai:final",
  });
  await waitForSolid(() => expect(view.textContent).toContain("openai:final"));
  stale.resolve();
  await previous.mock.results[0]!.value;
  await view.updateComplete;
  expect(view.textContent).toContain("openai:final");
  expect(view.textContent).not.toContain("openai:current");
  expect(current).toHaveBeenCalledTimes(3);
});

it("retires requests and native refresh receipts when disposed", async () => {
  const pending = createDeferredCore();
  const request = createGatewayRequestMock(async () => {
    await pending.promise;
    return snapshot;
  });
  const view = await mount(request);
  await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
  view.remove();
  await Promise.resolve();
  expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  view.agentId = "other";
  view.profileId = "openai:other";
  view.refreshUsage();
  await view.updateComplete;
  expect(request).toHaveBeenCalledOnce();
  pending.resolve();
  await request.mock.results[0]!.value;
  await view.updateComplete;
  expect(view.textContent).not.toContain("12 credits");
});

it("replaces a cancelled read when same-turn receipts return to the original account", async () => {
  const stale = createDeferredCore();
  let calls = 0;
  const request = createGatewayRequestMock(async () => {
    if (++calls === 1) {
      await stale.promise;
      return {
        ...snapshot,
        providers: [
          { ...snapshot.providers[0], billing: [{ type: "balance", amount: 99, unit: "credits" }] },
        ],
      };
    }
    return snapshot;
  });
  const view = await mount(request);
  await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
  view.agentId = "other";
  view.agentId = "main";
  expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  await waitForSolid(() => expect(view.textContent).toContain("12 credits"));
  stale.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  flush();
  await view.updateComplete;
  expect(request).toHaveBeenCalledTimes(2);
  expect(view.textContent).toContain("12 credits");
  expect(view.textContent).not.toContain("99 credits");
});

it("shows the empty state when Codex returns a snapshot without quota data", async () => {
  const request = createGatewayRequestMock(async () => ({
    updatedAt: 1,
    providers: [{ provider: "openai", displayName: "OpenAI", windows: [] }],
  }));
  const view = await mount(request);
  await waitForSolid(() => expect(view.textContent).toContain("No live usage data"));
});
