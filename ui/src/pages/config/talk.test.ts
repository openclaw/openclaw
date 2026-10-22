/* @vitest-environment jsdom */

import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { createComponent, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import type { SelectPicker } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
} from "../../test-helpers/native-device-settings.ts";
import { choosePickerValue, updatePickers } from "../../test-helpers/select-picker.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { TalkSettingsPage } from "./talk-page.tsx";

const ACTIVE_VOICES = ["", "cove", "spruce", "custom-voice"];
const DEFAULT_VOICES = ["", "marin", "custom-voice"];

function nativeVoice(snapshot: NonNullable<NativeDeviceSettingsCapability["snapshot"]>) {
  const listeners = new Set<() => void>();
  const settings = {
    snapshot,
    set: vi.fn<NativeDeviceSettingsCapability["set"]>(),
    subscribe: (listener: Parameters<NativeDeviceSettingsCapability["subscribe"]>[0]) => {
      const notify = () => listener(snapshot);
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    requestPermission: vi.fn(),
    openSystemSettings: vi.fn(),
    openPanel: vi.fn(),
    checkForUpdates: vi.fn(),
    setupChromeExtension: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
  } satisfies NativeDeviceSettingsCapability;
  return {
    settings,
    publish: () => {
      listeners.forEach((notify) => notify());
      flush();
    },
  };
}

function editTrigger(input: HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

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
  await waitForSolid(() => expect(harness.page.querySelector("textarea")?.value).toBe("openclaw"));
  vi.useFakeTimers();
  return {
    ...harness,
    input: harness.page.querySelector("textarea")!,
    voiceWakeRequest,
    writes: () => writes,
  };
}

type TalkPageElement = HTMLElement & {
  context: ApplicationContext;
  configObject: Record<string, unknown>;
  changeModel: (model: string | null) => void;
  changeProvider: (providerId: string | null) => void;
};

type TalkMutationHarnessOptions = {
  configSaving?: boolean;
  speakerVoice?: string | null;
  providerOption?: Partial<TalkCatalogResult["realtime"]["providers"][number]>;
  nativeDeviceSettings?: NativeDeviceSettingsCapability;
  voiceWakeRequest?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<{ triggers: string[] }>;
  catalogRequest?: (
    requestIndex: number,
    catalog: TalkCatalogResult,
  ) => Promise<TalkCatalogResult> | TalkCatalogResult;
  configSnapshot?: { hash?: string | null; configRevisionHash?: string | null };
  activeProvider?: string | null;
  activeVoiceSelectionPolicy?: "allowlist-default";
  aliases?: string[];
  consultRouting?: string | null;
  defaultModel?: string;
  model?: string | null;
  openAIProviderModel?: string;
  provider?: string | null;
  transport?: string | null;
  transports?: TalkCatalogResult["transports"];
  voicesByModel?: Record<string, string[]>;
};

function createTalkMutationHarness(options: TalkMutationHarnessOptions = {}) {
  const catalog = {
    modes: ["realtime"],
    transports: ["gateway-relay", "webrtc"],
    brains: ["agent-consult"],
    speech: { providers: [] },
    transcription: { providers: [] },
    realtime: {
      ready: true,
      activeProvider: options.activeProvider ?? "openai",
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          configured: true,
          aliases: options.aliases ?? [],
          models: [options.defaultModel ?? "gpt-live-test-canary"],
          voices: ["marin"],
          activeVoices: ["cove", "spruce"],
          activeVoiceSelectionPolicy: options.activeVoiceSelectionPolicy,
          voicesByModel: options.voicesByModel,
          modelFamilySettings: {
            family: "gpt-live",
            unlistedModelVoices: "active",
            unsupportedTransports: ["provider-websocket"],
            gatewayRelayHandlesAgentConsult: true,
            hint: {
              titleKey: "talkPage.gptLive.title",
              descriptionKey: "talkPage.gptLive.hint",
              readyKey: "talkPage.gptLive.ready",
            },
          },
          transports: options.transports ?? ["gateway-relay"],
          defaultModel: options.defaultModel ?? "gpt-live-test-canary",
          ...options.providerOption,
        },
        {
          id: "xai",
          label: "xAI",
          configured: true,
          aliases: [],
          models: ["grok-voice"],
          voices: ["ara"],
          activeVoices: ["xai-active"],
          transports: ["gateway-relay"],
          defaultModel: "grok-voice",
        },
      ],
    },
  } satisfies TalkCatalogResult;
  let catalogRequestIndex = 0;
  const request = vi.fn(async (_method: string, _params: Record<string, unknown>) => {
    catalogRequestIndex += 1;
    return await (options.catalogRequest?.(catalogRequestIndex, catalog) ?? catalog);
  });
  const { gateway, publish } = createApplicationGateway();
  gateway.connection.gatewayUrl = "wss://gateway.example.test";
  const hello: ApplicationContext["gateway"]["snapshot"]["hello"] = options.voiceWakeRequest
    ? {
        type: "hello-ok" as const,
        protocol: 4,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["voicewake.get", "voicewake.set"] },
      }
    : null;
  publish({
    ...gateway.snapshot,
    client: {
      request: (method: string, params: Record<string, unknown>) =>
        method.startsWith("voicewake.")
          ? (options.voiceWakeRequest?.(method, params) ?? Promise.resolve({ triggers: [] }))
          : request(method, params),
    } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello,
    assistantAgentId: "main",
    sessionKey: "main",
  });
  const configForm = {
    talk: {
      realtime: {
        provider: options.provider === undefined ? "openai" : options.provider,
        ...(options.model === null
          ? {}
          : { model: options.model === undefined ? "gpt-realtime-2.1" : options.model }),
        transport: options.transport === undefined ? "gateway-relay" : options.transport,
        consultRouting: options.consultRouting,
        speakerVoice: options.speakerVoice,
        providers: options.openAIProviderModel
          ? { openai: { model: options.openAIProviderModel } }
          : undefined,
      },
    },
  };
  const runtimeConfigListeners = new Set<() => void>();
  const runtimeConfig = {
    state: {
      configForm,
      configSnapshot: options.configSnapshot ?? { hash: "hash" },
      configLoading: false,
      configSaving: options.configSaving ?? false,
      configApplying: false,
    },
    patchForm: vi.fn(),
    removeFormValue: vi.fn(),
    subscribe: (listener: () => void) => {
      runtimeConfigListeners.add(listener);
      return () => runtimeConfigListeners.delete(listener);
    },
  };
  const context = {
    nativeDeviceSettings: options.nativeDeviceSettings ?? null,
    gateway,
    runtimeConfig,
  } as unknown as ApplicationContext;
  const page = mountTalkPage(context, configForm);
  return {
    page,
    request,
    runtimeConfig,
    setConfigHash: (hash: string | null) => {
      runtimeConfig.state.configSnapshot.hash = hash;
      runtimeConfigListeners.forEach((notify) => notify());
    },
    setGatewayConnection: (connected: boolean, gatewayUrl = gateway.connection.gatewayUrl) => {
      gateway.connection.gatewayUrl = gatewayUrl;
      publish({
        ...gateway.snapshot,
        phase: connected ? "connected" : "reconnecting",
        hello: connected ? hello : null,
      });
    },
  };
}

