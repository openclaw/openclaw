import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayEventListener } from "../../api/gateway.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  waitForCronPage,
} from "./cron-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CronPage lifecycle", () => {
  it("clears a failed catalog refresh during retry without holding the task draft", async () => {
    const fallback = createRequest();
    const failed = Promise.withResolvers<{ models: { id: string }[] }>();
    const retry = Promise.withResolvers<{ models: { id: string }[] }>();
    let reads = 0;
    const client = createTestGatewayClient((method) => {
      if (method !== "models.list") {
        return fallback(method);
      }
      reads += 1;
      return reads === 1
        ? { models: [{ id: "initial-model" }] }
        : reads === 2
          ? failed.promise
          : retry.promise;
    });
    const page = createPage(createContext(createGateway(client, true)), { render: true });
    try {
      await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["initial-model"]));
      page.querySelector<HTMLButtonElement>('[data-test-id="cron-new-task"]')!.click();
      await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
      const name = page.querySelector<HTMLInputElement>("#cron-name")!;
      name.value = "Retained task draft";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      invalidateChatMetadataStore(client);
      await waitForCronPage(() => expect(reads).toBe(2));
      failed.reject(new Error("Catalog refresh unavailable"));
      await waitForCronPage(() =>
        expect(page.textContent).toContain("Catalog refresh unavailable"),
      );
      expect(name.value).toBe("Retained task draft");

      invalidateChatMetadataStore(client);
      await waitForCronPage(() => expect(reads).toBe(3));
      await waitForCronPage(() =>
        expect(page.textContent).not.toContain("Catalog refresh unavailable"),
      );
      expect(page.querySelector("#cron-name")).toBe(name);
      name.value = "Draft edited during retry";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      await waitForCronPage(() =>
        expect(page.cron.cronForm.name).toBe("Draft edited during retry"),
      );
      expect(page.cronModelSuggestions).toEqual(["initial-model"]);
      retry.resolve({ models: [{ id: "updated-model" }] });
      await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["updated-model"]));
      expect(name.value).toBe("Draft edited during retry");
    } finally {
      failed.resolve({ models: [] });
      retry.resolve({ models: [] });
      page.remove();
    }
  });

  it("refreshes catalog warnings when the shell invalidates after the page receives an event", async () => {
    const fallback = createRequest();
    let refreshFailed = false;
    const client = createTestGatewayClient((method) =>
      method === "models.list"
        ? { models: [{ provider: "fixture", id: "current" }], refreshFailed }
        : fallback(method),
    );
    const gateway = createGateway(client, true);
    const listeners = new Set<GatewayEventListener>();
    vi.spyOn(gateway, "subscribeEvents").mockImplementation((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const page = createPage(createContext(gateway), { render: true });
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["fixture/current"]));

    refreshFailed = true;
    for (const listener of listeners) {
      listener({ type: "event", event: "chat.metadata.changed", payload: {} });
    }
    invalidateChatMetadataStore(client);
    await waitForCronPage(() =>
      expect(page.textContent).toContain(
        "Some models could not be refreshed. Open Models to try again.",
      ),
    );
  });
});
