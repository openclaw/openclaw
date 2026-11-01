/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayStoreTestStore } from "../../app/gateway-store.test-support.ts";
import { loadSettings } from "../../app/settings.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import {
  activityHello,
  activityResponse,
  activityRoster,
  toolEvent,
} from "./activity-page.test-support.ts";
import { createLiveActivity } from "./live-activity.ts";

const cleanups: (() => void)[] = [];

function activityGateway() {
  const store = createGatewayStoreTestStore({
    settings: {
      ...loadSettings(),
      gatewayUrl: "wss://activity.example.test",
      token: "",
      sessionKey: "main",
    },
  });
  store.gateway.start();
  store
    .current()
    .request.mockImplementation(async (method, params) => activityResponse(method, params));
  store.current().testOptions.onHello?.(activityHello());
  const sessions = createTestSessionCapability(store.gateway);
  cleanups.push(() => {
    sessions.dispose();
    store.gateway.stop();
  });
  return { ...store, sessions };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
});

describe("Live Activity presentation batches", () => {
  it("batches Activity presentation while delivering Gateway events and direct reads synchronously", async () => {
    vi.useFakeTimers();
    const { gateway: source, current, sessions } = activityGateway();
    const live = createLiveActivity(source, sessions);
    live.syncSessions(activityRoster().sessions);
    const rendered = vi.fn();
    live.subscribe(rendered);
    const delivered = vi.fn();
    const stop = source.subscribeEvents(delivered);
    try {
      const events = [toolEvent("first"), toolEvent("second"), toolEvent("first", "main", "exec")];
      for (const event of events) {
        current().testOptions.onEvent?.(event);
      }
      expect(delivered.mock.calls.map(([event]) => event)).toEqual(events);
      expect(rendered).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(rendered).toHaveBeenCalledTimes(1);
      expect(
        live.snapshot.entries.map(({ toolCallId, toolName }) => [toolCallId, toolName]),
      ).toEqual([
        ["first", "exec"],
        ["second", "read"],
      ]);

      current().testOptions.onEvent?.(toolEvent("third"));
      expect(live.snapshot.entries.map(({ toolCallId }) => toolCallId)).toEqual([
        "first",
        "second",
        "third",
      ]);
      expect(rendered).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20);
      expect(rendered).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      live.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["clear", "scope", "dispose"] as const)(
    "does not replay queued Activity after %s",
    async (action) => {
      vi.useFakeTimers();
      const { gateway: source, current, sessions } = activityGateway();
      const live = createLiveActivity(source, sessions);
      live.syncSessions(activityRoster().sessions);
      const rendered = vi.fn();
      live.subscribe(rendered);
      try {
        current().testOptions.onEvent?.(toolEvent("retired"));
        if (action === "clear") {
          live.clear();
        } else if (action === "scope") {
          source.connect({ gatewayUrl: "wss://replacement-activity.example.test" });
        } else {
          live.dispose();
        }
        const publications = rendered.mock.calls.length;
        await vi.advanceTimersByTimeAsync(20);
        expect(live.snapshot.entries).toEqual([]);
        expect(rendered).toHaveBeenCalledTimes(publications);
      } finally {
        live.dispose();
        vi.useRealTimers();
      }
    },
  );
});