function mountTalkPage(context: ApplicationContext, initialConfig: Record<string, unknown>) {
  const page: TalkPageElement = Object.assign(document.createElement("div"), {
    context,
    configObject: initialConfig,
    changeModel: (value: string | null) => {
      flush();
      const picker = page.querySelector<SelectPicker>("openclaw-select-picker");
      if (!picker) {
        throw new Error("Talk model picker is unavailable");
      }
      picker.params.onChange(value ?? "");
    },
    changeProvider: (value: string | null) => {
      const input = [...page.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
        (entry) => entry.value === (value ?? ""),
      );
      if (!input) {
        throw new Error("Talk provider choice is unavailable");
      }
      input.click();
    },
  });
  const [config, setConfig] = createSignal(initialConfig);
  document.body.append(page);
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(
    () =>
      createComponent(TalkSettingsPage, {
        get configObject() {
          return config();
        },
      }),
    { container: page, wrapper: provider.wrapper },
  );
  const remove = page.remove.bind(page);
  Object.defineProperties(page, {
    context: { value: context },
    configObject: { get: config, set: setConfig },
  });
  page.remove = () => {
    view.unmount();
    remove();
  };
  flush();
  return page;
}

function readVoiceOptions(page: HTMLElement): string[] {
  return [...page.querySelectorAll("select option")].map(
    (option) => option.getAttribute("value") ?? "",
  );
}

