import type { LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import "../../styles.css";
import "../../styles/settings.css";
import { bytesToBase64 } from "../../lib/bytes-base64.ts";
import { encodeWavPcm16Mono } from "../../lib/pcm-wav.ts";
import { TtsClipRecorder } from "./tts-clip-recorder.ts";
import "./tts-voice-lab.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

// jsdom submit coverage cannot detect flex-shrunk audio or clipped status text.
// Keep this at the rendered dialog boundary, with real CSS and decodable media.
it.each(["stored", "uncertain"])(
  "keeps %s voice results readable and controls reachable",
  async (outcome) => {
    const wav = encodeWavPcm16Mono(new Uint8Array(24_000 * 12 * 2), 24_000);
    vi.spyOn(TtsClipRecorder.prototype, "start").mockResolvedValue();
    vi.spyOn(TtsClipRecorder.prototype, "stop").mockResolvedValue({
      wav,
      mimeType: "audio/wav",
      durationMs: 12_000,
      sampleRate: 24_000,
    });
    const element = document.createElement("openclaw-tts-voice-lab") as LitElement;
    Object.assign(element, {
      context: {
        gateway: {
          snapshot: {
            phase: "connected",
            hello: {
              auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
              features: { methods: ["tts.voices", "tts.replicateVoice"] },
            },
            client: {
              request: async (method: string) => {
                if (method === "tts.providers") {
                  return {
                    providers: [
                      { id: "google", configured: true, capabilities: { replicateVoice: true } },
                    ],
                  };
                }
                if (method === "tts.replicateVoice") {
                  return outcome === "stored"
                    ? {
                        outcome,
                        id: "synthetic",
                        name: "Synthetic silent fixture",
                        mimeType: "audio/wav",
                        audioBase64: bytesToBase64(wav),
                      }
                    : {
                        outcome,
                        message:
                          "Store outcome is uncertain. Check the project catalog before trying again.",
                      };
                }
                return { voices: [] };
              },
            },
          },
        },
        theme: { settings: {} },
      },
    });
    document.body.append(element);
    const flush = async () => {
      await vi.dynamicImportSettled();
      await element.updateComplete;
    };
    const button = (name: string) =>
      [...element.querySelectorAll("button")].find((el) => el.textContent?.trim() === name)!;
    await flush();
    button("Create from my voice").click();
    await flush();
    const input = element.querySelector("input")!;
    input.value = "Synthetic silent fixture";
    input.dispatchEvent(new Event("input"));
    for (let slot = 0; slot < 2; slot++) {
      button("Start recording").click();
      await flush();
      button("Stop recording").click();
      await flush();
    }
    button("Store voice").click();
    await flush();
    const card = element.querySelector<HTMLElement>(".exec-approval-card")!;
    if (outcome === "stored") {
      const preview = element.querySelector<HTMLAudioElement>('audio[src^="data:"]')!;
      if (preview.readyState < 1) {
        await new Promise<void>((resolve, reject) => {
          preview.addEventListener("loadedmetadata", () => resolve(), { once: true });
          preview.addEventListener("error", () => reject(new Error("Invalid PCM fixture")), {
            once: true,
          });
        });
      }
      expect(preview.duration).toBe(12);
      expect(preview.getBoundingClientRect().height).toBeGreaterThan(30);
    }
    expect(card.scrollWidth - card.clientWidth).toBeLessThanOrEqual(1);
    for (const control of card.querySelectorAll("audio, button, .settings-status")) {
      control.scrollIntoView({ block: "nearest" });
      const rect = control.getBoundingClientRect();
      const bounds = card.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.right).toBeLessThanOrEqual(bounds.right);
      expect(rect.top).toBeGreaterThanOrEqual(bounds.top);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom);
    }
    expect(button("Store voice").disabled).toBe(true);
  },
);
