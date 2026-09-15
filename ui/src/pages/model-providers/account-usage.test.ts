import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { nextFrame } from "../../test-helpers/modal-dialog.ts";
import { ModelAccountUsages } from "./account-usage.ts";

registerSettingsEnglish();

let element: ModelAccountUsages | undefined;
afterEach(() => element?.remove());
const snapshot = (usedPercent: number) => ({
  updatedAt: 1,
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      plan: "Pro",
      windows: [{ label: "5h", usedPercent }],
      billing: [{ type: "balance", amount: 12, unit: "credits" }],
    },
  ],
});

async function mount(request: ReturnType<typeof createGatewayRequestMock>) {
  element = new ModelAccountUsages();
  element.client = createTestGatewayClient(request);
  element.agentId = "main";
  element.profiles = [
    { profileId: "openai:first", label: "First" },
    { profileId: "openai:second", label: "Second" },
  ];
  document.body.append(element);
  await element.updateComplete;
  return element;
}

it("loads every saved account concurrently in order and isolates a failed account", async () => {
  const request = createGatewayRequestMock(async (_method, params) => {
    if ((params as { profileId: string }).profileId === "openai:second") {
      throw new Error("Second account unavailable");
    }
    return snapshot(25);
  });
  const view = await mount(request);
  await expect.poll(() => view.textContent).toContain("12 credits");
  expect(view.textContent).toContain("Second account unavailable");
  expect(request.mock.calls.map(([, params]) => params)).toEqual([
    { agentId: "main", profileId: "openai:first" },
    { agentId: "main", profileId: "openai:second" },
  ]);
  expect(view.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("75");
  expectDefined(view.querySelector("button"), "refresh usage").click();
  await expect.poll(() => request.mock.calls.length).toBe(4);
});

it("drops pending agent and connection results after replacement", async () => {
  const stale = createDeferredCore();
  const first = createGatewayRequestMock(async () => {
    await stale.promise;
    return snapshot(25);
  });
  const view = await mount(first);
  await expect.poll(() => first.mock.calls.length).toBe(2);
  const replacement = createGatewayRequestMock(async () => snapshot(90));
  view.client = createTestGatewayClient(replacement);
  view.agentId = "other";
  await expect.poll(() => view.textContent).toContain("10% left");
  stale.resolve();
  await nextFrame();
  await view.updateComplete;
  expect(view.textContent).toContain("10% left");
  expect(view.textContent).not.toContain("75% left");
  expect(first.mock.calls.every((args) => args[2]?.signal?.aborted)).toBe(true);
});

it("does not request or render cards without a permitted client", async () => {
  const request = createGatewayRequestMock(async () => snapshot(25));
  element = new ModelAccountUsages();
  element.agentId = "main";
  element.profiles = [{ profileId: "openai:first", label: "First" }];
  document.body.append(element);
  await element.updateComplete;
  expect(element.textContent?.trim()).toBe("");
  expect(request).not.toHaveBeenCalled();
});
