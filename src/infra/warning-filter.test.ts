import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProcessWarningFilter, shouldIgnoreWarning } from "./warning-filter.js";

const warningFilterKey = Symbol.for("openclaw.warning-filter");
const baseEmitWarning = process.emitWarning.bind(process);

function resetWarningFilterInstallState(): void {
  const globalState = globalThis as typeof globalThis & {
    [warningFilterKey]?: { installed: boolean };
  };
  delete globalState[warningFilterKey];
  process.emitWarning = baseEmitWarning;
}

describe("warning filter", () => {
  beforeEach(() => {
    resetWarningFilterInstallState();
  });

  afterEach(() => {
    resetWarningFilterInstallState();
    vi.restoreAllMocks();
  });

  it("suppresses known deprecation and experimental warning signatures", () => {
    expect(
      shouldIgnoreWarning({
        name: "DeprecationWarning",
        code: "DEP0040",
        message: "The punycode module is deprecated.",
      }),
    ).toBe(true);
    expect(
      shouldIgnoreWarning({
        name: "DeprecationWarning",
        code: "DEP0060",
        message: "The `util._extend` API is deprecated.",
      }),
    ).toBe(true);
    expect(
      shouldIgnoreWarning({
        name: "ExperimentalWarning",
        message: "SQLite is an experimental feature and might change at any time",
      }),
    ).toBe(true);
  });

  it("keeps unknown warnings visible", () => {
    expect(
      shouldIgnoreWarning({
        name: "DeprecationWarning",
        code: "DEP9999",
        message: "Totally new warning",
      }),
    ).toBe(false);
  });

  it("installs once and suppresses known warnings at emit time", async () => {
    const seenWarnings: Array<{ code?: string; name: string; message: string }> = [];
    const onWarning = (warning: Error & { code?: string }) => {
      seenWarnings.push({
        code: warning.code,
        name: warning.name,
        message: warning.message,
      });
    };

    process.on("warning", onWarning);
    try {
      installProcessWarningFilter();
      installProcessWarningFilter();
      installProcessWarningFilter();
      const emitWarning = (...args: unknown[]) =>
        (process.emitWarning as unknown as (...warningArgs: unknown[]) => void)(...args);

      emitWarning(
        "The `util._extend` API is deprecated. Please use Object.assign() instead.",
        "DeprecationWarning",
        "DEP0060",
      );
      emitWarning("The `util._extend` API is deprecated. Please use Object.assign() instead.", {
        type: "DeprecationWarning",
        code: "DEP0060",
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(seenWarnings.find((warning) => warning.code === "DEP0060")).toBeUndefined();

      emitWarning("Visible warning", { type: "Warning", code: "OPENCLAW_TEST_WARNING" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        seenWarnings.find((warning) => warning.code === "OPENCLAW_TEST_WARNING"),
      ).toBeDefined();
    } finally {
      process.off("warning", onWarning);
    }
  });
});
