import { describe, expect, it } from "vitest";
import { buildCliSessionUnseenTurnsContext } from "../agents/cli-session.js";
import { findCarriedCompletion } from "./cli-announce-carried-completion.test-helpers.js";

const completionReply =
  "The child task finished and returned exactly the expected result: CHILD_551";
const followUpPrompt =
  "[Tue 2026-10-13 06:30 PDT] Do not call any tools. Quote, verbatim, the last update you sent me.";

describe("findCarriedCompletion", () => {
  it("matches a reply-only completion record without a prompt envelope", () => {
    const text = `${buildCliSessionUnseenTurnsContext([
      { source: "subagent_announce", reply: completionReply },
    ])}\n\n${followUpPrompt}`;

    expect(findCarriedCompletion(text, completionReply)).toEqual({
      source: "subagent_announce",
      reply: completionReply,
    });
  });

  it("matches a completion record that carries its prompt envelope", () => {
    const text = buildCliSessionUnseenTurnsContext([
      {
        source: "subagent_announce",
        prompt: "[Inter-session message] sourceTool=subagent_announce isUser=false child done",
        reply: completionReply,
      },
    ]);

    expect(findCarriedCompletion(text, completionReply)?.reply).toBe(completionReply);
  });

  it("matches the block when a transcript reader collapsed its line breaks", () => {
    const text = `${buildCliSessionUnseenTurnsContext([
      { source: "subagent_announce", reply: completionReply },
    ])}\n\n${followUpPrompt}`.replace(/\s+/g, " ");

    expect(findCarriedCompletion(text, completionReply)?.reply).toBe(completionReply);
  });

  it("ignores other sources, other replies, unmarked text and malformed blocks", () => {
    const texts = [
      buildCliSessionUnseenTurnsContext([{ source: "sessions_send", reply: completionReply }]),
      buildCliSessionUnseenTurnsContext([{ source: "subagent_announce", reply: "unrelated" }]),
      `[Inter-session message] sourceTool=subagent_announce isUser=false ${completionReply}`,
      `\`\`\`json\n[{"source":"subagent_announce","reply":"${completionReply}"}]\n\`\`\``,
      buildCliSessionUnseenTurnsContext([
        { source: "subagent_announce", reply: completionReply },
      ]).replace("]", ""),
    ];

    for (const text of texts) {
      expect(findCarriedCompletion(text, completionReply)).toBeUndefined();
    }
  });
});
