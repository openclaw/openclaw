import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { applyMediaUnderstanding } from "./apply.js";
import { MediaAttachmentCache } from "./attachments.cache.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

const send = vi.hoisted(() => vi.fn(async () => ({ status: "sent" })));
// mock-isolation: Observe transcript sends without opening a real channel delivery runtime.
vi.mock("../channels/message/runtime.js", () => ({ sendDurableMessageBatchCore: send }));
// mock-isolation: Use only the injected providers, without discovering host plugins or credentials.
vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));
// mock-isolation: The synthetic Telegram transport needs no channel plugin registry.
vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) => channel === "telegram",
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  send.mockClear();
});

async function audioContext() {
  const workspaceDir = tempDirs.make("openclaw-media-cancel-");
  const audio = path.join(workspaceDir, "note.wav");
  await fs.writeFile(audio, createSafeAudioFixtureBuffer(2048));
  const ctx: MsgContext = {
    Body: "<media:audio>",
    RawBody: "original message",
    Provider: "telegram",
    From: "synthetic-chat",
    media: [{ path: audio, contentType: "audio/wav" }],
  };
  const cfg: OpenClawConfig = {
    tools: {
      media: {
        image: { enabled: false },
        video: { enabled: false },
        audio: { enabled: true, echoTranscript: true },
        models: [
          { provider: "first-media", model: "transcriber", capabilities: ["audio"] },
          { provider: "fallback-media", model: "transcriber", capabilities: ["audio"] },
        ],
      },
    },
  };
  return { ctx, cfg, workspaceDir };
}

function audioProvider(
  id: string,
  transcribeAudio: MediaUnderstandingProvider["transcribeAudio"],
): MediaUnderstandingProvider {
  return {
    id,
    capabilities: ["audio"],
    resolveAuth: () => ({ kind: "none", source: "synthetic-local-provider" }),
    transcribeAudio,
  };
}

function observeCleanup() {
  const finished = createDeferred();
  // oxlint-disable-next-line typescript/unbound-method -- Invoke the captured method with the original cache receiver below.
  const original = MediaAttachmentCache.prototype.cleanup;
  const cleanup = vi
    .spyOn(MediaAttachmentCache.prototype, "cleanup")
    .mockImplementation(async function (this: MediaAttachmentCache) {
      try {
        await original.call(this);
      } finally {
        finished.resolve();
      }
    });
  return { cleanup, finished: finished.promise };
}

it.each(["success", "failure"] as const)(
  "does not publish or fall back after a cancelled provider's late %s",
  async (outcome) => {
    const params = await audioContext();
    const before = structuredClone(params.ctx);
    const started = createDeferred();
    const provider = createDeferred<{ text: string }>();
    const fallback = vi.fn(async () => ({ text: "fallback transcript" }));
    const controller = new AbortController();
    const reason = new DOMException("Turn stopped", "AbortError");
    const { cleanup, finished } = observeCleanup();
    const running = applyMediaUnderstanding({
      ...params,
      signal: controller.signal,
      providers: {
        "first-media": audioProvider("first-media", async () => {
          started.resolve();
          return await provider.promise;
        }),
        "fallback-media": audioProvider("fallback-media", fallback),
      },
    });
    const settled = running.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await started.promise;
    controller.abort(reason);
    if (outcome === "success") {
      provider.resolve({ text: "late transcript" });
    } else {
      provider.reject(new Error("late provider failure"));
    }
    expect(await settled).toEqual({ error: reason });
    await finished;
    expect(params.ctx).toEqual(before);
    expect(fallback).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  },
);

it("settles Stop promptly but retains the cache until an uncooperative provider exits", async ({
  signal,
}) => {
  const params = await audioContext();
  const before = structuredClone(params.ctx);
  const started = createDeferred();
  const provider = createDeferred<{ text: string }>();
  const controller = new AbortController();
  const reason = new DOMException("Turn stopped", "AbortError");
  const { cleanup, finished } = observeCleanup();
  const running = applyMediaUnderstanding({
    ...params,
    signal: controller.signal,
    providers: {
      "first-media": audioProvider("first-media", async () => {
        started.resolve();
        return await provider.promise;
      }),
    },
  });
  const settled = running.catch((error: unknown) => error);
  try {
    await withinTest(started.promise, signal);
    controller.abort(reason);
    expect(await withinTest(settled, signal)).toBe(reason);
    expect(cleanup).not.toHaveBeenCalled();
    expect(params.ctx).toEqual(before);
  } finally {
    provider.resolve({ text: "late transcript" });
    await finished;
  }
  expect(cleanup).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
  expect(params.ctx).toEqual(before);
});

it("does not publish an already completed transcript when document extraction is cancelled", async () => {
  const params = await audioContext();
  const document = path.join(params.workspaceDir, "notes.txt");
  await fs.writeFile(document, "document content");
  params.ctx.media!.push({ path: document, contentType: "text/plain" });
  const before = structuredClone(params.ctx);
  const controller = new AbortController();
  const reason = new DOMException("Turn stopped during document read", "AbortError");
  const { finished } = observeCleanup();
  // oxlint-disable-next-line typescript/unbound-method -- Invoke the captured method with the original cache receiver below.
  const getBuffer = MediaAttachmentCache.prototype.getBuffer;
  vi.spyOn(MediaAttachmentCache.prototype, "getBuffer").mockImplementation(async function (
    this: MediaAttachmentCache,
    options,
  ) {
    const result = await getBuffer.call(this, options);
    if (options.attachmentIndex === 1) {
      controller.abort(reason);
    }
    return result;
  });
  await expect(
    applyMediaUnderstanding({
      ...params,
      signal: controller.signal,
      providers: {
        "first-media": audioProvider("first-media", async () => ({ text: "completed transcript" })),
      },
    }),
  ).rejects.toBe(reason);
  await finished;
  expect(params.ctx).toEqual(before);
  expect(send).not.toHaveBeenCalled();
});
