/** Tests heartbeat filtering and skip behavior for empty heartbeat context. */
import { describe, expect, it } from "vitest";
import {
  filterHeartbeatTranscriptArtifacts,
  isHeartbeatOkResponse,
  isHeartbeatUserMessage,
} from "./heartbeat-filter.js";
import {
  HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS,
  HEARTBEAT_RESPONSE_TOOL_PROMPT,
  HEARTBEAT_PROMPT,
  INTERNAL_WAKE_TRANSCRIPT_PROMPTS,
  resolveHeartbeatPromptForResponseTool,
} from "./heartbeat.js";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "./reply/delivery-hints.js";

function user(content: unknown) {
  return { role: "user", content };
}

function assistant(content: unknown) {
  return { role: "assistant", content };
}

function createHeartbeatAttentionOutcome() {
  return {
    outcome: "needs_attention",
    notify: true,
    summary: "Build is blocked.",
    notificationText: "Build is blocked on missing credentials.",
  };
}

function createHeartbeatNoChangeMessage() {
  return assistant([
    {
      type: "toolCall",
      id: "call_heartbeat",
      name: "heartbeat_respond",
      arguments: {
        outcome: "no_change",
        notify: false,
        summary: "No visible update.",
      },
    },
  ]);
}

function createHeartbeatAttentionMessage() {
  return assistant([
    {
      type: "toolCall",
      id: "call_heartbeat",
      name: "heartbeat_respond",
      arguments: createHeartbeatAttentionOutcome(),
    },
  ]);
}

function createAnthropicHeartbeatAttentionMessage() {
  return assistant([
    {
      type: "tool_use",
      id: "toolu_heartbeat",
      name: "heartbeat_respond",
      input: createHeartbeatAttentionOutcome(),
    },
  ]);
}

const HIDDEN_REASONING_BLOCKS = [
  ["thinking", { type: "thinking", thinking: "Checking the heartbeat." }],
  ["reasoning", { type: "reasoning", text: "Checking the heartbeat." }],
  ["redacted thinking", { type: "redacted_thinking", data: "opaque-reasoning" }],
] as const;

describe("isHeartbeatUserMessage", () => {
  it("matches heartbeat prompts", () => {
    expect(
      isHeartbeatUserMessage(
        user(
          `${HEARTBEAT_PROMPT}\nUse the provided monitor scratch when deciding what needs attention.`,
        ),
        HEARTBEAT_PROMPT,
      ),
    ).toBe(true);

    for (const acknowledgement of ["HEARTBEAT_OK", "NO_REPLY"]) {
      expect(
        isHeartbeatUserMessage(
          user(
            `Run the following periodic tasks (only those due based on their intervals):\n\n- email-check: Check for urgent unread emails\n\nAfter completing all due tasks, reply ${acknowledgement}.`,
          ),
        ),
      ).toBe(true);
    }

    for (const completion of [
      "After completing all due tasks, use heartbeat_respond to report the outcome. Set notify=false when nothing needs the user's attention.",
      `After completing all due tasks:\n${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS}`,
    ]) {
      expect(
        isHeartbeatUserMessage(
          user(
            `Run the following periodic tasks (only those due based on their intervals):\n\n- deployment: Check deployment status\n\n${completion}\n\nHeartbeat monitor scratch:\nReview the deployment queue.`,
          ),
        ),
      ).toBe(true);
    }

    expect(isHeartbeatUserMessage(user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat))).toBe(true);

    expect(isHeartbeatUserMessage(user(HEARTBEAT_RESPONSE_TOOL_PROMPT))).toBe(true);

    const customHeartbeatPrompt = "Check the handoff queue.";
    expect(
      isHeartbeatUserMessage(
        user(
          `${resolveHeartbeatPromptForResponseTool(customHeartbeatPrompt)}\n\nUse workspace notes only.`,
        ),
        customHeartbeatPrompt,
      ),
    ).toBe(true);
  });

  it("ignores quoted or non-user token mentions", () => {
    expect(isHeartbeatUserMessage(user("Please reply HEARTBEAT_OK so I can test something."))).toBe(
      false,
    );

    expect(isHeartbeatUserMessage(assistant("HEARTBEAT_OK"))).toBe(false);
  });
});

