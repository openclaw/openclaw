/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ModelAuthStatusResult } from "../api/types.ts";
import { createGatewayHarness } from "../app/overlays-access.test-support.ts";
import type { SidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import { invalidateModelAuthStatusRequests } from "../lib/model-auth-request-state.ts";
import { loadModelAuthStatus } from "../lib/model-auth.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createStore } from "./sidebar-attention-store.test-support.ts";
import { SidebarAttentionStoreOwner } from "./sidebar-attention-store.ts";

let store: SidebarAttentionStore | undefined;
afterEach(() => {
  store?.dispose();
  store = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(expiresInMs?: number) {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 8, 17));
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const expiresAt = expiresInMs === undefined ? undefined : Date.now() + expiresInMs;
  const authRequest = vi.fn(async (): Promise<ModelAuthStatusResult> => {
    const expired = expiresAt !== undefined && Date.now() >= expiresAt;
    return {
      ts: Date.now(),
      providers: [
        {
          provider: "test",
          displayName: "Test",
          status: expired ? "expired" : expiresInMs === 60_000 ? "expiring" : "ok",
          expiry:
            expiresAt === undefined
              ? undefined
              : { at: expiresAt, remainingMs: expiresAt - Date.now(), label: "remaining" },
          profiles: [
            { profileId: "test:token", type: "token", status: expired ? "expired" : "ok" },
          ],
        },
      ],
    };
  });
  const client = createTestGatewayClient((method) =>
    method === "models.authStatus"
      ? authRequest()
      : Promise.resolve({ jobs: [], enabled: true, hasMore: false }),
  );
  const harness = createGatewayHarness(client);
  store = createStore(harness.gateway);
  store.activate(SidebarAttentionStoreOwner);
  await vi.advanceTimersByTimeAsync(0);
  return {
    authRequest,
    client,
    harness,
    visibility(value: DocumentVisibilityState) {
      visibility = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

it.each(["visible", "hidden"] as const)(
  "refreshes expired credentials once after a %s deadline",
  async (presentation) => {
    const h = await setup(60_000);
    expect(h.authRequest).toHaveBeenCalledOnce();
    expect(store?.entries).toEqual([]);
    if (presentation === "hidden") {
      h.visibility("hidden");
    }
    await vi.advanceTimersByTimeAsync(60_000);
    if (presentation === "hidden") {
      expect(h.authRequest).toHaveBeenCalledOnce();
      h.visibility("visible");
      h.visibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.authRequest).toHaveBeenCalledTimes(2);
    expect(store?.entries).toMatchObject([{ kind: "modelAuthExpired", label: "Test" }]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.authRequest).toHaveBeenCalledTimes(2);
  },
);

it("keeps a deadline for reads made during an independent explicit refresh", async () => {
  const h = await setup(60_000);
  const pending = createDeferred<ModelAuthStatusResult>();
  h.authRequest.mockReturnValueOnce(pending.promise);
  const refresh = loadModelAuthStatus(h.client, { agentId: "main", refresh: true });
  for (let index = 0; index < 10; index++) {
    h.harness.emitEvent("config.changed", { hash: `plugin-toggle-${index}` });
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(h.authRequest).toHaveBeenCalledTimes(2);
  h.harness.emitEvent("chat.metadata.changed", {});
  await vi.advanceTimersByTimeAsync(0);
  expect(h.authRequest).toHaveBeenCalledTimes(3);
  pending.resolve({ ts: Date.now(), providers: [] });
  await refresh;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.authRequest).toHaveBeenCalledTimes(4);
  expect(store?.entries).toMatchObject([{ kind: "modelAuthExpired" }]);
});

it.each([
  ["disposed", 60_000, 60_000],
  ["disconnected", 60_000, 60_000],
  ["replaced", 60_000, 60_000],
  ["no deadline", undefined, 5 * 60_000],
  ["distant deadline", 40 * 24 * 60 * 60_000, 5 * 60_000],
] as const)("keeps auth quiet after %s", async (transition, expiresInMs, delay) => {
  const h = await setup(expiresInMs);
  if (transition === "disposed") {
    store?.dispose();
  } else if (transition === "disconnected") {
    h.harness.update({ phase: "offline", client: null });
  } else if (transition === "replaced") {
    invalidateModelAuthStatusRequests(h.client);
    h.authRequest.mockResolvedValue({ ts: Date.now(), providers: [] });
    h.harness.emitEvent("chat.metadata.changed", {});
    await vi.advanceTimersByTimeAsync(0);
  }
  const calls = h.authRequest.mock.calls.length;
  if (transition === "no deadline" || transition === "distant deadline") {
    expect(h.authRequest).toHaveBeenCalledOnce();
  }
  await vi.advanceTimersByTimeAsync(delay);
  expect(h.authRequest).toHaveBeenCalledTimes(calls);
  if (transition === "distant deadline") {
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(h.authRequest).toHaveBeenCalledOnce();
  }
});
