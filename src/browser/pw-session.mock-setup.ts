import { vi } from "vitest";

export const connectOverCdpMock = vi.fn();
export const getChromeWebSocketUrlMock = vi.fn();

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: (...args: unknown[]) => connectOverCdpMock(...args),
  },
}));

vi.mock("./chrome.js", () => ({
  getChromeWebSocketUrl: (...args: unknown[]) => getChromeWebSocketUrlMock(...args),
}));
