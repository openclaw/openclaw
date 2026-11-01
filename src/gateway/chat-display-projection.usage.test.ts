import { expect, it } from "vitest";
import { projectChatDisplayMessages } from "./chat-display-projection.core.js";

it.each([
  { state: "available", report: { state: "available" } },
  { state: "unavailable", report: { state: "unavailable" } },
  { state: "invalid", report: undefined },
])("projects only the public usage completeness state: $state", ({ state, report }) => {
  expect(
    projectChatDisplayMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "Partial answer" }],
        usage: {
          input: 0,
          totalTokens: 0,
          usageReport: { state, internal: "private provider metadata" },
          cost: { total: 0, usageReport: { state } },
        },
      },
    ]),
  ).toEqual([
    {
      role: "assistant",
      content: [{ type: "text", text: "Partial answer" }],
      usage: {
        input: 0,
        totalTokens: 0,
        ...(report ? { usageReport: report } : {}),
        cost: { total: 0 },
      },
    },
  ]);
});
