/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { renderNotificationsSection } from "./notifications-section.tsx";

const userPreferences = {
  categories: {
    approvalRequested: true,
    agentFinished: false,
    agentQuestion: false,
    humanMentioned: false,
    scheduledTaskFailed: false,
  },
  detailLevel: "private" as const,
  quietHours: { enabled: false, startMinute: 1320, endMinute: 420, timeZone: "UTC" },
  agentIds: [],
};

describe("native notification test outcome", () => {
  it("renders pending immediately and disables duplicate sends", () => {
    const onSend = vi.fn();
    const container = document.createElement("div");

    mountSolid(
      () =>
        renderNotificationsSection({
          connected: true,
          nativeNotifications: { permission: "granted", test: { state: "pending" } },
          onNativeNotificationsSendTest: onSend,
        }),
      { container },
    );

    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Sending test");
    button?.click();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders an actionable error without replacing granted permission", () => {
    const container = document.createElement("div");

    mountSolid(
      () =>
        renderNotificationsSection({
          connected: true,
          nativeNotifications: {
            permission: "granted",
            test: { state: "error", message: "Open System Settings and try again." },
          },
        }),
      { container },
    );

    expect(container.textContent).toContain("Granted");
    expect(container.textContent).toContain("Open System Settings and try again.");
    expect(container.querySelector(".settings-status--danger")).not.toBeNull();
  });

  it("renders queued success independently from permission", () => {
    const container = document.createElement("div");
    mountSolid(
      () =>
        renderNotificationsSection({
          connected: true,
          nativeNotifications: { permission: "granted", test: { state: "sent" } },
        }),
      { container },
    );

    expect(container.textContent).toContain("Granted");
    expect(container.textContent).toContain("Test notification queued");
  });
});

describe("Web Push preference saves", () => {
  it("lets recipients opt in to mentions and override them for one browser", () => {
    const onUserPreferences = vi.fn();
    const onDevicePreferences = vi.fn();
    const { container, getByRole } = mountSolid(() =>
      renderNotificationsSection({
        connected: true,
        webPush: {
          supported: true,
          permission: "granted",
          subscription: "registered",
          loading: false,
          preferences: {
            durableIdentity: true,
            user: userPreferences,
            device: { enabled: true, label: "phone" },
            effective: { ...userPreferences, enabled: true, label: "phone" },
          },
        },
        onWebPushSetUserPreferences: onUserPreferences,
        onWebPushSetDevicePreferences: onDevicePreferences,
      }),
    );

    const accountToggle = getByRole("switch", { name: "Someone mentions me" });
    if (!(accountToggle instanceof HTMLInputElement)) {
      throw new Error("Expected the mention account preference switch");
    }
    expect(accountToggle.checked).toBe(false);
    accountToggle.click();
    expect(onUserPreferences).toHaveBeenCalledWith({
      ...userPreferences,
      categories: { ...userPreferences.categories, humanMentioned: true },
    });

    const browserOverride = expectDefined(
      container.querySelector<HTMLSelectElement>('select[aria-label="Someone mentions me"]'),
      "mention browser preference",
    );
    expect(browserOverride.value).toBe("inherit");
    browserOverride.value = "off";
    browserOverride.dispatchEvent(new Event("change"));
    expect(onDevicePreferences).toHaveBeenLastCalledWith({
      enabled: true,
      label: "phone",
      categories: { humanMentioned: false },
    });
  });

  it("disables every preference control while a save is in flight", () => {
    const container = document.createElement("div");

    mountSolid(
      () =>
        renderNotificationsSection({
          connected: true,
          webPush: {
            supported: true,
            permission: "granted",
            subscription: "registered",
            loading: true,
            preferences: {
              durableIdentity: true,
              user: userPreferences,
              device: { enabled: true, label: "phone" },
              effective: { ...userPreferences, enabled: true, label: "phone" },
            },
          },
        }),
      { container },
    );

    // Preference sections stack inside the page column; a nested .settings-page
    // would reapply the 760px max-width and inset them from the card above.
    expect(container.querySelector(".settings-page .settings-page")).toBeNull();
    const preferences = container.querySelector<HTMLElement>(".settings-page .settings-stack");
    const preferenceGroup = expectDefined(preferences, "notification preferences group");
    expect(preferenceGroup.querySelector("input, select")).not.toBeNull();
    expect(preferenceGroup.hasAttribute("inert")).toBe(true);
  });
});

