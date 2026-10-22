/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import { createGatewayStoreTestStore } from "../../app/gateway-store.test-support.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps,
  findComposerButton as button,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import * as realtimeTalkInput from "./talk/input.ts";

const discover = vi.fn();
const copy = (key: string) => t(`chat.composer.${key}`);
const emptyDevices = { devices: [], issue: "none-found" };
const studio = { deviceId: "studio-mic", label: "Studio microphone" };
const headset = { deviceId: "headset", label: "USB headset" };
beforeEach(() => {
  onTestFinished(installChatComposerPickerDismissal(document));
  vi.spyOn(realtimeTalkInput, "discoverRealtimeTalkInputs").mockImplementation(discover);
});
afterEach(() => resetComposerFixture(() => discover.mockReset()));

async function mountPicker(
  overrides: Parameters<typeof createComposerProps>[0] = {},
  beforeDraw?: (props: ReturnType<typeof createComposerProps>) => void,
) {
  const root = document.body.appendChild(createComposerContainer());
  const props = createComposerProps({ onToggleRealtimeTalk: vi.fn(), ...overrides });
  const all = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const part = (name: string) =>
    root.querySelector<HTMLElement>(`.chat-talk-input-picker__${name}`);
  const items = () => all(".chat-talk-input-picker__item");
  const draw = () => {
    beforeDraw?.(props);
    renderComposerInto(root, props);
  };
  draw();
  const dropdown = await waitForSolid(() => {
    const node = root.querySelector<HTMLElement>(".chat-talk-input-picker");
    expect(node).not.toBeNull();
    return node!;
  });
  const expectOpen = (open: boolean) =>
    waitForSolid(() => expect(dropdown.hasAttribute("open")).toBe(open));
  const open = async () => {
    button(root, copy("microphoneInput")).click();
    await expectOpen(true);
  };
  const escape = async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await expectOpen(false);
  };
  const count = (n: number) => waitForSolid(() => expect(items()).toHaveLength(n));
  const checked = () => items().map((item) => item.getAttribute("aria-checked"));
  return {
    root,
    props,
    dropdown,
    all,
    part,
    items,
    draw,
    open,
    escape,
    expectOpen,
    count,
    checked,
  };
}

function catalogClient(realtime: boolean, transcription: boolean) {
  const request = vi.fn(async (method: string) => {
    if (method === "talk.config") {
      return { config: {} };
    }
    if (method === "talk.catalog") {
      return {
        realtime: { ready: realtime, providers: [] },
        transcription: { ready: transcription, providers: [] },
      };
    }
    throw new Error(`unexpected request: ${method}`);
  });
  return { request, gatewayClient: { request } as unknown as GatewayBrowserClient };
}

it("persists microphone selection and preserves focused items across redraws", async () => {
  discover.mockResolvedValue({ devices: [studio, headset], issue: null });
  const settings = patchSettings({ realtimeTalkInputDeviceId: studio.deviceId });
  const theme = createApplicationTheme(settings, createGatewayStoreTestStore({ settings }).gateway);
  onTestFinished(() => theme.dispose());
  const v = await mountPicker({}, (props) => {
    props.realtimeTalkInputDeviceId = theme.settings.realtimeTalkInputDeviceId;
  });
  onTestFinished(theme.subscribe(v.draw));
  expect(v.dropdown.hasAttribute("open")).toBe(false);
  expect(v.part("item")).toBeNull();
  await v.open();
  await v.count(3);
  const choices = v.items();
  expect(
    choices.map((item) => item.querySelector(".chat-talk-input-picker__label")?.textContent),
  ).toEqual([copy("systemDefaultMicrophone"), studio.label, headset.label]);
  expect(choices.map((item) => item.getAttribute("role"))).toEqual([
    "menuitemradio",
    "menuitemradio",
    "menuitemradio",
  ]);
  const focused = v.root.querySelector<HTMLButtonElement>('[value="studio-mic"]')!;
  expect(focused.getAttribute("aria-checked")).toBe("true");
  expect(focused.querySelector(".chat-talk-input-picker__check svg")).toBeInstanceOf(SVGElement);
  await waitForSolid(() =>
    expect(v.dropdown.querySelector("[data-menu-content]")?.getAttribute("data-phase")).toBe(
      "open",
    ),
  );
  focused.focus();
  v.props.composerHoldToRecord = false;
  v.draw();
  await waitForSolid(() => {
    expect(v.part("preference")?.getAttribute("aria-checked")).toBe("false");
    expect(v.root.querySelector('[value="studio-mic"]')).toBe(focused);
    expect(document.activeElement).toBe(focused);
  });
  v.root.querySelector<HTMLButtonElement>('[value="headset"]')!.click();
  await waitForSolid(() => expect(loadSettings().realtimeTalkInputDeviceId).toBe("headset"));
  await v.expectOpen(false);
  await v.open();
  await waitForSolid(() => expect(discover).toHaveBeenCalledTimes(2));
  expect(v.checked()).toEqual(["false", "false", "true"]);
});

