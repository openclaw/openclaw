import { expect, it } from "vitest";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

it.each(["history", "live", "delta"] as const)(
  "never publishes model-only next-turn guidance through %s",
  (surface) => {
    const text = "Continue reviewing the patch.";
    const guidance = "Advisor guidance for the model only: check the rollback path.";
    const message = {
      role: "user",
      content: text,
      timestamp: 1,
      __openclaw: {
        runId: "next-turn-run",
        modelPromptProjection: { version: 1, text: `${guidance}\n\n${text}` },
      },
    };
    const canonical = structuredClone(message);
    const display =
      surface === "history"
        ? projectChatDisplayMessages([message])[0]
        : projectSessionMessagePayload({
            sessionKey: "agent:main:next-turn-guidance",
            message,
            historyDelta: surface === "delta",
          }).payload?.message;

    expect(display).not.toHaveProperty(["__openclaw", "modelPromptProjection"]);
    expect(JSON.stringify(display)).not.toContain(guidance);
    expect(display).toMatchObject({
      role: "user",
      content: text,
      __openclaw: { runId: "next-turn-run" },
    });
    expect(message).toEqual(canonical);
  },
);

it.each(["history", "live", "delta"] as const)(
  "omits provider input replay from %s without changing durable messages or tool arguments",
  (surface) => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "Visible answer." },
        {
          type: "toolCall",
          id: "call-1",
          name: "example",
          arguments: { openclawResponsesInputReplay: "user-supplied argument" },
        },
      ],
      openclawResponsesInputReplay: {
        afterResponseId: "synthetic-response",
        before: ["synthetic-input-fingerprint"],
        after: [],
      },
    };
    const canonical = structuredClone(message);
    const display =
      surface === "history"
        ? projectChatDisplayMessages([message])[0]
        : projectSessionMessagePayload({
            sessionKey: "agent:main:input-replay",
            message,
            historyDelta: surface === "delta",
          }).payload?.message;

    expect(display).not.toHaveProperty("openclawResponsesInputReplay");
    expect(display).toMatchObject({ role: "assistant", content: message.content });
    expect(message).toEqual(canonical);
  },
);
