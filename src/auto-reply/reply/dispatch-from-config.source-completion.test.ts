import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import * as directives from "../../tts/directives.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { emptyConfig, ttsMocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
});
afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const fencedFirst = "```ts\nconst x = \n```";
const fencedSecond = "```ts\n1;\n```";
const fencedSource = "```ts\nconst x = 1;\n```";

type Failure = "before-send" | "ambiguous" | "pending";

it.each<{
  name: string;
  prefix?: Failure;
  suffix?: Failure;
  media?: boolean;
  priorBracket?: boolean;
  paragraph?: boolean;
  finalMedia?: boolean;
  prepared?: boolean;
  fenced?: boolean;
  expected: string[];
  suffixCalls: number;
}>([
  { name: "failed suffix", suffix: "before-send", expected: ["See ", "["], suffixCalls: 1 },
  { name: "successful suffix", prepared: true, expected: ["See ", "["], suffixCalls: 1 },
  {
    name: "successful suffix after wrapped code",
    fenced: true,
    expected: [fencedFirst, fencedSecond, "See ", "["],
    suffixCalls: 1,
  },
  {
    name: "failed suffix after wrapped code",
    fenced: true,
    suffix: "before-send",
    expected: [fencedFirst, fencedSecond, "See ", `${fencedSource}\n\nSee [`],
    suffixCalls: 1,
  },
  { name: "unsent prefix", prefix: "before-send", expected: ["See ["], suffixCalls: 0 },
  {
    name: "ambiguous prefix",
    prefix: "ambiguous",
    prepared: true,
    expected: ["See "],
    suffixCalls: 0,
  },
  { name: "pending prefix", prefix: "pending", expected: [], suffixCalls: 0 },
  { name: "ambiguous suffix", suffix: "ambiguous", expected: ["See ", "["], suffixCalls: 1 },
  { name: "pending suffix", suffix: "pending", expected: ["See "], suffixCalls: 1 },
  {
    name: "paragraph boundary",
    paragraph: true,
    suffix: "before-send",
    expected: ["First", "See ", "["],
    suffixCalls: 1,
  },
  {
    name: "pending prefix with final-only media",
    prefix: "pending",
    finalMedia: true,
    expected: [],
    suffixCalls: 0,
  },
  {
    name: "ambiguous prefix with final-only media",
    prefix: "ambiguous",
    prepared: true,
    finalMedia: true,
    expected: ["See "],
    suffixCalls: 0,
  },
  {
    name: "failed suffix with sent media",
    suffix: "before-send",
    media: true,
    expected: ["See ", "["],
    suffixCalls: 1,
  },
  {
    name: "failed suffix after an unrelated bracket",
    suffix: "before-send",
    priorBracket: true,
    expected: ["[", "See ", "["],
    suffixCalls: 1,
  },
])("dispatchReplyFromConfig settles $name after producer filtering", async (scenario) => {
  const actualSessions = scenario.prepared
    ? await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
        "../../config/sessions/session-accessor.js",
      )
    : undefined;
  const preparedScope = actualSessions
    ? {
        storePath: path.join(tempDirs.make("openclaw-source-completion-"), "sessions.json"),
        sessionKey: "agent:main:discord:direct:source-completion",
      }
    : undefined;
  if (actualSessions) {
    const sessionAccessors = await import("../../config/sessions/session-accessor.js");
    const patch = actualSessions.patchSessionEntryCore;
    vi.spyOn(sessionAccessors, "patchSessionEntryCore").mockImplementation((...args) =>
      patch(...args),
    );
  }
  let buffered = false;
  // Hold the parser's future output fixed so this regression tests source accounting alone.
  vi.spyOn(directives, "createTtsDirectiveTextStreamCleaner").mockReturnValue({
    push: (text) => {
      buffered = text === "See [";
      return buffered ? "See " : text;
    },
    hasBufferedDirectiveText: () => buffered,
    flush: () => "[",
  });
  const delivered: ReplyPayload[] = [];
  let suffixCalls = 0;
  let sourceStarted = false;
  const dispatcher = createReplyDispatcher({
    deliver: async (payload, { kind }) => {
      const suffix = sourceStarted && kind === "block" && payload.text === "[";
      if (suffix) {
        suffixCalls++;
      }
      const failure =
        kind === "block" && payload.text === "See "
          ? scenario.prefix
          : suffix
            ? scenario.suffix
            : undefined;
      if (failure === "before-send") {
        throw new PlatformMessageNotDispatchedError("fragment was not sent", { cause: undefined });
      }
      if (failure === "pending") {
        return { visibleReplySent: false, suppression: { reason: "adapter_returned_no_identity" } };
      }
      delivered.push(payload);
      if (failure === "ambiguous") {
        if (scenario.prepared) {
          return { visibleReplySent: true, ambiguous: true };
        }
        throw new Error("acknowledgement lost after sending");
      }
      return undefined;
    },
  });
  const source: ReplyPayload = {
    text: "See [",
    ...(scenario.media ? { mediaUrl: "https://example.com/image.png" } : {}),
  };
  const result = await dispatchReplyFromConfig({
    ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
    cfg: emptyConfig,
    dispatcher,
    replyResolver: async (_ctx, options) => {
      if (scenario.priorBracket) {
        await options?.onBlockReply?.({ text: "[" });
        await dispatcher.waitForIdle();
      }
      sourceStarted = true;
      const pipeline = createBlockReplyPipeline({
        onBlockReply: (payload, context) => options?.onBlockReply?.(payload, context),
        timeoutMs: 0,
      });
      try {
        if (scenario.fenced) {
          pipeline.enqueue(
            setReplyPayloadMetadata(
              { text: fencedFirst },
              { blockSourceText: "```ts\nconst x = " },
            ),
          );
          pipeline.enqueue(
            setReplyPayloadMetadata({ text: fencedSecond }, { blockSourceText: "1;\n```" }),
          );
        }
        if (scenario.paragraph) {
          pipeline.enqueue({ text: "First" });
        }
        pipeline.enqueue(source);
        await pipeline.flush({ force: true });
        if (!scenario.prefix) {
          expect(delivered.at(-1)).toMatchObject({
            text: "See ",
            ...(scenario.media ? { mediaUrl: source.mediaUrl } : {}),
          });
        }
        const finalPayload = {
          ...source,
          text: scenario.fenced
            ? `${fencedSource}\n\nSee [`
            : scenario.paragraph
              ? "First\n\nSee ["
              : source.text,
          ...(scenario.finalMedia ? { mediaUrl: "https://example.com/final.opus" } : {}),
        };
        if (scenario.finalMedia) {
          setReplyPayloadMetadata(finalPayload, {
            pendingFinalDeliveryCompletion: {
              deliveryId: "source-delivery",
              intentId: "source-intent",
              sessionId: "session-1",
              sessionKey: "agent:main:main",
              storePath: "/tmp/mock-sessions.json",
            },
          });
        }
        const { replyPayloads } = await buildReplyPayloads({
          payloads: [finalPayload],
          isHeartbeat: false,
          didLogHeartbeatStrip: false,
          blockStreamingEnabled: true,
          blockReplyPipeline: pipeline,
          replyToMode: "off",
        });
        if (actualSessions && preparedScope) {
          setReplyPayloadMetadata(expectDefined(replyPayloads[0], "retained final"), {
            pendingFinalDeliveryCompletion: {
              ...preparedScope,
              sessionId: "source-session",
              intentId: "source-intent",
              deliveryId: "source-delivery",
            },
          });
          await actualSessions.replaceSessionEntry(preparedScope, {
            sessionId: "source-session",
            updatedAt: Date.now(),
            pendingFinalDelivery: {
              kind: "replayable",
              text: "See [",
              createdAt: Date.now(),
              intentId: "source-intent",
              deliveries: [{ id: "source-delivery", state: "prepared" }],
            },
          });
          expect(
            actualSessions.loadSessionEntry(preparedScope)?.pendingFinalDelivery?.deliveries,
          ).toEqual([{ id: "source-delivery", state: "prepared" }]);
        }
        await options?.onBlockReply?.({ text: "[" });
        return replyPayloads;
      } finally {
        pipeline.stop();
      }
    },
  });
  dispatcher.markComplete();
  await dispatcher.waitForIdle();
  if (actualSessions && preparedScope) {
    const pending = actualSessions.loadSessionEntry(preparedScope)?.pendingFinalDelivery;
    if (scenario.prefix === "ambiguous") {
      expect(pending?.deliveries).toEqual([{ id: "source-delivery", state: "unknown" }]);
    } else {
      expect(pending).toBeUndefined();
    }
    const recovery = await settlePendingFinalDelivery(
      {
        kind: "pending-final",
        ...preparedScope,
        sessionId: "source-session",
        intentId: "source-intent",
        deliveryId: "source-delivery",
      },
      "queued",
      ["prepared"],
    );
    expect(recovery.state).toBe("stale");
    expect(actualSessions.loadSessionEntry(preparedScope)?.pendingFinalDelivery).toEqual(pending);
  }
  expect(delivered.flatMap((payload) => payload.text ?? [])).toEqual(scenario.expected);
  expect(suffixCalls).toBe(scenario.suffixCalls);
  if (scenario.media) {
    expect(delivered.filter((payload) => payload.mediaUrl === source.mediaUrl)).toHaveLength(1);
  }
  if (scenario.finalMedia) {
    expect(delivered).toHaveLength(scenario.expected.length + 1);
    const media = delivered.filter(
      (payload) => payload.mediaUrl === "https://example.com/final.opus",
    );
    expect(media).toHaveLength(1);
    expect(result.queuedFinal).toBe(true);
    expect(
      getReplyPayloadMetadata(expectDefined(media[0], "final media"))
        ?.pendingFinalDeliveryCompletion,
    ).toBeUndefined();
  }
});

