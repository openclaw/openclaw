import { describe, expect, it } from "vitest";
import { readRunFailureNotice } from "./run-failure-notice.js";

describe("desktop failure detail", () => {
  const message = {
    openclawRunError: {
      runId: "failed-run",
      summary: "Your request couldn't be completed.",
      desktopSummary: "OpenClaw storage is busy. Check its status before retrying.",
    },
  };

  it("keeps the shared summary unless the desktop viewer opts in", () => {
    expect(readRunFailureNotice(message)?.summary).toBe(message.openclawRunError.summary);
    expect(readRunFailureNotice(message, { audience: "desktop" })?.summary).toBe(
      message.openclawRunError.desktopSummary,
    );
  });

  it.each([undefined, "", "  ", 42, {}])("ignores invalid desktop detail %j", (desktopSummary) => {
    expect(
      readRunFailureNotice(
        { openclawRunError: { ...message.openclawRunError, desktopSummary } },
        { audience: "desktop" },
      )?.summary,
    ).toBe(message.openclawRunError.summary);
  });

  it("does not turn an ordinary message into a failure notice", () => {
    expect(
      readRunFailureNotice(
        { content: "hello", desktopSummary: "internal detail" },
        { audience: "desktop" },
      ),
    ).toBeUndefined();
  });
});
