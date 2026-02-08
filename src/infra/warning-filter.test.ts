import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProcessWarningFilter, shouldIgnoreWarning } from "./warning-filter.js";

const warningFilterKey = Symbol.for("openclaw.warning-filter");

function resetWarningFilterInstallState(): void {
  const globalState = globalThis as typeof globalThis & {
    [warningFilterKey]?: { installed: boolean };
  };
  delete globalState[warningFilterKey];
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

  it("installs once and only writes unsuppressed warnings", () => {
    let warningHandler: ((warning: Error & { code?: string; message?: string }) => void) | null =
      null;
    const onSpy = vi.spyOn(process, "on").mockImplementation(((event, handler) => {
      if (event === "warning") {
        warningHandler = handler as (warning: Error & { code?: string; message?: string }) => void;
      }
      return process;
    }) as typeof process.on);
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    installProcessWarningFilter();
    installProcessWarningFilter();

    expect(onSpy).toHaveBeenCalledTimes(1);
    expect(warningHandler).not.toBeNull();

    warningHandler?.({
      name: "DeprecationWarning",
      code: "DEP0060",
      message: "The `util._extend` API is deprecated.",
      toString: () => "suppressed",
    } as Error & { code?: string; message?: string });
    expect(writeSpy).not.toHaveBeenCalled();

    warningHandler?.({
      name: "Warning",
      message: "Visible warning",
      stack: "Warning: visible",
      toString: () => "visible",
    } as Error & { code?: string; message?: string });
    expect(writeSpy).toHaveBeenCalledWith("Warning: visible\n");
  });
});
