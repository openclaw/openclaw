/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import type { WebPushSnapshot } from "../../app/web-push.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { NotificationsSection } from "./notifications-section.tsx";

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

type NotificationProps = Parameters<typeof NotificationsSection>[0];
function renderSection(props: Partial<NotificationProps>) {
  return mountSolid(() => <NotificationsSection connected={true} {...props} />);
}

function webPush(
  loading = false,
  user = userPreferences,
  device: { enabled: boolean; label: string; agentIds?: string[] } = {
    enabled: true,
    label: "phone",
  },
): WebPushSnapshot {
  return {
    supported: true,
    canManage: true,
    canReadPreferences: true,
    permission: "granted",
    subscription: "registered",
    loading,
    preferences: {
      durableIdentity: true,
      user,
      device,
      effective: { ...user, ...device },
    },
  };
}

function select(container: Element, label: string) {
  return expectDefined(
    container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`),
    label,
  );
}

describe("native notification test outcome", () => {
  it("keeps the send affordance pending until the command settles", async () => {
    const completion = createDeferredCore<undefined>();
    const onSend = vi.fn(() => completion.promise);
    const { container } = renderSection({
      nativeNotifications: { permission: "granted", test: null },
      onNativeNotificationsSendTest: onSend,
    });
    const button = expectDefined(container.querySelector<HTMLButtonElement>("button"), "send");
    button.click();
    flush();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Sending test");
    expect(container.querySelector(".settings-status--accent")?.textContent).toContain(
      "Sending test",
    );
    expect(container.textContent).toContain("Test notification");
    button.click();
    expect(onSend).toHaveBeenCalledTimes(1);
    completion.resolve(undefined);
    await waitForSolid(() => {
      expect(button.disabled).toBe(false);
      expect(button.textContent).toContain("Send test");
    });
  });

  it("renders pending immediately and disables duplicate sends", () => {
    const onSend = vi.fn();
    const { container } = renderSection({
      nativeNotifications: { permission: "granted", test: { state: "pending" } },
      onNativeNotificationsSendTest: onSend,
    });

    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Sending test");
    button?.click();
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([
    { state: "error", message: "Open System Settings and try again." },
    { state: "sent", message: "Test notification queued" },
  ] as const)("renders $state independently from permission", ({ state, message }) => {
    const test = state === "sent" ? { state } : { state, message };
    const { container } = renderSection({ nativeNotifications: { permission: "granted", test } });
    expect(container.textContent).toContain("Granted");
    expect(container.textContent).toContain(message);
    if (state === "error") {
      expect(container.querySelector(".settings-status--danger")).not.toBeNull();
    }
  });
});

describe("Web Push preference saves", () => {
  it("lets recipients opt in to mentions and override them for one browser", () => {
    const onUserPreferences = vi.fn();
    const onDevicePreferences = vi.fn();
    const view = renderSection({
      webPush: webPush(),
      onWebPushSetUserPreferences: onUserPreferences,
      onWebPushSetDevicePreferences: onDevicePreferences,
    });
    const { container } = view;

    const accountToggle = view.getByRole("switch", { name: "Someone mentions me" });
    if (!(accountToggle instanceof HTMLInputElement)) {
      throw new Error("Expected the mention account preference switch");
    }
    expect(accountToggle.checked).toBe(false);
    accountToggle.click();
    expect(onUserPreferences).toHaveBeenCalledWith({
      ...userPreferences,
      categories: { ...userPreferences.categories, humanMentioned: true },
    });

    const browserOverride = select(container, "Someone mentions me");
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
    const { container } = renderSection({ webPush: webPush(true) });

    expect(container.querySelector(".settings-page .settings-page")).toBeNull();
    const group = expectDefined(
      container.querySelector(".settings-page .settings-stack"),
      "preferences",
    );
    expect(group.querySelector("input, select")).not.toBeNull();
    expect(group.hasAttribute("inert")).toBe(true);
  });
});

type DevicePreferencesListener = NonNullable<NotificationProps["onWebPushSetDevicePreferences"]>;

describe("Web Push preference controls", () => {
  function renderPreferences(
    options: {
      onDevice?: DevicePreferencesListener;
      onUser?: NotificationProps["onWebPushSetUserPreferences"];
      timeZone?: string;
    } = {},
  ) {
    const [timeZone, setTimeZone] = createSignal(options.timeZone ?? "UTC");
    const device = { enabled: true, label: "phone", agentIds: ["main"] };
    const mounted = renderSection({
      onWebPushSetDevicePreferences: options.onDevice,
      onWebPushSetUserPreferences: options.onUser,
      get webPush(): WebPushSnapshot {
        return webPush(
          false,
          {
            ...userPreferences,
            quietHours: { ...userPreferences.quietHours, enabled: true, timeZone: timeZone() },
          },
          device,
        );
      },
    });
    return { ...mounted, setTimeZone };
  }

  it("preserves a saved timezone alias and saves a native selection", () => {
    const onUser = vi.fn();
    const { container, setTimeZone } = renderPreferences({ onUser, timeZone: "US/Pacific" });
    const timeZone = select(container, "Time zone");
    expect(timeZone.value).toBe("US/Pacific");
    timeZone.value = "Europe/London";
    timeZone.dispatchEvent(new Event("change"));
    setTimeZone("Europe/London");
    flush();
    expect(timeZone.value).toBe("Europe/London");
    expect(container.querySelector('select[aria-label="Time zone"]')).toBe(timeZone);
    expect(onUser).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        quietHours: expect.objectContaining({ timeZone: "Europe/London" }),
      }),
    );
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

    const detail = select(deviceGroup, "Lock-screen detail");
    detail.value = "detailed";
    detail.dispatchEvent(new Event("change"));
    expect(onDevice).toHaveBeenLastCalledWith(expect.objectContaining({ detailLevel: "detailed" }));
  });
});
