/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { talkProviderRejectsTransport } from "./talk-schema.ts";
import { renderTalk } from "./talk.ts";

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

describe("talkProviderRejectsTransport", () => {
  // The Control UI once cleared any non-webrtc transport when a GPT-Live model was picked,
  // because GPT-Live used to be WebRTC-only. The OpenAI provider now also advertises
  // gateway-relay, which the native macOS relay path requires, so this picker must stop
  // deleting a selector another client depends on.
  it("keeps a transport the selected provider advertises", () => {
    expect(talkProviderRejectsTransport(["webrtc", "gateway-relay"], "gateway-relay")).toBe(false);
  });

  it("clears a transport the selected provider cannot serve", () => {
    expect(talkProviderRejectsTransport(["webrtc"], "gateway-relay")).toBe(true);
  });

  it("leaves the configured value alone when the catalog declares no transports", () => {
    expect(talkProviderRejectsTransport([], "gateway-relay")).toBe(false);
    expect(talkProviderRejectsTransport(undefined, "gateway-relay")).toBe(false);
  });
});
