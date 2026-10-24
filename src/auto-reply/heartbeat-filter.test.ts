/** Tests heartbeat filtering and skip behavior for empty heartbeat context. */
import { describe, expect, it } from "vitest";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "../plugin-sdk/message-tool-delivery-hints.js";
import { filterHeartbeatTranscriptArtifacts, isHeartbeatUserMessage } from "./heartbeat-filter.js";
import {
  HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS,
  HEARTBEAT_RESPONSE_TOOL_PROMPT,
  HEARTBEAT_PROMPT,
  INTERNAL_WAKE_TRANSCRIPT_PROMPTS,
  resolveHeartbeatPromptForResponseTool,
} from "./heartbeat.js";

function user(content: unknown) {
  return { role: "user", content };
}

function assistant(content: unknown) {
  return { role: "assistant", content };
}

const wake = user(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat);
const followup = user("what changed while I was away?");
const modelQuestion = user("what model are you");
const filter = (messages: Parameters<typeof filterHeartbeatTranscriptArtifacts>[0]) =>
  filterHeartbeatTranscriptArtifacts(messages, undefined, HEARTBEAT_PROMPT);

function expectFiltered(
  messages: Parameters<typeof filter>[0],
  expected: Parameters<typeof filter>[0] = [followup],
) {
  expect(filter(messages)).toEqual(expected);
}

function functionCall(call_id: string, name: string, args: string, id?: string) {
  return assistant([
    { type: "function_call", ...(id ? { id } : {}), call_id, name, arguments: args },
  ]);
}

function functionResult(call_id: string, output: string) {
  return user([{ type: "function_call_output", call_id, output }]);
}

function toolResult(toolCallId: string, text: string, isError?: boolean) {
  return {
    role: "toolResult",
    toolCallId,
    ...(isError ? { isError } : {}),
    content: [{ type: "text", text }],
  };
}

function anthropicResult(
  type: "tool_result" | "tool_result_error",
  content: string,
  is_error?: boolean,
) {
  return { type, tool_use_id: "toolu_heartbeat", content, ...(is_error ? { is_error } : {}) };
}

function heartbeatCall(type: "toolCall" | "tool_use", attention = true) {
  const outcome = attention
    ? createHeartbeatAttentionOutcome()
    : {
        outcome: "no_change",
        notify: false,
        summary: "No visible update.",
      };
  return assistant([
    type === "tool_use"
      ? { type, id: "toolu_heartbeat", name: "heartbeat_respond", input: outcome }
      : { type, id: "call_heartbeat", name: "heartbeat_respond", arguments: outcome },
  ]);
}

function createHeartbeatAttentionOutcome() {
  return {
    outcome: "needs_attention",
    notify: true,
    summary: "Build is blocked.",
    notificationText: "Build is blocked on missing credentials.",
  };
}

const HIDDEN_REASONING_BLOCKS = [
  ["thinking", { type: "thinking", thinking: "Checking the heartbeat." }],
  ["reasoning", { type: "reasoning", text: "Checking the heartbeat." }],
  ["redacted thinking", { type: "redacted_thinking", data: "opaque-reasoning" }],
] as const;

describe("isHeartbeatUserMessage", () => {
  it("matches heartbeat prompts", () => {
    const expectPrompt = (text: string, prompt?: string) =>
      expect(isHeartbeatUserMessage(user(text), prompt)).toBe(true);
    const taskPrefix =
      "Run the following periodic tasks (only those due based on their intervals):";
    expectPrompt(`${HEARTBEAT_PROMPT}\nUse monitor scratch.`, HEARTBEAT_PROMPT);
    for (const acknowledgement of ["HEARTBEAT_OK", "NO_REPLY"]) {
      expectPrompt(
        `${taskPrefix}\n\n- email-check\n\nAfter completing all due tasks, reply ${acknowledgement}.`,
      );
    }

    for (const completion of [
      "After completing all due tasks, use heartbeat_respond to report the outcome. Set notify=false when nothing needs the user's attention.",
      `After completing all due tasks:\n${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS}`,
    ]) {
      expectPrompt(
        `${taskPrefix}\n\n- deployment\n\n${completion}\n\nHeartbeat monitor scratch:\nReview queue.`,
      );
    }

    expectPrompt(INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat);
    expectPrompt(HEARTBEAT_RESPONSE_TOOL_PROMPT);
    const customHeartbeatPrompt = "Check the handoff queue.";
    expectPrompt(
      `${resolveHeartbeatPromptForResponseTool(customHeartbeatPrompt)}\n\nUse workspace notes only.`,
      customHeartbeatPrompt,
    );
  });
});

