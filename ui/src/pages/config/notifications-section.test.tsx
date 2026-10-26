/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
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
  const retired = new Promise<void>(() => {});
  return mountSolid(() => (
    <NotificationsSection connected={true} presentationRetired={() => retired} {...props} />
  ));
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

function change(control: HTMLSelectElement, value: string) {
  control.value = value;
  control.dispatchEvent(new Event("change"));
}

it("keeps the send affordance pending until the command settles", async () => {
  const completion = createDeferredCore<undefined>();
  const onSend = vi.fn(() => completion.promise);
  const { container } = renderSection({
    nativeNotifications: { permission: "granted", test: null },
    onNativeNotificationsSendTest: onSend,
  });
  const button = expectDefined(container.querySelector<HTMLButtonElement>("button"), "send");
  button.click();
  await waitForSolid(() => {
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Sending test");
  });
  expect(container.querySelector(".settings-status--accent")?.textContent).toContain(
    "Sending test",
  );
  expect(
    container
      .querySelector(".settings-status--accent")
      ?.closest(".settings-row")
      ?.hasAttribute("role"),
  ).toBe(false);
  expect(container.textContent).toContain("Test notification");
  button.click();
  expect(onSend).toHaveBeenCalledTimes(1);
  completion.resolve(undefined);
  await waitForSolid(() => {
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("Send test");
  });
});

it("announces a native test error without populating the success region", () => {
  const message = "Open System Settings and try again.";
  const { container } = renderSection({
    nativeNotifications: { permission: "granted", test: { state: "error", message } },
  });
  const announcement = expectDefined(container.querySelector('[role="alert"]'), "alert");
  expect(announcement.textContent).toContain(message);
  expect(container.querySelector('.sr-only[role="status"]')?.textContent).toBe("");
});

it("establishes the polite live region before announcing a successful test", async () => {
  const [native, setNative] = createSignal<NonNullable<NotificationProps["nativeNotifications"]>>({
    permission: "granted",
    test: { state: "pending" },
  });
  const { container } = renderSection({
    get nativeNotifications() {
      return native();
    },
  });
  const live = expectDefined(
    container.querySelector<HTMLElement>('.sr-only[role="status"][aria-live="polite"]'),
    "live status",
  );
  expect(live.textContent).toBe("");

  setNative({ permission: "granted", test: { state: "sent" } });
  await waitForSolid(() => {
    expect(live.textContent).toContain("Test notification queued");
  });

  expect(container.querySelector('.sr-only[role="status"]')).toBe(live);
  expect(
    Array.from(container.querySelectorAll<HTMLElement>(".settings-row[role]")).some((row) =>
      ["status", "alert"].includes(row.getAttribute("role") ?? ""),
    ),
  ).toBe(false);
});

it("retires a failed receipt during retry and preserves the send control", async () => {
  const message = "Open System Settings and try again.";
  const [native, setNative] = createSignal<NonNullable<NotificationProps["nativeNotifications"]>>({
    permission: "granted",
    test: { state: "error", message },
  });
  let completion = createDeferredCore<undefined>();
  const onSend = vi.fn(() => {
    setNative({ permission: "granted", test: { state: "pending" } });
    return completion.promise;
  });
  const { container } = renderSection({
    get nativeNotifications() {
      return native();
    },
    onNativeNotificationsSendTest: onSend,
  });
  const button = expectDefined(container.querySelector<HTMLButtonElement>("button"), "send");
  await waitForSolid(() => expect(container.textContent).toContain(message));
  expect(container.textContent).toContain("Granted");
  expect(container.querySelector(".settings-status--danger")).not.toBeNull();

  for (const result of [{ state: "error", message }, { state: "sent" }] as const) {
    button.click();
    await waitForSolid(() => {
      expect(container.textContent).not.toContain(message);
      expect(button.disabled).toBe(true);
      expect(container.querySelector(".settings-status--accent")?.textContent).toContain(
        "Sending test",
      );
    });
    button.click();
    expect(onSend).toHaveBeenCalledTimes(result.state === "error" ? 1 : 2);
    setNative({ permission: "granted", test: result });
    completion.resolve(undefined);
    await waitForSolid(() => {
      expect(button.disabled).toBe(false);
      expect(container.textContent).toContain(
        result.state === "error" ? message : "Test notification queued",
      );
    });
    completion = createDeferredCore<undefined>();
    expect(container.querySelector("button")).toBe(button);
  }
  expect(onSend).toHaveBeenCalledTimes(2);
});
it("saves account mentions with pending gating and a per-browser override", async () => {
  const completion = createDeferred();
  const onUserPreferences = vi.fn(() => completion.promise);
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

  const group = expectDefined(container.querySelector(".settings-stack"), "preferences");
  await waitForSolid(() => expect(group.hasAttribute("inert")).toBe(true));
  expect(group.querySelector("input, select")).not.toBeNull();
  expect(container.querySelector(".settings-page .settings-page")).toBeNull();
  completion.resolve();
  await waitForSolid(() => expect(group.hasAttribute("inert")).toBe(false));

  const browserOverride = select(container, "Someone mentions me");
  expect(browserOverride.value).toBe("inherit");
  change(browserOverride, "off");
  expect(onDevicePreferences).toHaveBeenLastCalledWith({
    enabled: true,
    label: "phone",
    categories: { humanMentioned: false },
  });
});

it("retires a rejected read when a replacement finishes", async () => {
  const failed = createDeferred();
  const replacement = createDeferred();
  const [current, setCurrent] = createSignal({ ...webPush(), read: failed.promise });
  const { container } = renderSection({
    get webPush() {
      return current();
    },
  });
  expect(container.querySelector(".settings-stack")).toBeNull();
  failed.reject(new Error("Example preferences unavailable"));
  await waitForSolid(() =>
    expect(container.textContent).toContain("Example preferences unavailable"),
  );
  setCurrent({ ...webPush(), read: replacement.promise });
  flush();
  replacement.resolve();
  await waitForSolid(() => expect(container.querySelector(".settings-stack")).not.toBeNull());
  expect(container.textContent).not.toContain("Example preferences unavailable");
});
it("keeps settings available after an admitted command rejects", async () => {
  const completion = createDeferred();
  const initial = webPush();
  const [current, setCurrent] = createSignal(initial);
  const view = renderSection({
    get webPush() {
      return current();
    },
    onWebPushTest: () => {
      setCurrent({ ...initial, loading: true });
      void completion.promise.catch(() => setCurrent({ ...initial, command: completion.promise }));
      return completion.promise;
    },
  });
  const send = view.getByRole("button", { name: "Send test" });
  send.click();
  await waitForSolid(() => expect(send.hasAttribute("disabled")).toBe(true));
  completion.reject(new Error("Example notification service is unavailable."));
  await waitForSolid(() =>
    expect(view.container.textContent).toContain("Example notification service is unavailable."),
  );
  expect(view.container.textContent).toContain("Browser support");
  expect(view.container.querySelectorAll(".cfg-field__error")).toHaveLength(1);
  expect(view.getByRole("button", { name: "Send test" }).hasAttribute("disabled")).toBe(false);
  expect(view.container.querySelector(".settings-stack")?.hasAttribute("inert")).toBe(false);
});

type DevicePreferencesListener = NonNullable<NotificationProps["onWebPushSetDevicePreferences"]>;

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
  change(timeZone, "Europe/London");
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
  change(detail, "detailed");
  expect(onDevice).toHaveBeenLastCalledWith(expect.objectContaining({ detailLevel: "detailed" }));
});