it("keeps hold-to-dictate controlled without changing the selected microphone", async () => {
  discover.mockResolvedValue(emptyDevices);
  patchSettings({ realtimeTalkInputDeviceId: studio.deviceId });
  const onComposerHoldToRecordChange = vi.fn((enabled: boolean) => {
    v.props.composerHoldToRecord = patchSettings({
      composerHoldToRecord: enabled,
    }).composerHoldToRecord;
    v.draw();
  });
  const v = await mountPicker({
    composerHoldToRecord: true,
    realtimeTalkInputDeviceId: studio.deviceId,
    onComposerHoldToRecordChange,
  });
  await v.open();
  const preference = () => v.part('preference[role="menuitemcheckbox"]');
  expect(preference()?.getAttribute("aria-checked")).toBe("true");
  preference()?.click();
  await waitForSolid(() => expect(onComposerHoldToRecordChange).toHaveBeenCalledWith(false));
  expect(loadSettings()).toMatchObject({
    composerHoldToRecord: false,
    realtimeTalkInputDeviceId: studio.deviceId,
  });
  expect(v.dropdown.hasAttribute("open")).toBe(true);
  expect(preference()?.getAttribute("aria-checked")).toBe("false");
});

it.each([
  ["history admission", false, false, ["realtime", "dictation"]],
  ["voice only", true, false, ["dictation"]],
  ["transcription only", false, true, ["realtime"]],
  ["both", true, true, []],
] as const)(
  "maps %s to capability controls",
  async (_name, realtime, transcription, unavailable) => {
    discover.mockResolvedValue(emptyDevices);
    patchSettings({ realtimeTalkInputDeviceId: studio.deviceId });
    const { request, gatewayClient } = catalogClient(realtime, transcription);
    const onToggleRealtimeTalk = vi.fn();
    const onOpenTalkSettings = vi.fn();
    const onOpenDictationSettings = vi.fn();
    const pending = !realtime && !transcription;
    const v = await mountPicker({
      gatewayClient,
      realtimeTalkInputDeviceId: studio.deviceId,
      onToggleRealtimeTalk,
      submitDisabledReason: pending ? t("chat.thread.loading") : undefined,
      onOpenTalkSettings: pending ? onOpenTalkSettings : undefined,
      onOpenDictationSettings: pending ? onOpenDictationSettings : undefined,
    });
    const capabilities = () => v.all("[data-chat-talk-capability]");
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("talk.catalog", { sessionKey: "main" }),
    );
    expect(v.dropdown.hasAttribute("open")).toBe(false);
    expect(v.dropdown.querySelector("[data-chat-talk-capability]")).toBeNull();
    if (pending) {
      button(v.root, copy("startVoiceInput")).click();
    } else {
      await v.open();
    }
    await waitForSolid(() =>
      expect(capabilities().map((entry) => entry.dataset.chatTalkCapability)).toEqual(unavailable),
    );
    if (!pending) {
      return;
    }
    await waitForSolid(() =>
      expect(v.all('[data-chat-talk-capability][data-status="unavailable"]')).toHaveLength(2),
    );
    const tooltip = v.root.querySelector<HTMLElement & { content?: string }>(
      ".chat-talk-control > openclaw-tooltip",
    );
    expect(v.root.querySelector(".chat-talk-control__capability-alert")).toBeNull();
    expect(tooltip?.content).toBe(`${t("chat.thread.loading")} · ${copy("voiceGestureHint")}`);
    const alerts = v.all(
      '.chat-talk-input-picker__capability[data-status="unavailable"] .chat-talk-input-picker__capability-alert',
    );
    expect(alerts).toHaveLength(2);
    expect(
      alerts.every((alert) =>
        alert.parentElement?.matches(".chat-talk-input-picker__capability-copy strong"),
      ),
    ).toBe(true);
    await v.expectOpen(true);
    expect(onToggleRealtimeTalk).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("talk.catalog", { sessionKey: "main" });
    expect(request).not.toHaveBeenCalledWith("talk.client.create", expect.anything());
    expect(v.root.textContent).toContain(copy("realtimeTalkProviderUnavailable"));
    expect(v.root.textContent).toContain(copy("dictationProviderUnavailableShort"));
    const labels = v.all(".chat-talk-input-picker__settings");
    expect(labels.map((entry) => entry.textContent?.trim())).toEqual([
      copy("configureCapability"),
      copy("configureCapability"),
    ]);
    expect(labels.every((entry) => entry.querySelector("svg") !== null)).toBe(true);
    const settingsItems = capabilities();
    expect(settingsItems.map((item) => item.getAttribute("role"))).toEqual([
      "menuitem",
      "menuitem",
    ]);
    settingsItems[0]?.click();
    await waitForSolid(() => expect(onOpenTalkSettings).toHaveBeenCalledOnce());
    expect(onOpenDictationSettings).not.toHaveBeenCalled();
    settingsItems[1]?.click();
    await waitForSolid(() => expect(onOpenDictationSettings).toHaveBeenCalledOnce());
    expect(loadSettings().realtimeTalkInputDeviceId).toBe(studio.deviceId);
    expect(v.dropdown.hasAttribute("open")).toBe(true);
  },
);