function setTalkRealtimeConfig(page: TalkPageElement, realtime: Record<string, unknown>) {
  page.configObject = { talk: { realtime } };
}

function expectVoiceState(page: TalkPageElement, options: string[], unsupported: boolean) {
  expect(readVoiceOptions(page)).toEqual(options);
  expect(page.textContent?.includes(t("talkPage.voice.unsupportedDefault"))).toBe(unsupported);
}

async function selectMutation(
  field: "model" | "provider",
  value: string,
  options: TalkMutationHarnessOptions = {},
) {
  const harness = createTalkMutationHarness(options);
  await waitForSolid(() => expect(harness.request).toHaveBeenCalledWith("talk.catalog", {}));
  await waitForSolid(() =>
    expect(
      harness.page.querySelector(
        field === "model" ? "openclaw-select-picker" : 'input[type="radio"]',
      ),
    ).not.toBeNull(),
  );
  if (field === "model") {
    harness.page.changeModel(value);
  } else {
    harness.page.changeProvider(value);
  }
  expect(harness.runtimeConfig.patchForm).toHaveBeenCalledWith(["talk", "realtime", field], value);
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
  await waitForSolid(() =>
    expect(harness.page.querySelector("openclaw-select-picker")).not.toBeNull(),
  );
  await updatePickers(harness.page);
  return harness;
}

it("locks every curated picker while config is saving", async () => {
  const { page } = await readyTalk({ configSaving: true, speakerVoice: "marin" });
  expect(page.querySelector<HTMLInputElement>(".settings-segmented__input")?.disabled).toBe(true);
  expect([...page.querySelectorAll("select")]).toMatchObject([{ disabled: true }]);
  expect(page.querySelector<HTMLButtonElement>("openclaw-select-picker button")?.disabled).toBe(
    true,
  );
});

it("commits provider-local model ids without qualifying them", async () => {
  const { page, runtimeConfig } = await readyTalk({
    providerOption: { models: ["gpt-live", "gpt-realtime"] },
  });
  await choosePickerValue(
    page.querySelector<SelectPicker>("openclaw-select-picker")!,
    "gpt-realtime",
  );
  expect(runtimeConfig.patchForm).toHaveBeenCalledWith(
    ["talk", "realtime", "model"],
    "gpt-realtime",
  );
});

