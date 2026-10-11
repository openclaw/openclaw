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

it("shows the empty state when Codex returns a snapshot without quota data", async () => {
  const request = createGatewayRequestMock(async () => ({
    updatedAt: 1,
    providers: [{ provider: "openai", displayName: "OpenAI", windows: [] }],
  }));
  const view = await mount(request);
  await waitForSolid(() => expect(view.textContent).toContain("No live usage data"));
});