describe("filterHeartbeatTranscriptArtifacts", () => {
  it.each(Object.entries(INTERNAL_WAKE_TRANSCRIPT_PROMPTS))(
    "limits truncated silence to heartbeat context: %s",
    (kind, marker) => {
      for (const prompt of [marker, `${MESSAGE_TOOL_DELIVERY_HINTS[0]} ${marker}`]) {
        const messages = [user(prompt), assistant("no_r"), user("Continue")];
        expect(filterHeartbeatTranscriptArtifacts(messages)).toEqual(
          kind === "heartbeat" ? [user("Continue")] : messages,
        );
      }
    },
  );

  it.each([
    "[OpenClaw heartbeat poll]",
    "[OpenClaw exec completion]",
    "[OpenClaw exec completion]\nDisable automatic completion turns with tools.exec.notifyOnExit=false; check per-agent overrides. Background exec and process poll remain available.",
    "[OpenClaw cron wake]",
    "[OpenClaw session event]",
  ])("removes no-op wake pairs for %s", (marker) => {
    expectFiltered(
      [
        user("Hello"),
        assistant("Hi there!"),
        user(HEARTBEAT_PROMPT),
        assistant("NO_REPLY"),
        user(marker),
        assistant("HEARTBEAT_OK"),
        user("What time is it?"),
        assistant("It is 3pm."),
      ],
      [user("Hello"), assistant("Hi there!"), user("What time is it?"), assistant("It is 3pm.")],
    );
  });

  it.each(HIDDEN_REASONING_BLOCKS)(
    "removes no-op heartbeat pairs with hidden %s blocks",
    (_label, reasoningBlock) => {
      const nextUserMessage = user("What time is it?");

      expectFiltered(
        [
          wake,
          assistant([reasoningBlock, { type: "text", text: "HEARTBEAT_OK" }]),
          nextUserMessage,
        ],
        [nextUserMessage],
      );
    },
  );

  it("removes OpenAI Responses input/output text heartbeat pairs", () => {
    for (const deliveryHint of MESSAGE_TOOL_DELIVERY_HINTS) {
      expectFiltered(
        [
          user([
            {
              type: "input_text",
              text: `${deliveryHint} ${INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat}`,
            },
          ]),
          assistant([{ type: "output_text", text: "HEARTBEAT_OK" }]),
          user([{ type: "input_text", text: "what model are you" }]),
        ],
        [user([{ type: "input_text", text: "what model are you" }])],
      );
    }
  });

  it("removes native OpenAI Responses heartbeat function-call spans", () => {
    expectFiltered(
      [
        wake,
        functionCall("call_bash", "bash", '{"command":"inspect monitor scratch"}'),
        functionResult("call_bash", "checked monitor scratch"),
        functionCall("call_heartbeat", "heartbeat_respond", '{"notify":false}'),
        functionResult("call_heartbeat", '{"notify":false}'),
        modelQuestion,
      ],
      [modelQuestion],
    );
  });

  it("removes assistant continuations after heartbeat response-tool results", () => {
    expectFiltered(
      [
        wake,
        heartbeatCall("toolCall", false),
        toolResult("call_heartbeat", "HEARTBEAT_OK"),
        assistant("No visible update. notify=false"),
        modelQuestion,
      ],
      [modelQuestion],
    );
  });

  it("removes pre-terminal assistant text once a heartbeat ack arrives", () => {
    expectFiltered(
      [wake, assistant("Checking heartbeat status..."), assistant("HEARTBEAT_OK"), modelQuestion],
      [modelQuestion],
    );
  });

  it("preserves top-level notify=true heartbeat response-tool calls followed by a final ack", () => {
    const messages = [
      wake,
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
      followup,
    ];

    expect(filter(messages)).toEqual(messages);
  });

  it("preserves OpenAI Responses notify=true heartbeat calls keyed by call_id", () => {
    const messages = [
      wake,
      functionCall(
        "call_heartbeat",
        "heartbeat_respond",
        JSON.stringify(createHeartbeatAttentionOutcome()),
        "fc_item_123",
      ),
      functionResult("call_heartbeat", '{"notify":true}'),
      followup,
    ];

    expect(filter(messages)).toEqual(messages);
  });

  it("preserves Anthropic-style notify=true heartbeat calls completed by mixed user turns", () => {
    const messages = [
      wake,
      heartbeatCall("tool_use"),
      user([
        anthropicResult("tool_result", "recorded"),
        { type: "text", text: "heartbeat delivery recorded" },
      ]),
      followup,
    ];

    expect(filter(messages)).toEqual(messages);
  });

  it("removes failed notify=true heartbeat response-tool calls", () => {
    expectFiltered([
      wake,
      heartbeatCall("toolCall"),
      toolResult("call_heartbeat", "heartbeat response rejected", true),
      followup,
    ]);
  });

  it("removes Anthropic-style failed notify=true heartbeat calls keyed by tool_use_id", () => {
    expectFiltered([
      wake,
      heartbeatCall("tool_use"),
      user([anthropicResult("tool_result", "heartbeat response rejected", true)]),
      followup,
    ]);
  });

  it("removes Anthropic-style error result heartbeat calls keyed by tool_use_id", () => {
    expectFiltered([
      wake,
      heartbeatCall("tool_use"),
      user([anthropicResult("tool_result_error", "heartbeat response rejected")]),
      followup,
    ]);
  });

  it("does not treat unrelated helper tool results as completed notify=true responses", () => {
    expectFiltered([
      wake,
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
      toolResult("call_bash", "checked monitor scratch"),
      followup,
    ]);
  });

  it("preserves mixed user text after silent heartbeat response-tool spans", () => {
    const mixedUserMessage = user([
      anthropicResult("tool_result", "recorded"),
      { type: "text", text: "what model are you" },
    ]);
    const assistantMessage = assistant("I am OpenClaw.");
    expectFiltered(
      [wake, heartbeatCall("tool_use", false), mixedUserMessage, assistantMessage],
      [mixedUserMessage, assistantMessage],
    );
  });

  it("stops a prompt-only span before a later visible heartbeat alert", () => {
    expectFiltered(
      [wake, wake, assistant("Build is blocked on a failing release check."), followup],
      [wake, assistant("Build is blocked on a failing release check."), followup],
    );
  });
});
