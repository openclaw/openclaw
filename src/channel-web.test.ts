import { describe, it, expect } from "vitest";

describe("channel-web module", () => {
  it("should export ChannelWeb class", async () => {
    const mod = await import("./channel-web.js");
    expect(mod.ChannelWeb).toBeDefined();
    expect(typeof mod.ChannelWeb).toBe("function");
  });

  it("should create channel instance", async () => {
    const { ChannelWeb } = await import("./channel-web.js");
    expect(() => {
      new ChannelWeb({});
    }).not.toThrow();
  });

  it("should support channel configuration", async () => {
    const { ChannelWeb } = await import("./channel-web.js");
    const channel = new ChannelWeb({
      name: "test-web",
      baseUrl: "http://localhost:3000",
    });
    expect(channel).toBeDefined();
  });

  it("should have standard channel methods", async () => {
    const { ChannelWeb } = await import("./channel-web.js");
    const channel = new ChannelWeb({});
    
    expect(typeof channel.connect).toBe("function");
    expect(typeof channel.send).toBe("function");
  });

  it("should handle channel events", async () => {
    const { ChannelWeb } = await import("./channel-web.js");
    const channel = new ChannelWeb({});
    
    expect(typeof channel.on).toBe("function");
    expect(typeof channel.off).toBe("function");
  });

  it("should initialize without required config", async () => {
    const { ChannelWeb } = await import("./channel-web.js");
    expect(() => {
      new ChannelWeb({});
    }).not.toThrow();
  });
});
