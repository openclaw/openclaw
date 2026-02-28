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
    resolveCliChannelOptionsMock.mockReturnValue(["telegram", "whatsapp"]);

    expect(createProgramContext()).toEqual({
      programVersion: "9.9.9-test",
      channelOptions: ["telegram", "whatsapp"],
      messageChannelOptions: "telegram|whatsapp",
      agentChannelOptions: "last|telegram|whatsapp",
    });
  });

  it("handles empty channel options", () => {
    resolveCliChannelOptionsMock.mockReturnValue([]);

    expect(createProgramContext()).toEqual({
      programVersion: "9.9.9-test",
      channelOptions: [],
      messageChannelOptions: "",
      agentChannelOptions: "last",
    });
  });
});
