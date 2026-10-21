/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import type { SelectPicker } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers, choosePickerValue } from "../../test-helpers/select-picker.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { Talk, type TalkRealtimeProviderOption } from "./talk.tsx";

type TalkProps = Parameters<typeof Talk>[0];
const modelPicker = (container: HTMLElement) =>
  expectDefined(
    container.querySelector<SelectPicker>("openclaw-select-picker.model-picker__select"),
    "Missing model picker",
  );

function renderFixture(
  overrides: Partial<Omit<TalkProps, "selection" | "catalog">> & {
    selection?: Partial<TalkProps["selection"]>;
    provider?: Partial<TalkRealtimeProviderOption>;
  } = {},
) {
  const { selection, provider, ...props } = overrides;
  const model = selection?.model ?? "gpt-live";
  const option: TalkRealtimeProviderOption = {
    id: "openai",
    label: "OpenAI",
    configured: true,
    models: [model],
    defaultModel: model,
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
    ...provider,
  };
  const view = mountSolid(() =>
    createComponent(Talk, {
      selection: {
        provider: "openai",
        model,
        speakerVoice: null,
        transport: "webrtc",
        consultRouting: null,
        providerEntries: {},
        ...selection,
      },
      catalog: {
        kind: "ready",
        ready: true,
        activeProvider: "openai",
        providers: [option],
      },
      configBusy: false,
      onProviderChange: vi.fn(),
      onModelChange: vi.fn(),
      onVoiceChange: vi.fn(),
      editor: null,
      ...props,
    }),
  );
  flush();
  return view.container;
}

it("locks every curated picker when config mutation is unavailable", async () => {
  const container = renderFixture({
    configBusy: true,
    selection: { speakerVoice: "marin" },
    provider: { voices: ["marin"] },
  });
  await updatePickers(container);

  const provider = container.querySelector<HTMLInputElement>(".settings-segmented__input");
  expect(provider?.disabled).toBe(true);
  const voice = [...container.querySelectorAll<HTMLSelectElement>("select")];
  expect(voice).toMatchObject([{ disabled: true }]);
  expect(modelPicker(container).querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
});

it("commits provider-local model ids without qualifying them", async () => {
  const onModelChange = vi.fn();
  const container = renderFixture({
    provider: { models: ["gpt-live", "gpt-realtime"] },
    onModelChange,
  });
  await updatePickers(container);

  const picker = modelPicker(container);
  await choosePickerValue(picker, "gpt-realtime");
  expect(onModelChange).toHaveBeenCalledWith("gpt-realtime");
});

it.each([
  ["gpt-live", true],
  [" GPT-LIVE-test-canary ", true],
  ["gpt-liveish", false],
] as const)("renders the GPT-Live hint only for the exact family: %s", (model, showsHint) => {
  const container = renderFixture({ selection: { model, transport: "gateway-relay" } });
  expect(container.textContent?.includes(t("talkPage.gptLive.hint"))).toBe(showsHint);
  if (showsHint) {
    const row = [...container.querySelectorAll(".settings-row")].find((entry) =>
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
  (kind, model, speakerVoice, voices) => {
    const selection = { model, speakerVoice, provider: kind === "model" ? "openai" : "other" };
    const provider: Partial<TalkRealtimeProviderOption> =
      kind === "model"
        ? { voicesByModel: { [model]: voices } }
        : { id: "other", voices, activeVoices: ["active-only"], modelFamilySettings: undefined };
    const container = renderFixture({ selection, provider });
    const options = [...container.querySelectorAll<HTMLOptionElement>("select option")];
    expect(options.map((option) => option.value)).toEqual(["", ...voices]);
    expect(options.map((option) => option.getAttribute("value") ?? "")).toEqual(["", ...voices]);
    if (selection.provider === "other") {
      expect(container.textContent).not.toContain(t("talkPage.gptLive.hint"));
    }
  },
);
