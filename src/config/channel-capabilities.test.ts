import { describe, expect, it } from "vitest";
import { resolveChannelCapabilities } from "./channel-capabilities.js";

describe("resolveChannelCapabilities", () => {
  it("returns undefined for missing config", () => {
    expect(resolveChannelCapabilities({})).toBeUndefined();
    expect(resolveChannelCapabilities({ cfg: undefined })).toBeUndefined();
  });

  it("returns undefined for missing channel", () => {
    const cfg = { channels: {} } as any;
    expect(resolveChannelCapabilities({ cfg })).toBeUndefined();
  });

  it("returns undefined for empty capabilities", () => {
    const cfg = { channels: { telegram: { capabilities: [] } } } as any;
    expect(resolveChannelCapabilities({ cfg, channel: "telegram" })).toBeUndefined();
  });

  it("returns trimmed capabilities", () => {
    const cfg = { channels: { telegram: { capabilities: [" a ", " b"] } } } as any;
    const result = resolveChannelCapabilities({ cfg, channel: "telegram" });
    expect(result).toEqual(["a", "b"]);
  });

  it("normalizes channel name", () => {
    const cfg = { channels: { "Telegram": { capabilities: ["typing"] } } } as any;
    const result = resolveChannelCapabilities({ cfg, channel: "telegram" });
    expect(result).toEqual(["typing"]);
  });
});
