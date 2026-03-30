import { describe, expect, it } from "vitest";
import { extractRecentInterSessionActivity } from "./sessions-history-tool.js";

describe("extractRecentInterSessionActivity", () => {
  it("returns newest inter-session provenance entries first", () => {
    const result = extractRecentInterSessionActivity([
      { role: "user", content: "normal user message" },
      {
        role: "user",
        content: "forwarded from ops",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:ops:main",
          sourceChannel: "internal",
          sourceTool: "sessions_send",
        },
      },
      {
        role: "assistant",
        content: "latest linked activity",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:skippy:main",
          sourceChannel: "internal",
          sourceTool: "sessions_send",
        },
      },
    ]);

    expect(result).toEqual([
      {
        role: "assistant",
        text: "latest linked activity",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:skippy:main",
          sourceChannel: "internal",
          sourceTool: "sessions_send",
        },
      },
      {
        role: "user",
        text: "forwarded from ops",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:ops:main",
          sourceChannel: "internal",
          sourceTool: "sessions_send",
        },
      },
    ]);
  });

  it("caps returned activity items", () => {
    const result = extractRecentInterSessionActivity(
      [
        {
          role: "user",
          content: "one",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
        {
          role: "user",
          content: "two",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
      ],
      1,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("two");
  });
});
