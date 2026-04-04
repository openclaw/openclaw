import { describe, expect, it, vi } from "vitest";
import { runGatewayHttpRequestStages } from "./server-http.js";

describe("runGatewayHttpRequestStages", () => {
  it("returns true when a stage handles the request", async () => {
    const stages = [
      { name: "a", run: () => false },
      { name: "b", run: () => true },
      { name: "c", run: () => false },
    ];
    expect(await runGatewayHttpRequestStages(stages)).toBe(true);
  });

  it("returns false when no stage handles the request", async () => {
    const stages = [
      { name: "a", run: () => false },
      { name: "b", run: () => false },
    ];
    expect(await runGatewayHttpRequestStages(stages)).toBe(false);
  });

  it("skips a throwing stage and continues to subsequent stages", async () => {
    const stageC = vi.fn(() => true);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stages = [
      { name: "a", run: () => false },
      {
        name: "broken-facade",
        run: () => {
          throw new Error("Cannot find module '@slack/bolt'");
        },
      },
      { name: "c", run: stageC },
    ];

    const result = await runGatewayHttpRequestStages(stages);

    expect(result).toBe(true);
    expect(stageC).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('stage "broken-facade" threw'),
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });

  it("skips a rejecting async stage and continues", async () => {
    const stageC = vi.fn(() => true);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stages = [
      {
        name: "async-broken",
        run: async () => {
          throw new Error("ERR_MODULE_NOT_FOUND");
        },
      },
      { name: "c", run: stageC },
    ];

    const result = await runGatewayHttpRequestStages(stages);

    expect(result).toBe(true);
    expect(stageC).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("returns false when the only non-throwing stages do not handle", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stages = [
      {
        name: "broken",
        run: () => {
          throw new Error("load failed");
        },
      },
      { name: "unmatched", run: () => false },
    ];

    const result = await runGatewayHttpRequestStages(stages);

    expect(result).toBe(false);

    consoleSpy.mockRestore();
  });
});
