import { expect, it, vi } from "vitest";
import { classifyProviderFailoverSignalWithPlugin } from "../plugins/provider-failover.js";
import { projectChatDisplayMessage } from "./chat-display-projection.core.js";

vi.mock("../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(() => "context_overflow"),
}));

it("projects recorded errors without discovering unrelated provider policy", () => {
  expect(
    projectChatDisplayMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "prompt reached the tenant maximum",
      content: [],
    }),
  ).toMatchObject({
    content: [{ type: "text", text: "The agent run failed before producing a reply." }],
  });
  expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
});

it("projects the persisted storage failure with actionable copy", () => {
  expect(
    projectChatDisplayMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "database is locked",
      content: [],
    }),
  ).toMatchObject({
    content: [
      {
        type: "text",
        text: "⚠️ Agent run failed: the Gateway state database was busy (SQLite: database is locked). Retry; if it repeats, check Gateway storage health.",
      },
    ],
  });
});

it("shows the upstream cache limit in persisted history without proxy metadata", () => {
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
  const projected = projectChatDisplayMessage({
    role: "assistant",
    stopReason: "error",
    errorCode: "400",
    errorMessage: `400: ${errorBody}`,
    errorBody,
    content: [],
  });
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
