/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type {
  WebPushDevicePreferences,
  WebPushNotificationPreferences,
} from "../../../../packages/gateway-protocol/src/schema/push.js";
import { renderNotificationsSection } from "./notifications-section.ts";

const userPreferences = {
  categories: {
    approvalRequested: true,
    agentFinished: false,
    agentQuestion: false,
    humanMentioned: false,
    scheduledTaskFailed: false,
    backgroundTaskFailed: false,
  },
  detailLevel: "private" as const,
  quietHours: { enabled: false, startMinute: 1320, endMinute: 420, timeZone: "UTC" },
  agentIds: [],
};

describe("native notification test outcome", () => {
  it("renders pending immediately and disables duplicate sends", () => {
    const onSend = vi.fn();
    const container = document.createElement("div");

    render(
      renderNotificationsSection({
        connected: true,
        nativeNotifications: { permission: "granted", test: { state: "pending" } },
        onNativeNotificationsSendTest: onSend,
      }),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Sending test");
    button?.click();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders an actionable error without replacing granted permission", () => {
    const container = document.createElement("div");

    render(
      renderNotificationsSection({
        connected: true,
        nativeNotifications: {
          permission: "granted",
          test: { state: "error", message: "Open System Settings and try again." },
        },
      }),
      container,
    );

    expect(container.textContent).toContain("Granted");
    expect(container.textContent).toContain("Open System Settings and try again.");
    expect(container.querySelector(".settings-status--danger")).not.toBeNull();
  });

  it("renders queued success independently from permission", () => {
    const container = document.createElement("div");
    render(
      renderNotificationsSection({
        connected: true,
        nativeNotifications: { permission: "granted", test: { state: "sent" } },
      }),
      container,
    );

    expect(container.textContent).toContain("Granted");
    expect(container.textContent).toContain("Test notification queued");
  });
});

describe("Web Push preference saves", () => {
  it("lets recipients opt in to mentions and override them for one browser", () => {
    const container = document.createElement("div");
    const onUserPreferences = vi.fn();
    const onDevicePreferences = vi.fn();
    render(
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
      container,
    );

    const accountToggle = expectDefined(
      [...container.querySelectorAll<HTMLElement & { checked: boolean }>("wa-switch")].find(
        (toggle) => toggle.textContent?.trim() === "Someone mentions me",
      ),
      "mention account preference",
    );
    expect(accountToggle.checked).toBe(false);
    accountToggle.checked = true;
    accountToggle.dispatchEvent(new Event("change"));
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

    render(
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
      container,
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

type UserPreferencesListener = NonNullable<
  Parameters<typeof renderNotificationsSection>[0]["onWebPushSetUserPreferences"]
>;
type DevicePreferencesListener = NonNullable<
  Parameters<typeof renderNotificationsSection>[0]["onWebPushSetDevicePreferences"]
>;
type PreferencesRenderOptions = {
  onUser?: UserPreferencesListener;
  onDevice?: DevicePreferencesListener;
  userQuietHours?: Partial<WebPushNotificationPreferences["quietHours"]>;
  deviceQuietHours?: WebPushDevicePreferences["quietHours"];
};

describe("Web Push preference controls", () => {
  function renderPreferences(options: PreferencesRenderOptions = {}) {
    const container = document.createElement("div");
    const user: WebPushNotificationPreferences = {
      ...userPreferences,
      quietHours: { ...userPreferences.quietHours, enabled: true, ...options.userQuietHours },
    };
    const device: WebPushDevicePreferences = {
      enabled: true,
      label: "phone",
      agentIds: ["main"],
      quietHours: options.deviceQuietHours,
    };
    const rerender = (
      nextUser: WebPushNotificationPreferences = user,
      nextDevice: WebPushDevicePreferences = device,
    ) =>
      render(
        renderNotificationsSection({
          connected: true,
          onWebPushSetUserPreferences: options.onUser,
          onWebPushSetDevicePreferences: options.onDevice,
          webPush: {
            supported: true,
            permission: "granted",
            subscription: "registered",
            loading: false,
            preferences: {
              durableIdentity: true,
              user: nextUser,
              device: nextDevice,
              effective: {
                ...nextUser,
                enabled: nextDevice.enabled,
                label: nextDevice.label,
              },
            },
          },
        }),
        container,
      );
    rerender();
    return { container, device, rerender, user };
  }

  it("renders every preference control through the shared settings control set", () => {
    const { container } = renderPreferences();

    // Native checkboxes bypass the settings toggle; booleans are wa-switch rows.
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(container.querySelectorAll("wa-switch.settings-toggle")).toHaveLength(8);

    const unstyled = Array.from(container.querySelectorAll<HTMLElement>("select, input"))
      .filter((control) => {
        const expectedClass = control.tagName === "SELECT" ? "settings-select" : "settings-input";
        return !control.classList.contains(expectedClass) || !control.getAttribute("aria-label");
      })
      .map((control) => control.outerHTML.slice(0, 60));
    expect(container.querySelectorAll("select")).toHaveLength(11);
    expect(container.querySelectorAll('input[type="time"]')).toHaveLength(2);
    expect(unstyled).toEqual([]);
  });

  it("groups the quiet-hours controls below descriptive text and saves IANA timezone choices", () => {
    const onUser = vi.fn<UserPreferencesListener>();
    const { container } = renderPreferences({ onUser });
    const quietHours = expectDefined(
      container.querySelector<HTMLElement>(".quiet-hours-window"),
      "quiet-hours controls",
    );

    expect(quietHours.textContent).toContain("Quiet hours window");
    expect(quietHours.textContent).toContain("Time zone");
    expect(quietHours.previousElementSibling?.classList).toContain("settings-row--toggle");

    const timeZone = expectDefined(
      quietHours.querySelector<HTMLSelectElement>('select[aria-label="Time zone"]'),
      "quiet-hours timezone select",
    );
    expect(timeZone.querySelector('option[value="Pacific/Tahiti"]')?.textContent).toContain(
      "Tahiti Time",
    );

    timeZone.value = "Pacific/Tahiti";
    timeZone.dispatchEvent(new Event("change"));
    expect(onUser).toHaveBeenLastCalledWith({
      ...userPreferences,
      quietHours: { ...userPreferences.quietHours, enabled: true, timeZone: "Pacific/Tahiti" },
    });
  });

  it("preserves a saved account timezone alias when quiet hours reopen", () => {
    const { container, device, rerender, user } = renderPreferences({
      userQuietHours: { timeZone: "US/Pacific" },
    });
    const selectedTimeZone = () =>
      expectDefined(
        container.querySelector<HTMLSelectElement>(
          '.quiet-hours-window select[aria-label="Time zone"]',
        ),
        "account quiet-hours timezone select",
      );

    expect(selectedTimeZone().value).toBe("US/Pacific");
    expect(selectedTimeZone().selectedOptions[0]?.value).toBe("US/Pacific");

    rerender({ ...user, quietHours: { ...user.quietHours, enabled: false } }, device);
    expect(container.querySelector(".quiet-hours-window")).toBeNull();

    rerender(user, device);
    expect(selectedTimeZone().value).toBe("US/Pacific");
  });

  it("patches device preferences from the toggle row and select row", () => {
    const onDevice = vi.fn<DevicePreferencesListener>();
    const { container } = renderPreferences({ onDevice });
    const deviceGroup = expectDefined(
      container.querySelectorAll(".settings-page .settings-stack .settings-group")[1],
      "device preference group",
    );

    const toggle = expectDefined(
      deviceGroup.querySelector<HTMLElement & { checked: boolean }>("wa-switch"),
      "deliver toggle",
    );
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
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

  it("shows the saved device quiet-hours timezone override", () => {
    const { container } = renderPreferences({
      deviceQuietHours: {
        enabled: true,
        startMinute: 1320,
        endMinute: 420,
        timeZone: "US/Pacific",
      },
    });
    const deviceGroup = expectDefined(
      container.querySelectorAll(".settings-page .settings-stack .settings-group")[1],
      "device preference group",
    );
    const timeZone = expectDefined(
      deviceGroup.querySelector<HTMLSelectElement>(
        '.quiet-hours-window select[aria-label="Time zone"]',
      ),
      "device quiet-hours timezone select",
    );

    expect(timeZone.value).toBe("US/Pacific");
    expect(timeZone.selectedOptions[0]?.value).toBe("US/Pacific");
  });
});
