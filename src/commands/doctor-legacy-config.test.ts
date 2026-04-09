import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeCompatibilityConfigValues } from "./doctor-legacy-config.js";

function asLegacyConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function getLegacyProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
describe("normalizeCompatibilityConfigValues preview streaming aliases", () => {
  it("preserves telegram boolean streaming aliases as-is", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          telegram: {
            streaming: false,
          },
        },
      }),
    );

    expect(res.config.channels?.telegram?.streaming).toEqual({ mode: "off" });
    expect(getLegacyProperty(res.config.channels?.telegram, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.telegram.streaming (boolean) → channels.telegram.streaming.mode (off).",
    ]);
  });

  it("preserves discord boolean streaming aliases as-is", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          discord: {
            streaming: true,
          },
        },
      }),
    );

    expect(res.config.channels?.discord?.streaming).toEqual({ mode: "partial" });
    expect(getLegacyProperty(res.config.channels?.discord, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.discord.streaming (boolean) → channels.discord.streaming.mode (partial).",
    ]);
  });

  it("preserves explicit discord streaming=false as-is", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          discord: {
            streaming: false,
          },
        },
      }),
    );

    expect(res.config.channels?.discord?.streaming).toEqual({ mode: "off" });
    expect(getLegacyProperty(res.config.channels?.discord, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.discord.streaming (boolean) → channels.discord.streaming.mode (off).",
    ]);
  });

  it("preserves discord streamMode when legacy config resolves to off", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          discord: {
            streamMode: "off",
          },
        },
      }),
    );

    expect(res.config.channels?.discord?.streaming).toEqual({ mode: "off" });
    expect(getLegacyProperty(res.config.channels?.discord, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.discord.streamMode → channels.discord.streaming.mode (off).",
      'channels.discord.streaming remains off by default to avoid Discord preview-edit rate limits; set channels.discord.streaming.mode="partial" to opt in explicitly.',
    ]);
  });

  it("preserves slack boolean streaming aliases as-is", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          slack: {
            streaming: false,
          },
        },
      }),
    );

    expect(res.config.channels?.slack?.streaming).toEqual({
      mode: "off",
      nativeTransport: false,
    });
    expect(getLegacyProperty(res.config.channels?.slack, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.slack.streaming (boolean) → channels.slack.streaming.mode (off).",
      "Moved channels.slack.streaming (boolean) → channels.slack.streaming.nativeTransport.",
    ]);
  });
});

describe("normalizeCompatibilityConfigValues browser compatibility aliases", () => {
  it("removes legacy browser relay bind host and migrates extension profiles", () => {
    const res = normalizeCompatibilityConfigValues({
      browser: {
        relayBindHost: "127.0.0.1",
        profiles: {
          work: {
            driver: "extension",
          },
          keep: {
            driver: "existing-session",
          },
        },
      },
    } as never);

    expect(
      (res.config.browser as { relayBindHost?: string } | undefined)?.relayBindHost,
    ).toBeUndefined();
    expect(res.config.browser?.profiles?.work?.driver).toBe("existing-session");
    expect(res.config.browser?.profiles?.keep?.driver).toBe("existing-session");
    expect(res.changes).toEqual([
      "Removed browser.relayBindHost (legacy Chrome extension relay setting; host-local Chrome now uses Chrome MCP existing-session attach).",
      'Moved browser.profiles.work.driver "extension" → "existing-session" (Chrome MCP attach).',
    ]);
  });
});
