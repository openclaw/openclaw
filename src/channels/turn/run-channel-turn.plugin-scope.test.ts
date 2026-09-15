import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createPluginRuntimeStore } from "../../plugin-sdk/runtime-store.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createCtx } from "./run-channel-turn.delivery.test-helpers.js";
import { runChannelTurn } from "./run-channel-turn.js";

const dispatchReplyWithRoutedChannelDispatcherCore = vi.hoisted(() => vi.fn());
vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessageWithRoutedChannelDispatcher: dispatchReplyWithRoutedChannelDispatcherCore,
  };
});
vi.mock("../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session.js")>();
  return { ...actual, recordInboundSession: vi.fn(async () => undefined) };
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("channel callback ownership", () => {
  it.each(["preview", "typing", "tool", "final"] as const)(
    "keeps %s callbacks in the admitting channel instance during provider execution",
    async (kind) => {
      const cfg = {
        session: { store: `${tempDirs.make("channel-callback-owner-")}/sessions.json` },
      };
      const channel = new PluginInstance("matrix");
      const candidate = new PluginInstance("matrix");
      const provider = new PluginInstance("codex");
      const runtime = createPluginRuntimeStore<object>({
        pluginId: "matrix",
        errorMessage: "Matrix runtime not initialized",
      });
      const liveRuntime = {};
      channel.run(() => runtime.setRuntime(liveRuntime));
      candidate.run(() => runtime.setRuntime({}));
      const payload = { text: "Working on it" };
      const identities = new WeakMap<object, string>([[payload, "original"]]);
      const seen: string[] = [];
      let retainedPreview: (() => unknown) | undefined;
      dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(
        async (params: Parameters<DispatchReplyWithBufferedBlockDispatcher>[0]) => {
          retainedPreview = () => params.replyOptions?.onPartialReply?.(payload);
          await provider.run(async () => {
            if (kind === "preview") {
              await retainedPreview?.();
            } else if (kind === "typing") {
              await params.dispatcherOptions.onReplyStart?.();
            } else {
              await params.dispatcherOptions.deliver(payload, { kind });
            }
          });
          return {
            queuedFinal: kind === "final",
            counts: { tool: kind === "tool" ? 1 : 0, block: 0, final: kind === "final" ? 1 : 0 },
          };
        },
      );
      const observe = (value: ReplyPayload) => {
        expect(runtime.getRuntime()).toBe(liveRuntime);
        expect(identities.get(value)).toBe("original");
        seen.push(kind);
      };
      try {
        await channel.run(() =>
          runChannelTurn({
            channel: "matrix",
            raw: "hello",
            adapter: {
              ingest: (raw) => ({ id: "event-1", rawText: raw, raw }),
              resolveTurn: () => ({
                cfg,
                channel: "matrix",
                route: { agentId: "main", sessionKey: "agent:main:matrix:peer" },
                ctxPayload: createCtx({ Surface: "matrix" }),
                replyOptions: { onPartialReply: observe },
                dispatcherOptions: { onReplyStart: () => observe(payload) },
                delivery: {
                  deliver: async (value) => {
                    observe(value);
                    return { visibleReplySent: true };
                  },
                },
              }),
            },
          }),
        );
        expect(seen).toEqual([kind]);
        expect(provider.run(() => runtime.tryGetRuntime())).toBeNull();
        await channel.dispose();
        expect(() => retainedPreview?.()).toThrow(/reloaded or disabled/);
      } finally {
        await Promise.all([channel.dispose(), candidate.dispose(), provider.dispose()]);
      }
    },
  );
});
