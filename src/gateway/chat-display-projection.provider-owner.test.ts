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
    "⚠️ Agent run failed: the Gateway state database was busy (SQLite: database is locked). Retry; if it repeats, check Gateway storage health.",
  ],
])("projects recorded failures without discovering provider policy: %s", (error, text) => {
  expect(failure(error)).toMatchObject({ content: [{ type: "text", text }] });
  expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
});

it("shows the upstream cache limit without proxy metadata", () => {
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
        text: "LLM request rejected: provider allows at most 4 cache_control blocks; the request contained 5.",
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
        text: "⚠️ LLM request failed (rate limited, HTTP 429). This is usually temporary — try again shortly.\n\nThe first step completed.",
      },
    ],
  });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_CANARY");
  expect(projectChatDisplayMessage(projected)).toEqual(projected);
});
