/**
 * The Telegram "Current message:" block, split out of inbound-meta.test.ts so that
 * file stays under the line cap (the ratchet rejects growth on a file that is
 * already over it). Subject: src/auto-reply/reply/inbound-meta.current-message.ts.
 */
import { describe, expect, it } from "vitest";
import { buildCurrentInboundPrompt } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import type { TemplateContext } from "../templating.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { projectTelegramCurrentMessageCarrier } from "./inbound-meta.current-message.js";
import {
  buildInboundUserContextPrefix,
  resolveInboundUserContextPromptJoiner,
} from "./inbound-meta.js";
import { buildReplyPromptEnvelopeBase } from "./prompt-prelude.js";

// The carrier projection of the inbound user-context prefix, as prompt-prelude
// builds it for the separate runtime-context carrier.
function buildCarrierContext(ctx: TemplateContext): string {
  return projectTelegramCurrentMessageCarrier(
    buildInboundUserContextPrefix(ctx, { timezone: "utc" }),
    ctx,
  );
}

describe("projectTelegramCurrentMessageCarrier — Telegram current-message carrier", () => {
  it("states the current message body inside the Telegram current-message block", () => {
    const body = "What's the end result?";
    const text = buildCarrierContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      MessageSid: "34974",
      ReplyToId: "34971",
      ReplyToBody: "The full message should not be preferred.",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
      Timestamp: Date.UTC(2026, 4, 10, 17, 8),
      agentText: body,
      Body: body,
      BodyForAgent: body,
    } as TemplateContext);

    // The carrier block is a separate model-facing message; a bare "#34974:"
    // header is read as an empty (elided) current-message body and real
    // instructions get treated as absent/duplicate. The body must be stated
    // inside the block itself.
    expect(text).toContain(`Current message:\n[Replying to: "selected quote"]\n#34974: ${body}`);
    const currentMessageBlock = text.split("Current message:").at(-1) ?? "";
    expect(currentMessageBlock.trimEnd().endsWith("#34974:")).toBe(false);
  });
  it("preserves the bare Telegram current-message header when the turn has no body", () => {
    const text = buildCarrierContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      MessageSid: "34974",
      ReplyToId: "34971",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
    } as TemplateContext);

    expect(text).toContain('Current message:\n[Replying to: "selected quote"]\n#34974:');
    expect(text.trimEnd().endsWith("#34974:")).toBe(true);
  });

  it("states the current body without a header when the Telegram turn has no message id", () => {
    // Before the carrier fix this block rendered as quote-only: no header line and
    // no body. The body now stands where the header would be, so a turn without a
    // message id is still self-contained rather than silently bodyless.
    const text = buildCarrierContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      ReplyToId: "34971",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
      Body: "ship it",
    } as TemplateContext);

    expect(text).toContain('Current message:\n[Replying to: "selected quote"]\nship it');
    expect(text).not.toMatch(/#\S*:/);
  });

  it("prefers agentText and collapses whitespace for the Telegram current-message body", () => {
    const text = buildCarrierContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      MessageSid: "34974",
      ReplyToId: "34971",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
      agentText: "agent\n\n  text",
      BodyForAgent: "body for agent",
      Body: "raw body",
    } as TemplateContext);

    expect(text).toContain('Current message:\n[Replying to: "selected quote"]\n#34974: agent text');
    expect(text).not.toContain("body for agent");
    expect(text).not.toContain("raw body");
  });
});

describe("Telegram current-message block across the carrier and CLI inline projections", () => {
  function countOccurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  // Producer and consumer are the real ones: get-reply-run-context builds the
  // prefix and joiner, prompt-prelude builds currentInboundContext, and the CLI
  // runner (src/agents/cli-runner/prepare.ts) renders the current turn with
  // buildCurrentInboundPrompt, joining context.text and the prompt with the joiner.
  function projectQuotedTelegramTurn(body: string) {
    const sessionCtx = finalizeInboundContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      MessageSid: "34974",
      ReplyToId: "34971",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
      Body: body,
      BodyForAgent: body,
    });
    const { currentInboundContext } = buildReplyPromptEnvelopeBase({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: body,
      hasUserBody: true,
      inboundUserContext: buildInboundUserContextPrefix(sessionCtx, { timezone: "utc" }),
      inboundUserContextPromptJoiner: resolveInboundUserContextPromptJoiner(sessionCtx),
      isBareSessionReset: false,
      startupAction: "new",
    });
    return {
      cliPrompt: buildCurrentInboundPrompt({ context: currentInboundContext, prompt: body }),
      carrier: (currentInboundContext?.fragments ?? [])
        .map((fragment) => fragment.text)
        .join("\n\n"),
    };
  }

  it("states a quoted Telegram body exactly once in the CLI inline prompt", () => {
    const body = "What's the end result?";
    const { cliPrompt, carrier } = projectQuotedTelegramTurn(body);

    expect(countOccurrences(cliPrompt, body)).toBe(1);
    expect(cliPrompt.endsWith(`[Replying to: "selected quote"]\n#34974: ${body}`)).toBe(true);
    // The separate carrier still states the body inside its own block.
    expect(carrier).toContain(`Current message:\n[Replying to: "selected quote"]\n#34974: ${body}`);
  });

  it("keeps the complete formatted body in the CLI prompt and the sanitized one in the carrier", () => {
    const body = "Step one:\n\n  run `pnpm check`\nthen reply";
    const sanitized = "Step one: run `pnpm check` then reply";
    const { cliPrompt, carrier } = projectQuotedTelegramTurn(body);

    expect(cliPrompt.endsWith(`[Replying to: "selected quote"]\n#34974: ${body}`)).toBe(true);
    expect(cliPrompt).not.toContain(sanitized);
    expect(carrier).toContain(`[Replying to: "selected quote"]\n#34974: ${sanitized}`);
    expect(carrier).not.toContain(body);
  });
});
