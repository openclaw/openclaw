import { describe, expect, it } from "vitest";
import {
  resolveInstallModeOptions,
  resolveTimedInstallModeOptions,
} from "./install-mode-options.js";

describe("install mode option helpers", () => {
  it("applies logger, mode, and dryRun defaults", () => {
    const logger = { warn: (_message: string) => {} };
    const result = resolveInstallModeOptions({}, logger);

    expect(result).toEqual({
      logger,
      mode: "install",
      dryRun: false,
    });
  });

  it("preserves explicit mode and dryRun values", () => {
    const logger = { warn: (_message: string) => {} };
    const result = resolveInstallModeOptions(
      {
        logger,
        mode: "update",
        dryRun: true,
      },
      { warn: () => {} },
    );

    expect(result).toEqual({
      logger,
      mode: "update",
      dryRun: true,
    });
  });

  it("uses default timeout when not provided", () => {
    const logger = { warn: (_message: string) => {} };
    const result = resolveTimedInstallModeOptions({}, logger);

    expect(result.timeoutMs).toBe(120_000);
    expect(result.mode).toBe("install");
    expect(result.dryRun).toBe(false);
  });

  it("honors custom timeout default override", () => {
    const result = resolveTimedInstallModeOptions({}, { warn: () => {} }, 5000);

    expect(result.timeoutMs).toBe(5000);
  });
});
