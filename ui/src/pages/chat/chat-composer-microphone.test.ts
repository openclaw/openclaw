/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import { createGatewayStoreTestStore } from "../../app/gateway-store.test-support.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import {
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
    const container = document.createElement("div");
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
    expect(
      items
        .find((item) => item.value === "studio-mic")
        ?.querySelector(".chat-talk-input-picker__check"),
    ).not.toBeNull();

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
    const container = document.createElement("div");
    document.body.append(container);
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
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();

    const dropdown = container.querySelector<
      HTMLElement & { open: boolean; updateComplete: Promise<unknown> }
    >("wa-dropdown.chat-talk-input-picker");
    await dropdown?.updateComplete;
    button(container, t("chat.composer.microphoneInput")).click();
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

  it("gates unavailable voice capabilities before starting and routes to Talk Settings", async () => {
    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    patchSettings({ realtimeTalkInputDeviceId: "studio-mic" });
    const request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        return {
          realtime: { ready: false, providers: [] },
          transcription: { ready: false, providers: [] },
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const gatewayClient = { request } as unknown as GatewayBrowserClient;
    const onToggleRealtimeTalk = vi.fn();
    const onOpenTalkSettings = vi.fn();
    const onOpenDictationSettings = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const composerProps = props({
      gatewayClient,
      realtimeTalkInputDeviceId: "studio-mic",
      onOpenTalkSettings,
      onOpenDictationSettings,
      onToggleRealtimeTalk,
    });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();

    await vi.waitFor(() =>
      expect(
        container.querySelectorAll('[data-chat-talk-capability][data-status="unavailable"]'),
      ).toHaveLength(2),
    );
    const voiceTooltip = container.querySelector<HTMLElement & { content?: string }>(
      ".chat-talk-control > openclaw-tooltip",
    );
    expect(container.querySelector(".chat-talk-control__capability-alert")).toBeNull();
    expect(voiceTooltip?.content).toBe(t("chat.composer.voiceGestureHint"));
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
    const dropdown = container.querySelector<HTMLElement & { open: boolean }>(
      "wa-dropdown.chat-talk-input-picker",
    );
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
  });

  it.each([
    ["no providers", false, false, ["realtime", "dictation"]],
    ["voice only", true, false, ["dictation"]],
    ["transcription only", false, true, ["realtime"]],
    ["voice and transcription", true, true, []],
  ] as const)(
    "maps the %s catalog to independent visible capability outcomes",
    async (_name, realtimeReady, transcriptionReady, unavailableCapabilities) => {
      discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
      const request = vi.fn(async (method: string) => {
        if (method === "talk.catalog") {
          return {
            realtime: { ready: realtimeReady, providers: [] },
            transcription: { ready: transcriptionReady, providers: [] },
          };
        }
        throw new Error(`unexpected request: ${method}`);
      });
      const container = document.createElement("div");
      document.body.append(container);
      const composerProps = props({
        gatewayClient: { request } as unknown as GatewayBrowserClient,
        onToggleRealtimeTalk: vi.fn(),
      });
      const draw = () => render(renderChatComposer(composerProps), container);
      composerProps.onRequestUpdate = draw;
      draw();

      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("talk.catalog", {}));
      await vi.waitFor(() =>
        expect(
          [...container.querySelectorAll<HTMLElement>("[data-chat-talk-capability]")].map(
            (entry) => entry.dataset.chatTalkCapability,
          ),
        ).toEqual(unavailableCapabilities),
      );
    },
  );

  it.each([
    ["none-found", "chat.composer.microphoneNoneFound", false],
    ["list-unsupported", "chat.composer.microphoneListUnsupported", false],
    ["permission-blocked", "chat.composer.microphonePermissionBlocked", true],
    ["busy", "chat.composer.microphoneBusy", true],
    ["page-inactive", "chat.composer.microphonePageInactive", true],
    ["failed", "chat.composer.microphoneAccessFailed", true],
  ] as const)(
    "renders %s as one empty state with no claimed selection",
    async (issue, messageKey, fault) => {
      discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue });
      const container = document.createElement("div");
      document.body.append(container);
      const composerProps = props({
        onToggleRealtimeTalk: vi.fn(),
        realtimeTalkActive: true,
        realtimeTalkStatus: "listening",
      });
      const draw = () => render(renderChatComposer(composerProps), container);
      composerProps.onRequestUpdate = draw;
      draw();

      const dropdown = container.querySelector<
        HTMLElement & { open: boolean; updateComplete: Promise<unknown> }
      >("wa-dropdown.chat-talk-input-picker");
      await dropdown?.updateComplete;
      button(container, t("chat.composer.microphoneInput")).click();
      const empty = await vi.waitFor(() => {
        const node = container.querySelector(".chat-talk-input-picker__empty");
        expect(node?.textContent?.trim()).toBe(t(messageKey));
        return node;
      });

      // One designed state: never a checked System default row, a second
      // negative note, or a hint about a selection that cannot be made.
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(0);
      expect(container.querySelector(".chat-talk-input-picker__note")).toBeNull();
      expect(container.querySelector(".chat-talk-input-picker__warning")).toBeNull();
      expect(container.querySelector(".chat-talk-input-picker__hint")).toBeNull();
      expect(container.querySelectorAll(".chat-talk-input-picker__empty")).toHaveLength(1);
      expect(empty?.getAttribute("role")).toBe("status");
      expect(empty?.classList.contains("chat-talk-input-picker__empty--fault")).toBe(fault);
    },
  );

  it("keeps the list plus one warning when inputs exist but discovery reported an issue", async () => {
    discoverRealtimeTalkInputsMock.mockResolvedValue({
      devices: [{ deviceId: "headset", label: "USB headset" }],
      issue: "busy",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const composerProps = props({
      onToggleRealtimeTalk: vi.fn(),
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
    });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();

    const dropdown = container.querySelector<
      HTMLElement & { open: boolean; updateComplete: Promise<unknown> }
    >("wa-dropdown.chat-talk-input-picker");
    await dropdown?.updateComplete;
    button(container, t("chat.composer.microphoneInput")).click();
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(2),
    );

    expect(container.querySelector(".chat-talk-input-picker__warning")?.textContent?.trim()).toBe(
      t("chat.composer.microphoneBusy"),
    );
    expect(container.querySelector(".chat-talk-input-picker__empty")).toBeNull();
    expect(container.querySelector(".chat-talk-input-picker__hint")?.textContent).toContain(
      t("chat.composer.microphoneAppliesNextSession"),
    );

    dropdown?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await dropdown?.updateComplete;
    expect(dropdown?.open).toBe(false);
  });

  it("marks the selected input with a single trailing check", async () => {
    discoverRealtimeTalkInputsMock.mockResolvedValue({
      devices: [{ deviceId: "headset", label: "USB headset" }],
      issue: null,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const composerProps = props({ onToggleRealtimeTalk: vi.fn() });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();

    const dropdown = container.querySelector<
      HTMLElement & { open: boolean; updateComplete: Promise<unknown> }
    >("wa-dropdown.chat-talk-input-picker");
    await dropdown?.updateComplete;
    button(container, t("chat.composer.microphoneInput")).click();
    const items = await vi.waitFor(() => {
      const rows = [...container.querySelectorAll(".chat-talk-input-picker__item")];
      expect(rows).toHaveLength(2);
      return rows;
    });

    // type="checkbox" would make wa-dropdown-item paint its own leading check
    // and toggle it on click, so the row would show two disagreeing marks.
    expect(items.map((item) => item.getAttribute("type"))).toEqual(["normal", "normal"]);
    expect(items[0]?.querySelector(".chat-talk-input-picker__check")?.getAttribute("slot")).toBe(
      "details",
    );
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("follows devicechange while open and stops listening once closed", async () => {
    const mediaDevices = new EventTarget();
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });
    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    const container = document.createElement("div");
    document.body.append(container);
    const composerProps = props({ onToggleRealtimeTalk: vi.fn() });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();

    const dropdown = container.querySelector<
      HTMLElement & { open: boolean; updateComplete: Promise<unknown> }
    >("wa-dropdown.chat-talk-input-picker");
    await dropdown?.updateComplete;
    button(container, t("chat.composer.microphoneInput")).click();
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
