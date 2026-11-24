import { describe, expect, it } from "vitest";
import { projectChatErrorDetail } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { readRunFailureCause, readRunFailureNotice } from "./run-failure-notice.js";

describe("billing display projection", () => {
  const billing = (billingError: unknown, failoverReason = "billing") =>
    readRunFailureCause(
      projectChatErrorDetail({
        provider: "local-provider",
        failoverReason,
        billingError,
        providerErrorMessagePreview: "Private raw billing message",
      }),
    )?.billingError;

  it("keeps a valid HTTP action absolute when the browser has a base URL", () => {
    expect(billing({ message: "Choose a plan.", actionUrl: "http:example.com" })?.actionUrl).toBe(
      "http://example.com/",
    );
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "/plans",
    "https://",
    "x".repeat(2049),
    "https://user:pass@example.com/plans",
    "https://user@example.com/plans",
    "http://:pass@example.com/plans",
  ])("drops only the invalid billing link %j", (actionUrl) => {
    expect(billing({ message: "  Choose an active plan.  ", actionUrl })).toEqual({
      message: "Choose an active plan.",
    });
  });

  it("bounds messages and never promotes raw previews or non-billing metadata", () => {
    expect(billing({ message: "x".repeat(700) })?.message).toHaveLength(600);
    for (const value of [undefined, { message: "  " }]) {
      expect(billing(value)).toBeUndefined();
    }
    expect(billing({ message: "Wrong category" }, "auth")).toBeUndefined();
  });
});

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
