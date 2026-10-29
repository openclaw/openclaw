import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveGeneratedImageDownloadMaxBytes,
  resolveGeneratedMediaMaxBytes,
} from "../plugin-sdk/media-generation-runtime.js";
import { resolveOutboundMediaMaxBytes } from "./configured-max-bytes.js";

const MB = 1024 * 1024;

describe("outbound routed account media limits", () => {
  it.each([
    { accountId: "roomy", accounts: { Roomy: { mediaMaxMb: 2 } }, expected: 2 },
    {
      accountId: "roomy",
      accounts: { Roomy: { mediaMaxMb: 2 }, roomy: { mediaMaxMb: 3 } },
      expected: 3,
    },
    { accountId: "absent", accounts: { Roomy: { mediaMaxMb: 2 } }, expected: 1 },
    { accountId: undefined, accounts: { Roomy: { mediaMaxMb: 2 } }, expected: 1 },
  ])(
    "uses the selected $accountId account cap with exact-key precedence",
    ({ accountId, accounts, expected }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { mediaMaxMb: 4 } },
        channels: { "qa-channel": { mediaMaxMb: 1, accounts } },
      };
      expect(resolveOutboundMediaMaxBytes({ cfg, channel: "qa-channel", accountId })).toBe(
        expected * MB,
      );
    },
  );

  it("uses Telegram's transport default after explicit limits", () => {
    expect(resolveOutboundMediaMaxBytes({ cfg: {}, channel: "telegram" })).toBe(100 * MB);
    expect(
      resolveOutboundMediaMaxBytes({
        cfg: { agents: { defaults: { mediaMaxMb: 8 } } },
        channel: "telegram",
      }),
    ).toBe(8 * MB);
    expect(resolveOutboundMediaMaxBytes({ cfg: {}, channel: "discord" })).toBe(5 * MB);
  });
});

function configWithMediaMaxMb(mediaMaxMb: number): OpenClawConfig {
  return { agents: { defaults: { mediaMaxMb } } } as OpenClawConfig;
}

describe("resolveGeneratedMediaMaxBytes", () => {
  it.each([
    { kind: "image" as const, expected: 6 * MB },
    { kind: "audio" as const, expected: 16 * MB },
    { kind: "video" as const, expected: 16 * MB },
  ])("uses the $kind default when mediaMaxMb is unset", ({ kind, expected }) => {
    expect(resolveGeneratedMediaMaxBytes(undefined, kind)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1])(
    "keeps per-kind caps and the image download bound for invalid mediaMaxMb %s",
    (mediaMaxMb) => {
      const cfg = configWithMediaMaxMb(mediaMaxMb);

      expect(resolveGeneratedMediaMaxBytes(cfg, "image")).toBe(6 * MB);
      expect(resolveGeneratedMediaMaxBytes(cfg, "audio")).toBe(16 * MB);
      expect(resolveGeneratedMediaMaxBytes(cfg, "video")).toBe(16 * MB);
      expect(resolveGeneratedImageDownloadMaxBytes(cfg)).toBe(64 * MB);
    },
  );

  it("floors fractional configured megabytes to whole bytes", () => {
    const mediaMaxMb = 1.000_001;

    expect(resolveGeneratedMediaMaxBytes(configWithMediaMaxMb(mediaMaxMb), "audio")).toBe(
      Math.floor(mediaMaxMb * MB),
    );
  });
});

describe("resolveGeneratedImageDownloadMaxBytes", () => {
  it("lets providers download images above the default media cap", () => {
    expect(resolveGeneratedImageDownloadMaxBytes(undefined)).toBe(64 * MB);
  });

  it("never drops below a larger configured media cap", () => {
    expect(resolveGeneratedImageDownloadMaxBytes(configWithMediaMaxMb(128))).toBe(128 * MB);
  });
});
