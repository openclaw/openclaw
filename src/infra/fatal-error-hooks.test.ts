// Covers the fatal diagnostic callback and output collection.
import { afterEach, describe, expect, it } from "vitest";
import { runFatalErrorHooks, setFatalErrorHook } from "./fatal-error-hooks.js";

afterEach(() => setFatalErrorHook(undefined));

describe("fatal error hooks", () => {
  it("collects the installed callback's non-empty message", () => {
    setFatalErrorHook(() => "diagnostic");
    expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual(["diagnostic"]);
    setFatalErrorHook(() => "  ");
    expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual([]);
    setFatalErrorHook(undefined);
    expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual([]);
  });

  it("does not expose hook failure message or stack text", () => {
    setFatalErrorHook(() => {
      throw new Error("raw secret from hook");
    });

    const messages = runFatalErrorHooks({ reason: "uncaught_exception" });
    const output = messages.join("\n");

    expect(messages).toEqual(["fatal-error hook failed: Error"]);
    expect(output).not.toContain("raw secret");
    expect(output).not.toContain("at ");
  });
});
