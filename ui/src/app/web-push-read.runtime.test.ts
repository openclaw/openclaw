/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../test-helpers/application-context-fixtures.ts";
import { createWebPushReadRuntime } from "./web-push-read.runtime.ts";

const viewed = { agentId: "a", sessionKey: "agent:a:s", runId: "run", messageId: "answer" };
function notification(change: object = {}) {
  return {
    data: { completion: { version: 1, ...viewed, profileId: null, ...change } },
    close: vi.fn(),
  };
}
function harness() {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const serviceWorker = Object.assign(new EventTarget(), {
    getRegistration: vi.fn(),
  });
  vi.stubGlobal("navigator", { serviceWorker });
  const fixture = createApplicationGateway(createApplicationGatewaySnapshot({
    phase: "connected", client: {} as GatewayBrowserClient, selfUser: null,
  }));
  fixture.gateway.connection.gatewayUrl = location.origin.replace(/^http/u, "ws");
  const notifications: ReturnType<typeof notification>[] = [];
  const getNotifications = vi.fn(async () => notifications);
  serviceWorker.getRegistration.mockResolvedValue({
    scope: location.origin + "/", getNotifications,
  });
  const runtime = createWebPushReadRuntime(fixture.gateway);
  const delivered = () => serviceWorker.dispatchEvent(new MessageEvent("message", {
    data: { type: "openclaw-completion-delivered" },
  }));
  return { ...fixture, runtime, notifications, getNotifications, serviceWorker, delivered };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser completion read dismissal", () => {
  it("closes only a seen exact response, including a later delivery of it", async () => {
    const h = harness();
    const seen = notification();
    const newer = notification({ messageId: "unseen-answer" });
    const other = notification({ sessionKey: "agent:a:other" });
    const otherProfile = notification({ profileId: "another-reader" });
    const legacy = { data: {}, close: vi.fn() };
    h.getNotifications.mockResolvedValue([seen, newer, other, otherProfile, legacy] as typeof h.notifications);
    try {
      h.runtime.viewed(viewed, () => true);
      await vi.waitFor(() => expect(seen.close).toHaveBeenCalledOnce());
      for (const entry of [newer, other, otherProfile, legacy]) {
        expect(entry.close).not.toHaveBeenCalled();
      }
      const late = notification();
      h.getNotifications.mockResolvedValue([late, newer]);
      h.delivered();
      await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
      expect(newer.close).not.toHaveBeenCalled();
    } finally {
      h.runtime.dispose();
    }
  });

  it.each(["navigation", "disconnect", "client", "identity-unresolved", "dispose"])("does not apply a stale enumeration: %s", async (change) => {
    const h = harness();
    const entry = notification();
    const enumerated = Promise.withResolvers<typeof h.notifications>();
    h.getNotifications.mockReturnValue(enumerated.promise);
    let presented = true;
    try {
      h.runtime.viewed(viewed, () => presented);
      await vi.waitFor(() => expect(h.getNotifications).toHaveBeenCalledOnce());
      if (change === "navigation") {
        presented = false;
      } else if (change === "disconnect") {
        h.publish({ ...h.gateway.snapshot, phase: "offline" });
      } else if (change === "client") {
        h.publish({ ...h.gateway.snapshot, client: {} as GatewayBrowserClient });
      } else if (change === "identity-unresolved") {
        h.publish({ ...h.gateway.snapshot, selfUser: undefined });
      } else {
        h.runtime.dispose();
      }
      enumerated.resolve([entry]);
      await enumerated.promise;
      await Promise.resolve();
      expect(entry.close).not.toHaveBeenCalled();
    } finally {
      h.runtime.dispose();
    }
  });

  it("does not clear on a delivery hint without an actual view or after receipts expire", async () => {
    const h = harness();
    const entry = notification();
    h.notifications.push(entry);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1);
    try {
      h.delivered();
      await vi.waitFor(() => expect(h.getNotifications).toHaveBeenCalledOnce());
      expect(entry.close).not.toHaveBeenCalled();
      h.runtime.viewed(viewed, () => false);
      expect(entry.close).not.toHaveBeenCalled();
      h.runtime.viewed(viewed, () => true);
      await vi.waitFor(() => expect(entry.close).toHaveBeenCalledOnce());
      entry.close.mockClear();
      clock.mockReturnValue(10 * 60_000);
      h.delivered();
      await vi.waitFor(() => expect(h.getNotifications).toHaveBeenCalledTimes(3));
      expect(entry.close).not.toHaveBeenCalled();
    } finally {
      h.runtime.dispose();
    }
  });

  it("declines a different Gateway path on the same origin", async () => {
    const h = harness();
    h.gateway.connection.gatewayUrl += "/other";
    const entry = notification();
    h.notifications.push(entry);
    try {
      h.runtime.viewed(viewed, () => true);
      await vi.waitFor(() => expect(h.serviceWorker.getRegistration).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(h.getNotifications).not.toHaveBeenCalled();
      expect(entry.close).not.toHaveBeenCalled();
    } finally {
      h.runtime.dispose();
    }
  });
});
