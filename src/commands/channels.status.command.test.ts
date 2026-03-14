import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const callGateway = vi.fn(async (_opts: unknown) => ({}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGateway(opts),
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

describe("channels status timeout validation", () => {
  let channelsStatusCommand: typeof import("./channels/status.js").channelsStatusCommand;

  beforeAll(async () => {
    ({ channelsStatusCommand } = await import("./channels/status.js"));
  });

  beforeEach(() => {
    callGateway.mockClear();
    callGateway.mockResolvedValue({});
  });

  it("rejects invalid timeout before calling the gateway", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await expect(channelsStatusCommand({ timeout: "nope" }, runtime as never)).rejects.toThrow(
      "--timeout must be a positive integer (milliseconds)",
    );

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
