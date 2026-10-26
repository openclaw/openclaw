export function canonicalParallelBatchHistory() {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-read",
          name: "read",
          arguments: { path: "/repo/src/a.ts", offset: 3, limit: 20 },
        },
        {
          type: "toolCall",
          id: "call-patch",
          name: "apply_patch",
          arguments: {
            input: [
              "*** Begin Patch",
              "*** Update File: src/a.ts",
              "@@",
              "-const before = true;",
              "+const after = true;",
              "*** Add File: src/b.ts",
              "+export const created = true;",
              "*** End Patch",
            ].join("\n"),
          },
        },
      ],
      activity: [
        {
          itemId: "tool:call-read",
          toolCallId: "call-read",
          kind: "tool",
          phase: "end",
          status: "completed",
          title: "Read source",
        },
        {
          itemId: "tool:call-patch",
          toolCallId: "call-patch",
          kind: "tool",
          phase: "end",
          status: "completed",
          title: "Apply patch",
        },
      ],
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read",
      content: [{ type: "text", text: "A_ONLY_fixture" }],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-patch",
      toolName: "apply_patch",
      content: [{ type: "text", text: "Applied patch" }],
      timestamp: 3,
    },
  ];
}
