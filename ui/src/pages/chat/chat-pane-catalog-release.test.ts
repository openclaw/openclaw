import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  CATALOG_SESSION_RELEASED_EVENT,
  type CatalogSessionReleasedDetail,
} from "../../lib/sessions/catalog-key.ts";
import { ChatCatalogReleaseReconciler } from "./chat-pane-catalog-release.ts";

describe("ChatCatalogReleaseReconciler", () => {
  afterEach(() => vi.useRealTimers());

  it("retires delayed retries when the selected agent changes", async () => {
    vi.useFakeTimers();
    const client = {} as GatewayBrowserClient;
    const context = {
      connected: true,
      client,
      sessionKey: "catalog:codex:local:thread-1",
      agentId: "main",
    };
    const load = vi.fn(async () => true);
    const reconciler = new ChatCatalogReleaseReconciler({ current: () => context, load });
    const disconnect = reconciler.connect();
    const detail: CatalogSessionReleasedDetail = {
      agentId: "main",
      catalogId: "codex",
      hostId: "local",
      threadId: "thread-1",
    };
    document.dispatchEvent(new CustomEvent(CATALOG_SESSION_RELEASED_EVENT, { detail }));

    context.agentId = "other";
    await vi.advanceTimersByTimeAsync(5_000);

    expect(load).not.toHaveBeenCalled();
    disconnect();
  });

  it("does not restart retries when disconnected during a catalog load", async () => {
    vi.useFakeTimers();
    const client = {} as GatewayBrowserClient;
    const context = {
      connected: true,
      client,
      sessionKey: "catalog:codex:local:thread-1",
      agentId: "main",
    };
    const pending = createDeferred<boolean>();
    const load = vi.fn(() => pending.promise);
    const reconciler = new ChatCatalogReleaseReconciler({ current: () => context, load });
    const disconnect = reconciler.connect();
    const detail: CatalogSessionReleasedDetail = {
      agentId: "main",
      catalogId: "codex",
      hostId: "local",
      threadId: "thread-1",
    };
    document.dispatchEvent(new CustomEvent(CATALOG_SESSION_RELEASED_EVENT, { detail }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledOnce();

    disconnect();
    pending.resolve(true);
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(load).toHaveBeenCalledOnce();
  });
});
