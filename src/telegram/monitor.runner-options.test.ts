import { describe, expect, it } from "vitest";
import { createTelegramRunnerOptions } from "./monitor.js";

describe("createTelegramRunnerOptions — per-account concurrency (#16055)", () => {
  it("uses full maxConcurrent when accountCount is 1 (single bot)", () => {
    const cfg = { agents: { defaults: { maxConcurrent: 6 } } };
    const opts = createTelegramRunnerOptions(cfg, { accountCount: 1 });
    expect(opts.sink).toEqual({ concurrency: 6 });
  });

  it("divides concurrency by accountCount for multi-bot setups", () => {
    const cfg = { agents: { defaults: { maxConcurrent: 6 } } };
    const opts = createTelegramRunnerOptions(cfg, { accountCount: 3 });
    expect(opts.sink).toEqual({ concurrency: 2 });
  });

  it("floors fractional concurrency and ensures minimum of 1", () => {
    const cfg = { agents: { defaults: { maxConcurrent: 5 } } };
    const opts = createTelegramRunnerOptions(cfg, { accountCount: 3 });
    // floor(5 / 3) = 1
    expect(opts.sink).toEqual({ concurrency: 1 });
  });

  it("uses default maxConcurrent (4) when no config provided", () => {
    const opts = createTelegramRunnerOptions({}, { accountCount: 2 });
    // floor(4 / 2) = 2
    expect(opts.sink).toEqual({ concurrency: 2 });
  });

  it("ignores accountCount <= 0 and uses full concurrency", () => {
    const cfg = { agents: { defaults: { maxConcurrent: 8 } } };
    const opts = createTelegramRunnerOptions(cfg, { accountCount: 0 });
    expect(opts.sink).toEqual({ concurrency: 8 });
  });

  it("preserves runner options regardless of accountCount", () => {
    const cfg = { agents: { defaults: { maxConcurrent: 4 } } };
    const opts = createTelegramRunnerOptions(cfg, { accountCount: 2 });
    expect(opts.runner).toMatchObject({
      silent: true,
      maxRetryTime: 60 * 60 * 1000,
      retryInterval: "exponential",
    });
  });
});
