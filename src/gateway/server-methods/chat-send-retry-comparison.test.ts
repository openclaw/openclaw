import { expect, it } from "vitest";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import {
  compareChatSendSubmittedInput,
  type ChatSendRetryComparison,
} from "./chat-send-retry-comparison.js";

type Request = Pick<
  NormalizedChatSendRequest,
  "activeSteer" | "p" | "rawMessage" | "requestIdentity"
>;
const session = {
  agentId: "main",
  storePath: "/fixture/agent.sqlite",
  sessionKey: "agent:main:fixture",
  clientRunId: "input",
  entry: { sessionId: "physical-session", updatedAt: 1 },
};
const request: Request = {
  activeSteer: { profileId: "person", runId: "native-run" },
  p: {
    sessionKey: session.sessionKey,
    sessionId: "physical-session",
    idempotencyKey: "input",
    message: " original text ",
  },
  rawMessage: "original text",
  requestIdentity: "same-hmac",
};
const marker = {
  ...request.activeSteer,
  sessionId: "physical-session",
  originalText: " original text ",
};
function comparison(activeSteer: unknown, withIdentity = true): ChatSendRetryComparison {
  return {
    ...session,
    sessionId: "physical-session",
    lifecycleRevision: undefined,
    submitted: {
      role: "user",
      timestamp: 1,
      content: "hook-transformed text",
      __openclaw: {
        ...(withIdentity ? { chatRequestIdentity: "same-hmac" } : {}),
        ...(activeSteer === undefined ? {} : { activeSteer }),
      },
    },
    source: "pending",
  };
}
it.each([true, false])(
  "compares exact active metadata independently of HMAC (%s)",
  (withIdentity) => {
    expect(
      compareChatSendSubmittedInput(
        { ...request, requestIdentity: withIdentity ? "same-hmac" : undefined },
        session,
        comparison(marker, withIdentity),
      ),
    ).toBe(false);
  },
);
it.each(["profileId", "runId", "sessionId", "originalText"])(
  "rejects mismatched or missing retained %s even with a matching HMAC",
  (field) => {
    expect(
      compareChatSendSubmittedInput(
        request,
        session,
        comparison({ ...marker, [field]: "different" }),
      ),
    ).toBe(true);
    const incomplete: Record<string, unknown> = { ...marker };
    delete incomplete[field];
    expect(compareChatSendSubmittedInput(request, session, comparison(incomplete))).toBe(
      "unverifiable",
    );
  },
);
it.each([undefined, null, {}, "invalid"])(
  "rejects unverifiable active operation metadata: %s",
  (metadata) => {
    expect(compareChatSendSubmittedInput(request, session, comparison(metadata))).toBe(
      "unverifiable",
    );
  },
);
it("rejects a known retry without a retained source", () => {
  expect(
    compareChatSendSubmittedInput(request, session, {
      ...comparison(marker),
      submitted: undefined,
    }),
  ).toBe("unverifiable");
});
it("does not acknowledge an active operation as ordinary chat", () => {
  expect(
    compareChatSendSubmittedInput(
      { ...request, activeSteer: undefined },
      session,
      comparison(marker),
    ),
  ).toBe(true);
});
it("preserves the ordinary chat text-only legacy comparison", () => {
  expect(
    compareChatSendSubmittedInput(
      { ...request, activeSteer: undefined, requestIdentity: undefined },
      session,
      {
        ...comparison(undefined, false),
        submitted: { role: "user", timestamp: 1, content: "original text" },
      },
    ),
  ).toBe(false);
});
