import { afterEach, expect, it, vi } from "vitest";
import type { GatewayEventListener } from "../../api/gateway.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { click, fillInput } from "./cron-assertions.test-support.ts";
import {
  createContext,
  createGateway,
  createPage,
  waitForCronPage,
} from "./cron-page.test-support.tsx";
import { catalogModel, cronRpc, emitEvent } from "./cron-rpc.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("clears a failed catalog refresh during retry without holding the task draft", async () => {
  const failed = Promise.withResolvers<{ models: { id: string }[] }>();
  const retry = Promise.withResolvers<{ models: { id: string }[] }>();
  let reads = 0;
  const client = createTestGatewayClient(
    cronRpc({
      "models.list": () =>
        ++reads === 1
          ? { models: [catalogModel("initial-model")] }
          : reads === 2
            ? failed.promise
            : retry.promise,
    }),
  );
  const page = createPage(createContext(createGateway(client, true)), { render: true });
  try {
    click(page, '[data-test-id="cron-new-task"]');
    await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
    await waitForCronPage(() => expect(page.cronCatalogModels).toEqual(["fixture/initial-model"]));
    const name = fillInput(page, "#cron-name", "Retained task draft");
    invalidateChatMetadataStore(client);
    await waitForCronPage(() => expect(reads).toBe(2));
    failed.reject(new Error("Catalog refresh unavailable"));
    await waitForCronPage(() => expect(page.textContent).toContain("Catalog refresh unavailable"));
    expect(name.value).toBe("Retained task draft");

    invalidateChatMetadataStore(client);
    await waitForCronPage(() => expect(reads).toBe(3));
    await waitForCronPage(() =>
      expect(page.textContent).not.toContain("Catalog refresh unavailable"),
    );
    expect(page.querySelector("#cron-name")).toBe(name);
    fillInput(page, "#cron-name", "Draft edited during retry");
    await waitForCronPage(() => expect(page.cron.cronForm.name).toBe("Draft edited during retry"));
    expect(page.cronCatalogModels).toEqual(["fixture/initial-model"]);
    retry.resolve({ models: [catalogModel("updated-model")] });
    await waitForCronPage(() => expect(page.cronCatalogModels).toEqual(["fixture/updated-model"]));
    expect(name.value).toBe("Draft edited during retry");
  } finally {
    failed.resolve({ models: [] });
    retry.resolve({ models: [] });
    page.remove();
  }
});

it("refreshes catalog warnings when the shell invalidates after the page receives an event", async () => {
  let refreshFailed = false;
  const client = createTestGatewayClient(
    cronRpc({
      "models.list": () => ({ models: [catalogModel("current")], refreshFailed }),
    }),
  );
  const gateway = createGateway(client, true);
  const listeners = new Set<GatewayEventListener>();
  vi.spyOn(gateway, "subscribeEvents").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const page = createPage(createContext(gateway), { render: true });
  click(page, '[data-test-id="cron-new-task"]');
  await waitForCronPage(() => expect(page.cronCatalogModels).toEqual(["fixture/current"]));

  refreshFailed = true;
  for (const listener of listeners) {
    listener({ type: "event", event: "chat.metadata.changed", payload: {} });
  }
  invalidateChatMetadataStore(client);
  await waitForCronPage(() =>
    expect(page.textContent).toContain("Couldn’t refresh some models. Open Models to try again."),
  );
});

it("loads the catalogue only for an open editor and retires closed-editor invalidations", async () => {
  const request = cronRpc({ "models.list": () => ({ models: [catalogModel("editor-model")] }) });
  const client = createTestGatewayClient(request);
  const gateway = createGateway(client, true);
  const page = createPage(createContext(gateway), { render: true });
  const modelCalls = () => request.mock.calls.filter(([method]) => method === "models.list");
  try {
    await page.settle();
    expect(modelCalls()).toHaveLength(0);
    emitEvent(gateway, "chat.metadata.changed");
    await page.settle();
    expect(modelCalls()).toHaveLength(0);
    click(page, '[data-test-id="cron-new-task"]');
    await waitForCronPage(() => expect(page.cronCatalogModels).toEqual(["fixture/editor-model"]));
    expect(modelCalls()).toHaveLength(1);
    page.closePanel();
    await page.settle();
    emitEvent(gateway, "chat.metadata.changed");
    await page.settle();
    expect(modelCalls()).toHaveLength(1);
    click(page, '[data-test-id="cron-new-task"]');
    await waitForCronPage(() => expect(modelCalls()).toHaveLength(2));
    await waitForCronPage(() => expect(page.cronCatalogModels).toEqual(["fixture/editor-model"]));
  } finally {
    page.remove();
  }
});
