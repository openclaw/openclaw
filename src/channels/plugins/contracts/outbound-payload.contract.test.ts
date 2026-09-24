// Outbound payload contract tests cover channel plugin outbound payload shape and normalization.
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
  const ctx = {
    cfg: {},
    to: "user1",
    text: "",
    payload: params.payload,
  };
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

describe("outbound payload contracts", () => {
  describe("direct text/media", () => {
    installChannelOutboundPayloadContractSuite({
      channel: "direct-text-media",
      chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
      createHarness: createDirectTextMediaHarness,
    });
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

const mediaLimitCases: Array<{
  name: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
  expected: number | undefined;
}> = [
  { name: "no configured limit", cfg: {}, expected: undefined },
  {
    name: "agent default only",
    cfg: { agents: { defaults: { mediaMaxMb: 4 } } },
    expected: 4194304,
  },
  {
    name: "channel limit before agent default",
    cfg: scopedMediaConfig,
    accountId: "missing",
    expected: 2097152,
  },
  { name: "omitted account selects default", cfg: scopedMediaConfig, expected: 3145728 },
  {
    name: "null account selects default",
    cfg: scopedMediaConfig,
    accountId: null,
    expected: 3145728,
  },
  {
    name: "blank account selects default",
    cfg: scopedMediaConfig,
    accountId: "  ",
    expected: 3145728,
  },
  {
    name: "account limit before channel limit",
    cfg: scopedMediaConfig,
    accountId: "office",
    expected: 1048576,
  },
  {
    name: "trimmed lowercase account",
    cfg: scopedMediaConfig,
    accountId: " OFFICE ",
    expected: 1048576,
  },
  {
    name: "canonicalized account key",
    cfg: scopedMediaConfig,
    accountId: " Office / East ",
    expected: 5242880,
  },
  // These characterize programmatic inputs, not configuration-schema acceptance.
  {
    name: "zero account limit falls through to agent default",
    cfg: scopedMediaConfig,
    accountId: "zero",
    expected: 4194304,
  },
  {
    name: "NaN account limit falls through to agent default",
    cfg: scopedMediaConfig,
    accountId: "nan",
    expected: 4194304,
  },
  {
    name: "non-number account limit falls through to channel",
    cfg: scopedMediaConfig,
    accountId: "text",
    expected: 2097152,
  },
  {
    name: "zero channel limit falls through to agent default",
    cfg: {
      agents: { defaults: { mediaMaxMb: 4 } },
      channels: { "media-limit-fixture": { mediaMaxMb: 0 } },
    },
    expected: 4194304,
  },
  {
    name: "NaN channel limit falls through to agent default",
    cfg: {
      agents: { defaults: { mediaMaxMb: 4 } },
      channels: { "media-limit-fixture": { mediaMaxMb: Number.NaN } },
    },
    expected: 4194304,
  },
  {
    name: "zero agent default is absent",
    cfg: { agents: { defaults: { mediaMaxMb: 0 } } },
    expected: undefined,
  },
  {
    name: "NaN agent default is absent",
    cfg: { agents: { defaults: { mediaMaxMb: Number.NaN } } },
    expected: undefined,
  },
  {
    name: "non-record channel section falls through to agent default",
    cfg: { agents: { defaults: { mediaMaxMb: 4 } }, channels: { "media-limit-fixture": [] } },
    expected: 4194304,
  },
  {
    name: "fractional channel limit retains byte conversion",
    cfg: { channels: { "media-limit-fixture": { mediaMaxMb: 0.5 } } },
    expected: 524288,
  },
  {
    name: "non-number channel limit falls through to agent default",
    cfg: {
      agents: { defaults: { mediaMaxMb: 4 } },
      channels: { "media-limit-fixture": { mediaMaxMb: "2" } },
    },
    expected: 4194304,
  },
];

describe("scoped channel media limits", () => {
  it.each(mediaLimitCases)("$name", ({ name: _name, expected, ...input }) => {
    const resolveLimit = createScopedChannelMediaMaxBytesResolver("media-limit-fixture");
    expect(resolveLimit(input)).toBe(expected);
  });

  it("reads the configuration supplied to each call of the same resolver", () => {
    const resolveLimit = createScopedChannelMediaMaxBytesResolver("media-limit-fixture");
    expect(resolveLimit({ cfg: { channels: { "media-limit-fixture": { mediaMaxMb: 1 } } } })).toBe(
      1048576,
    );
    expect(resolveLimit({ cfg: { channels: { "media-limit-fixture": { mediaMaxMb: 2 } } } })).toBe(
      2097152,
    );
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

    expect(built).toStrictEqual([
      {
        cfg,
        mediaUrl: undefined,
        mediaAccess: undefined,
        mediaLocalRoots: undefined,
        mediaReadFile: undefined,
        accountId: " OFFICE ",
        replyToId: "reply-1",
        maxBytes: 1048576,
      },
      {
        cfg,
        mediaUrl: "https://example.test/canonical.png",
        mediaAccess,
        mediaLocalRoots: roots,
        mediaReadFile: readFile,
        accountId: " OFFICE ",
        replyToId: "reply-1",
        maxBytes: 1048576,
      },
      {
        cfg,
        mediaUrl: "https://example.test/legacy.png",
        mediaAccess: { localRoots: legacyRoots, readFile: legacyReadFile },
        mediaLocalRoots: legacyRoots,
        mediaReadFile: legacyReadFile,
        accountId: " OFFICE ",
        replyToId: "reply-1",
        maxBytes: 1048576,
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
