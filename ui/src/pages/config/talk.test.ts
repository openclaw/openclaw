/* @vitest-environment jsdom */

import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SelectPicker } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
} from "../../test-helpers/native-device-settings.ts";
import { choosePickerValue, updatePickers } from "../../test-helpers/select-picker.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createTalkMutationHarness,
  expectVoiceState,
  mountTalkPage,
  mountTalkSettingsRoutes,
  nativeVoice,
  readVoiceOptions,
  realtimeModelPicker,
  realtimeProviderPicker,
  setTalkRealtimeConfig,
  type TalkMutationHarnessOptions,
} from "./talk.test-support.tsx";

const ACTIVE_VOICES = ["", "cove", "spruce", "custom-voice"];
const DEFAULT_VOICES = ["", "marin", "custom-voice"];

function editTrigger(input: HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

const triggerInput = (page: HTMLElement) => page.querySelector("textarea")!;
const triggerAlert = (page: HTMLElement) => page.querySelector("[role='alert']");
const retryTrigger = (page: HTMLElement) =>
  page.querySelector<HTMLButtonElement>("[role='alert'] button")?.click();
const expectTriggerWrite = (request: unknown, text: string) =>
  expect(request).toHaveBeenLastCalledWith("voicewake.set", { triggers: [text] });
const expectFocused = (input: HTMLTextAreaElement, value: string) => {
  expect(input.value).toBe(value);
  expect(document.activeElement).toBe(input);
};
const modelPicker = realtimeModelPicker;
const waitCatalogCalls = (request: unknown, count: number) =>
  waitForSolid(() => expect(request).toHaveBeenCalledTimes(count));
const realtimePath = (field: string) => ["talk", "realtime", field];
const settingRows = (page: HTMLElement) => [...page.querySelectorAll<HTMLElement>(".settings-row")];
const rowTitle = (row: HTMLElement) =>
  row.querySelector(".settings-row__title")?.textContent?.trim();

type TriggerReply = { triggers: string[] };
async function voiceWakeFixture(
  write: (index: number) => TriggerReply | Promise<TriggerReply>,
  read: () => string[] = () => ["openclaw"],
) {
  let writes = 0;
  const voiceWakeRequest = vi.fn(async (method: string) =>
    method === "voicewake.get" ? { triggers: read() } : write(++writes),
  );
  const harness = createTalkMutationHarness({ voiceWakeRequest });
  await waitForSolid(() => expect(triggerInput(harness.page)?.value).toBe("openclaw"));
  vi.useFakeTimers();
  return {
    ...harness,
    input: triggerInput(harness.page),
    voiceWakeRequest,
    writes: () => writes,
  };
}

async function selectMutation(
  field: "model" | "provider",
  value: string,
  options: TalkMutationHarnessOptions = {},
) {
  const harness = createTalkMutationHarness(options);
  await waitForSolid(() =>
    expect(
      field === "model"
        ? modelPicker(harness.page)
        : (realtimeProviderPicker(harness.page)?.params.options.find(
            (option) => option.value === value,
          ) ?? null),
    ).not.toBeNull(),
  );
  if (field === "model") {
    harness.page.changeModel(value);
  } else {
    harness.page.changeProvider(value);
  }
  expect(harness.runtimeConfig.patchForm).toHaveBeenCalledWith(realtimePath(field), value);
  return harness.runtimeConfig.removeFormValue;
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function readyTalk(options: TalkMutationHarnessOptions = {}) {
  const harness = createTalkMutationHarness(options);
  await waitForSolid(() => expect(modelPicker(harness.page)).not.toBeNull());
  await updatePickers(harness.page);
  return harness;
}

it("only shows the Reply chime in split mode without saving a preference", async () => {
  const { page: connectedPage, runtimeConfig } = createTalkMutationHarness();
  const page = mountTalkPage(connectedPage.context, {});
  const reply = () =>
    [...page.querySelectorAll<HTMLLabelElement>("label")]
      .find((label) => label.textContent?.trim() === "Ready for reply")
      ?.querySelector("input");
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  await waitForSolid(() => expect(reply()).toBeUndefined());

  setTalkRealtimeConfig(page, { mode: "stt-tts" });
  await waitForSolid(() => expect(reply()).toMatchObject({ disabled: false, checked: true }));

  setTalkRealtimeConfig(page, { mode: "realtime" });
  await waitForSolid(() => expect(reply()).toBeUndefined());
  expect(setItem).not.toHaveBeenCalled();
  expect(runtimeConfig.patchForm).not.toHaveBeenCalled();
});

it("locks every curated picker while config is saving", async () => {
  const { page } = await readyTalk({ configSaving: true, speakerVoice: "marin" });
  expect(page.querySelectorAll("select").length).toBeGreaterThan(0);
  expect([...page.querySelectorAll("select")].every((select) => select.disabled)).toBe(true);
  expect(modelPicker(page)?.querySelector("button")?.disabled).toBe(true);
  expect(realtimeProviderPicker(page)?.params.disabled).toBe(true);
});

it("commits provider-local model ids without qualifying them", async () => {
  const { page, runtimeConfig } = await readyTalk({
    providerOption: { models: ["gpt-live", "gpt-realtime"] },
  });
  await choosePickerValue(modelPicker(page)!, "gpt-realtime");
  expect(runtimeConfig.patchForm).toHaveBeenCalledWith(realtimePath("model"), "gpt-realtime");
});

it.each([
  ["gpt-live", true],
  [" GPT-LIVE-test-canary ", true],
  ["gpt-liveish", false],
] as const)("renders the GPT-Live hint only for the exact family: %s", async (model, showsHint) => {
  const { page } = await readyTalk({ model });
  expect(page.textContent?.includes(t("talkPage.gptLive.hint"))).toBe(showsHint);
  if (showsHint) {
    const row = settingRows(page).find((entry) =>
      entry.textContent?.includes("Released browser/Gateway-owned WebRTC"),
    );
    expect(row?.textContent).toContain("GPT-Live");
    expect(row?.textContent).toContain("Ready");
    expect(row?.textContent).not.toContain("talkPage.");
  }
});

it.each([
  ["model", "gpt-live-1-codex", "spruce", ["arbor", "spruce"]],
  ["provider", "gpt-live-private-example", null, ["other-voice"]],
] satisfies [string, string, string | null, string[]][])(
  "resolves the %s voice catalog",
  async (kind, model, speakerVoice, voices) => {
    const { page } = await readyTalk({
      model,
      speakerVoice,
      provider: kind === "model" ? "openai" : "other",
      providerOption:
        kind === "model"
          ? { voicesByModel: { [model]: voices } }
          : { id: "other", voices, activeVoices: ["active-only"], modelFamilySettings: undefined },
    });
    expect(readVoiceOptions(page)).toEqual(["", ...voices]);
    if (kind === "provider") {
      expect(page.textContent).not.toContain(t("talkPage.gptLive.hint"));
    }
  },
);

describe("Talk catalog boundaries", () => {
  it("keeps the trigger editor mounted through catalog failure and focus recovery", async () => {
    const initial = createDeferred<TalkCatalogResult>();
    const refresh = createDeferred();
    const { page, request } = createTalkMutationHarness({
      voiceWakeRequest: async () => ({ triggers: ["openclaw"] }),
      catalogRequest: (index, catalog) =>
        index === 1 ? initial.promise : index === 2 ? catalog : refresh.promise.then(() => catalog),
    });
    await waitForSolid(() => expect(triggerInput(page)?.value).toBe("openclaw"));
    const input = triggerInput(page);
    initial.reject(new Error("catalog temporarily unavailable"));
    await waitForSolid(() => expect(page.textContent).toContain(t("talkPage.status.unavailable")));
    expect(page.textContent).toContain("catalog temporarily unavailable");
    expect(page.textContent).not.toContain(t("talkPage.status.unavailableHint"));
    expect(page.querySelector<HTMLInputElement>('input[aria-label="Model"]')?.value).toBe(
      "gpt-realtime-2.1",
    );
    expect(triggerInput(page)).toBe(input);

    window.dispatchEvent(new Event("focus"));
    await waitForSolid(() => expect(modelPicker(page)).not.toBeNull());
    expect(triggerInput(page)).toBe(input);
    expect(request).toHaveBeenCalledTimes(2);

    const picker = modelPicker(page);
    window.dispatchEvent(new Event("focus"));
    await waitCatalogCalls(request, 3);
    expect(modelPicker(page)).toBe(picker);
    expect(triggerInput(page)).toBe(input);
    expect(page.textContent).not.toContain(t("common.loading"));
    refresh.resolve();
    await request.mock.results[2]?.value;
  });

  it("keeps a retired connection's catalog out of provider display and mutation policy", async () => {
    const old = createDeferred();
    const current = createDeferred();
    const { page, request, runtimeConfig, setGatewayConnection } = createTalkMutationHarness({
      defaultModel: "realtime-model",
      transport: "provider-websocket",
      catalogRequest: (index, catalog) =>
        (index === 1 ? old.promise : current.promise).then<TalkCatalogResult>(() => ({
          ...catalog,
          realtime: {
            ...catalog.realtime,
            providers: catalog.realtime.providers.map((provider) =>
              provider.id === "openai"
                ? {
                    ...provider,
                    label: index === 1 ? "Old provider" : "Current provider",
                    transports: index === 1 ? ["webrtc"] : ["provider-websocket"],
                  }
                : provider,
            ),
          },
        })),
    });
    await waitCatalogCalls(request, 1);
    setGatewayConnection(true, "wss://replacement.example.test");
    await waitCatalogCalls(request, 2);
    current.resolve();
    await waitForSolid(() => expect(page.textContent).toContain("Current provider"));
    old.resolve();
    await request.mock.results[0]?.value;
    flush();
    expect(page.textContent).not.toContain("Old provider");
    page.changeProvider("openai");
    expect(runtimeConfig.removeFormValue).not.toHaveBeenCalledWith(realtimePath("transport"));
  });
});

describe("Talk device and voice wake settings", () => {
  it("renders only published iOS voice controls and routes edits to native owners", async () => {
    const snapshot = createIosNativeDeviceSettingsSnapshot();
    snapshot.voice = { supported: true, wakeEnabled: false };
    const nativeDeviceSettings = nativeVoice(snapshot).settings;
    const { page, request } = createTalkMutationHarness({ nativeDeviceSettings });
    await waitForSolid(() => expect(request).toHaveBeenCalled());
    flush();
    const section = [...page.querySelectorAll<HTMLElement>(".settings-section")].find(
      (element) =>
        element.querySelector(".settings-section__heading")?.textContent?.trim() === "This iPhone",
    )!;
    expect(section).toBeDefined();
    const rows = settingRows(section);
    expect(rows.map(rowTitle)).toEqual(["Voice wake"]);
    const next = !rows[0]!.querySelector<HTMLInputElement>(".settings-toggle__input")!.checked;
    rows[0]!.click();
    expect(nativeDeviceSettings.set).toHaveBeenCalledExactlyOnceWith(
      "voice.wakeEnabled",
      next,
      expect.any(Function),
    );
    expect(section.querySelector("select, button")).toBeNull();
  });

  it.each(["retry", "replacement"])("isolates trigger reads on %s", async (mode) => {
    const pending = createDeferred<{ triggers: string[] }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ triggers: ["new trigger"] });
    const { page, setGatewayConnection } = createTalkMutationHarness({ voiceWakeRequest: request });
    await waitForSolid(() => expect(page.querySelector(".model-picker")).not.toBeNull());
    expect(triggerInput(page)).toMatchObject({ rows: 4, value: "", disabled: true });
    expect(triggerInput(page).getAttribute("aria-busy")).toBe("true");
    if (mode === "retry") {
      pending.reject(new TypeError("Cannot read properties of undefined"));
      await waitForSolid(() =>
        expect(triggerAlert(page)?.textContent).toBe(
          `${t("configPage.deviceTalk.triggerWordsLoadFailed")}${t("common.retry")}`,
        ),
      );
      expect(page.querySelector(".settings-group [role='alert']")).toBeNull();
      retryTrigger(page);
    } else {
      setGatewayConnection(false);
      setGatewayConnection(true, "wss://replacement-gateway.example.test");
      pending.reject(new Error("retired Gateway read"));
    }
    await waitForSolid(() => expect(triggerInput(page)?.value).toBe("new trigger"));
    expect(triggerInput(page).disabled).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    expect(triggerAlert(page)).toBeNull();
  });

  it("redacts the Gateway's reason when trigger words fail to load", async () => {
    const voiceWakeRequest = vi.fn(async () => {
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Access denied. Authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk",
      });
    });
    const { page } = createTalkMutationHarness({ voiceWakeRequest });
    await waitForSolid(() =>
      expect(triggerAlert(page)?.textContent).toBe(
        `Couldn’t load trigger words. Try again. Access denied. Authorization: [redacted]${t("common.retry")}`,
      ),
    );
  });

  it("redacts the Gateway's reason when trigger words fail to save", async () => {
    const { page, input } = await voiceWakeFixture(() => {
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Access denied. Authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk",
      });
    });
    editTrigger(input, "hello");
    await tick(400);
    expect(triggerAlert(page)?.textContent).toBe(
      `Couldn’t save trigger words. Try again. Access denied. Authorization: [redacted]${t("common.retry")}`,
    );
  });

  it("retains rejected trigger edits and recovers through retry or typing", async () => {
    const { page, input, voiceWakeRequest } = await voiceWakeFixture((index) => {
      if (index <= 2) {
        throw new Error("Permission denied");
      }
      return { triggers: ["new phrase"] };
    });
    input.focus();
    editTrigger(input, "hello");
    await tick(400);
    expect(triggerAlert(page)?.textContent).toBe(
      `${t("configPage.deviceTalk.triggerWordsSaveFailed")}${t("common.retry")}`,
    );
    expect(page.querySelector(".settings-group [role='alert']")).toBeNull();
    expect(input.value).toBe("hello");
    expect(input.disabled).toBe(false);
    retryTrigger(page);
    expect(voiceWakeRequest).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(0);
    editTrigger(input, "new phrase");
    await tick();
    expect(triggerAlert(page)).toBeNull();
    await tick(400);
    expect(page.querySelector(".settings-row__value[role='status']")?.textContent).toBe("Saved");
    expect(triggerInput(page)).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("keeps trigger typing focused across an older failure while serializing saves", async () => {
    const first = createDeferred<{ triggers: string[] }>();
    const second = createDeferred<{ triggers: string[] }>();
    const { page, input, writes, voiceWakeRequest } = await voiceWakeFixture((index) =>
      index === 1 ? first.promise : second.promise,
    );
    input.focus();
    editTrigger(input, "first phrase");
    await tick(400);
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    editTrigger(input, "second phrase");
    await vi.advanceTimersByTimeAsync(400);
    expect(writes()).toBe(1);
    first.reject(new Error("Older edit failed"));
    await tick();
    expectFocused(input, "second phrase");
    expect(triggerAlert(page)).toBeNull();
    expect(page.querySelector(".settings-row__value[role='status']")?.textContent).toBe("Saving…");
    expectTriggerWrite(voiceWakeRequest, "second phrase");
    second.resolve({ triggers: ["second phrase"] });
    await tick();
    expect(input.value).toBe("second phrase");
    expect(page.querySelector(".settings-row__value[role='status']")?.textContent).toBe("Saved");
  });

  it("leaves Talk while a trigger write is unresolved", async () => {
    const pending = createDeferred<{ triggers: string[] }>();
    const voiceWakeRequest = vi.fn(async (method: string) =>
      method === "voicewake.get" ? { triggers: ["openclaw"] } : pending.promise,
    );
    const { page } = createTalkMutationHarness({ voiceWakeRequest });
    page.remove();
    const sendNotification = vi.fn(async () => undefined);
    const context: ApplicationContext = {
      ...page.context,
      nativeNotifications: {
        snapshot: { permission: "granted", test: null },
        subscribe: () => () => {},
        requestPermission: vi.fn(),
        sendTest: sendNotification,
        backgroundSessionCompleted: vi.fn(),
        dispose: vi.fn(),
      },
    };
    const view = await mountTalkSettingsRoutes(context);
    await waitForSolid(() =>
      expect(view.container.querySelector("textarea")?.value).toBe("openclaw"),
    );
    const configHost = view.container.querySelector("openclaw-config-page");
    const expectNotificationsBody = () => {
      const bodies = view.container.querySelectorAll(
        "#settings-communications-notifications .settings-group",
      );
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.textContent).toContain(t("configView.notifications.sendTest"));
      expect(view.container.querySelector("openclaw-config-page")).toBe(configHost);
      return bodies[0]!;
    };
    vi.useFakeTimers();
    const input = view.container.querySelector("textarea")!;
    editTrigger(input, "new phrase");
    await vi.advanceTimersByTimeAsync(400);
    expectTriggerWrite(voiceWakeRequest, "new phrase");

    await view.navigate("notifications");
    await vi.advanceTimersByTimeAsync(0);
    expect(view.container.querySelector("h1")?.textContent).toBe("Notifications");
    const notificationsBody = await waitForSolid(expectNotificationsBody);
    const expectDeparted = () => {
      expect(view.container.querySelector("openclaw-talk-settings, textarea")).toBeNull();
      expect(input.isConnected).toBe(false);
    };
    expectDeparted();
    const send = notificationsBody!.querySelector<HTMLButtonElement>("button")!;
    send.click();
    await waitForSolid(() => expect(sendNotification).toHaveBeenCalledOnce());

    pending.resolve({ triggers: ["new phrase"] });
    await vi.advanceTimersByTimeAsync(0);
    await waitForSolid(() => expect(expectNotificationsBody()).toBe(notificationsBody));
    expectDeparted();
  });

  it.each(["latest phrase", "first phrase"])(
    "flushes the latest queued trigger draft on navigation: %s",
    async (latest) => {
      const first = createDeferred<{ triggers: string[] }>();
      const { page, input, voiceWakeRequest, writes } = await voiceWakeFixture((index) =>
        index === 1 ? first.promise : { triggers: [latest] },
      );
      for (const text of ["first phrase", "intermediate phrase"]) {
        editTrigger(input, text);
        await vi.advanceTimersByTimeAsync(400);
      }
      expect(writes()).toBe(1);
      editTrigger(input, latest);
      page.remove();
      first.resolve({ triggers: ["first phrase"] });
      await vi.advanceTimersByTimeAsync(400);
      expectTriggerWrite(voiceWakeRequest, latest);
      expect(writes()).toBe(latest === "first phrase" ? 1 : 2);
    },
  );

  it.each(["debounce", "in-flight"])(
    "preserves the unsaved trigger draft across a same-Gateway %s disconnect",
    async (timing) => {
      const interrupted = createDeferred<{ triggers: string[] }>();
      const { page, input, voiceWakeRequest, setGatewayConnection } = await voiceWakeFixture(
        (index) =>
          timing === "in-flight" && index === 1
            ? interrupted.promise
            : { triggers: ["hello computer"] },
      );
      editTrigger(input, "hello computer");
      await vi.advanceTimersByTimeAsync(timing === "in-flight" ? 400 : 100);
      setGatewayConnection(false);
      await tick();
      expect(triggerInput(page)?.value).toBe("hello computer");
      await waitForSolid(() => expect(triggerAlert(page)?.textContent).toContain("Reconnect"));
      await vi.advanceTimersByTimeAsync(400);
      const priorCalls = voiceWakeRequest.mock.calls.length;
      retryTrigger(page);
      expect(voiceWakeRequest).toHaveBeenCalledTimes(priorCalls);
      setGatewayConnection(true);
      flush();
      expect(triggerInput(page)?.value).toBe("hello computer");
      retryTrigger(page);
      await tick();
      expectTriggerWrite(voiceWakeRequest, "hello computer");
      expect(triggerAlert(page)).toBeNull();
      expect(triggerInput(page)?.value).toBe("hello computer");
      if (timing === "in-flight") {
        interrupted.reject(new Error("Retired connection closed"));
        await vi.advanceTimersByTimeAsync(0);
        expect(triggerAlert(page)).toBeNull();
      }
    },
  );

  it.each([false, true])(
    "restores an offline trigger draft after reopening Talk only for its Gateway (switch: %s)",
    async (switchGateway) => {
      let gatewayWords = ["openclaw"];
      const { page, input, voiceWakeRequest, setGatewayConnection } = await voiceWakeFixture(
        () => ({ triggers: ["retained phrase"] }),
        () => gatewayWords,
      );
      editTrigger(input, "initial phrase");
      setGatewayConnection(false);
      flush();
      editTrigger(input, "retained phrase");
      await vi.advanceTimersByTimeAsync(400);
      page.remove();
      gatewayWords = ["other gateway phrase"];
      setGatewayConnection(true, switchGateway ? "wss://other-gateway.example.test" : undefined);
      const reopened = mountTalkPage(page.context, page.configObject);
      await tick();
      expect(triggerInput(reopened)?.value).toBe(
        switchGateway ? "other gateway phrase" : "retained phrase",
      );
      if (switchGateway) {
        expect(triggerAlert(reopened)).toBeNull();
        expect(voiceWakeRequest).toHaveBeenCalledTimes(2);
      } else {
        expect(triggerAlert(reopened)?.textContent).toContain("not been saved");
        retryTrigger(reopened);
        await tick();
        expectTriggerWrite(voiceWakeRequest, "retained phrase");
        expect(triggerAlert(reopened)).toBeNull();
      }
    },
  );

  it("routes device voice changes to native owners and excludes the primary language from additions", async () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    snapshot.voice.supported = false;
    snapshot.voice.locale.additional = ["de-DE"];
    const { settings: nativeDeviceSettings, publish: publishSnapshot } = nativeVoice(snapshot);
    const { page, request } = createTalkMutationHarness({ nativeDeviceSettings });
    await waitForSolid(() => expect(request).toHaveBeenCalled());
    flush();
    const rows = settingRows(page);
    const row = (title: string) => rows.find((element) => rowTitle(element) === title)!;
    const expectWakeDisabled = (disabled: boolean) =>
      expect(
        row("Voice wake").querySelector(".settings-toggle__input")?.hasAttribute("disabled"),
      ).toBe(disabled);
    expect(page.textContent).toContain("This Mac");
    expectWakeDisabled(true);
    expect(row("Voice wake").textContent).toContain("macOS 26");
    row("Hold Right Option to talk").click();
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
      "voice.pushToTalkEnabled",
      false,
      expect.any(Function),
    );
    const microphone = row("Microphone").querySelector("select")!;
    microphone.value = "builtin";
    microphone.dispatchEvent(new Event("change"));
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
      "voice.microphone",
      "builtin",
      expect.any(Function),
    );
    expect(
      [...row("Additional languages").querySelectorAll("option")].map((option) => option.value),
    ).toEqual([""]);
    const primary = row("Primary language").querySelector("select")!;
    primary.value = "de-DE";
    primary.dispatchEvent(new Event("change"));
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
      "voice.locale.additional",
      [],
      expect.any(Function),
    );
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
      "voice.locale.primary",
      "de-DE",
      expect.any(Function),
    );
    row("Test microphone…").querySelector("button")?.click();
    expect(nativeDeviceSettings.openPanel).toHaveBeenCalledWith("microphone-test");
    snapshot.voice.wakeEnabled = true;
    publishSnapshot();
    await waitForSolid(() => expectWakeDisabled(false));
    row("Voice wake").click();
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
      "voice.wakeEnabled",
      false,
      expect.any(Function),
    );
    snapshot.voice.wakeEnabled = false;
    publishSnapshot();
    expectWakeDisabled(true);
    snapshot.voice.supported = true;
    publishSnapshot();
    expectWakeDisabled(false);
  });
});

