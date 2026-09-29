/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SelectPicker } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import { updatePickers, choosePickerValue } from "../../test-helpers/select-picker.ts";
import { isTalkGptLiveModel, resolveTalkRealtimeSelection } from "./talk-schema.ts";
import { renderTalk, type TalkRealtimeProviderOption } from "./talk.ts";

type TalkProps = Parameters<typeof renderTalk>[0];

function renderFixture(
  overrides: Partial<Omit<TalkProps, "selection" | "catalog">> & {
    selection?: Partial<TalkProps["selection"]>;
    provider?: Partial<TalkRealtimeProviderOption>;
  } = {},
) {
  const { selection, provider, ...props } = overrides;
  const model = selection?.model ?? "gpt-live";
  const container = document.createElement("div");
  render(
    renderTalk({
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
        providers: [
          {
            id: "openai",
            label: "OpenAI",
            configured: true,
            aliases: [],
            models: [model],
            voices: [],
            transports: [selection?.transport ?? "webrtc"],
            defaultModel: model,
            ...provider,
          },
        ],
      },
      configBusy: false,
      onProviderChange: vi.fn(),
      onModelChange: vi.fn(),
      onVoiceChange: vi.fn(),
      editor: html``,
      ...props,
    }),
    container,
  );
  return container;
}

describe("isTalkGptLiveModel", () => {
  it.each(["gpt-live", " Gpt-Live-1-Codex "])("accepts the GPT-Live family: %s", (model) => {
    expect(isTalkGptLiveModel(model)).toBe(true);
  });

  it("rejects an absent model", () => {
    expect(isTalkGptLiveModel(null)).toBe(false);
  });
});

describe("resolveTalkRealtimeSelection", () => {
  it.each([
    [" Provider-Direct ", "provider-direct"],
    [null, null],
  ])("normalizes consult routing: %s", (consultRouting, expected) => {
    expect(
      resolveTalkRealtimeSelection({
        talk: { realtime: { consultRouting } },
      }).consultRouting,
    ).toBe(expected);
  });
});

describe("renderTalk", () => {
  it("locks every curated picker when config mutation is unavailable", async () => {
    const container = renderFixture({
      configBusy: true,
      selection: { speakerVoice: "marin" },
      provider: { voices: ["marin"] },
    });
    await updatePickers(container);

    const provider = container.querySelector<HTMLElement & { disabled?: boolean }>(
      "wa-radio-group",
    );
    expect(provider?.disabled).toBe(true);
    const voice = [...container.querySelectorAll<HTMLSelectElement>("select")];
    expect(voice).toHaveLength(1);
    expect(voice.every((select) => select.disabled)).toBe(true);
    expect(
      container
        .querySelector("openclaw-select-picker.model-picker__select")
        ?.querySelector<HTMLButtonElement>("button")?.disabled,
    ).toBe(true);
  });

  it("commits provider-local model ids without qualifying them", async () => {
    const onModelChange = vi.fn();
    const container = renderFixture({
      provider: { models: ["gpt-live", "gpt-realtime"] },
      onModelChange,
    });
    await updatePickers(container);

    const picker = container.querySelector<SelectPicker>(
      "openclaw-select-picker.model-picker__select",
    );
    expect(picker?.querySelector('[role="option"][data-value="gpt-realtime"]')).not.toBeNull();
    if (picker) {
      await choosePickerValue(picker, "gpt-realtime");
    }
    expect(onModelChange).toHaveBeenCalledWith("gpt-realtime");
  });

  it("renders model-specific voices from the catalog", () => {
    const voices = ["arbor", "spruce"];
    const container = renderFixture({
      selection: { model: "gpt-live-1-codex", speakerVoice: "spruce" },
      provider: { voicesByModel: { "gpt-live-1-codex": voices } },
    });

    expect(
      [...container.querySelectorAll("select option")].map(
        (option) => option.getAttribute("value") ?? "",
      ),
    ).toEqual(["", ...voices]);
  });

  it.each([
    ["gpt-liveish", false],
    ["gpt-live-test-canary", true],
  ] as const)("renders the GPT-Live hint only for the exact family: %s", (model, showsHint) => {
    const container = renderFixture({ selection: { model, transport: "gateway-relay" } });
    expect(container.textContent?.includes(t("talkPage.gptLive.hint"))).toBe(showsHint);
  });
});