describe("isHeartbeatOkResponse", () => {
  it("matches no-op heartbeat acknowledgements", () => {
    expect(isHeartbeatOkResponse(assistant("NO_REPLY"))).toBe(true);

    expect(isHeartbeatOkResponse(assistant("**HEARTBEAT_OK**"))).toBe(true);

    expect(isHeartbeatOkResponse(assistant("You have 3 unread urgent emails. HEARTBEAT_OK"))).toBe(
      true,
    );
  });

  it("preserves meaningful or non-text responses", () => {
    expect(isHeartbeatOkResponse(assistant("Status HEARTBEAT_OK due to watchdog failure"))).toBe(
      false,
    );

    expect(
      isHeartbeatOkResponse(
        assistant([{ type: "tool_use", id: "tool-1", name: "search", input: {} }]),
      ),
    ).toBe(false);

    const toolCallOnlyMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_heartbeat",
          function: {
            name: "heartbeat_respond",
            arguments: '{"notify":true}',
          },
        },
      ],
    } as { role: string; content?: unknown };
    expect(isHeartbeatOkResponse(toolCallOnlyMessage)).toBe(false);
  });

  it("respects ackMaxChars overrides", () => {
    expect(isHeartbeatOkResponse(assistant("HEARTBEAT_OK all good"), 0)).toBe(false);
  });
});

