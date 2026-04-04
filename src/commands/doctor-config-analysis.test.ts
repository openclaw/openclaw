import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";
import {
  formatConfigPath,
  noteLegacyTalkConfig,
  resolveConfigPathTarget,
  stripUnknownConfigKeys,
} from "./doctor-config-analysis.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

describe("doctor config analysis helpers", () => {
  it("formats config paths predictably", () => {
    expect(formatConfigPath([])).toBe("<root>");
    expect(formatConfigPath(["channels", "slack", "accounts", 0, "token"])).toBe(
      "channels.slack.accounts[0].token",
    );
  });

  it("resolves nested config targets without throwing", () => {
    const target = resolveConfigPathTarget(
      { channels: { slack: { accounts: [{ token: "x" }] } } },
      ["channels", "slack", "accounts", 0],
    );
    expect(target).toEqual({ token: "x" });
    expect(resolveConfigPathTarget({ channels: null }, ["channels", "slack"])).toBeNull();
  });

  it("strips unknown config keys while keeping known values", () => {
    const result = stripUnknownConfigKeys({
      hooks: {},
      unexpected: true,
    } as never);
    expect(result.removed).toContain("unexpected");
    expect((result.config as Record<string, unknown>).unexpected).toBeUndefined();
    expect((result.config as Record<string, unknown>).hooks).toEqual({});
  });

  it("notes legacy talk configuration fields", () => {
    const cfg = {
      talk: {
        voiceId: "some-voice",
        apiKey: "some-key",
        providers: {
          elevenlabs: {
            voiceId: "another-voice",
          },
        },
      },
    } as OpenClawConfig;

    noteLegacyTalkConfig(cfg);

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Found legacy Talk Mode configuration fields at the root level: talk.voiceId, talk.apiKey",
      ),
      "Talk Mode Migration",
    );
  });

  it("does not note legacy talk fields when none are present", () => {
    vi.mocked(note).mockClear();
    const cfg = {
      talk: {
        provider: "mistral",
        providers: {
          mistral: {
            voiceId: "v1",
          },
        },
      },
    } as OpenClawConfig;

    noteLegacyTalkConfig(cfg);
    expect(note).not.toHaveBeenCalled();
  });
});