it.each([
  ["gpt-live", true],
  [" GPT-LIVE-test-canary ", true],
  ["gpt-liveish", false],
] as const)("renders the GPT-Live hint only for the exact family: %s", async (model, showsHint) => {
  const { page } = await readyTalk({ model });
  expect(page.textContent?.includes(t("talkPage.gptLive.hint"))).toBe(showsHint);
  if (showsHint) {
    const row = [...page.querySelectorAll(".settings-row")].find((entry) =>
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
    expect(
      [...page.querySelectorAll<HTMLOptionElement>("select option")].map((option) => option.value),
    ).toEqual(["", ...voices]);
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
    await waitForSolid(() => expect(page.querySelector("textarea")?.value).toBe("openclaw"));
    const input = page.querySelector("textarea");
    initial.reject(new Error("catalog temporarily unavailable"));
    await waitForSolid(() => expect(page.textContent).toContain(t("talkPage.status.unavailable")));
    expect(page.textContent).toContain("gpt-realtime-2.1");
    expect(page.querySelector("textarea")).toBe(input);

    window.dispatchEvent(new Event("focus"));
    await waitForSolid(() => expect(page.querySelector("openclaw-select-picker")).not.toBeNull());
    expect(page.querySelector("textarea")).toBe(input);
    expect(request).toHaveBeenCalledTimes(2);

    const picker = page.querySelector("openclaw-select-picker");
    window.dispatchEvent(new Event("focus"));
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(3));
    expect(page.querySelector("openclaw-select-picker")).toBe(picker);
    expect(page.querySelector("textarea")).toBe(input);
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
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(1));
    setGatewayConnection(true, "wss://replacement.example.test");
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    current.resolve();
    await waitForSolid(() => expect(page.textContent).toContain("Current provider"));
    old.resolve();
    await request.mock.results[0]?.value;
    flush();
    expect(page.textContent).not.toContain("Old provider");
    page.changeProvider("openai");
    expect(runtimeConfig.removeFormValue).not.toHaveBeenCalledWith([
      "talk",
      "realtime",
      "transport",
    ]);
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
    const rows = [...section.querySelectorAll<HTMLElement>(".settings-row")];
    expect(
      rows.map((row) => row.querySelector(".settings-row__title")?.textContent?.trim()),
    ).toEqual(["Voice Wake"]);
    const next = !rows[0]!.querySelector<HTMLInputElement>(".settings-toggle__input")!.checked;
    rows[0]!.click();
    expect(nativeDeviceSettings.set).toHaveBeenCalledExactlyOnceWith("voice.wakeEnabled", next);
    expect(section.querySelector("select, button")).toBeNull();
  });

  it.each(["retry", "replacement"])("isolates trigger reads on %s", async (mode) => {
    const pending = createDeferred<{ triggers: string[] }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ triggers: ["new trigger"] });
    const { page, setGatewayConnection } = createTalkMutationHarness({ voiceWakeRequest: request });
    const alert = () => page.querySelector("[role='alert']");
    await waitForSolid(() => expect(page.querySelector(".model-picker")).not.toBeNull());
    expect(page.querySelector("textarea")).toBeNull();
    if (mode === "retry") {
      pending.reject(new Error("trigger read unavailable"));
      await waitForSolid(() => expect(alert()?.textContent).toContain("trigger read unavailable"));
      alert()?.querySelector<HTMLButtonElement>("button")?.click();
    } else {
      setGatewayConnection(false);
      setGatewayConnection(true, "wss://replacement-gateway.example.test");
      pending.reject(new Error("retired Gateway read"));
    }
    await waitForSolid(() => expect(page.querySelector("textarea")?.value).toBe("new trigger"));
    expect(request).toHaveBeenCalledTimes(2);
    expect(alert()).toBeNull();
  });

  it("retains rejected trigger edits and gives a visible retry action", async () => {
    const { page, input, voiceWakeRequest } = await voiceWakeFixture(() => {
      throw new Error("Permission denied");
    });
    editTrigger(input, "hello");
    await vi.advanceTimersByTimeAsync(400);
    flush();
    expect(page.querySelector("[role='alert']")?.textContent).toContain("Permission denied");
    expect(input.value).toBe("hello");
    expect(input.disabled).toBe(false);
    page.querySelector<HTMLButtonElement>("[role='alert'] button")?.click();
    expect(voiceWakeRequest).toHaveBeenCalledTimes(3);
  });

  it("keeps trigger typing focused while serializing saves and ignoring older acknowledgments", async () => {
    const first = createDeferred<{ triggers: string[] }>();
    const second = createDeferred<{ triggers: string[] }>();
    const { page, input, voiceWakeRequest, writes } = await voiceWakeFixture((index) =>
      index === 1 ? first.promise : second.promise,
    );
    input.focus();
    editTrigger(input, "first phrase");
    await vi.advanceTimersByTimeAsync(400);
    flush();
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    editTrigger(input, "second phrase");
    await vi.advanceTimersByTimeAsync(400);
    expect(writes()).toBe(1);
    first.resolve({ triggers: ["first phrase"] });
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(input.value).toBe("second phrase");
    expect(document.activeElement).toBe(input);
    expect(voiceWakeRequest).toHaveBeenLastCalledWith("voicewake.set", {
      triggers: ["second phrase"],
    });
    second.resolve({ triggers: ["second phrase"] });
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(input.value).toBe("second phrase");
    expect(page.querySelector("[role='status']")?.textContent).toBe("Saved");
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
      expect(voiceWakeRequest).toHaveBeenLastCalledWith("voicewake.set", { triggers: [latest] });
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
      if (timing === "in-flight") {
        interrupted.reject(new Error("Connection closed"));
      }
      flush();
      expect(page.querySelector("textarea")?.value).toBe("hello computer");
      expect(page.querySelector("[role='alert']")?.textContent).toContain("Reconnect");
      await vi.advanceTimersByTimeAsync(400);
      const priorCalls = voiceWakeRequest.mock.calls.length;
      page.querySelector<HTMLButtonElement>("[role='alert'] button")?.click();
      expect(voiceWakeRequest).toHaveBeenCalledTimes(priorCalls);
      setGatewayConnection(true);
      flush();
      expect(page.querySelector("textarea")?.value).toBe("hello computer");
      page.querySelector<HTMLButtonElement>("[role='alert'] button")?.click();
      await vi.advanceTimersByTimeAsync(0);
      flush();
      expect(voiceWakeRequest).toHaveBeenLastCalledWith("voicewake.set", {
        triggers: ["hello computer"],
      });
      expect(page.querySelector("[role='alert']")).toBeNull();
      expect(page.querySelector("textarea")?.value).toBe("hello computer");
    },
  );

  it("does not carry an unsaved trigger draft into another Gateway", async () => {
    let gatewayWords = ["openclaw"];
    const { page, input, voiceWakeRequest, setGatewayConnection } = await voiceWakeFixture(
      () => ({ triggers: gatewayWords }),
      () => gatewayWords,
    );
    editTrigger(input, "old gateway words");
    setGatewayConnection(false);
    gatewayWords = ["new gateway words"];
    setGatewayConnection(true, "wss://other-gateway.example.test");
    await vi.advanceTimersByTimeAsync(400);
    flush();
    expect(page.querySelector("textarea")?.value).toBe("new gateway words");
    expect(voiceWakeRequest.mock.calls).toEqual([
      ["voicewake.get", {}],
      ["voicewake.get", {}],
    ]);
  });

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
      await vi.advanceTimersByTimeAsync(0);
      flush();
      expect(reopened.querySelector("textarea")?.value).toBe(
        switchGateway ? "other gateway phrase" : "retained phrase",
      );
      if (switchGateway) {
        expect(reopened.querySelector("[role='alert']")).toBeNull();
        expect(voiceWakeRequest).toHaveBeenCalledTimes(2);
      } else {
        expect(reopened.querySelector("[role='alert']")?.textContent).toContain("not been saved");
        reopened.querySelector<HTMLButtonElement>("[role='alert'] button")?.click();
        await vi.advanceTimersByTimeAsync(0);
        flush();
        expect(voiceWakeRequest).toHaveBeenLastCalledWith("voicewake.set", {
          triggers: ["retained phrase"],
        });
        expect(reopened.querySelector("[role='alert']")).toBeNull();
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
    const rows = [...page.querySelectorAll<HTMLElement>(".settings-row")];
    const row = (title: string) =>
      rows.find(
        (element) => element.querySelector(".settings-row__title")?.textContent?.trim() === title,
      )!;
    const expectWakeDisabled = (disabled: boolean) =>
      expect(
        row("Voice Wake").querySelector<HTMLInputElement>(".settings-toggle__input")?.disabled,
      ).toBe(disabled);
    expect(page.textContent).toContain("This Mac");
    expectWakeDisabled(true);
    expect(row("Voice Wake").textContent).toContain("macOS 26");
    row("Hold Right Option to talk").click();
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith("voice.pushToTalkEnabled", false);
    const microphone = row("Microphone").querySelector("select")!;
    microphone.value = "builtin";
    microphone.dispatchEvent(new Event("change"));
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith("voice.microphone", "builtin");
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
    expectWakeDisabled(false);
    row("Voice Wake").click();
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith("voice.wakeEnabled", false);
    snapshot.voice.wakeEnabled = false;
    publishSnapshot();
    expectWakeDisabled(true);
    snapshot.voice.supported = true;
    publishSnapshot();
    expectWakeDisabled(false);
  });

  it("preserves pending language additions across an older native acknowledgment and the next edit", () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    snapshot.voice.locale.available.push(
      { id: "fr-FR", name: "French" },
      { id: "es-ES", name: "Spanish" },
      { id: "it-IT", name: "Italian" },
    );
    const { settings: nativeDeviceSettings, publish: publishSnapshot } = nativeVoice(snapshot);
    const { page } = createTalkMutationHarness({ nativeDeviceSettings });
    flush();
    const add = (id: string, expected?: string[]) => {
      const select = page.querySelector<HTMLSelectElement>('select[aria-label="Add language…"]')!;
      select.value = id;
      select.dispatchEvent(new Event("change"));
      if (expected) {
        expect(nativeDeviceSettings.set).toHaveBeenLastCalledWith(
          "voice.locale.additional",
          expected,
          expect.any(Function),
        );
      }
    };
    add("de-DE");
    add("fr-FR", ["de-DE", "fr-FR"]);
    snapshot.voice.locale.additional = ["de-DE"];
    nativeDeviceSettings.set.mock.calls[0]?.[2]?.();
    publishSnapshot();
    add("es-ES", ["de-DE", "fr-FR", "es-ES"]);
    const primary = page.querySelector<HTMLSelectElement>('select[aria-label="Primary language"]')!;
    primary.value = "fr-FR";
    primary.dispatchEvent(new Event("change"));
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
      "voice.locale.additional",
      ["de-DE", "es-ES"],
      expect.any(Function),
    );
    snapshot.voice.locale.additional = ["de-DE", "fr-FR"];
    nativeDeviceSettings.set.mock.calls[1]?.[2]?.();
    publishSnapshot();
    expect(primary.value).toBe("fr-FR");
    add("it-IT", ["de-DE", "es-ES", "it-IT"]);
    nativeDeviceSettings.set.mock.lastCall?.[2]?.(new Error("Native edit failed"));
    publishSnapshot();
    add("es-ES", ["de-DE", "es-ES"]);
  });
});