type DevicePreferencesListener = NonNullable<
  Parameters<typeof renderNotificationsSection>[0]["onWebPushSetDevicePreferences"]
>;

describe("Web Push preference controls", () => {
  function renderPreferences(
    options: {
      onDevice?: DevicePreferencesListener;
      onUser?: Parameters<typeof renderNotificationsSection>[0]["onWebPushSetUserPreferences"];
      timeZone?: string;
    } = {},
  ) {
    const [timeZone, setTimeZone] = createSignal(options.timeZone ?? "UTC");
    const user = () => ({
      ...userPreferences,
      quietHours: {
        ...userPreferences.quietHours,
        enabled: true,
        timeZone: timeZone(),
      },
    });
    const device = { enabled: true, label: "phone", agentIds: ["main"] };
    const mounted = mountSolid(() =>
      renderNotificationsSection({
        connected: true,
        onWebPushSetDevicePreferences: options.onDevice,
        onWebPushSetUserPreferences: options.onUser,
        get webPush() {
          return {
            supported: true,
            permission: "granted",
            subscription: "registered",
            loading: false,
            preferences: {
              durableIdentity: true,
              user: user(),
              device,
              effective: { ...user(), ...device },
            },
          };
        },
      }),
    );
    return { ...mounted, setTimeZone };
  }

  it("preserves a saved timezone alias and saves a native selection", () => {
    const onUser = vi.fn();
    const { container, setTimeZone } = renderPreferences({ onUser, timeZone: "US/Pacific" });
    const select = expectDefined(
      container.querySelector<HTMLSelectElement>('select[aria-label="Time zone"]'),
      "timezone select",
    );
    expect(select.value).toBe("US/Pacific");
    select.value = "Europe/London";
    select.dispatchEvent(new Event("change"));
    setTimeZone("Europe/London");
    flush();
    expect(select.value).toBe("Europe/London");
    expect(container.querySelector('select[aria-label="Time zone"]')).toBe(select);
    expect(onUser).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        quietHours: expect.objectContaining({ timeZone: "Europe/London" }),
      }),
    );
  });

  it("retains UTC and the saved timezone when the browser catalog is unavailable", () => {
    const catalog = vi.spyOn(Intl, "supportedValuesOf").mockImplementation(() => {
      throw new RangeError("unavailable");
    });
    try {
      const { container } = renderPreferences({ timeZone: "US/Pacific" });
      const select = expectDefined(
        container.querySelector<HTMLSelectElement>('select[aria-label="Time zone"]'),
        "timezone select",
      );
      expect(select.value).toBe("US/Pacific");
      expect([...select.options].map((option) => option.value)).toEqual(
        expect.arrayContaining(["UTC", "US/Pacific"]),
      );
    } finally {
      catalog.mockRestore();
    }
  });

  it("patches device preferences from the toggle row and select row", () => {
    const onDevice = vi.fn<DevicePreferencesListener>();
    const { container } = renderPreferences({ onDevice });
    const deviceGroup = expectDefined(
      container.querySelectorAll(".settings-page .settings-stack .settings-group")[1],
      "device preference group",
    );

    const toggle = expectDefined(
      deviceGroup.querySelector<HTMLInputElement>(".settings-toggle__input"),
      "deliver toggle",
    );
    toggle.click();
    expect(onDevice).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, label: "phone", agentIds: ["main"] }),
    );

    const detail = expectDefined(
      deviceGroup.querySelector<HTMLSelectElement>('select[aria-label="Lock-screen detail"]'),
      "device lock-screen detail select",
    );
    detail.value = "detailed";
    detail.dispatchEvent(new Event("change"));
    expect(onDevice).toHaveBeenLastCalledWith(expect.objectContaining({ detailLevel: "detailed" }));
  });
});
