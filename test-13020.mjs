import { pruneHistoryForContextShare } from "./dist/agents/compaction.js";

// Test scenario from issue #13020
const messages = [
  // Early messages (will be dropped)
  {
    role: "user",
    content: "First user message",
    timestamp: 1,
  },
  {
    role: "assistant",
    content: "First assistant response",
    timestamp: 2,
  },
  {
    role: "user",
    content: "Second user message",
    timestamp: 3,
  },
  // Assistant with tool_use that will be dropped
  {
    role: "assistant",
    content: [
      { type: "text", text: "I'll run a command for you" },
      {
        type: "toolUse",
        id: "toolu_01GAkAmTaPHv1fFZxXj2kgyE",
        name: "exec",
        input: { command: "ls -la" },
      },
    ],
    timestamp: 4,
  },
  // User message with tool_result - this will be kept but the tool_result should be dropped
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_01GAkAmTaPHv1fFZxXj2kgyE",
        content: "command output here",
      },
    ],
    timestamp: 5,
  },
  // More recent messages that will be kept
  {
    role: "assistant",
    content: "The command ran successfully",
    timestamp: 6,
  },
  {
    role: "user",
    content: "Thanks, what else can you do?",
    timestamp: 7,
  },
  {
    role: "assistant",
    content: "I can help with many things!",
    timestamp: 8,
  },
];

console.log("Testing compaction with orphaned tool_result...\n");

// Run compaction with small context to force dropping
const result = pruneHistoryForContextShare({
  messages,
  maxContextTokens: 200, // Small context to force dropping
  maxHistoryShare: 0.5,
  parts: 2,
});

console.log("Results:");
console.log("- Dropped chunks:", result.droppedChunks);
console.log("- Dropped messages:", result.droppedMessages);
console.log("- Kept messages:", result.messages.length);
console.log(
  "\nKept message roles:",
  result.messages.map((m) => m.role),
);

// Check if any tool_result blocks remain in user messages
let hasOrphanedToolResult = false;
for (const msg of result.messages) {
  if (msg.role === "user" && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (typeof block === "object" && block !== null && block.type === "tool_result") {
        console.log("\n❌ ERROR: Found orphaned tool_result block!");
        console.log("  Tool use ID:", block.tool_use_id);
        hasOrphanedToolResult = true;
      }
    }
  }
}

if (!hasOrphanedToolResult) {
  console.log("\n✅ SUCCESS: No orphaned tool_result blocks found");
} else {
  console.log(
    "\n⚠️  This would cause API error: 'unexpected tool_use_id found in tool_result blocks'",
  );
  process.exit(1);
}
