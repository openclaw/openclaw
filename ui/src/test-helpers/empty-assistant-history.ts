export const emptyAssistantAcknowledgment =
  "I could not find the parent session yet. I’m waiting for an incoming message before continuing.";

/** Synthetic chat.history shape from a Code Mode turn that ends in a message yield. */
export function emptyAssistantHistory() {
  const runId = "parent-conversation";
  const exec = (id: string, title: string, timestamp: number, thinking: string[] = []) => ({
    role: "assistant",
    runId,
    timestamp,
    stopReason: "toolUse",
    content: [
      ...thinking.map((text) => ({ type: "thinking", thinking: text })),
      {
        type: "toolCall",
        id,
        name: "exec",
        arguments: { title, code: "await tools.sessions_list({});" },
      },
    ],
  });
  const result = (id: string, timestamp: number) => ({
    role: "toolResult",
    runId,
    timestamp,
    toolCallId: id,
    toolName: "exec",
    content: [{ type: "text", text: '{"status":"completed","output":"No parent session found."}' }],
  });
  const nested = (id: string, timestamp: number) => ({
    role: "custom",
    customType: "openclaw.nested-tool.v1",
    runId,
    timestamp,
    content: [
      {
        type: "toolCall",
        id,
        name: "sessions_list",
        parentToolCallId: "verify",
        arguments: { limit: 10 },
      },
      {
        type: "toolResult",
        toolCallId: id,
        name: "sessions_list",
        parentToolCallId: "verify",
        content: [{ type: "text", text: '{"sessions":[]}' }],
      },
    ],
  });
  return [
    { role: "user", content: "talk to parent session", timestamp: 1_000 },
    exec("find", "Find parent session messaging control", 2_000),
    result("find", 2_100),
    exec("verify", "Verify parent session relationship", 3_000, [
      "Look up the parent.",
      "Check the available sessions.",
    ]),
    nested("list-1", 3_100),
    nested("list-2", 3_200),
    result("verify", 3_300),
    {
      role: "assistant",
      runId,
      timestamp: 4_000,
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "Wait for a reply from the parent." },
        {
          type: "toolCall",
          id: "yield",
          name: "sessions_yield",
          arguments: {
            waitFor: "message",
            acknowledgment: emptyAssistantAcknowledgment,
            message: "PRIVATE_CONTINUATION",
          },
        },
      ],
    },
    {
      role: "toolResult",
      runId,
      timestamp: 4_100,
      toolCallId: "yield",
      toolName: "sessions_yield",
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "yielded", acknowledgment: emptyAssistantAcknowledgment }),
        },
      ],
    },
  ];
}
