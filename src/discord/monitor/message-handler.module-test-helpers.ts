import { vi } from "vitest";
import type { MockFn } from "../../test-utils/vitest-mock-fn.js";

export const preflightDiscordMessageMock: MockFn = vi.fn();
export const processDiscordMessageMock: MockFn = vi.fn();

vi.mock("./message-handler.preflight.js", () => ({
  preflightDiscordMessage: preflightDiscordMessageMock,
}));

vi.mock("./message-handler.process.js", () => ({
  processDiscordMessage: processDiscordMessageMock,
}));

export const { createDiscordMessageHandler } = await import("./message-handler.js");
