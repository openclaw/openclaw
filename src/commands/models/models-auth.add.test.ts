import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

// Mock clack prompts to simulate user cancelling (Esc => undefined)
vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
}));

describe("models auth add - cancellation", () => {
  let clack: typeof import("@clack/prompts");

  beforeEach(async () => {
    vi.resetAllMocks();
    clack = await import("@clack/prompts");
  });

  it("does not throw when provider select is cancelled", async () => {
    const mockedClack = vi.mocked(clack, true);
    mockedClack.select.mockResolvedValueOnce(undefined);

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;

    const { modelsAuthAddCommand } = await import("./auth.js");

    await expect(modelsAuthAddCommand({}, runtime)).resolves.toBeUndefined();
    expect(runtime.log).toHaveBeenCalledWith("Cancelled.");
    expect(mockedClack.text).not.toHaveBeenCalled();
    expect(mockedClack.confirm).not.toHaveBeenCalled();
  });

  it("does not throw when method select is cancelled", async () => {
    // First select for provider returns 'anthropic'
    // Second select (method) returns undefined to simulate cancel
    const mockedClack = vi.mocked(clack, true);
    mockedClack.select.mockResolvedValueOnce("anthropic");
    mockedClack.select.mockResolvedValueOnce(undefined);

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;

    const { modelsAuthAddCommand } = await import("./auth.js");

    await expect(modelsAuthAddCommand({}, runtime)).resolves.toBeUndefined();
    expect(runtime.log).toHaveBeenCalledWith("Cancelled.");
    expect(mockedClack.text).not.toHaveBeenCalled();
    expect(mockedClack.confirm).not.toHaveBeenCalled();
  });
});
