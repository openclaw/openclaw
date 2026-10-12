/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import { createGatewayStoreTestStore } from "../../app/gateway-store.test-support.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import {
  createComposerContainer,
  createComposerProps as props,
  findComposerButton as button,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import * as realtimeTalkInput from "./talk/input.ts";

const discoverRealtimeTalkInputsMock = vi.fn();

beforeEach(() => {
  onTestFinished(installChatComposerPickerDismissal(document));
  vi.spyOn(realtimeTalkInput, "discoverRealtimeTalkInputs").mockImplementation(
    discoverRealtimeTalkInputsMock,
  );
});

afterEach(async () => {
  await resetComposerFixture(() => discoverRealtimeTalkInputsMock.mockReset());
});

type PickerDropdown = HTMLElement & { open: boolean; updateComplete: Promise<unknown> };

function mountPicker(composerProps: ReturnType<typeof props>) {
  const container = document.body.appendChild(createComposerContainer());
  const draw = () => render(renderChatComposer(composerProps), container);
  composerProps.onRequestUpdate = draw;
  draw();
  const dropdown = container.querySelector<PickerDropdown>("wa-dropdown.chat-talk-input-picker");
  return { container, dropdown, draw };
}

async function openPicker(container: HTMLElement) {
  const dropdown = container.querySelector<PickerDropdown>("wa-dropdown.chat-talk-input-picker");
  await dropdown?.updateComplete;
  button(container, t("chat.composer.microphoneInput")).click();
  await dropdown?.updateComplete;
  return dropdown;
}