it.each([
  ["none-found", "microphoneNoneFound", false, false],
  ["list-unsupported", "microphoneListUnsupported", false, false],
  ["permission-blocked", "microphonePermissionBlocked", true, false],
  ["busy", "microphoneBusy", true, false],
  ["page-inactive", "microphonePageInactive", true, false],
  ["failed", "microphoneAccessFailed", true, false],
  ["busy", "microphoneBusy", true, true],
] as const)("renders %s (%s, fault=%s, inputs=%s)", async (issue, messageKey, fault, hasInputs) => {
  discover.mockResolvedValue({ devices: hasInputs ? [headset] : [], issue });
  const v = await mountPicker({ realtimeTalkActive: true, realtimeTalkStatus: "listening" });
  await v.open();
  if (hasInputs) {
    await v.count(2);
    expect(v.checked()).toEqual(["true", "false"]);
    expect(v.part("warning")?.textContent?.trim()).toBe(copy(messageKey));
    expect(v.part("empty")).toBeNull();
    expect(v.part("hint")?.textContent).toContain(copy("microphoneAppliesNextSession"));
    await v.escape();
  } else {
    const empty = await waitForSolid(() => {
      const node = v.part("empty");
      expect(node?.textContent?.trim()).toBe(copy(messageKey));
      return node;
    });
    expect(v.items()).toHaveLength(0);
    for (const name of ["note", "warning", "hint"]) {
      expect(v.part(name)).toBeNull();
    }
    expect(v.all(".chat-talk-input-picker__empty")).toHaveLength(1);
    expect(empty?.getAttribute("role")).toBe("status");
    expect(empty?.classList.contains("chat-talk-input-picker__empty--fault")).toBe(fault);
  }
});

it("tracks devicechange only while open", async () => {
  const mediaDevices = new EventTarget();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
  discover.mockResolvedValue(emptyDevices);
  const v = await mountPicker();
  await v.open();
  await waitForSolid(() =>
    expect(v.part("empty")?.textContent?.trim()).toBe(copy("microphoneNoneFound")),
  );
  discover.mockResolvedValue({
    devices: [{ deviceId: "usb", label: "USB Audio Interface" }],
    issue: null,
  });
  mediaDevices.dispatchEvent(new Event("devicechange"));
  await v.count(2);
  expect(v.part("empty")).toBeNull();
  discover.mockResolvedValue(emptyDevices);
  mediaDevices.dispatchEvent(new Event("devicechange"));
  await v.count(0);
  await v.escape();
  const callsWhileClosed = discover.mock.calls.length;
  mediaDevices.dispatchEvent(new Event("devicechange"));
  await Promise.resolve();
  expect(discover.mock.calls.length).toBe(callsWhileClosed);
});
