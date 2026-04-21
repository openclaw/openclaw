/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { loadChannels } from "./channels.ts";
import type { ChannelsState } from "./channels.types.ts";
import type { ChannelsStatusSnapshot } from "../types.ts";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createState(
  request: (method: string, params: Record<string, unknown>) => Promise<ChannelsStatusSnapshot | null>,
): ChannelsState {
  return {
    client: {
      request,
    } as unknown as ChannelsState["client"],
    connected: true,
    channelsLoading: false,
    channelsSnapshot: null,
    channelsError: null,
    channelsLastSuccess: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
    whatsappLoginConnected: null,
    whatsappBusy: false,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean, maxTicks = 20) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) {
      return;
    }
    await flushMicrotasks();
  }
  throw new Error("condition not met");
}

describe("loadChannels", () => {
  it("queues a stronger full-account refresh behind an in-flight lightweight request", async () => {
    const lightweightDeferred = createDeferred<ChannelsStatusSnapshot | null>();
    const fullDeferred = createDeferred<ChannelsStatusSnapshot | null>();
    const requestCalls: Array<Record<string, unknown>> = [];
    const state = createState(async (_method, params) => {
      requestCalls.push(params);
      if (requestCalls.length === 1) {
        return await lightweightDeferred.promise;
      }
      return await fullDeferred.promise;
    });

    const lightweightLoad = loadChannels(state, false, { includeAccounts: false });
    await flushMicrotasks();

    void loadChannels(state, true, { includeAccounts: true });
    expect(requestCalls).toEqual([
      { probe: false, includeAccounts: false, timeoutMs: 8000 },
    ]);

    lightweightDeferred.resolve({
      ts: 1,
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
      channels: { telegram: { configured: true } },
      channelAccounts: { telegram: [] },
      channelDefaultAccountId: { telegram: "default" },
    });
    await lightweightLoad;
    await waitFor(() => requestCalls.length === 2);

    expect(requestCalls).toEqual([
      { probe: false, includeAccounts: false, timeoutMs: 8000 },
      { probe: true, includeAccounts: true, timeoutMs: 8000 },
    ]);
    expect(state.channelsSnapshot).toBeNull();

    fullDeferred.resolve({
      ts: 2,
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
      channels: { telegram: { configured: true } },
      channelAccounts: {
        telegram: [{ accountId: "default", configured: true }],
      },
      channelDefaultAccountId: { telegram: "default" },
    });
    await flushMicrotasks();

    expect(state.channelsSnapshot?.channelAccounts.telegram).toEqual([
      { accountId: "default", configured: true },
    ]);
    expect(state.channelsLoading).toBe(false);
  });
});
