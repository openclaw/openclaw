/* @vitest-environment jsdom */
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import type { LitElement } from "lit";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { TtsClipRecorder } from "./tts-clip-recorder.ts";
import "./tts-voice-lab.ts";

const restoreDialog = installDialogPolyfill();
afterAll(restoreDialog);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([true, false])(
  "locks Store only when the timed-out request was sent (%s)",
  async (requestSent) => {
    const request = vi.fn(async (method: string) => {
      if (method === "tts.replicateVoice") {
        throw new GatewayProtocolRequestTimeoutError({ method, timeoutMs: 30_000, requestSent });
      }
      return { voices: [] };
    });
    const { button, flush } = await prepareRecordings(request);
    button("Store voice").click();
    await flush();
    expect(request.mock.calls.filter(([method]) => method === "tts.replicateVoice")).toHaveLength(
      1,
    );
    expect(button("Store voice").disabled).toBe(requestSent);
    button("Store voice").click();
    await flush();
    expect(request.mock.calls.filter(([method]) => method === "tts.replicateVoice")).toHaveLength(
      requestSent ? 1 : 2,
    );
  },
);

async function prepareRecordings(
  request: (
    method: string,
    params?: unknown,
    options?: { onSent?: (id: string) => void },
  ) => Promise<unknown>,
  configured = true,
  open = true,
) {
  const start = vi.spyOn(TtsClipRecorder.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(TtsClipRecorder.prototype, "stop").mockResolvedValue({
    wav: new Uint8Array([1, 2]),
    mimeType: "audio/wav",
    durationMs: 12_000,
    sampleRate: 24_000,
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:clip");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const element = document.createElement("openclaw-tts-voice-lab") as LitElement;
  Object.assign(element, {
    context: {
      gateway: {
        snapshot: {
          phase: "connected",
          client: {
            request: (
              method: string,
              params?: unknown,
              options?: { onSent?: (id: string) => void },
            ) =>
              method === "tts.providers"
                ? Promise.resolve({
                    providers: [
                      { id: "google", configured, capabilities: { replicateVoice: true } },
                    ],
                  })
                : request(method, params, options),
          },
          hello: {
            auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
            features: { methods: ["tts.voices", "tts.replicateVoice"] },
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
  const button = (text: string) => {
    const found = [...element.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === text,
    );
    if (!found) {
      throw new Error("Missing button: " + text);
    }
    return found;
  };
  await flush();
  if (!open) {
    return { element, button, flush, start, stop };
  }
  element.querySelector<HTMLButtonElement>("button.primary")!.click();
  await flush();
  const input = element.querySelector("input")!;
  input.value = "Test voice";
  input.dispatchEvent(new Event("input"));
  await flush();
  for (let clip = 0; clip < 2; clip += 1) {
    button("Start recording").click();
    await flush();
    button("Stop recording").click();
    await flush();
  }
  return { element, button, flush, start, stop };
}

it("blocks Store throughout replacement capture and freezes inputs during creation", async () => {
  const storing = createDeferred<{ id: string }>();
  const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({
    voices: [],
  }));
  const { element, button, flush, start, stop } = await prepareRecordings(request);
  const capture = createDeferred();
  start.mockReturnValueOnce(capture.promise);
  button("Record again").click();
  await flush();
  expect(button("Store voice").disabled).toBe(true);
  capture.resolve();
  await flush();
  expect(button("Store voice").disabled).toBe(true);
  const finalized = createDeferred<Awaited<ReturnType<TtsClipRecorder["stop"]>>>();
  stop.mockReturnValueOnce(finalized.promise);
  button("Stop recording").click();
  await flush();
  expect(button("Store voice").disabled).toBe(true);
  finalized.resolve({
    wav: new Uint8Array([3, 4]),
    mimeType: "audio/wav",
    durationMs: 12_000,
    sampleRate: 24_000,
  });
  await flush();
  request.mockImplementationOnce(() => storing.promise);
  button("Store voice").click();
  await flush();
  expect(element.querySelector("input")!.disabled).toBe(true);
  expect(button("Record again").disabled).toBe(true);
  storing.resolve({ id: "voice_test" });
  await flush();
  expect(request.mock.calls.find(([method]) => method === "tts.replicateVoice")?.[1]).toMatchObject(
    { consentAudioBase64: "AwQ=", sourceAudioBase64: "AQI=" },
  );
});

it("shows an incomplete catalog as a failed read and refreshes it explicitly", async () => {
  const request = vi.fn(async () => ({ voices: [], projectListingIncomplete: true }));
  const { element, button, flush } = await prepareRecordings(request);
  expect(element.textContent).toContain("Could not list stored voices.");
  expect(element.textContent).not.toContain("No stored custom voices");
  request.mockResolvedValue({ voices: [], projectListingIncomplete: false });
  button("Refresh").click();
  await flush();
  expect(element.textContent).toContain("No stored custom voices");
});

it("does not offer cloning solely because the RPC is advertised", async () => {
  const { element } = await prepareRecordings(async () => ({ voices: [] }), false, false);
  expect(element.querySelector<HTMLButtonElement>("button.primary")!.disabled).toBe(true);
});
it("keeps provider-uncertain stores locked across refresh and dialog reopening", async () => {
  const request = vi.fn(async (method: string) =>
    method === "tts.replicateVoice"
      ? { outcome: "uncertain", message: "Check the project catalog." }
      : { voices: [] },
  );
  const { element, button, flush } = await prepareRecordings(request);
  button("Store voice").click();
  await flush();
  expect(button("Store voice").disabled).toBe(true);
  button("Refresh").click();
  await flush();
  button("Close").click();
  await flush();
  element.querySelector<HTMLButtonElement>("button.primary")!.click();
  await flush();
  button("Record again").click();
  await flush();
  button("Stop recording").click();
  await flush();
  expect(button("Store voice").disabled).toBe(true);
  button("Store voice").dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(request.mock.calls.filter(([method]) => method === "tts.replicateVoice")).toHaveLength(1);
});

it("locks a dispatched store when its socket closes before a response", async () => {
  const request = vi.fn(
    async (method: string, _params?: unknown, options?: { onSent?: (id: string) => void }) => {
      if (method === "tts.replicateVoice") {
        options?.onSent?.("request-1");
        throw new Error("gateway closed (1006)");
      }
      return { voices: [] };
    },
  );
  const { button, flush } = await prepareRecordings(request);
  button("Store voice").click();
  await flush();
  expect(button("Store voice").disabled).toBe(true);
});

it.each([undefined, "AQI="])(
  "requires a new dialog creation after confirmed Store (preview %s)",
  async (audioBase64) => {
    const request = vi.fn(async (method: string) =>
      method === "tts.replicateVoice"
        ? { outcome: "stored", id: "voice_test", name: "Test voice", audioBase64 }
        : { voices: [] },
    );
    const { element, button, flush, start } = await prepareRecordings(request);
    button("Store voice").click();
    await flush();
    expect(element.textContent).toContain("Test voice");
    expect(button("Store voice").disabled).toBe(true);
    const preview = element.querySelector('audio[src^="data:"]');
    expect(Boolean(preview)).toBe(Boolean(audioBase64));

    // Dispatch also reaches the handler despite native disabled-button suppression.
    button("Store voice").dispatchEvent(new MouseEvent("click"));
    const input = element.querySelector("input")!;
    input.value = "Edited name";
    input.dispatchEvent(new Event("input"));
    expect(button("Record again").disabled).toBe(true);
    button("Record again").dispatchEvent(new MouseEvent("click"));
    button("Refresh").click();
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
    expect(button("Store voice").disabled).toBe(true);
    expect(element.querySelector('audio[src^="data:"]')).toBe(preview);
    button("Store voice").dispatchEvent(new MouseEvent("click"));
    await flush();
    expect(request.mock.calls.filter(([method]) => method === "tts.replicateVoice")).toHaveLength(
      1,
    );

    button("Close").click();
    await flush();
    element.querySelector<HTMLButtonElement>("button.primary")!.click();
    await flush();
    expect(element.querySelector('audio[src^="data:"]')).toBeNull();
    expect(button("Record again").disabled).toBe(false);
    expect(button("Store voice").disabled).toBe(false);
    button("Record again").click();
    await flush();
    button("Stop recording").click();
    await flush();
    button("Store voice").click();
    await flush();
    expect(request.mock.calls.filter(([method]) => method === "tts.replicateVoice")).toHaveLength(
      2,
    );
    expect(button("Store voice").disabled).toBe(true);
  },
);
