import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  createDirectTextMediaOutbound,
  createScopedChannelMediaMaxBytesResolver,
} from "../outbound/direct-text-media.js";
import {
  installChannelOutboundPayloadContractSuite,
  type OutboundPayloadHarnessParams,
} from "./outbound-payload-testkit.js";
import { primeChannelOutboundSendMock } from "./test-helpers.js";

function createDirectTextMediaHarness(params: OutboundPayloadHarnessParams) {
  const sendFn = vi.fn();
  primeChannelOutboundSendMock(sendFn, { messageId: "m1" }, params.sendResults);
  const outbound = createDirectTextMediaOutbound({
    channel: "direct-text-media",
    resolveSender: () => sendFn,
    resolveMaxBytes: () => undefined,
    buildTextOptions: (opts) => opts as never,
    buildMediaOptions: (opts) => opts as never,
  });
  const ctx = { cfg: {}, to: "user1", text: "", payload: params.payload };
  const sendPayload = expectDefined(outbound.sendPayload, "sendPayload");
  return {
    run: async () => await sendPayload(ctx),
    sendMock: sendFn,
    to: ctx.to,
  };
}

describe("outbound payload contracts: direct text/media", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "direct-text-media",
    chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
    createHarness: createDirectTextMediaHarness,
  });
});

const scopedMediaConfig: OpenClawConfig = {
  agents: { defaults: { mediaMaxMb: 4 } },
  channels: {
    "media-limit-fixture": {
      mediaMaxMb: 2,
      accounts: {
        default: { mediaMaxMb: 3 },
        office: { mediaMaxMb: 1 },
        "office-east": { mediaMaxMb: 5 },
        zero: { mediaMaxMb: 0 },
        text: { mediaMaxMb: "1" },
      },
    },
  },
};

const agentLimit = (mediaMaxMb: number): OpenClawConfig => ({
  agents: { defaults: { mediaMaxMb } },
});
const channelLimit = (mediaMaxMb: number | string, withDefault = true): OpenClawConfig => ({
  ...(withDefault ? agentLimit(4) : {}),
  channels: { "media-limit-fixture": { mediaMaxMb } },
});

// Programmatic inputs, not configuration-schema acceptance. Columns: name, config, account, bytes.
const mediaLimitCases: Array<
  [string, OpenClawConfig, string | null | undefined, number | undefined]
> = [
  ["no configured limit", {}, undefined, undefined],
  ["agent default only", agentLimit(4), undefined, 4194304],
  ["channel overrides agent", scopedMediaConfig, "missing", 2097152],
  ["default account", scopedMediaConfig, undefined, 3145728],
  ["trimmed account overrides channel", scopedMediaConfig, " OFFICE ", 1048576],
  ["canonical account key", scopedMediaConfig, " Office / East ", 5242880],
  ["zero account uses agent", scopedMediaConfig, "zero", 4194304],
  ["non-number account uses channel", scopedMediaConfig, "text", 2097152],
  ["zero channel uses agent", channelLimit(0), undefined, 4194304],
  ["zero agent default is absent", agentLimit(0), undefined, undefined],
  [
    "non-record channel uses agent",
    { ...agentLimit(4), channels: { "media-limit-fixture": [] } },
    undefined,
    4194304,
  ],
  ["fractional channel bytes", channelLimit(0.5, false), undefined, 524288],
  ["non-number channel uses agent", channelLimit("2"), undefined, 4194304],
];

describe("scoped channel media limits", () => {
  it.each(mediaLimitCases)("%s", (_name, cfg, accountId, expected) => {
    const resolveLimit = createScopedChannelMediaMaxBytesResolver("media-limit-fixture");
    expect(resolveLimit({ cfg, accountId })).toBe(expected);
  });

  it("reads the configuration supplied to each call of the same resolver", () => {
    const resolveLimit = createScopedChannelMediaMaxBytesResolver("media-limit-fixture");
    for (const [limit, expected] of [
      [1, 1048576],
      [2, 2097152],
    ] as const) {
      expect(resolveLimit({ cfg: channelLimit(limit, false) })).toBe(expected);
    }
  });

  it("carries selected limits and unchanged text/media options to the sender", async () => {
    const cfg = scopedMediaConfig;
    type BuilderInput = Parameters<
      Parameters<typeof createDirectTextMediaOutbound>[0]["buildTextOptions"]
    >[0];
    const send = vi.fn(async (_to: string, _text: string, _options: BuilderInput) => ({
      messageId: "fixture-message",
    }));
    const outbound = createDirectTextMediaOutbound({
      channel: "media-limit-fixture",
      resolveSender: () => send,
      resolveMaxBytes: createScopedChannelMediaMaxBytesResolver("media-limit-fixture"),
      buildTextOptions: (options) => ({ ...options, kind: "text" }),
      buildMediaOptions: (options) => ({ ...options, kind: "media" }),
    });
    const sendText = expectDefined(outbound.sendText, "sendText");
    const sendMedia = expectDefined(outbound.sendMedia, "sendMedia");
    const readFile = vi.fn(async () => Buffer.from("unused"));
    const legacyReadFile = vi.fn(async () => Buffer.from("unused-legacy"));
    const roots = ["/tmp/media-limit-canonical-fixture"];
    const legacyRoots = ["/tmp/media-limit-legacy-fixture"];
    const mediaAccess = { localRoots: roots, readFile, workspaceDir: "/tmp/media-limit-workspace" };
    const context = { cfg, to: "fixture-recipient", accountId: " OFFICE ", replyToId: "reply-1" };

    for (const [text, suppliedAccess, expectedAccess] of [
      ["text", undefined, undefined],
      ["caption", mediaAccess, mediaAccess],
      ["legacy caption", undefined, { localRoots: legacyRoots, readFile: legacyReadFile }],
    ] as const) {
      const isText = text === "text";
      const mediaUrl = isText ? undefined : "https://example.test/media.png";
      const result = await (isText ? sendText : sendMedia)({
        ...context,
        text,
        mediaUrl,
        ...(!isText && {
          mediaAccess: suppliedAccess,
          mediaLocalRoots: legacyRoots,
          mediaReadFile: legacyReadFile,
        }),
      });
      expect(send).toHaveBeenLastCalledWith(context.to, text, {
        cfg,
        accountId: context.accountId,
        replyToId: context.replyToId,
        maxBytes: 1048576,
        kind: isText ? "text" : "media",
        mediaUrl,
        mediaAccess: expectedAccess,
        mediaLocalRoots: expectedAccess?.localRoots,
        mediaReadFile: expectedAccess?.readFile,
      });
      const options = send.mock.lastCall?.[2];
      expect(options?.cfg).toBe(cfg);
      if (suppliedAccess) {
        expect(options?.mediaAccess).toBe(suppliedAccess);
      }
      expect(options?.mediaLocalRoots).toBe(expectedAccess?.localRoots);
      expect(result).toStrictEqual({
        channel: "media-limit-fixture",
        messageId: "fixture-message",
      });
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(legacyReadFile).not.toHaveBeenCalled();
  });
});