describe("filterHeartbeatTranscriptArtifacts", () => {
  it.each([
    "[OpenClaw heartbeat poll]",
    "[OpenClaw exec completion]",
    "[OpenClaw exec completion]\nDisable automatic completion turns with tools.exec.notifyOnExit=false; check per-agent overrides. Background exec and process poll remain available.",
    "[OpenClaw cron wake]",
    "[OpenClaw session event]",
  ])("removes no-op wake pairs for %s", (marker) => {
    const messages = [
      user("Hello"),
      assistant("Hi there!"),
      user(HEARTBEAT_PROMPT),
      assistant("NO_REPLY"),
      user(marker),
      assistant("HEARTBEAT_OK"),
      user("What time is it?"),
      assistant("It is 3pm."),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("Hello"),
      assistant("Hi there!"),
      user("What time is it?"),
      assistant("It is 3pm."),
    ]);
  });

  it.each(HIDDEN_REASONING_BLOCKS)(
    "removes no-op heartbeat pairs with hidden %s blocks",
    (_label, reasoningBlock) => {
      const nextUserMessage = user("What time is it?");
      const messages = [
        user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
        assistant([reasoningBlock, { type: "text", text: "HEARTBEAT_OK" }]),
        nextUserMessage,
      ];

      expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
        nextUserMessage,
      ]);
    },
  );

  it("removes OpenAI Responses input/output text heartbeat pairs", () => {
    for (const deliveryHint of MESSAGE_TOOL_DELIVERY_HINTS) {
      const messages = [
        user([
          {
            type: "input_text",
            text: `${deliveryHint} ${INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat}`,
          },
        ]),
        assistant([{ type: "output_text", text: "HEARTBEAT_OK" }]),
        user([{ type: "input_text", text: "what model are you" }]),
      ];

      expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
        user([{ type: "input_text", text: "what model are you" }]),
      ]);
    }
  });

  it("removes prompt-only interrupted heartbeat spans", () => {
    const messages = [user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat), user("what model are you")];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what model are you"),
    ]);
  });

  it("removes interrupted helper-only heartbeat spans", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant([
        {
          type: "toolCall",
          id: "call_bash",
          name: "bash",
          arguments: { command: "inspect monitor scratch" },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "checked monitor scratch" }],
      },
      user("what model are you"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what model are you"),
    ]);
  });

  it.each([
    ["default", HEARTBEAT_RESPONSE_TOOL_PROMPT],
    [
      "scheduled task",
      `Run the following periodic tasks (only those due based on their intervals):\n\n- deployment: Check deployment status\n\nAfter completing all due tasks:\n${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS}\n\nHeartbeat monitor scratch:\nReview the deployment queue.`,
    ],
    [
      "previous scheduled task",
      "Run the following periodic tasks (only those due based on their intervals):\n\n- deployment: Check deployment status\n\nAfter completing all due tasks, use heartbeat_respond to report the outcome. Set notify=false when nothing needs the user's attention.",
    ],
  ])("removes %s response-tool prompt spans", (_label, prompt) => {
    const messages = [
      user(prompt),
      createHeartbeatNoChangeMessage(),
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      },
      user("what model are you"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what model are you"),
    ]);
  });

  it("removes native OpenAI Responses heartbeat function-call spans", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant([
        {
          type: "function_call",
          call_id: "call_bash",
          name: "bash",
          arguments: '{"command":"inspect monitor scratch"}',
        },
      ]),
      user([
        {
          type: "function_call_output",
          call_id: "call_bash",
          output: "checked monitor scratch",
        },
      ]),
      assistant([
        {
          type: "function_call",
          call_id: "call_heartbeat",
          name: "heartbeat_respond",
          arguments: '{"notify":false}',
        },
      ]),
      user([
        {
          type: "function_call_output",
          call_id: "call_heartbeat",
          output: '{"notify":false}',
        },
      ]),
      user("what model are you"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what model are you"),
    ]);
  });

  it("removes assistant continuations after heartbeat response-tool results", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      createHeartbeatNoChangeMessage(),
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      },
      assistant("No visible update. notify=false"),
      user("what model are you"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what model are you"),
    ]);
  });

  it("removes pre-terminal assistant text once a heartbeat ack arrives", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant("Checking heartbeat status..."),
      assistant("HEARTBEAT_OK"),
      user("what model are you"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what model are you"),
    ]);
  });

  it("preserves notify=true heartbeat response-tool alerts followed by a final ack", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      createHeartbeatAttentionMessage(),
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: '{"notify":true}' }],
      },
      assistant("HEARTBEAT_OK"),
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("preserves top-level notify=true heartbeat response-tool calls followed by a final ack", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_heartbeat",
            function: {
              name: "heartbeat_respond",
              arguments: JSON.stringify(createHeartbeatAttentionOutcome()),
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: '{"notify":true}' }],
      },
      assistant("HEARTBEAT_OK"),
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("preserves OpenAI Responses notify=true heartbeat calls keyed by call_id", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant([
        {
          type: "function_call",
          id: "fc_item_123",
          call_id: "call_heartbeat",
          name: "heartbeat_respond",
          arguments: JSON.stringify(createHeartbeatAttentionOutcome()),
        },
      ]),
      user([
        {
          type: "function_call_output",
          call_id: "call_heartbeat",
          output: '{"notify":true}',
        },
      ]),
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("preserves Anthropic-style notify=true heartbeat calls keyed by tool_use_id", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      createAnthropicHeartbeatAttentionMessage(),
      user([
        {
          type: "tool_result",
          tool_use_id: "toolu_heartbeat",
          content: "recorded",
        },
      ]),
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("preserves Anthropic-style notify=true heartbeat calls completed by mixed user turns", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      createAnthropicHeartbeatAttentionMessage(),
      user([
        {
          type: "tool_result",
          tool_use_id: "toolu_heartbeat",
          content: "recorded",
        },
        { type: "text", text: "heartbeat delivery recorded" },
      ]),
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("removes pending notify=true heartbeat response-tool calls without tool results", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      createHeartbeatAttentionMessage(),
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what changed while I was away?"),
    ]);
  });

  it("removes failed notify=true heartbeat response-tool calls", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      createHeartbeatAttentionMessage(),
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        isError: true,
        content: [{ type: "text", text: "heartbeat response rejected" }],
      },
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what changed while I was away?"),
    ]);
  });

  it("removes Anthropic-style failed notify=true heartbeat calls keyed by tool_use_id", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      createAnthropicHeartbeatAttentionMessage(),
      user([
        {
          type: "tool_result",
          tool_use_id: "toolu_heartbeat",
          is_error: true,
          content: "heartbeat response rejected",
        },
      ]),
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what changed while I was away?"),
    ]);
  });

  it("removes Anthropic-style error result heartbeat calls keyed by tool_use_id", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      createAnthropicHeartbeatAttentionMessage(),
      user([
        {
          type: "tool_result_error",
          tool_use_id: "toolu_heartbeat",
          content: "heartbeat response rejected",
        },
      ]),
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what changed while I was away?"),
    ]);
  });

  it("does not treat unrelated helper tool results as completed notify=true responses", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant([
        {
          type: "toolCall",
          id: "call_bash",
          name: "bash",
          arguments: { command: "inspect monitor scratch" },
        },
        {
          type: "toolCall",
          id: "call_heartbeat",
          name: "heartbeat_respond",
          arguments: createHeartbeatAttentionOutcome(),
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "checked monitor scratch" }],
      },
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what changed while I was away?"),
    ]);
  });

  it("removes heartbeat response-tool spans with notify=false even when alert fields are present", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant([
        {
          type: "toolCall",
          id: "call_heartbeat",
          name: "heartbeat_respond",
          arguments: {
            outcome: "needs_attention",
            notify: false,
            summary: "Build is blocked.",
            notificationText: "Build is blocked on missing credentials.",
          },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: '{"notify":false}' }],
      },
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what changed while I was away?"),
    ]);
  });

  it("preserves mixed user text after silent heartbeat response-tool spans", () => {
    const mixedUserMessage = user([
      {
        type: "tool_result",
        tool_use_id: "toolu_heartbeat",
        content: "recorded",
      },
      { type: "text", text: "what model are you" },
    ]);
    const assistantMessage = assistant("I am OpenClaw.");
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant([
        {
          type: "tool_use",
          id: "toolu_heartbeat",
          name: "heartbeat_respond",
          input: {
            outcome: "no_change",
            notify: false,
            summary: "No visible update.",
          },
        },
      ]),
      mixedUserMessage,
      assistantMessage,
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      mixedUserMessage,
      assistantMessage,
    ]);
  });

  it("stops a no-op span before a later visible heartbeat alert", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant("HEARTBEAT_OK"),
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant("Build is blocked on a failing release check."),
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant("Build is blocked on a failing release check."),
      user("what changed while I was away?"),
    ]);
  });

  it("stops a prompt-only span before a later visible heartbeat alert", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant("Build is blocked on a failing release check."),
      user("what changed while I was away?"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant("Build is blocked on a failing release check."),
      user("what changed while I was away?"),
    ]);
  });

  it("does not remove across a real user message", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      createHeartbeatNoChangeMessage(),
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      },
      user("what model are you"),
      assistant("notify=false"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual([
      user("what model are you"),
      assistant("notify=false"),
    ]);
  });

  it("preserves meaningful heartbeat output without terminal artifacts", () => {
    const meaningfulMessages = [
      user(HEARTBEAT_PROMPT),
      assistant("Status HEARTBEAT_OK due to watchdog failure"),
    ];
    expect(
      filterHeartbeatTranscriptArtifacts(meaningfulMessages, undefined, HEARTBEAT_PROMPT),
    ).toEqual(meaningfulMessages);
  });

  it("preserves helper tool turns when the heartbeat produces a visible alert", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      assistant([{ type: "toolCall", id: "call_bash", name: "bash", arguments: {} }]),
      {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "checked monitor scratch" }],
      },
      assistant("Build is blocked on a failing release check."),
      user("what model are you"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("preserves top-level helper tool turns when the heartbeat produces a visible alert", () => {
    const messages = [
      user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_bash",
            function: {
              name: "bash",
              arguments: '{"command":"inspect monitor scratch"}',
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "checked monitor scratch" }],
      },
      assistant("Build is blocked on a failing release check."),
      user("what model are you"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });

  it("keeps ordinary chats that mention the token", () => {
    const messages = [
      user("Please reply HEARTBEAT_OK so I can test something."),
      assistant("HEARTBEAT_OK"),
    ];

    expect(filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT)).toEqual(
      messages,
    );
  });
});
