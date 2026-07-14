import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  askLogbook,
  configureLogbookPolling,
  getLogbookState,
  loadLogbookStandup,
  stopLogbookPolling,
} from "./logbook-controller.ts";

function clientWithRequest(
  request: (method: string, params: unknown) => Promise<unknown>,
): GatewayBrowserClient {
  return { request } as GatewayBrowserClient;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Logbook controller", () => {
  const hosts: object[] = [];

  afterEach(() => {
    for (const host of hosts.splice(0)) {
      stopLogbookPolling(host);
    }
    vi.useRealTimers();
  });

  it("rebinds polling when the gateway client changes", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    const firstRequest = vi.fn(async () => ({}));
    const secondRequest = vi.fn(async () => ({}));

    configureLogbookPolling(state, clientWithRequest(firstRequest), true);
    configureLogbookPolling(state, clientWithRequest(secondRequest), true);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(firstRequest).not.toHaveBeenCalled();
    expect(secondRequest).toHaveBeenCalled();
  });

  it("discards a standup response after the selected day changes", async () => {
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    const pending = deferred<unknown>();
    const request = loadLogbookStandup(
      state,
      clientWithRequest(() => pending.promise),
      false,
    );

    state.day = "2026-07-05";
    pending.resolve({ day: "2026-07-04", text: "Old day", updatedMs: 1 });
    await request;

    expect(state.standup).toBeNull();
  });

  it("discards an ask response after the selected day changes", async () => {
    const host = {};
    hosts.push(host);
    const state = getLogbookState(host);
    state.day = "2026-07-04";
    state.askQuestion = "What did I do?";
    const pending = deferred<unknown>();
    const request = askLogbook(
      state,
      clientWithRequest(() => pending.promise),
    );

    state.day = "2026-07-05";
    pending.resolve({ answer: "Old day" });
    await request;

    expect(state.askAnswer).toBeNull();
  });
});