it("dispatchReplyFromConfig reserves a source before concurrent fragment preparation", async () => {
  const prefixPreparing = createDeferred();
  const suffixParsed = createDeferred();
  const releasePrefix = createDeferred();
  let buffered = false;
  vi.spyOn(directives, "createTtsDirectiveTextStreamCleaner").mockReturnValue({
    push: (text) => {
      buffered = text === "See [";
      if (!buffered) {
        suffixParsed.resolve();
      }
      return buffered ? "See " : text;
    },
    hasBufferedDirectiveText: () => buffered,
    flush: () => "[",
  });
  ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (input: unknown) => {
    const { payload, kind } = input as { payload: ReplyPayload; kind: string };
    if (kind === "block" && payload.text === "See ") {
      prefixPreparing.resolve();
      await releasePrefix.promise;
    }
    return payload;
  });
  const delivered: string[] = [];
  const attempted: string[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload, { kind }) => {
      if (payload.text) {
        attempted.push(payload.text);
      }
      if (kind === "block" && payload.text === "See ") {
        throw new PlatformMessageNotDispatchedError("prefix was not sent", { cause: undefined });
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
    replyResolver: async (_ctx, options) => {
      const pipeline = createBlockReplyPipeline({
        onBlockReply: (payload, context) => options?.onBlockReply?.(payload, context),
        timeoutMs: 0,
      });
      try {
        pipeline.enqueue({ text: "See [" });
        const prefix = pipeline.flush({ force: true });
        await prefixPreparing.promise;
        const suffix = options?.onBlockReply?.({ text: "[" });
        await suffixParsed.promise;
        await nextEventLoopTurn();
        expect(attempted).toEqual([]);
        releasePrefix.resolve();
        await Promise.all([prefix, suffix]);
        const { replyPayloads } = await buildReplyPayloads({
          payloads: [{ text: "See [" }],
          isHeartbeat: false,
          didLogHeartbeatStrip: false,
          blockStreamingEnabled: true,
          blockReplyPipeline: pipeline,
          replyToMode: "off",
        });
        return replyPayloads;
      } finally {
        releasePrefix.resolve();
        pipeline.stop();
      }
    },
  });
  dispatcher.markComplete();
  await dispatcher.waitForIdle();
  expect(attempted).toEqual(["See ", "See ["]);
  expect(delivered).toEqual(["See ["]);
});
