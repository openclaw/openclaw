import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { nextFrame } from "../../test-helpers/modal-dialog.ts";
import { ModelAccountUsage } from "./account-usage.ts";

registerSettingsEnglish();

let element: ModelAccountUsage | undefined;
afterEach(() => element?.remove());
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
  element = new ModelAccountUsage();
  element.client = createTestGatewayClient(request);
  element.agentId = "main";
  element.profileId = "openai:account";
  document.body.append(element);
  await element.updateComplete;
  return element;
}

it("loads automatically, renders remaining quota and balance, and refreshes that account", async () => {
  const request = createGatewayRequestMock(async () => snapshot);
  const view = await mount(request);
  await expect.poll(() => view.textContent).toContain("12 credits");
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
  document.body.append(view);
  await view.updateComplete;
  expect(view.textContent).toContain("12 credits");
  expectDefined(view.querySelector("button"), "refresh usage").click();
  await expect.poll(() => request.mock.calls.length).toBe(2);
  expect(request.mock.lastCall?.[1]).toEqual({
    agentId: "main",
    profileId: "openai:account",
  });
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
  await expect.poll(() => request.mock.calls.length).toBe(1);
  view.agentId = "other";
  await expect.poll(() => view.textContent).toContain("Account usage unavailable");
  stale.resolve();
  await nextFrame();
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
  await expect.poll(() => view.textContent).toContain("No live usage data");
});
