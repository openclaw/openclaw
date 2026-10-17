/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import { createGatewayStoreTestStore } from "../../app/gateway-store.test-support.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps as props,
  findComposerButton as button,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
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

async function mountedPicker(container: HTMLElement) {
  return waitForSolid(() => {
    const dropdown = container.querySelector<HTMLElement>(".chat-talk-input-picker");
    expect(dropdown).not.toBeNull();
    return dropdown!;
  });
}

async function mountPicker(composerProps: ReturnType<typeof props>) {
  const container = document.body.appendChild(createComposerContainer());
  const draw = () => renderComposerInto(container, composerProps);
  draw();
  const dropdown = await mountedPicker(container);
  return { container, dropdown, draw };
}

async function openPicker(container: HTMLElement) {
  const dropdown = await mountedPicker(container);
  button(container, t("chat.composer.microphoneInput")).click();
  await waitForSolid(() => expect(dropdown.hasAttribute("open")).toBe(true));
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
      renderComposerInto(container, composerProps);
    };
    onTestFinished(theme.subscribe(draw));
    draw();

    const dropdown = await mountedPicker(container);
    expect(dropdown?.hasAttribute("open")).toBe(false);
    expect(dropdown?.querySelector(".chat-talk-input-picker__item")).toBeNull();
    await openPicker(container);

    expect(dropdown?.hasAttribute("open")).toBe(true);
    await waitForSolid(() =>
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(3),
    );
    const items = [
      ...container.querySelectorAll<HTMLButtonElement>(".chat-talk-input-picker__item"),
    ];
    expect(
      items.map((item) => item.querySelector(".chat-talk-input-picker__label")?.textContent),
    ).toEqual([t("chat.composer.systemDefaultMicrophone"), "Studio microphone", "USB headset"]);
    expect(items.map((item) => item.getAttribute("role"))).toEqual([
      "menuitemradio",
      "menuitemradio",
      "menuitemradio",
    ]);
    expect(items.find((item) => item.value === "studio-mic")?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      items
        .find((item) => item.value === "studio-mic")
        ?.querySelector(".chat-talk-input-picker__check")
        ?.querySelector("svg"),
    ).toBeInstanceOf(SVGElement);

    await waitForSolid(() =>
      expect(dropdown.querySelector("[data-menu-content]")?.getAttribute("data-phase")).toBe(
        "open",
      ),
    );
    const focused = items.find((item) => item.value === "studio-mic")!;
    focused.focus();
    composerProps.composerHoldToRecord = false;
    draw();
    await waitForSolid(() => {
      expect(
        container
          .querySelector(".chat-talk-input-picker__preference")
          ?.getAttribute("aria-checked"),
      ).toBe("false");
      expect(container.querySelector('[value="studio-mic"]')).toBe(focused);
      expect(document.activeElement).toBe(focused);
    });

    items.find((item) => item.value === "headset")?.click();
    await waitForSolid(() => expect(loadSettings().realtimeTalkInputDeviceId).toBe("headset"));
    await waitForSolid(() => expect(dropdown?.hasAttribute("open")).toBe(false));

    button(container, t("chat.composer.microphoneInput")).click();
    await waitForSolid(() => expect(discoverRealtimeTalkInputsMock).toHaveBeenCalledTimes(2));
    expect(dropdown?.hasAttribute("open")).toBe(true);
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
    const { container, dropdown, draw } = await mountPicker(composerProps);

    await openPicker(container);

    const preference = container.querySelector<HTMLElement>(
      '.chat-talk-input-picker__preference[role="menuitemcheckbox"]',
    );
    expect(preference?.getAttribute("aria-checked")).toBe("true");
    preference?.click();

    await waitForSolid(() => expect(onComposerHoldToRecordChange).toHaveBeenCalledWith(false));
    expect(loadSettings().composerHoldToRecord).toBe(false);
    expect(loadSettings().realtimeTalkInputDeviceId).toBe("studio-mic");
    expect(dropdown?.hasAttribute("open")).toBe(true);
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
        if (method === "talk.config") {
          return { config: {} };
        }
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
      const { container, dropdown } = await mountPicker(composerProps);

      await waitForSolid(() =>
        expect(request).toHaveBeenCalledWith("talk.catalog", { sessionKey: "main" }),
      );
      expect(dropdown?.hasAttribute("open")).toBe(false);
      expect(dropdown?.querySelector("[data-chat-talk-capability]")).toBeNull();
      if (pending) {
        button(container, t("chat.composer.startVoiceInput")).click();
      } else {
        await openPicker(container);
      }
      await waitForSolid(() =>
        expect(
          [...container.querySelectorAll<HTMLElement>("[data-chat-talk-capability]")].map(
            (entry) => entry.dataset.chatTalkCapability,
          ),
        ).toEqual(unavailableCapabilities),
      );
      if (!pending) {
        return;
      }
      await waitForSolid(() =>
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
      await waitForSolid(() => expect(dropdown?.hasAttribute("open")).toBe(true));

      expect(onToggleRealtimeTalk).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledWith("talk.catalog", { sessionKey: "main" });
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
      await waitForSolid(() => expect(onOpenTalkSettings).toHaveBeenCalledOnce());
      expect(onOpenDictationSettings).not.toHaveBeenCalled();
      settingsItems[1]?.click();
      await waitForSolid(() => expect(onOpenDictationSettings).toHaveBeenCalledOnce());
      expect(loadSettings().realtimeTalkInputDeviceId).toBe("studio-mic");
      expect(dropdown?.hasAttribute("open")).toBe(true);
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
      const { container, dropdown } = await mountPicker(
        props({
          onToggleRealtimeTalk: vi.fn(),
          realtimeTalkActive: true,
          realtimeTalkStatus: "listening",
        }),
      );
      await openPicker(container);
      if (hasInputs) {
        await waitForSolid(() =>
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
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await waitForSolid(() => expect(dropdown?.hasAttribute("open")).toBe(false));
      } else {
        const empty = await waitForSolid(() => {
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
    const { container, dropdown } = await mountPicker(composerProps);

    await openPicker(container);
    await waitForSolid(() =>
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
    await waitForSolid(() =>
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(2),
    );
    expect(container.querySelector(".chat-talk-input-picker__empty")).toBeNull();

    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await waitForSolid(() =>
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(0),
    );

    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await waitForSolid(() => expect(dropdown?.hasAttribute("open")).toBe(false));
    const callsWhileClosed = discoverRealtimeTalkInputsMock.mock.calls.length;
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await Promise.resolve();
    expect(discoverRealtimeTalkInputsMock.mock.calls.length).toBe(callsWhileClosed);
  });
});
