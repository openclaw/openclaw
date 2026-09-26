import { describe, expect, it } from "vitest";
import {
  resolveInstallModeOptions,
  resolveInstallWorkTimeoutMs,
  resolveTimedInstallModeOptions,
} from "./install-mode-options.js";

describe("install mode option helpers", () => {
  it.each([
    { mode: "install", timeoutMs: undefined, workTimeoutMs: undefined, expected: 300_000 },
    { mode: "install", timeoutMs: 500, workTimeoutMs: undefined, expected: 300_000 },
    { mode: "update", timeoutMs: undefined, workTimeoutMs: undefined, expected: undefined },
    { mode: "update", timeoutMs: 500, workTimeoutMs: undefined, expected: 500 },
    { mode: "update", timeoutMs: 500, workTimeoutMs: null, expected: undefined },
    { mode: "update", timeoutMs: 500, workTimeoutMs: 37, expected: 37 },
  ] as const)(
    "keeps $mode work policy through a nested install target",
    ({ mode, timeoutMs, workTimeoutMs, expected }) => {
      const outer = resolveTimedInstallModeOptions({ mode, timeoutMs, workTimeoutMs }, {});
      const nested = resolveTimedInstallModeOptions({ ...outer, mode: "install" }, {});
      expect(
        resolveInstallWorkTimeoutMs(nested.workTimeoutMs, Math.max(nested.timeoutMs, 300_000)),
      ).toBe(expected);
      expect(nested.timeoutMs).toBe(timeoutMs ?? 120_000);
    },
  );

  it("preserves explicit logger, mode, and dryRun values", () => {
    const defaultLogger = { warn: (_message: string) => {} };
    const logger = { warn: (_message: string) => {} };
    expect(
      resolveInstallModeOptions({ logger, mode: "update", dryRun: true }, defaultLogger),
    ).toEqual({ logger, mode: "update", dryRun: true });
  });

  it.each([
    {
      name: "uses default timeout when not provided",
      params: {},
      defaultTimeoutMs: undefined,
      expected: { timeoutMs: 120_000, mode: "install", dryRun: false },
    },
    {
      name: "honors custom timeout default override",
      params: {},
      defaultTimeoutMs: 5000,
      expected: { timeoutMs: 5000, mode: "install", dryRun: false },
    },
    {
      name: "preserves explicit timeout values",
      params: { timeoutMs: 0, mode: "update" as const, dryRun: true },
      defaultTimeoutMs: 5000,
      expected: { timeoutMs: 0, mode: "update", dryRun: true },
    },
  ])("$name", ({ params, defaultTimeoutMs, expected }) => {
    const logger = { warn: (_message: string) => {} };
    const result = resolveTimedInstallModeOptions(params, logger, defaultTimeoutMs);
    expect(result.timeoutMs).toBe(expected.timeoutMs);
    expect(result.mode).toBe(expected.mode);
    expect(result.dryRun).toBe(expected.dryRun);
    expect(result.logger).toBe(logger);
  });
});
