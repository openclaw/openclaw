/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { SelectPicker } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers, openPicker, choosePickerValue } from "../../test-helpers/select-picker.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { Talk, type TalkRealtimeProviderOption } from "./talk.tsx";

type TalkProps = Parameters<typeof Talk>[0];

function renderFixture(
  overrides: Partial<Omit<TalkProps, "selection" | "catalog">> & {
    selection?: Partial<TalkProps["selection"]>;
    provider?: Partial<TalkRealtimeProviderOption>;
  } = {},
) {
  const { selection, provider, ...props } = overrides;
  const model = selection?.model ?? "gpt-live";
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
        providers: [
          {
            id: "openai",
            label: "OpenAI",
            configured: true,
            aliases: [],
            models: [model],
            voices: [],
            transports: ["webrtc", "gateway-relay"],
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
          },
        ],
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

describe("renderTalk", () => {
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
    )!;
    await openPicker(picker);
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
    ["gpt-live", true],
    [" GPT-LIVE-test-canary ", true],
    ["gpt-liveish", false],
  ] as const)("renders the GPT-Live hint only for the exact family: %s", (model, showsHint) => {
    const container = renderFixture({ selection: { model, transport: "gateway-relay" } });
    expect(container.textContent?.includes(t("talkPage.gptLive.hint"))).toBe(showsHint);
  });

  it("resolves the declared family hint keys from the existing English catalog", () => {
    const container = renderFixture();
    const row = [...container.querySelectorAll(".settings-row")].find((entry) =>
      entry.textContent?.includes("Released browser/Gateway-owned WebRTC"),
    );
    expect(row?.textContent).toContain("GPT-Live");
    expect(row?.textContent).toContain("Ready");
    expect(row?.textContent).not.toContain("talkPage.");
  });

  it("keeps another provider's unlisted model on its own voice catalog", () => {
    const container = renderFixture({
      selection: { provider: "other", model: "gpt-live-private-example" },
      provider: {
        id: "other",
        voices: ["other-voice"],
        activeVoices: ["active-only"],
        modelFamilySettings: undefined,
      },
    });

    expect(
      [...container.querySelectorAll<HTMLOptionElement>("select option")].map(
        (option) => option.value,
      ),
    ).toEqual(["", "other-voice"]);
    expect(container.textContent).not.toContain(t("talkPage.gptLive.hint"));
  });
});
