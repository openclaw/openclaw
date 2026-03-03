import { describe, expect, it, vi } from "vitest";

const resolveCliChannelOptionsMock = vi.fn(() => ["telegram", "whatsapp"]);

vi.mock("../../version.js", () => ({
  VERSION: "9.9.9-test",
}));

vi.mock("../channel-options.js", () => ({
  resolveCliChannelOptions: resolveCliChannelOptionsMock,
}));

const { createProgramContext } = await import("./context.js");

describe("createProgramContext", () => {
  it("builds program context from version and resolved channel options", () => {
    resolveCliChannelOptionsMock.mockClear().mockReturnValue(["telegram", "whatsapp"]);
    const ctx = createProgramContext();
    expect(ctx).toEqual({
      programVersion: "9.9.9-test",
      channelOptions: ["telegram", "whatsapp"],
      messageChannelOptions: "telegram|whatsapp",
      agentChannelOptions: "last|telegram|whatsapp",
    });
    expect(resolveCliChannelOptionsMock).toHaveBeenCalledOnce();
  });

  it("handles empty channel options", () => {
    resolveCliChannelOptionsMock.mockClear().mockReturnValue([]);
    const ctx = createProgramContext();
    expect(ctx).toEqual({
      programVersion: "9.9.9-test",
      channelOptions: [],
      messageChannelOptions: "",
      agentChannelOptions: "last",
    });
    expect(resolveCliChannelOptionsMock).toHaveBeenCalledOnce();
  });

  it("does not resolve channel options before access", () => {
    resolveCliChannelOptionsMock.mockClear();
    createProgramContext();
    expect(resolveCliChannelOptionsMock).not.toHaveBeenCalled();
  });

  it("reuses one channel option resolution across all getters", () => {
    resolveCliChannelOptionsMock.mockClear().mockReturnValue(["telegram"]);
    const ctx = createProgramContext();
    expect(ctx.channelOptions).toEqual(["telegram"]);
    expect(ctx.messageChannelOptions).toBe("telegram");
    expect(ctx.agentChannelOptions).toBe("last|telegram");
    expect(resolveCliChannelOptionsMock).toHaveBeenCalledOnce();
  });

  it("reads program version without resolving channel options", () => {
    resolveCliChannelOptionsMock.mockClear();
    const ctx = createProgramContext();
    expect(ctx.programVersion).toBe("9.9.9-test");
    expect(resolveCliChannelOptionsMock).not.toHaveBeenCalled();
  });
});
