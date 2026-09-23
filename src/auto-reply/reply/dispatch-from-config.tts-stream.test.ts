import { beforeAll, beforeEach, expect, it } from "vitest";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { emptyConfig, ttsMocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  installCaptionedVoiceTestPlugin,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
});

it.each([
  {
    name: "opening bracket pair",
    chunks: ["Intro [", "[tts:text]]hidden speech[[/tts:text]] visible"],
    visible: "Intro  visible",
  },
  {
    name: "closing tag bracket pair",
    chunks: ["Intro [[tts:text]]hidden speech[", "[/tts:text]] visible"],
    visible: "Intro  visible",
  },
  { name: "literal end", chunks: ["See ["], visible: "See [" },
  { name: "complete final after literal end", chunks: ["See ["], visible: "See [", final: true },
  {
    name: "literal with attachment",
    chunks: ["See ["],
    visible: "See [",
    mediaUrl: "https://example.com/image.png",
  },
  {
    name: "complete final after literal with attachment",
    chunks: ["See ["],
    visible: "See [",
    mediaUrl: "https://example.com/image.png",
    final: true,
  },
  { name: "literal continuation", chunks: ["See [", "note]"], visible: "See [note]" },
  { name: "hidden end", chunks: ["[[tts:text]]hidden speech["], visible: "" },
])("dispatchReplyFromConfig settles $name once", async ({ chunks, visible, final, mediaUrl }) => {
  ttsMocks.state.synthesizeFinalAudio = true;
  const delivered: ReplyPayload[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      delivered.push(payload);
    },
  });
  await dispatchReplyFromConfig({
    ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
    cfg: emptyConfig,
    dispatcher,
    replyResolver: async (_ctx, opts) => {
      const pipeline = createBlockReplyPipeline({
        onBlockReply: (block, context) => opts?.onBlockReply?.(block, context),
        timeoutMs: 0,
      });
      try {
        for (const text of chunks) {
          pipeline.enqueue({
            text,
            replyToId: "source-message",
            ...(mediaUrl ? { mediaUrl } : {}),
          });
          await pipeline.flush({ force: true });
          if (mediaUrl && chunks.length === 1) {
            expect(delivered).toContainEqual(expect.objectContaining({ text: "See ", mediaUrl }));
          }
        }
        if (!final) {
          return undefined;
        }
        return (
          await buildReplyPayloads({
            payloads: [{ text: chunks.join(""), ...(mediaUrl ? { mediaUrl } : {}) }],
            isHeartbeat: false,
            didLogHeartbeatStrip: false,
            blockStreamingEnabled: true,
            blockReplyPipeline: pipeline,
            replyToMode: "off",
          })
        ).replyPayloads;
      } finally {
        pipeline.stop();
      }
    },
  });
  dispatcher.markComplete();
  await dispatcher.waitForIdle();

  expect(delivered.map((payload) => payload.text ?? "").join("")).toBe(visible);
  for (const payload of delivered.filter((entry) => entry.text)) {
    expect(payload.replyToId).toBe("source-message");
  }
  if (mediaUrl) {
    expect(delivered.filter((payload) => payload.mediaUrl === mediaUrl)).toHaveLength(1);
  }
  expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "final",
      payload: expect.objectContaining({ text: chunks.join("") }),
    }),
  );
});

it("dispatchReplyFromConfig keeps a deferred literal in its complete-text fallback", async () => {
  installCaptionedVoiceTestPlugin("telegram");
  const delivered: Array<{ text?: string; kind: string }> = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload, { kind }) => {
      delivered.push({ text: payload.text, kind });
    },
  });
  await dispatchReplyFromConfig({
    ctx: buildTestCtx({ Provider: "telegram", Surface: "telegram" }),
    cfg: emptyConfig,
    dispatcher,
    replyResolver: async (_ctx, opts) => {
      await opts?.onBlockReply?.({ text: "See [" });
      return undefined;
    },
  });
  dispatcher.markComplete();
  await dispatcher.waitForIdle();
  expect(delivered).toEqual([{ text: "See [", kind: "final" }]);
});

it("preserves a failed terminal bracket after the real producer filters its final", async () => {
  const delivered: string[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload, { kind }) => {
      if (kind === "block" && payload.text === "[") {
        throw new PlatformMessageNotDispatchedError("tail failed before send", {
          cause: undefined,
        });
      }
      if (payload.text) {
        delivered.push(payload.text);
      }
    },
  });
  await dispatchReplyFromConfig({
    ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
    cfg: emptyConfig,
    dispatcher,
    replyResolver: async (_ctx, opts) => {
      const pipeline = createBlockReplyPipeline({
        onBlockReply: (payload, context) => opts?.onBlockReply?.(payload, context),
        timeoutMs: 0,
      });
      pipeline.enqueue({ text: "See [" });
      await pipeline.flush({ force: true });
      const { replyPayloads } = await buildReplyPayloads({
        payloads: [{ text: "See [" }],
        isHeartbeat: false,
        didLogHeartbeatStrip: false,
        blockStreamingEnabled: true,
        blockReplyPipeline: pipeline,
        replyToMode: "off",
      });
      pipeline.stop();
      return replyPayloads;
    },
  });
  dispatcher.markComplete();
  await dispatcher.waitForIdle();
  expect(delivered.join("")).toBe("See [");
});

it.each([false, true])(
  "settles retained followup streams with optional cleanup (%s)",
  async (externalCleanup) => {
    let retained: GetReplyOptions | undefined;
    const delivered: string[] = [];
    const settled: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        if (payload.text) {
          delivered.push(payload.text);
        }
      },
    });
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: externalCleanup
        ? {
            onQueuedFollowupSettled: () => {
              settled.push(delivered.join(""));
            },
          }
        : {},
      replyResolver: async (_ctx, opts) => {
        retained = opts;
        return { text: "initial" };
      },
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    for (const text of ["See [", "Intro [[tts:text]]hidden[", "After ["]) {
      await retained?.onBlockReply?.({ text });
      await dispatcher.waitForIdle();
      await retained?.onQueuedFollowupSettled?.();
    }
    expect(delivered.join("")).toBe("initialSee [Intro After [");
    expect(settled).toEqual(
      externalCleanup ? ["initialSee [", "initialSee [Intro ", "initialSee [Intro After ["] : [],
    );
  },
);
