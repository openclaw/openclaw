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
