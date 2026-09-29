import { afterEach, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

it.each([
  { retryable: true, message: "Models are still loading; retry in a moment." },
  { retryable: false, message: "model not allowed: openai/gpt-5.6-sol" },
])(
  "keeps the draft after a create failure and offers retry=$retryable",
  async ({ retryable, message }) => {
    const { context, flow } = createDraftFixture();
    vi.mocked(context.sessions.createResult)
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: retryable ? "UNAVAILABLE" : "INVALID_REQUEST",
          message,
          retryable,
        }),
      )
      .mockResolvedValueOnce({ key: "agent:main:retried", initialRun: { status: "idle" } });
    vi.mocked(context.navigateAndWait).mockImplementation(async () => {
      queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
    });
    flow.setMessage("Review the deployment plan");

    await flow.submit();

    expect({
      error: flow.error,
      canRetryError: flow.canRetryError,
      message: flow.message,
      submitting: flow.submitting,
    }).toEqual({
      error: message,
      canRetryError: retryable,
      message: "Review the deployment plan",
      submitting: false,
    });

    await flow.submit();

    expect(
      vi.mocked(context.sessions.createResult).mock.calls.map(([params]) => params?.message),
    ).toEqual(["Review the deployment plan", "Review the deployment plan"]);
    expect({ error: flow.error, canRetryError: flow.canRetryError }).toEqual({
      error: null,
      canRetryError: false,
    });
    flow.disconnect();
  },
);