describe("TalkSettingsPage realtime transport mutation", () => {
  async function resetHarness(options: TalkMutationHarnessOptions = {}) {
    const harness = createTalkMutationHarness({
      defaultModel: "gpt-realtime-2.1",
      model: null,
      ...options,
    });
    await waitForSolid(() => {
      expect(harness.request).toHaveBeenCalledExactlyOnceWith("talk.catalog", {});
      expect(modelPicker(harness.page)).not.toBeNull();
    });
    return harness;
  }

  it("acknowledges a model reset from the canonical config revision", async () => {
    const hashCatalog = createDeferred();
    const { page, request, runtimeConfig, setConfigHash } = await resetHarness({
      activeVoiceSelectionPolicy: "allowlist-default",
      configSnapshot: { hash: null, configRevisionHash: "revision-1" },
      catalogRequest: (requestIndex, catalog) =>
        requestIndex === 3 ? hashCatalog.promise.then(() => catalog) : catalog,
    });
    setTalkRealtimeConfig(page, { provider: "openai", speakerVoice: "custom-voice" });
    await waitForSolid(() => expectVoiceState(page, ACTIVE_VOICES, true));

    setTalkRealtimeConfig(page, {
      provider: "openai",
      model: "gpt-realtime-2.1",
      speakerVoice: "custom-voice",
    });
    await waitForSolid(() => expectVoiceState(page, DEFAULT_VOICES, false));

    page.changeModel(null);
    setTalkRealtimeConfig(page, { provider: "openai", speakerVoice: "custom-voice" });
    await waitForSolid(() => expectVoiceState(page, DEFAULT_VOICES, false));

    window.dispatchEvent(new Event("focus"));
    await waitCatalogCalls(request, 2);
    await waitForSolid(() => expectVoiceState(page, DEFAULT_VOICES, false));

    Object.assign(runtimeConfig.state.configSnapshot, { configRevisionHash: "revision-2" });
    setConfigHash(null);
    await waitCatalogCalls(request, 3);
    window.dispatchEvent(new Event("focus"));
    await waitCatalogCalls(request, 4);
    await waitForSolid(() => expectVoiceState(page, ACTIVE_VOICES, true));
    hashCatalog.resolve();
    await request.mock.results[2]?.value;
    expectVoiceState(page, ACTIVE_VOICES, true);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("retains a reset without revisions, then clears it after reconnect with a revision", async () => {
    const { page, request, setConfigHash, setGatewayConnection } = await resetHarness({
      activeVoiceSelectionPolicy: "allowlist-default",
      configSnapshot: { hash: null, configRevisionHash: null },
    });
    page.changeModel(null);
    setTalkRealtimeConfig(page, { provider: "openai", speakerVoice: "custom-voice" });
    flush();

    window.dispatchEvent(new Event("focus"));
    await waitCatalogCalls(request, 2);
    expectVoiceState(page, DEFAULT_VOICES, false);
    await waitForSolid(() => expectVoiceState(page, DEFAULT_VOICES, false));

    setGatewayConnection(false);
    setConfigHash("hash-3");
    expectVoiceState(page, DEFAULT_VOICES, false);
    setGatewayConnection(true);
    await waitCatalogCalls(request, 3);
    await waitForSolid(() => expectVoiceState(page, ACTIVE_VOICES, true));
  });

  it("clears model reset intent on explicit model, provider, and Gateway changes", async () => {
    const { page, request, setGatewayConnection } = await resetHarness({
      voicesByModel: {
        "gpt-realtime-2.1": ["marin"],
        "gpt-realtime-alt": ["verse"],
      },
    });

    page.changeModel(null);
    page.changeModel("gpt-realtime-alt");
    setTalkRealtimeConfig(page, { provider: "openai", model: "gpt-realtime-alt" });
    flush();
    expect(readVoiceOptions(page)).toEqual(["", "verse"]);

    page.changeModel(null);
    page.changeProvider("xai");
    setTalkRealtimeConfig(page, { provider: "xai" });
    flush();
    expect(readVoiceOptions(page)).toEqual(["", "xai-active"]);

    page.changeModel(null);
    flush();
    expect(readVoiceOptions(page)).toEqual(["", "ara"]);
    setGatewayConnection(true, "wss://replacement.example.test");
    await waitCatalogCalls(request, 2);
    await waitForSolid(() => expect(readVoiceOptions(page)).toEqual(["", "xai-active"]));
  });

  const rejectedModelOptions: TalkMutationHarnessOptions = {
    model: "gpt-realtime-2.1",
    consultRouting: "force-agent-consult",
    aliases: ["openai-voice"],
    provider: "openai-voice",
  };
  it.each([
    [
      "relay consult",
      { consultRouting: " Force-Agent-Consult ", transports: ["gateway-relay"] },
      "consultRouting",
    ],
    [
      "another provider",
      { provider: "xai", transport: "provider-websocket", consultRouting: "force-agent-consult" },
      null,
    ],
    [
      "auto provider",
      { activeProvider: "openai", provider: null, transports: ["gateway-relay"] },
      null,
    ],
    [
      "family rejection",
      {
        ...rejectedModelOptions,
        transport: "provider-websocket",
        transports: ["provider-websocket", "gateway-relay"],
      },
      "transport",
      " GPT-LIVE-test-canary ",
    ],
    [
      "provider rejection",
      { ...rejectedModelOptions, transport: "gateway-relay", transports: ["webrtc"] },
      "transport",
      " GPT-LIVE-test-canary ",
    ],
  ] satisfies [string, TalkMutationHarnessOptions, string | null, string?][])(
    "applies model transport policy: %s",
    async (_name, options, removed, model = "gpt-live-test-canary") => {
      const remove = await selectMutation("model", model, options);
      if (removed) {
        expect(remove).toHaveBeenCalledExactlyOnceWith(realtimePath(removed));
      } else {
        expect(remove).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [
      "no family facts",
      {
        transport: "provider-websocket",
        transports: ["provider-websocket", "gateway-relay"],
        providerOption: { modelFamilySettings: undefined },
      },
      null,
      ["transport", "consultRouting"],
    ],
    [
      "GPT-Live fallback",
      {
        consultRouting: "force-agent-consult",
        defaultModel: "gpt-realtime-2.1",
        openAIProviderModel: "gpt-live-test-canary",
        transports: ["gateway-relay", "webrtc"],
      },
      "consultRouting",
      ["transport"],
    ],
    ["positive rejection", { transports: ["webrtc"] }, "transport", []],
  ] satisfies [string, TalkMutationHarnessOptions, string | null, string[]][])(
    "applies provider transport policy: %s",
    async (_name, options, removed, retained) => {
      const remove = await selectMutation("provider", "openai", { provider: "xai", ...options });
      if (removed) {
        expect(remove).toHaveBeenCalledWith(realtimePath(removed));
      }
      for (const field of retained) {
        expect(remove).not.toHaveBeenCalledWith(realtimePath(field));
      }
    },
  );
});

describe("Talk settings page revamp", () => {
  it("shows the Gateway's route under Provider only when the catalog reports one", async () => {
    const withRoute = await readyTalk({
      providerOption: { authRoute: "chatgpt-sign-in" } as never,
      model: null,
      defaultModel: "gpt-live-1-codex",
    });
    await waitForSolid(() =>
      expect(withRoute.page.textContent).toContain(
        `${t("talkPage.provider.routeSignIn")} · gpt-live-1-codex`,
      ),
    );
    cleanupSolid();
    document.body.replaceChildren();
    const withoutRoute = await readyTalk();
    expect(withoutRoute.page.textContent).not.toContain(t("talkPage.provider.routeSignIn"));
    expect(withoutRoute.page.textContent).not.toContain(t("talkPage.provider.routeApiKey"));
  });

  it("offers the Talk transcription provider only when the Gateway schema has the key", async () => {
    const stt = (page: HTMLElement) =>
      [...page.querySelectorAll<SelectPicker>("openclaw-select-picker")].find((picker) =>
        picker.params.options.some((option) => option.value === "media-understanding"),
      );
    const schema = {
      properties: { talk: { properties: { transcription: { properties: { provider: {} } } } } },
    };
    const { page } = await readyTalk({ schema });
    page.configObject = { talk: { realtime: { mode: "stt-tts" } } };
    await waitForSolid(() => expect(stt(page)).toBeDefined());
    cleanupSolid();
    document.body.replaceChildren();
    const old = await readyTalk();
    old.page.configObject = { talk: { realtime: { mode: "stt-tts" } } };
    flush();
    expect(stt(old.page)).toBeUndefined();
  });

  it("keeps Voice notes in Live, and moves Talk's own listening rows to the collapsed card", async () => {
    const schema = {
      properties: { talk: { properties: { transcription: { properties: { provider: {} } } } } },
    };
    const { page } = await readyTalk({ schema });
    const rowsIn = (root: ParentNode) =>
      [...root.querySelectorAll(".settings-row__title")].map((row) => row.textContent);
    const open = () =>
      [...page.querySelectorAll("details")].filter(
        (d) => d.querySelector("summary")?.textContent === t("talkPage.revamp.split"),
      );
    const outside = () => {
      const copy = page.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("details").forEach((d) => d.remove());
      return rowsIn(copy);
    };
    await waitForSolid(() =>
      expect(outside()).toContain(t("talkPage.transcription.voiceNotesTitle")),
    );
    expect(open()).toHaveLength(1);
    expect(rowsIn(open()[0]!)).toContain(t("talkPage.revamp.speechLocale"));
    expect(outside()).not.toContain(t("talkPage.revamp.speechLocale"));
    page.configObject = { talk: { realtime: { mode: "stt-tts" } } };
    await waitForSolid(() => expect(outside()).toContain(t("talkPage.revamp.speechLocale")));
    expect(outside()).toContain(t("talkPage.transcription.voiceNotesTitle"));
    const live = [...page.querySelectorAll("details")].find(
      (d) => d.querySelector("summary")?.textContent === t("talkPage.voiceSection.title"),
    );
    expect(live).toBeDefined();
    expect(rowsIn(live!)).not.toContain(t("talkPage.transcription.voiceNotesTitle"));
  });

  it("shows readiness in the mode card and lists configured agents with the default named", async () => {
    const { page } = await readyTalk();
    const modeCard = () =>
      [...page.querySelectorAll("section.settings-section")].find(
        (section) => section.querySelector("h2")?.textContent === t("talkPage.revamp.modeSection"),
      );
    await waitForSolid(() =>
      expect(modeCard()?.textContent).toContain(t("talkPage.revamp.hearingVoice")),
    );
    expect(modeCard()?.textContent).toContain(t("talkPage.status.ready"));
    // The Live card no longer repeats the status.
    expect(
      [...page.querySelectorAll(".settings-row__title")].map((row) => row.textContent),
    ).not.toContain("Status");
    page.configObject = { talk: { realtime: { mode: "stt-tts" } } };
    await waitForSolid(() =>
      expect(modeCard()?.textContent).toContain(t("talkPage.transcription.title")),
    );
    expect(modeCard()?.textContent).toContain(t("talkPage.revamp.voice"));
    const agent = [...page.querySelectorAll<SelectPicker>("openclaw-select-picker")].find(
      (picker) => picker.params.label === t("talkPage.revamp.agent"),
    );
    expect(agent?.params.options.map((option) => option.label)).toEqual([
      t("talkPage.revamp.agentDefault", { agent: "Main" }),
      "Main",
      "Helper",
    ]);
  });

  it("writes and clears the Talk transcription provider from the picker", async () => {
    const schema = {
      properties: { talk: { properties: { transcription: { properties: { provider: {} } } } } },
    };
    const { page, runtimeConfig } = await readyTalk({ schema });
    page.configObject = { talk: { realtime: { mode: "stt-tts" } } };
    const picker = () =>
      [...page.querySelectorAll<SelectPicker>("openclaw-select-picker")].find((candidate) =>
        candidate.params.options.some((option) => option.value === "media-understanding"),
      );
    await waitForSolid(() => expect(picker()).toBeDefined());
    picker()!.params.onChange("media-understanding");
    expect(runtimeConfig.patchForm).toHaveBeenCalledWith(
      ["talk", "transcription", "provider"],
      "media-understanding",
    );
    picker()!.params.onChange("");
    expect(runtimeConfig.removeFormValue).toHaveBeenCalledWith([
      "talk",
      "transcription",
      "provider",
    ]);
  });

  it("blocks Voice provider choices the Gateway would reject", async () => {
    const { page } = await readyTalk();
    page.configObject = {
      talk: {
        realtime: { mode: "stt-tts" },
        provider: "a",
        providers: { a: {}, b: {} },
      },
    };
    const voice = () =>
      [...page.querySelectorAll<SelectPicker>("openclaw-select-picker")].find((candidate) =>
        candidate.params.options.some((option) => option.value === "tts-local-cli"),
      );
    await waitForSolid(() => expect(voice()).toBeDefined());
    const byValue = (value: string) =>
      voice()!.params.options.find((option) => option.value === value);
    // Two entries: unsetting the provider is invalid, and so is a provider outside the map.
    expect(byValue("")?.disabled).toBe(true);
    expect(byValue("tts-local-cli")?.disabled).not.toBe(true);
    page.configObject = { talk: { realtime: { mode: "stt-tts" }, providers: { a: {} } } };
    await waitForSolid(() => expect(byValue("")?.disabled).toBe(false));
    expect(byValue("")?.description).toBeUndefined();
  });

  it("keeps Model and Speaker voice editable when the catalog cannot list them", async () => {
    // A saved provider the catalog does not know.
    const unlisted = createTalkMutationHarness({ provider: "acme-voice", model: "acme-1" });
    const input = (label: string) =>
      unlisted.page.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    await waitForSolid(() => expect(input("Model")?.value).toBe("acme-1"));
    input("Model")!.value = "acme-2";
    input("Model")!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(unlisted.runtimeConfig.patchForm).toHaveBeenCalledWith(
      ["talk", "realtime", "model"],
      "acme-2",
    );
    input("Speaker voice")!.value = "river";
    input("Speaker voice")!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(unlisted.runtimeConfig.patchForm).toHaveBeenCalledWith(
      ["talk", "realtime", "speakerVoice"],
      "river",
    );
  });

  it("offers an unlisted model through the picker's custom entry", async () => {
    const { page, runtimeConfig } = await readyTalk();
    await waitForSolid(() => expect(realtimeModelPicker(page)).not.toBeNull());
    expect(realtimeModelPicker(page)?.params.options.map((option) => option.label)).toContain(
      t("talkPage.model.custom"),
    );
    realtimeModelPicker(page)!.params.onChange("brand-new-model");
    expect(runtimeConfig.patchForm).toHaveBeenCalledWith(
      ["talk", "realtime", "model"],
      "brand-new-model",
    );
  });

  it("keeps transcription-only mode selectable from any mode", async () => {
    const { page, runtimeConfig } = await readyTalk();
    const mode = () =>
      [...page.querySelectorAll("select")].find(
        (select) => select.getAttribute("aria-label") === t("talkPage.revamp.mode"),
      )!;
    expect([...mode().options].map((option) => option.value)).toContain("transcription");
    mode().value = "transcription";
    mode().dispatchEvent(new Event("change", { bubbles: true }));
    expect(runtimeConfig.patchForm).toHaveBeenCalledWith(
      ["talk", "realtime", "mode"],
      "transcription",
    );
  });

  it("shows the general text-to-speech route when no Talk speech provider is chosen", async () => {
    const { page } = await readyTalk({
      catalogRequest: (_index, catalog) => ({ ...catalog, speech: { providers: [] } }),
    });
    page.configObject = { talk: { realtime: { mode: "stt-tts" } } };
    await waitForSolid(() =>
      expect(page.textContent).toContain(t("talkPage.revamp.generalSpeech")),
    );
    expect(page.textContent).not.toContain(
      `${t("talkPage.revamp.voice")}${t("talkPage.status.notReady")}`,
    );
  });

  it("shows saved booleans as On or Off, not Default", async () => {
    const { page } = await readyTalk();
    page.configObject = {
      talk: { realtime: { mode: "stt-tts" }, interruptOnSpeech: false, consultFastMode: true },
    };
    const interrupt = () =>
      [...page.querySelectorAll("select")].find(
        (select) => select.getAttribute("aria-label") === t("talkPage.revamp.interrupt"),
      );
    await waitForSolid(() => expect(interrupt()?.value).toBe("false"));
  });

  it("can edit and clear the speech provider when the catalog fails", async () => {
    const { page, runtimeConfig } = createTalkMutationHarness({
      catalogRequest: () => Promise.reject(new Error("catalog unavailable")),
    });
    page.configObject = { talk: { realtime: { mode: "stt-tts" }, provider: "elevenlabs" } };
    const input = () =>
      page.querySelector<HTMLInputElement>(
        `input[aria-label="${t("talkPage.provider.title")}"][placeholder="${t("talkPage.revamp.defaultValue")}"]`,
      );
    await waitForSolid(() => expect(page.textContent).toContain("catalog unavailable"));
    expect(input()).toMatchObject({ disabled: false, value: "elevenlabs" });
    const before = input()!;
    before.value = "openai";
    page.configObject = {
      talk: { realtime: { mode: "stt-tts" }, provider: "elevenlabs", silenceTimeoutMs: 1500 },
    };
    await waitForSolid(() =>
      expect(page.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("1500"),
    );
    expect(input() === before).toBe(true);
    expect(input()?.value).toBe("openai");
    input()!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(runtimeConfig.patchForm).toHaveBeenCalledWith(["talk", "provider"], "openai");
    input()!.value = "";
    input()!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(runtimeConfig.removeFormValue).toHaveBeenCalledWith(["talk", "provider"]);
  });
});
