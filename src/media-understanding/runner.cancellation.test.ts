import { ok } from "@openclaw/normalization-core/result";
import { describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { runCliEntry, runProviderEntry } from "./runner.entries.js";
import { runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

type Transcribe = NonNullable<MediaUnderstandingProvider["transcribeAudioWithContext"]>;

describe("media understanding cancellation", () => {
  it.each(["success", "failure"] as const)(
    "rejects a late provider %s without admitting another candidate or attachment",
    async (outcome) => {
      await withAudioFixture("openclaw-media-cancellation", async ({ ctx, media, cache }) => {
        const attachment = media[0];
        if (!attachment) {
          throw new Error("missing audio fixture");
        }
        media.push({ ...attachment, index: 1 });
        const controller = new AbortController();
        const reason = new Error("reply stopped");
        const started = createDeferred<Parameters<Transcribe>[0]>();
        const released = createDeferred();
        const first = vi.fn<Transcribe>(async (request) => {
          started.resolve(request);
          await released.promise;
          if (outcome === "failure") {
            throw new Error("provider stopped late");
          }
          return ok({ text: "late transcript" });
        });
        const fallback = vi.fn<Transcribe>(async () => ok({ text: "fallback transcript" }));
        const request = {
          capability: "audio" as const,
          cfg: {
            tools: {
              media: {
                models: [
                  { provider: "first", model: "stt" },
                  { provider: "fallback", model: "stt" },
                ],
                audio: {
                  attachments: { mode: "all" as const },
                },
              },
            },
          },
          ctx,
          media,
          attachments: cache,
          providerRegistry: new Map<string, MediaUnderstandingProvider>([
            ["first", { id: "first", capabilities: ["audio"], transcribeAudioWithContext: first }],
            [
              "fallback",
              { id: "fallback", capabilities: ["audio"], transcribeAudioWithContext: fallback },
            ],
          ]),
          signal: controller.signal,
        };
        const operation = runCapability(request);
        try {
          const providerRequest = await awaitGateBeforeSettlement(
            started.promise,
            operation,
            "provider did not start",
          );
          controller.abort(reason);
          released.resolve();
          await expect(operation).rejects.toBe(reason);
          expect(providerRequest.signal).toBe(controller.signal);
          expect(first).toHaveBeenCalledOnce();
          expect(fallback).not.toHaveBeenCalled();
        } finally {
          released.resolve();
          await operation.catch(() => {});
        }
      });
    },
  );

  it("does not admit a provider for an already stopped turn", async () => {
    await withAudioFixture("openclaw-media-preabort", async ({ ctx, media, cache }) => {
      const controller = new AbortController();
      const reason = new Error("reply already stopped");
      controller.abort(reason);
      const transcribe = vi.fn<Transcribe>(async () => ok({ text: "unexpected transcript" }));
      const request = {
        capability: "audio" as const,
        cfg: { tools: { media: { models: [{ provider: "fixture", model: "stt" }] } } },
        ctx,
        media,
        attachments: cache,
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          [
            "fixture",
            { id: "fixture", capabilities: ["audio"], transcribeAudioWithContext: transcribe },
          ],
        ]),
        signal: controller.signal,
      };
      await expect(runCapability(request)).rejects.toBe(reason);
      expect(transcribe).not.toHaveBeenCalled();
    });
  });

  it("does not retry an API-key provider after caller cancellation", async () => {
    await withAudioFixture("openclaw-media-retry-cancellation", async ({ cache }) => {
      const controller = new AbortController();
      const reason = new Error("reply stopped during provider execution");
      const transcribe = vi.fn<NonNullable<MediaUnderstandingProvider["transcribeAudio"]>>(
        async (request) => {
          expect(request.signal).toBe(controller.signal);
          controller.abort(reason);
          throw Object.assign(new Error("provider temporarily unavailable"), { status: 503 });
        },
      );
      await expect(
        runProviderEntry({
          capability: "audio",
          cfg: {
            models: {
              providers: {
                fixture: { apiKey: "test-key", baseUrl: "https://fixture.invalid", models: [] },
              },
            },
          },
          entry: { provider: "fixture", model: "stt" },
          attachmentIndex: 0,
          cache,
          providerRegistry: new Map([
            ["fixture", { id: "fixture", capabilities: ["audio"], transcribeAudio: transcribe }],
          ]),
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
      expect(transcribe).toHaveBeenCalledOnce();
    });
  });

  it("stops a real transcription child before returning cancellation", async ({ signal }) => {
    const receipts = await openFixtureReceiptChannel();
    const source = "media-transcription";
    try {
      await withAudioFixture("openclaw-media-cli-process", async ({ ctx, media, cache }) => {
        const attachment = media[0];
        if (!attachment) {
          throw new Error("missing audio fixture");
        }
        const controller = new AbortController();
        const reason = new Error("reply stopped during CLI transcription");
        const script = `${fixtureReceiptClientSource(receipts.endpoint)}
          sendReceipt(${JSON.stringify(source)}, "started");
          await awaitRelease(${JSON.stringify(source)}, "finish");`;
        const operation = runCliEntry({
          capability: "audio",
          entry: { command: process.execPath, args: ["--input-type=module", "-e", script] },
          cfg: {},
          ctx,
          attachment,
          cache,
          signal: controller.signal,
        });
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              receipts.waitFor(source, "started"),
              operation,
              "transcription child did not start",
            ),
            signal,
          );
          controller.abort(reason);
          await expect(withinTest(operation, signal)).rejects.toBe(reason);
          await withinTest(receipts.waitForExit(source), signal);
        } finally {
          controller.abort(reason);
          receipts.release(source, "finish");
          await operation.catch(() => {});
        }
      });
    } finally {
      await receipts.close();
    }
  });

  it("keeps ordinary provider timeouts eligible for fallback", async () => {
    await withAudioFixture("openclaw-media-timeout", async ({ ctx, media, cache }) => {
      const first = vi.fn<Transcribe>(async () => {
        throw new DOMException("provider timed out", "TimeoutError");
      });
      const fallback = vi.fn<Transcribe>(async () => ok({ text: "fallback transcript" }));
      const result = await runCapability({
        capability: "audio",
        cfg: {
          tools: {
            media: {
              models: [
                { provider: "first", model: "stt" },
                { provider: "fallback", model: "stt" },
              ],
            },
          },
        },
        ctx,
        media,
        attachments: cache,
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          ["first", { id: "first", capabilities: ["audio"], transcribeAudioWithContext: first }],
          [
            "fallback",
            { id: "fallback", capabilities: ["audio"], transcribeAudioWithContext: fallback },
          ],
        ]),
        signal: new AbortController().signal,
      });
      expect(result.outputs).toMatchObject([{ text: "fallback transcript" }]);
      expect(first).toHaveBeenCalledOnce();
      expect(fallback).toHaveBeenCalledOnce();
    });
  });
});
