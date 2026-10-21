/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
} from "../../app/gateway-store.test-support.ts";
import { loadSettings } from "../../app/settings.ts";
import { i18n } from "../../i18n/index.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext } from "../../test-helpers/app-sidebar.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  activityHello,
  activityResponse,
  activityRoster,
  createActivityPage,
} from "./activity-page.test-support.ts";

it("expires presence without another event, catches up after hiding, and stops on disposal", async () => {
  await i18n.setLocale("en");
  const { gateway: source, current } = createGatewayStoreTestStore({
    settings: {
      ...loadSettings(),
      gatewayUrl: "wss://activity.example.test",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
    },
  });
  const sessions = createTestSessionCapability(source);
  try {
    const context = {
      ...createContext(source, sessions),
      basePath: "",
      resourceBasePath: "",
      replace: vi.fn(),
    };
    source.start();
    const person = {
      id: "person",
      name: "Synthetic person",
      identity: { type: "profile" as const, id: "person" },
    };
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list"
        ? {
            ...activityRoster([]),
            people: [{ identity: person.identity, label: person.name, sessionCount: 0 }],
          }
        : activityResponse(method, params),
    );
    current().testOptions.onHello?.(activityHello());
    const page = createActivityPage(context, {
      pathname: "/activity/person",
      search: "",
      hash: "",
    });
    await waitForSolid(() =>
      expect(page.container.querySelector('[data-activity-identity="person"]')).not.toBeNull(),
    );
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12));
    const scheduledTimers = vi.spyOn(globalThis, "setTimeout");
    const clearedTimers = vi.spyOn(globalThis, "clearTimeout");
    const latestExpiry = () => {
      const index = scheduledTimers.mock.calls.findLastIndex((call) => call[1] === 120_000);
      expect(index).toBeGreaterThanOrEqual(0);
      return scheduledTimers.mock.results[index]?.value;
    };
    let presenceVersion = 0;
    const publishPresence = (lastActivityAt: number) => {
      current().testOptions.onEvent?.(
        createGatewayEvent("presence", {
          reset: true,
          version: ++presenceVersion,
          keys: ["synthetic-device"],
          presence: [{ user: person, host: "Synthetic device", ts: Date.now(), lastActivityAt }],
        }),
      );
      flush();
    };
    try {
      publishPresence(Date.now() - 119_000);
      const identity = page.container.querySelector('[data-activity-identity="person"]')!;
      const details = identity.querySelector<HTMLDetailsElement>(
        ".activity-feed__connection-details",
      )!;
      details.open = true;
      expect(identity.querySelector(".settings-status")?.textContent).toContain("Online · Active");

      await vi.advanceTimersByTimeAsync(1_000);
      flush();
      expect(identity.querySelector(".settings-status")?.textContent).toContain("Online · Idle");
      expect(page.container.querySelector('[data-activity-identity="person"]')).toBe(identity);
      expect(identity.querySelector(".activity-feed__connection-details")).toBe(details);
      expect(details.open).toBe(true);

      publishPresence(Date.now());
      expect(identity.querySelector(".settings-status")?.textContent).toContain("Online · Active");
      const hiddenExpiry = latestExpiry();
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      flush();
      expect(clearedTimers).toHaveBeenCalledWith(hiddenExpiry);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(identity.querySelector(".settings-status")?.textContent).toContain("Online · Active");
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      flush();
      expect(identity.querySelector(".settings-status")?.textContent).toContain("Online · Idle");
      expect(identity.querySelector(".activity-feed__connection-details")).toBe(details);
      expect(details.open).toBe(true);

      publishPresence(Date.now());
      const disposedExpiry = latestExpiry();
      page.dispose();
      expect(clearedTimers).toHaveBeenCalledWith(disposedExpiry);
      const scheduledCount = scheduledTimers.mock.calls.length;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(scheduledTimers).toHaveBeenCalledTimes(scheduledCount);
    } finally {
      page.dispose();
      visibility.mockRestore();
      vi.useRealTimers();
    }
  } finally {
    cleanupSolid();
    vi.restoreAllMocks();
    vi.useRealTimers();
    sessions.dispose();
    disposeSidebarContextLifecycles();
    source.stop();
    await vi.dynamicImportSettled();
    setAvatarGatewayOrigin(null);
    localStorage.clear();
    sessionStorage.clear();
  }
});
