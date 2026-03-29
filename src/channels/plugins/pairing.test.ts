import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  listPairingChannels,
  getPairingAdapter,
  requirePairingAdapter,
  resolvePairingChannel,
} from "./pairing.js";
import { getChannelPlugin, listChannelPlugins } from "./index.js";

// Mock the channel plugins
vi.mock("./index.js", () => ({
  getChannelPlugin: vi.fn(),
  listChannelPlugins: vi.fn(),
  normalizeChannelId: (id: string) => id.toLowerCase(),
}));

const mockGetChannelPlugin = vi.mocked(getChannelPlugin);
const mockListChannelPlugins = vi.mocked(listChannelPlugins);

describe("pairing functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listPairingChannels", () => {
    it("should return channels that support pairing", () => {
      mockListChannelPlugins.mockReturnValue([
        { id: "telegram", pairing: { idLabel: "userId" } },
        { id: "discord", pairing: null },
        { id: "slack", pairing: { idLabel: "teamId" } },
      ] as any);

      const result = listPairingChannels();
      expect(result).toEqual(["telegram", "slack"]);
    });

    it("should return empty array when no channels support pairing", () => {
      mockListChannelPlugins.mockReturnValue([
        { id: "discord", pairing: null },
        { id: "slack", pairing: null },
      ] as any);

      const result = listPairingChannels();
      expect(result).toEqual([]);
    });
  });

  describe("getPairingAdapter", () => {
    it("should return adapter for channel with pairing support", () => {
      mockGetChannelPlugin.mockReturnValue({
        id: "telegram",
        pairing: { idLabel: "userId" },
      } as any);

      const result = getPairingAdapter("telegram");
      expect(result).toEqual({ idLabel: "userId" });
    });

    it("should return null for channel without pairing support", () => {
      mockGetChannelPlugin.mockReturnValue({
        id: "discord",
        pairing: null,
      } as any);

      const result = getPairingAdapter("discord");
      expect(result).toBeNull();
    });

    it("should return null for unknown channel", () => {
      mockGetChannelPlugin.mockReturnValue(undefined);

      const result = getPairingAdapter("unknown");
      expect(result).toBeNull();
    });
  });

  describe("requirePairingAdapter", () => {
    it("should return adapter for channel with pairing support", () => {
      mockListChannelPlugins.mockReturnValue([
        { id: "telegram", pairing: { idLabel: "userId" } },
        { id: "slack", pairing: { idLabel: "teamId" } },
      ] as any);
      mockGetChannelPlugin.mockReturnValue({
        id: "telegram",
        pairing: { idLabel: "userId" },
      } as any);

      const result = requirePairingAdapter("telegram");
      expect(result).toEqual({ idLabel: "userId" });
    });

    it("should throw descriptive error for channel without pairing support", () => {
      mockListChannelPlugins.mockReturnValue([
        { id: "telegram", pairing: { idLabel: "userId" } },
        { id: "slack", pairing: { idLabel: "teamId" } },
      ] as any);
      mockGetChannelPlugin.mockReturnValue({
        id: "discord",
        pairing: null,
      } as any);

      expect(() => requirePairingAdapter("discord")).toThrow(
        'Channel "discord" does not support pairing. Available pairing channels: telegram, slack.'
      );
    });

    it("should throw descriptive error for unknown channel", () => {
      mockListChannelPlugins.mockReturnValue([
        { id: "telegram", pairing: { idLabel: "userId" } },
        { id: "slack", pairing: { idLabel: "teamId" } },
      ] as any);
      mockGetChannelPlugin.mockReturnValue(undefined);

      expect(() => requirePairingAdapter("unknown")).toThrow(
        'Channel "unknown" does not support pairing. Available pairing channels: telegram, slack.'
      );
    });

    it("should handle case with no available pairing channels", () => {
      mockListChannelPlugins.mockReturnValue([]);
      mockGetChannelPlugin.mockReturnValue(undefined);

      expect(() => requirePairingAdapter("unknown")).toThrow(
        'Channel "unknown" does not support pairing. Available pairing channels: .'
      );
    });
  });

  describe("resolvePairingChannel", () => {
    beforeEach(() => {
      mockListChannelPlugins.mockReturnValue([
        { id: "telegram", pairing: { idLabel: "userId" } },
        { id: "slack", pairing: { idLabel: "teamId" } },
      ] as any);
    });

    it("should resolve valid channel names", () => {
      expect(resolvePairingChannel("telegram")).toBe("telegram");
      expect(resolvePairingChannel("TELEGRAM")).toBe("telegram");
      expect(resolvePairingChannel(" slack ")).toBe("slack");
    });

    it("should resolve numeric and boolean inputs", () => {
      expect(resolvePairingChannel(123)).toBe("123");
      expect(resolvePairingChannel(true)).toBe("true");
    });

    it("should throw descriptive error for invalid channel", () => {
      expect(() => resolvePairingChannel("invalid")).toThrow(
        'Invalid pairing channel "invalid". Expected one of: telegram, slack'
      );
    });

    it("should throw descriptive error for empty input", () => {
      expect(() => resolvePairingChannel("")).toThrow(
        'Invalid pairing channel "(empty)". Expected one of: telegram, slack'
      );
    });

    it("should throw descriptive error when no channels available", () => {
      mockListChannelPlugins.mockReturnValue([]);

      expect(() => resolvePairingChannel("telegram")).toThrow(
        'Invalid pairing channel "telegram". Expected one of: no channels available'
      );
    });
  });
});
