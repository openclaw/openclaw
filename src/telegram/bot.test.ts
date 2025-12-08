import { describe, expect, it, vi } from "vitest";

const useSpy = vi.fn();
const onSpy = vi.fn();
const stopSpy = vi.fn();
type ApiStub = { config: { use: (arg: unknown) => void } };
const apiStub: ApiStub = { config: { use: useSpy } };

vi.mock("grammy", () => ({
  Bot: class {
    api = apiStub;
    on = onSpy;
    stop = stopSpy;
    constructor(public token: string) {}
  },
  InputFile: class {},
  webhookCallback: vi.fn(),
}));

const throttlerSpy = vi.fn(() => "throttler");

vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => throttlerSpy(),
}));

import { createTelegramBot } from "./bot.js";

describe("createTelegramBot", () => {
  it("installs grammY throttler", () => {
    createTelegramBot({ token: "tok" });
    expect(throttlerSpy).toHaveBeenCalledTimes(1);
    expect(useSpy).toHaveBeenCalledWith("throttler");
  });
});
