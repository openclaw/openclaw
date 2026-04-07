import { describe, expect, it } from "vitest";
import { parseInlineDirectives } from "./reply/directive-handling.parse.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import { buildInboundUserContextPrefix } from "./reply/inbound-meta.js";
import { buildReplyPromptBodies } from "./reply/prompt-prelude.js";

describe("RawBody directive parsing", () => {
  it("handles directives and history in the prompt", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "/think:high status please",
      BodyForAgent: "/think:high status please",
      BodyForCommands: "/think:high status please",
      RawBody: "/think:high status please",
      InboundHistory: [{ sender: "Peter", body: "hello", timestamp: 1700000000000 }],
      From: "+1222",
      To: "+1222",
      ChatType: "group",
      GroupSubject: "Ops",
      SenderName: "Jake McInteer",
      SenderE164: "+6421807830",
      CommandAuthorized: true,
    });
    const directives = parseInlineDirectives(sessionCtx.BodyForCommands ?? "", {
      allowStatusDirective: true,
    });
    const prefixedBody = [buildInboundUserContextPrefix(sessionCtx), directives.cleaned]
      .filter(Boolean)
      .join("\n\n");
    const prompt = buildReplyPromptBodies({
      ctx: sessionCtx,
      sessionCtx: { ...sessionCtx, BodyStripped: directives.cleaned },
      effectiveBaseBody: prefixedBody,
      prefixedBody,
    }).prefixedCommandBody;

    expect(prompt).toContain("Chat history since last reply (untrusted, for context):");
    expect(prompt).toContain('"sender": "Peter"');
    expect(prompt).toContain('"body": "hello"');
    expect(prompt).toContain("status please");
    expect(prompt).not.toContain("/think:high");
  });
});