describe("TalkSettingsPage realtime transport mutation", () => {
  it("acknowledges a model reset from the canonical config revision", async () => {
    const hashCatalog = createDeferred();
    const { page, request, runtimeConfig, setConfigHash } = createTalkMutationHarness({
      activeVoiceSelectionPolicy: "allowlist-default",
      configSnapshot: { hash: null, configRevisionHash: "revision-1" },
      defaultModel: "gpt-realtime-2.1",
      model: null,
      catalogRequest: (requestIndex, catalog) =>
        requestIndex === 3 ? hashCatalog.promise.then(() => catalog) : catalog,
    });
    await waitForSolid(() => expect(request).toHaveBeenCalledWith("talk.catalog", {}));
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
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForSolid(() => expectVoiceState(page, DEFAULT_VOICES, false));

    Object.assign(runtimeConfig.state.configSnapshot, { configRevisionHash: "revision-2" });
    setConfigHash(null);
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(3));
    window.dispatchEvent(new Event("focus"));
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(4));
    await waitForSolid(() => expectVoiceState(page, ACTIVE_VOICES, true));
    hashCatalog.resolve();
    await request.mock.results[2]?.value;
    expectVoiceState(page, ACTIVE_VOICES, true);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("retains a reset without revisions, then clears it after reconnect with a revision", async () => {
    const { page, request, setConfigHash, setGatewayConnection } = createTalkMutationHarness({
      activeVoiceSelectionPolicy: "allowlist-default",
      configSnapshot: { hash: null, configRevisionHash: null },
      defaultModel: "gpt-realtime-2.1",
      model: null,
    });
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledTimes(1);
      expect(page.querySelector("openclaw-select-picker")).not.toBeNull();
    });
    page.changeModel(null);
    setTalkRealtimeConfig(page, { provider: "openai", speakerVoice: "custom-voice" });
    flush();

    window.dispatchEvent(new Event("focus"));
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    expectVoiceState(page, DEFAULT_VOICES, false);
    await waitForSolid(() => expectVoiceState(page, DEFAULT_VOICES, false));

    setGatewayConnection(false);
    setConfigHash("hash-3");
    expectVoiceState(page, DEFAULT_VOICES, false);
    setGatewayConnection(true);
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(3));
    await waitForSolid(() => expectVoiceState(page, ACTIVE_VOICES, true));
  });

  it("clears model reset intent on explicit model, provider, and Gateway changes", async () => {
    const { page, request, setGatewayConnection } = createTalkMutationHarness({
      defaultModel: "gpt-realtime-2.1",
      model: null,
      voicesByModel: {
        "gpt-realtime-2.1": ["marin"],
        "gpt-realtime-alt": ["verse"],
      },
    });
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledTimes(1);
      expect(page.querySelector("openclaw-select-picker")).not.toBeNull();
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
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForSolid(() => expect(readVoiceOptions(page)).toEqual(["", "xai-active"]));
  });

  it("removes forced consult routing when OpenAI GPT-Live keeps gateway relay", async () => {
    const removeFormValue = await selectMutation("model", "gpt-live-test-canary", {
      consultRouting: " Force-Agent-Consult ",
      transports: ["gateway-relay"],
    });

    expect(removeFormValue).toHaveBeenCalledTimes(1);
    expect(removeFormValue).toHaveBeenCalledWith(["talk", "realtime", "consultRouting"]);
    expect(removeFormValue).not.toHaveBeenCalledWith(["talk", "realtime", "transport"]);
  });

  it.each([
    ["provider-websocket", ["provider-websocket", "gateway-relay"]],
    ["gateway-relay", ["webrtc"]],
  ] as const)(
    "removes rejected %s before relay consult cleanup on a model switch",
    async (transport, transports) => {
      const removeFormValue = await selectMutation("model", " GPT-LIVE-test-canary ", {
        model: "gpt-realtime-2.1",
        transport,
        transports: [...transports],
        consultRouting: "force-agent-consult",
        aliases: ["openai-voice"],
        provider: "openai-voice",
      });

      expect(removeFormValue).toHaveBeenCalledExactlyOnceWith(["talk", "realtime", "transport"]);
    },
  );

  it("does not apply OpenAI family cleanup to another provider's model", async () => {
    const removeFormValue = await selectMutation("model", "gpt-live-test-canary", {
      provider: "xai",
      transport: "provider-websocket",
      consultRouting: "force-agent-consult",
    });

    expect(removeFormValue).not.toHaveBeenCalled();
  });

  it("keeps generic transport handling when a catalog has no family facts", async () => {
    const removeFormValue = await selectMutation("provider", "openai", {
      provider: "xai",
      transport: "provider-websocket",
      transports: ["provider-websocket", "gateway-relay"],
      catalogRequest: (_index, catalog) => ({
        ...catalog,
        realtime: {
          ...catalog.realtime,
          providers: catalog.realtime.providers.map((provider) => ({
            ...provider,
            modelFamilySettings: undefined,
          })),
        },
      }),
    });

    expect(removeFormValue).not.toHaveBeenCalledWith(["talk", "realtime", "transport"]);
    expect(removeFormValue).not.toHaveBeenCalledWith(["talk", "realtime", "consultRouting"]);
  });

  it.each([["provider fallback", "gpt-realtime-2.1", "gpt-live-test-canary"]])(
    "removes forced consult when a provider switch activates a GPT-Live %s",
    async (_label, defaultModel, openAIProviderModel) => {
      const removeFormValue = await selectMutation("provider", "openai", {
        consultRouting: "force-agent-consult",
        defaultModel,
        openAIProviderModel,
        provider: "xai",
        transports: ["gateway-relay", "webrtc"],
      });

      expect(removeFormValue).toHaveBeenCalledWith(["talk", "realtime", "consultRouting"]);
      expect(removeFormValue).not.toHaveBeenCalledWith(["talk", "realtime", "transport"]);
    },
  );

  it("removes transport when switching to a provider that positively rejects it", async () => {
    const removeFormValue = await selectMutation("provider", "openai", {
      provider: "xai",
      transports: ["webrtc"],
    });

    expect(removeFormValue).toHaveBeenCalledWith(["talk", "realtime", "transport"]);
  });

  it("uses the auto-selected provider before preserving transport", async () => {
    expect(
      await selectMutation("model", "gpt-live-test-canary", {
        activeProvider: "openai",
        provider: null,
        transports: ["gateway-relay"],
      }),
    ).not.toHaveBeenCalled();
  });
});
