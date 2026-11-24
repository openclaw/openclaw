import { describe, expect, it } from "vitest";
import { projectChatErrorDetail } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { readRunFailureCause, readRunFailureNotice } from "./run-failure-notice.js";

describe("billing display projection", () => {
  it("keeps a valid HTTP action absolute when the browser has a base URL", () => {
    const cause = readRunFailureCause({
      provider: "local-provider",
      failoverReason: "billing",
      billingError: { message: "Choose a plan.", actionUrl: "http:example.com" },
    });
    expect(cause?.billingError?.actionUrl).toBe("http://example.com/");
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
    const detail = projectChatErrorDetail({
      provider: "local-provider",
      failoverReason: "billing",
      billingError: { message: "  Choose an active plan.  ", actionUrl },
    });
    expect(readRunFailureCause(detail)?.billingError).toEqual({
      message: "Choose an active plan.",
    });
  });

  it("bounds messages and never promotes raw previews or non-billing metadata", () => {
    expect(
      readRunFailureCause({
        provider: "local-provider",
        failoverReason: "billing",
        billingError: { message: "x".repeat(700) },
      })?.billingError?.message,
    ).toHaveLength(600);
    for (const billingError of [undefined, { message: "  " }]) {
      expect(
        readRunFailureCause(
          projectChatErrorDetail({
            provider: "local-provider",
            failoverReason: "billing",
            billingError,
            providerErrorMessagePreview: "Private raw billing message",
          }),
        )?.billingError,
      ).toBeUndefined();
    }
    expect(
      readRunFailureCause(
        projectChatErrorDetail({
          provider: "local-provider",
          failoverReason: "auth",
          billingError: { message: "Wrong category" },
        }),
      )?.billingError,
    ).toBeUndefined();
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
