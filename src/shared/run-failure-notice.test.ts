import { describe, expect, it } from "vitest";
import { readRunFailureNotice } from "./run-failure-notice.js";

describe("desktop failure detail", () => {
  const readDesktop = (message: unknown) => readRunFailureNotice(message, { audience: "desktop" });
  const message = {
    openclawRunError: {
      runId: "failed-run",
      summary: "Your request couldn't be completed.",
      desktopSummary: "OpenClaw storage is busy. Check its status before retrying.",
    },
  };

  it("keeps the shared summary unless the desktop viewer opts in", () => {
    expect(readRunFailureNotice(message)?.summary).toBe(message.openclawRunError.summary);
    expect(readDesktop(message)?.summary).toBe(message.openclawRunError.desktopSummary);
  });

  it.each([undefined, "", "  ", 42, {}])("ignores invalid desktop detail %j", (desktopSummary) => {
    expect(
      readDesktop({ openclawRunError: { ...message.openclawRunError, desktopSummary } })?.summary,
    ).toBe(message.openclawRunError.summary);
  });

  it("does not turn an ordinary message into a failure notice", () => {
    expect(readDesktop({ content: "hello", desktopSummary: "internal detail" })).toBeUndefined();
  });
});
