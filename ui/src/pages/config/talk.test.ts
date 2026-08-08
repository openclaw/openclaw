/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { TalkRealtimeSelection } from "./talk-schema.ts";
import { renderTalk, selectedTalkProviderRejectsTransport, type TalkCatalogState } from "./talk.ts";

describe("renderTalk", () => {
  it("locks every curated picker when config mutation is unavailable", () => {
    const container = document.createElement("div");
    render(
      renderTalk({
        selection: {
          provider: "openai",
          model: "gpt-live",
          speakerVoice: "marin",
          transport: "webrtc",
          providerEntries: {},
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
              models: ["gpt-live"],
              voices: ["marin"],
              transports: ["webrtc"],
              defaultModel: "gpt-live",
            },
          ],
        },
        configBusy: true,
        onProviderChange: vi.fn(),
        onModelChange: vi.fn(),
        onVoiceChange: vi.fn(),
        editor: html``,
      }),
      container,
    );

    const provider = container.querySelector<HTMLElement & { disabled?: boolean }>(
      "wa-radio-group",
    );
    expect(provider?.disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLSelectElement>("select")]).toHaveLength(2);
    expect(
      [...container.querySelectorAll<HTMLSelectElement>("select")].every(
        (select) => select.disabled,
      ),
    ).toBe(true);
  });
});

describe("selectedTalkProviderRejectsTransport", () => {
  // The Control UI once cleared any non-webrtc transport when a GPT-Live model was picked,
  // because GPT-Live used to be WebRTC-only. The OpenAI provider now also advertises
  // gateway-relay, which the native macOS relay path requires, so this picker must stop
  // deleting a selector another client depends on.
  const catalog: TalkCatalogState = {
    kind: "ready",
    ready: true,
    activeProvider: "openai",
    providers: [
      {
        id: "openai",
        label: "OpenAI",
        configured: true,
        aliases: ["openai-realtime"],
        models: ["gpt-live"],
        voices: ["marin"],
        transports: ["webrtc"],
        defaultModel: "gpt-live",
      },
    ],
  };
  const selection = (provider: string | null): TalkRealtimeSelection => ({
    provider,
    model: "gpt-live",
    speakerVoice: "marin",
    transport: "gateway-relay",
    providerEntries: {},
  });

  it.each([["openai"], ["openai-realtime"], [null]])(
    "clears a rejected transport for canonical, alias, and auto provider %s",
    (provider) => {
      expect(
        selectedTalkProviderRejectsTransport(catalog, selection(provider), "gateway-relay"),
      ).toBe(true);
    },
  );

  it("keeps a transport the selected provider advertises", () => {
    const supportedCatalog: TalkCatalogState = {
      ...catalog,
      providers: [{ ...catalog.providers[0]!, transports: ["webrtc", "gateway-relay"] }],
    };
    expect(
      selectedTalkProviderRejectsTransport(supportedCatalog, selection("openai"), "gateway-relay"),
    ).toBe(false);
  });

  it("leaves the configured value alone for unknown providers or missing declarations", () => {
    const undeclaredCatalog: TalkCatalogState = {
      ...catalog,
      providers: [{ ...catalog.providers[0]!, transports: [] }],
    };
    expect(
      selectedTalkProviderRejectsTransport(undeclaredCatalog, selection("openai"), "gateway-relay"),
    ).toBe(false);
    expect(
      selectedTalkProviderRejectsTransport(catalog, selection("unknown"), "gateway-relay"),
    ).toBe(false);
  });
});
