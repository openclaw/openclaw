import { expect, it, vi } from "vitest";
import { classifyProviderFailoverSignalWithPlugin } from "../plugins/provider-failover.js";
import { projectChatDisplayMessage } from "./chat-display-projection.core.js";

vi.mock("../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(() => "context_overflow"),
}));
const failure = (errorMessage: string, fields: Record<string, unknown> = {}) =>
  projectChatDisplayMessage({
    role: "assistant",
    stopReason: "error",
    content: [],
    errorMessage,
    ...fields,
  });

it.each([
  ["prompt reached the tenant maximum", "The agent run failed before producing a reply."],
  [
    "database is locked",
    "⚠️ OpenClaw is busy saving your conversation. Wait a moment, then check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.",
  ],
])("projects recorded failures without discovering provider policy: %s", (error, text) => {
  expect(failure(error)).toMatchObject({ content: [{ type: "text", text }] });
  expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
});

it("shows cache-limit recovery guidance without proxy metadata", () => {
  const errorBody = JSON.stringify({
    error: {
      message: "All target providers failed.",
      target_provider_names: ["PRIVATE_ROUTING_NAME"],
      attempts: [
        {
          status: 400,
          details: {
            error: {
              type: "invalid_request_error",
              message: "A maximum of 4 blocks with cache_control may be provided. Found 5.",
            },
          },
        },
      ],
    },
  });
  const projected = failure("400: " + errorBody, { errorCode: "400", errorBody });
  expect(projected).toMatchObject({
    content: [
      {
        type: "text",
        text: "The AI service couldn't accept this conversation. Start a new conversation with /new, or choose another model in the Control UI.",
      },
    ],
  });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_ROUTING_NAME");
  expect(projected).not.toHaveProperty("errorBody");
  expect(projected).not.toHaveProperty("errorMessage");
  expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
});

it("keeps safe failure guidance alongside partial reply text", () => {
  const projected = failure("429: PRIVATE_CANARY", {
    content: [{ type: "text", text: "The first step completed." }],
  });
  expect(projected).toMatchObject({
    content: [
      {
        type: "text",
        text: "⚠️ The AI service needs a short break. Please try again in a few minutes.\n\nThe first step completed.",
      },
    ],
  });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_CANARY");
  expect(projectChatDisplayMessage(projected)).toEqual(projected);
});
