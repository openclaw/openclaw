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
  it("normalizes telegram boolean streaming aliases to enum", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          telegram: {
            streaming: false,
          },
        },
      }),
    );

    expect(res.config.channels?.telegram?.streaming).toBe("off");
    expect(getLegacyProperty(res.config.channels?.telegram, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual(["Normalized channels.telegram.streaming boolean → enum (off)."]);
  });

  it("normalizes discord boolean streaming aliases to enum", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          discord: {
            streaming: true,
          },
        },
      }),
    );

    expect(res.config.channels?.discord?.streaming).toBe("partial");
    expect(getLegacyProperty(res.config.channels?.discord, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Normalized channels.discord.streaming boolean → enum (partial).",
    ]);
  });

  it("does not label explicit discord streaming=false as a default-off case", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          discord: {
            streaming: false,
          },
        },
      }),
    );

    expect(res.config.channels?.discord?.streaming).toBe("off");
    expect(getLegacyProperty(res.config.channels?.discord, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual(["Normalized channels.discord.streaming boolean → enum (off)."]);
  });

  it("explains why discord preview streaming stays off when legacy config resolves to off", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          discord: {
            streamMode: "off",
          },
        },
      }),
    );

    expect(res.config.channels?.discord?.streaming).toBe("off");
    expect(getLegacyProperty(res.config.channels?.discord, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.discord.streamMode → channels.discord.streaming (off).",
      'channels.discord.streaming remains off by default to avoid Discord preview-edit rate limits; set channels.discord.streaming="partial" to opt in explicitly.',
    ]);
  });

  it("normalizes slack boolean streaming aliases to enum and native streaming", () => {
    const res = normalizeCompatibilityConfigValues(
      asLegacyConfig({
        channels: {
          slack: {
            streaming: false,
          },
        },
      }),
    );

    expect(res.config.channels?.slack?.streaming).toBe("off");
    expect(res.config.channels?.slack?.nativeStreaming).toBe(false);
    expect(getLegacyProperty(res.config.channels?.slack, "streamMode")).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.slack.streaming (boolean) → channels.slack.nativeStreaming (false).",
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
