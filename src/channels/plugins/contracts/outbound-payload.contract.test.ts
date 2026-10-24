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
  const sendPayload = outbound.sendPayload;
  if (!sendPayload) {
    throw new Error("Expected direct text/media outbound sendPayload");
  }
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
        nan: { mediaMaxMb: Number.NaN },
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
  ["channel limit before agent default", scopedMediaConfig, "missing", 2097152],
  ["omitted account selects default", scopedMediaConfig, undefined, 3145728],
  ["null account selects default", scopedMediaConfig, null, 3145728],
  ["blank account selects default", scopedMediaConfig, "  ", 3145728],
  ["account limit before channel limit", scopedMediaConfig, "office", 1048576],
  ["trimmed lowercase account", scopedMediaConfig, " OFFICE ", 1048576],
  ["canonicalized account key", scopedMediaConfig, " Office / East ", 5242880],
  ["zero account limit falls through to agent default", scopedMediaConfig, "zero", 4194304],
  ["NaN account limit falls through to agent default", scopedMediaConfig, "nan", 4194304],
  ["non-number account limit falls through to channel", scopedMediaConfig, "text", 2097152],
  ["zero channel limit falls through to agent default", channelLimit(0), undefined, 4194304],
  [
    "NaN channel limit falls through to agent default",
    channelLimit(Number.NaN),
    undefined,
    4194304,
  ],
  ["zero agent default is absent", agentLimit(0), undefined, undefined],
  ["NaN agent default is absent", agentLimit(Number.NaN), undefined, undefined],
  [
    "non-record channel section falls through to agent default",
    { ...agentLimit(4), channels: { "media-limit-fixture": [] } },
    undefined,
    4194304,
  ],
  ["fractional channel limit retains byte conversion", channelLimit(0.5, false), undefined, 524288],
  [
    "non-number channel limit falls through to agent default",
    channelLimit("2"),
    undefined,
    4194304,
  ],
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
    const textOptions = { kind: "text" };
    const mediaOptions = { kind: "media" };
    const send = vi.fn(async (_to: string, _text: string, _options: { kind: string }) => ({
      messageId: "fixture-message",
    }));
    type BuilderInput = Parameters<
      Parameters<typeof createDirectTextMediaOutbound>[0]["buildTextOptions"]
    >[0];
    const built: BuilderInput[] = [];
    const outbound = createDirectTextMediaOutbound({
      channel: "media-limit-fixture",
      resolveSender: () => send,
      resolveMaxBytes: createScopedChannelMediaMaxBytesResolver("media-limit-fixture"),
      buildTextOptions: (options) => {
        built.push(options);
        return textOptions;
      },
      buildMediaOptions: (options) => {
        built.push(options);
        return mediaOptions;
      },
    });
    const sendText = outbound.sendText;
    const sendMedia = outbound.sendMedia;
    if (!sendText || !sendMedia) {
      throw new Error("Expected direct text and media send operations");
    }
    const readFile = vi.fn(async () => Buffer.from("unused"));
    const legacyReadFile = vi.fn(async () => Buffer.from("unused-legacy"));
    const roots = ["/tmp/media-limit-canonical-fixture"];
    const legacyRoots = ["/tmp/media-limit-legacy-fixture"];
    const mediaAccess = { localRoots: roots, readFile, workspaceDir: "/tmp/media-limit-workspace" };
    const context = { cfg, to: "fixture-recipient", accountId: " OFFICE ", replyToId: "reply-1" };

    const textResult = await sendText({ ...context, text: "text" });
    const mediaResult = await sendMedia({
      ...context,
      text: "caption",
      mediaUrl: "https://example.test/canonical.png",
      mediaAccess,
      mediaLocalRoots: legacyRoots,
      mediaReadFile: legacyReadFile,
    });
    const legacyResult = await sendMedia({
      ...context,
      text: "legacy caption",
      mediaUrl: "https://example.test/legacy.png",
      mediaLocalRoots: legacyRoots,
      mediaReadFile: legacyReadFile,
    });

    const commonOptions = { cfg, accountId: " OFFICE ", replyToId: "reply-1", maxBytes: 1048576 };
    expect(built).toStrictEqual([
      {
        ...commonOptions,
        mediaUrl: undefined,
        mediaAccess: undefined,
        mediaLocalRoots: undefined,
        mediaReadFile: undefined,
      },
      {
        ...commonOptions,
        mediaUrl: "https://example.test/canonical.png",
        mediaAccess,
        mediaLocalRoots: roots,
        mediaReadFile: readFile,
      },
      {
        ...commonOptions,
        mediaUrl: "https://example.test/legacy.png",
        mediaAccess: { localRoots: legacyRoots, readFile: legacyReadFile },
        mediaLocalRoots: legacyRoots,
        mediaReadFile: legacyReadFile,
      },
    ]);
    for (const options of built) {
      expect(options.cfg).toBe(cfg);
    }
    expect(built[1]?.mediaAccess).toBe(mediaAccess);
    expect(built[1]?.mediaLocalRoots).toBe(roots);
    expect(built[2]?.mediaLocalRoots).toBe(legacyRoots);
    expect(send.mock.calls).toStrictEqual([
      ["fixture-recipient", "text", textOptions],
      ["fixture-recipient", "caption", mediaOptions],
      ["fixture-recipient", "legacy caption", mediaOptions],
    ]);
    expect(send.mock.calls[0]?.[2]).toBe(textOptions);
    expect(send.mock.calls[1]?.[2]).toBe(mediaOptions);
    expect(send.mock.calls[2]?.[2]).toBe(mediaOptions);
    expect([textResult, mediaResult, legacyResult]).toStrictEqual([
      { channel: "media-limit-fixture", messageId: "fixture-message" },
      { channel: "media-limit-fixture", messageId: "fixture-message" },
      { channel: "media-limit-fixture", messageId: "fixture-message" },
    ]);
    expect(readFile).not.toHaveBeenCalled();
    expect(legacyReadFile).not.toHaveBeenCalled();
  });
});