describe("composer microphone picker", () => {
  it("opens the microphone picker, marks the selected input, and persists a selection", async () => {
    discoverRealtimeTalkInputsMock.mockResolvedValue({
      devices: [
        { deviceId: "studio-mic", label: "Studio microphone" },
        { deviceId: "headset", label: "USB headset" },
      ],
      issue: null,
    });
    const settings = patchSettings({ realtimeTalkInputDeviceId: "studio-mic" });
    const theme = createApplicationTheme(
      settings,
      createGatewayStoreTestStore({ settings }).gateway,
    );
    onTestFinished(() => theme.dispose());
    const container = createComposerContainer();
    document.body.append(container);
    const composerProps = props({ onToggleRealtimeTalk: vi.fn() });
    const draw = () => {
      composerProps.realtimeTalkInputDeviceId = theme.settings.realtimeTalkInputDeviceId;
      render(renderChatComposer(composerProps), container);
    };
    onTestFinished(theme.subscribe(draw));
    composerProps.onRequestUpdate = draw;
    draw();

    const dropdown = container.querySelector<
      HTMLElement & { open: boolean; updateComplete: Promise<unknown> }
    >("wa-dropdown.chat-talk-input-picker");
    await dropdown?.updateComplete;
    button(container, t("chat.composer.microphoneInput")).click();
    await dropdown?.updateComplete;

    expect(dropdown?.open).toBe(true);
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(3),
    );
    const items = [
      ...container.querySelectorAll<HTMLElement & { value: string }>(
        ".chat-talk-input-picker__item",
      ),
    ];
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      t("chat.composer.systemDefaultMicrophone"),
      "Studio microphone",
      "USB headset",
    ]);
    expect(items.map((item) => item.getAttribute("role"))).toEqual([
      "menuitemradio",
      "menuitemradio",
      "menuitemradio",
    ]);
    expect(items.find((item) => item.value === "studio-mic")?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(items.map((item) => item.getAttribute("type"))).toEqual(["normal", "normal", "normal"]);
    expect(
      items
        .find((item) => item.value === "studio-mic")
        ?.querySelector(".chat-talk-input-picker__check")
        ?.getAttribute("slot"),
    ).toBe("details");

    items.find((item) => item.value === "headset")?.click();
    await dropdown?.updateComplete;
    expect(loadSettings().realtimeTalkInputDeviceId).toBe("headset");
    expect(dropdown?.open).toBe(false);

    button(container, t("chat.composer.microphoneInput")).click();
    await vi.waitFor(() => expect(discoverRealtimeTalkInputsMock).toHaveBeenCalledTimes(2));
    expect(dropdown?.open).toBe(true);
    expect(
      [...container.querySelectorAll(".chat-talk-input-picker__item")].map((item) =>
        item.getAttribute("aria-checked"),
      ),
    ).toEqual(["false", "false", "true"]);
  });

  it("keeps the controlled hold-to-dictate preference in sync after toggling", async () => {
    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    patchSettings({ realtimeTalkInputDeviceId: "studio-mic" });
    const onComposerHoldToRecordChange = vi.fn((enabled: boolean) => {
      composerProps.composerHoldToRecord = patchSettings({
        composerHoldToRecord: enabled,
      }).composerHoldToRecord;
      draw();
    });
    const composerProps = props({
      composerHoldToRecord: true,
      realtimeTalkInputDeviceId: "studio-mic",
      onComposerHoldToRecordChange,
      onToggleRealtimeTalk: vi.fn(),
    });
    const { container, dropdown, draw } = mountPicker(composerProps);

    await openPicker(container);
    await dropdown?.updateComplete;

    const preference = container.querySelector<HTMLElement>(
      '.chat-talk-input-picker__preference[role="menuitemcheckbox"]',
    );
    expect(preference?.getAttribute("aria-checked")).toBe("true");
    preference?.click();
    await dropdown?.updateComplete;

    expect(onComposerHoldToRecordChange).toHaveBeenCalledWith(false);
    expect(loadSettings().composerHoldToRecord).toBe(false);
    expect(loadSettings().realtimeTalkInputDeviceId).toBe("studio-mic");
    expect(dropdown?.open).toBe(true);
    expect(
      container
        .querySelector<HTMLElement>('.chat-talk-input-picker__preference[role="menuitemcheckbox"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it.each([
    ["no providers during history admission", false, false, ["realtime", "dictation"]],
    ["voice only", true, false, ["dictation"]],
    ["transcription only", false, true, ["realtime"]],
    ["voice and transcription", true, true, []],
  ] as const)(
    "maps %s to available controls and settings",
    async (_name, realtimeReady, transcriptionReady, unavailableCapabilities) => {
      discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
      patchSettings({ realtimeTalkInputDeviceId: "studio-mic" });
      const request = vi.fn(async (method: string) => {
        if (method === "talk.catalog") {
          return {
            realtime: { ready: realtimeReady, providers: [] },
            transcription: { ready: transcriptionReady, providers: [] },
          };
        }
        throw new Error(`unexpected request: ${method}`);
      });
      const gatewayClient = { request } as unknown as GatewayBrowserClient;
      const onToggleRealtimeTalk = vi.fn();
      const onOpenTalkSettings = vi.fn();
      const onOpenDictationSettings = vi.fn();
      const pending = !realtimeReady && !transcriptionReady;
      const composerProps = props({
        gatewayClient,
        submitDisabledReason: pending ? t("chat.thread.loading") : undefined,
        realtimeTalkInputDeviceId: "studio-mic",
        onOpenTalkSettings: pending ? onOpenTalkSettings : undefined,
        onOpenDictationSettings: pending ? onOpenDictationSettings : undefined,
        onToggleRealtimeTalk,
      });
      const { container, dropdown } = mountPicker(composerProps);

      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("talk.catalog", {}));
      await vi.waitFor(() =>
        expect(
          [...container.querySelectorAll<HTMLElement>("[data-chat-talk-capability]")].map(
            (entry) => entry.dataset.chatTalkCapability,
          ),
        ).toEqual(unavailableCapabilities),
      );
      if (!pending) {
        return;
      }
      await vi.waitFor(() =>
        expect(
          container.querySelectorAll('[data-chat-talk-capability][data-status="unavailable"]'),
        ).toHaveLength(2),
      );
      const voiceTooltip = container.querySelector<HTMLElement & { content?: string }>(
        ".chat-talk-control > openclaw-tooltip",
      );
      expect(container.querySelector(".chat-talk-control__capability-alert")).toBeNull();
      expect(voiceTooltip?.content).toBe(
        `${t("chat.thread.loading")} · ${t("chat.composer.voiceGestureHint")}`,
      );
      const capabilityAlerts = [
        ...container.querySelectorAll<HTMLElement>(
          '.chat-talk-input-picker__capability[data-status="unavailable"] .chat-talk-input-picker__capability-alert',
        ),
      ];
      expect(capabilityAlerts).toHaveLength(2);
      expect(
        capabilityAlerts.every((alert) =>
          alert.parentElement?.matches(".chat-talk-input-picker__capability-copy strong"),
        ),
      ).toBe(true);
      button(container, t("chat.composer.startVoiceInput")).click();
      await vi.waitFor(() => expect(dropdown?.open).toBe(true));

      expect(onToggleRealtimeTalk).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledWith("talk.catalog", {});
      expect(request).not.toHaveBeenCalledWith("talk.client.create", expect.anything());
      expect(container.textContent).toContain(t("chat.composer.realtimeTalkProviderUnavailable"));
      expect(container.textContent).toContain(t("chat.composer.dictationProviderUnavailableShort"));

      const settingsLabels = [
        ...container.querySelectorAll<HTMLElement>(".chat-talk-input-picker__settings"),
      ];
      expect(settingsLabels.map((entry) => entry.textContent?.trim())).toEqual([
        t("chat.composer.configureCapability"),
        t("chat.composer.configureCapability"),
      ]);
      expect(settingsLabels.every((entry) => entry.querySelector("svg") !== null)).toBe(true);
      const settingsItems = [
        ...container.querySelectorAll<HTMLElement>("[data-chat-talk-capability]"),
      ];
      expect(settingsItems.map((item) => item.getAttribute("role"))).toEqual([
        "menuitem",
        "menuitem",
      ]);
      settingsItems[0]?.click();
      expect(onOpenTalkSettings).toHaveBeenCalledOnce();
      expect(onOpenDictationSettings).not.toHaveBeenCalled();
      settingsItems[1]?.click();
      expect(onOpenDictationSettings).toHaveBeenCalledOnce();
      expect(loadSettings().realtimeTalkInputDeviceId).toBe("studio-mic");
      expect(dropdown?.open).toBe(true);
    },
  );

  it.each([
    ["none-found", "chat.composer.microphoneNoneFound", false, false],
    ["list-unsupported", "chat.composer.microphoneListUnsupported", false, false],
    ["permission-blocked", "chat.composer.microphonePermissionBlocked", true, false],
    ["busy", "chat.composer.microphoneBusy", true, false],
    ["page-inactive", "chat.composer.microphonePageInactive", true, false],
    ["failed", "chat.composer.microphoneAccessFailed", true, false],
    ["busy", "chat.composer.microphoneBusy", true, true],
  ] as const)(
    "renders %s (%s, fault=%s, available inputs=%s)",
    async (issue, messageKey, fault, hasInputs) => {
      discoverRealtimeTalkInputsMock.mockResolvedValue({
        devices: hasInputs ? [{ deviceId: "headset", label: "USB headset" }] : [],
        issue,
      });
      const { container, dropdown } = mountPicker(
        props({
          onToggleRealtimeTalk: vi.fn(),
          realtimeTalkActive: true,
          realtimeTalkStatus: "listening",
        }),
      );
      await openPicker(container);
      if (hasInputs) {
        await vi.waitFor(() =>
          expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(2),
        );
        expect(
          [...container.querySelectorAll(".chat-talk-input-picker__item")].map((item) =>
            item.getAttribute("aria-checked"),
          ),
        ).toEqual(["true", "false"]);
        expect(
          container.querySelector(".chat-talk-input-picker__warning")?.textContent?.trim(),
        ).toBe(t(messageKey));
        expect(container.querySelector(".chat-talk-input-picker__empty")).toBeNull();
        expect(container.querySelector(".chat-talk-input-picker__hint")?.textContent).toContain(
          t("chat.composer.microphoneAppliesNextSession"),
        );
        dropdown?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await dropdown?.updateComplete;
        expect(dropdown?.open).toBe(false);
      } else {
        const empty = await vi.waitFor(() => {
          const node = container.querySelector(".chat-talk-input-picker__empty");
          expect(node?.textContent?.trim()).toBe(t(messageKey));
          return node;
        });
        expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(0);
        expect(container.querySelector(".chat-talk-input-picker__note")).toBeNull();
        expect(container.querySelector(".chat-talk-input-picker__warning")).toBeNull();
        expect(container.querySelector(".chat-talk-input-picker__hint")).toBeNull();
        expect(container.querySelectorAll(".chat-talk-input-picker__empty")).toHaveLength(1);
        expect(empty?.getAttribute("role")).toBe("status");
        expect(empty?.classList.contains("chat-talk-input-picker__empty--fault")).toBe(fault);
      }
    },
  );

  it("follows devicechange while open and stops listening once closed", async () => {
    const mediaDevices = new EventTarget();
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });
    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    const composerProps = props({ onToggleRealtimeTalk: vi.fn() });
    const { container, dropdown } = mountPicker(composerProps);

    await openPicker(container);
    await vi.waitFor(() =>
      expect(container.querySelector(".chat-talk-input-picker__empty")?.textContent?.trim()).toBe(
        t("chat.composer.microphoneNoneFound"),
      ),
    );

    // The empty state promises the list keeps up, so plugging in has to land
    // without reopening the popover.
    discoverRealtimeTalkInputsMock.mockResolvedValue({
      devices: [{ deviceId: "usb", label: "USB Audio Interface" }],
      issue: null,
    });
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(2),
    );
    expect(container.querySelector(".chat-talk-input-picker__empty")).toBeNull();

    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(0),
    );

    dropdown?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await dropdown?.updateComplete;
    const callsWhileClosed = discoverRealtimeTalkInputsMock.mock.calls.length;
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await Promise.resolve();
    expect(discoverRealtimeTalkInputsMock.mock.calls.length).toBe(callsWhileClosed);
  });
});
