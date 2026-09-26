/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { createInAppNotificationsCapability } from "./in-app-notifications.ts";

const key = "ui.notifications.otherSessionsFinished";

function setup(request = vi.fn().mockResolvedValue({ status: "ok", entries: {} })) {
  const snapshot: ApplicationGatewaySnapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
    selfUser: { id: "profile-a" },
  };
  const harness = createApplicationGateway(snapshot);
  return {
    ...harness,
    snapshot,
    request,
    capability: createInAppNotificationsCapability(harness.gateway),
  };
}

describe("in-app completion preference", () => {
  it("defaults off and persists an account preference independently of push", async () => {
    const h = setup();
    await vi.waitFor(() => expect(h.capability.snapshot.loading).toBe(false));
    expect(h.capability.snapshot).toMatchObject({
      enabled: false,
      available: true,
      loading: false,
    });
    await h.capability.setEnabled(true);
    expect(h.request).toHaveBeenCalledWith("users.prefs.set", { entries: { [key]: true } });
    expect(h.capability.snapshot.enabled).toBe(true);
    h.capability.dispose();
  });

  it("resets on profile change and rejects late profile reads", async () => {
    let resolve!: (value: unknown) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue({ status: "ok", entries: {} });
    const h = setup(request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    h.publish({ ...h.snapshot, selfUser: { id: "profile-b" } });
    await vi.waitFor(() => expect(h.capability.snapshot.loading).toBe(false));
    resolve({ status: "ok", entries: { [key]: true } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.capability.snapshot.enabled).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    h.capability.dispose();
  });

  it("does not publish a late save into the new profile", async () => {
    const h = setup();
    await vi.waitFor(() => expect(h.capability.snapshot.loading).toBe(false));
    let resolve!: (value: unknown) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const saving = h.capability.setEnabled(true);
    h.publish({ ...h.snapshot, selfUser: { id: "profile-b" } });
    await vi.waitFor(() => expect(h.capability.snapshot.loading).toBe(false));
    resolve({ status: "ok" });
    await saving;
    expect(h.capability.snapshot.enabled).toBe(false);
    h.capability.dispose();
  });

  it("refreshes matching publications and reconnects without retaining a stale cache", async () => {
    const h = setup();
    await vi.waitFor(() => expect(h.capability.snapshot.loading).toBe(false));
    h.request.mockResolvedValue({ status: "ok", entries: { [key]: true } });
    h.publishEvent({
      type: "event",
      event: "users.prefs.changed",
      payload: { profileId: "profile-a", keys: [key] },
    });
    await vi.waitFor(() => expect(h.capability.snapshot.loading).toBe(false));
    expect(h.capability.snapshot.enabled).toBe(true);
    h.publish({ ...h.snapshot, phase: "reconnecting" });
    expect(h.capability.snapshot.enabled).toBe(false);
    h.request.mockResolvedValue({ status: "ok", entries: {} });
    h.publish(h.snapshot);
    await vi.waitFor(() => expect(h.capability.snapshot.loading).toBe(false));
    expect(h.capability.snapshot.enabled).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(3);
    h.capability.dispose();
  });

  it("preserves the saved value on failure and disables accounts without durable identity", async () => {
    const h = setup();
    await vi.waitFor(() => expect(h.capability.snapshot.loading).toBe(false));
    h.request.mockRejectedValueOnce(new Error("Try again"));
    await h.capability.setEnabled(true);
    expect(h.capability.snapshot).toMatchObject({
      enabled: false,
      loading: false,
      error: "Try again",
    });
    h.publish({ ...h.snapshot, phase: "reconnecting" });
    h.request.mockResolvedValue({ status: "no_durable_identity" });
    h.publish(h.snapshot);
    await vi.waitFor(() => expect(h.capability.snapshot.loading).toBe(false));
    expect(h.capability.snapshot.available).toBe(false);
    h.capability.dispose();
  });
});
