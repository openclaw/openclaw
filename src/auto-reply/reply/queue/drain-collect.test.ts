/**
 * Tests that the collect-mode queue drain strips inbound metadata blocks
 * (Conversation info JSON, Sender JSON, etc.) from individual queued prompts
 * before assembling the batched prompt sent to the model.
 *
 * Regression for issue #30405 — "Model echoes queued message metadata
 * (Conversation info JSON) into Discord output".
 */

import { describe, it, expect } from "vitest";
import { buildCollectPrompt } from "../../../utils/queue-helpers.js";
import { stripLeadingInboundMetadata } from "../strip-inbound-meta.js";

// ---------------------------------------------------------------------------
// Fixtures: sample metadata blocks matching buildInboundUserContextPrefix output
// ---------------------------------------------------------------------------

const CONV_INFO_BLOCK = `Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "1234567890",
  "sender_id": "987654321",
  "sender": "alice#1234",
  "conversation_label": "test-server / #general"
}
\`\`\``;

const SENDER_BLOCK = `Sender (untrusted metadata):
\`\`\`json
{
  "label": "Alice",
  "name": "Alice",
  "username": "alice",
  "tag": "alice#1234"
}
\`\`\``;

const THREAD_STARTER_BLOCK = `Thread starter (untrusted, for context):
\`\`\`json
{
  "body": "Starting a discussion about cats"
}
\`\`\``;

const FORWARDED_BLOCK = `Forwarded message context (untrusted metadata):
\`\`\`json
{
  "from": "Bob",
  "type": "user"
}
\`\`\``;

/**
 * Build a realistic queued item prompt the way buildInboundUserContextPrefix
 * produces it: leading metadata blocks followed by the actual user message.
 */
function makeQueuedPrompt(userText: string, ...blocks: string[]): string {
  if (blocks.length === 0) {
    return userText;
  }
  return blocks.join("\n\n") + "\n\n" + userText;
}

/**
 * The renderItem function used by drain.ts after the fix.
 * Mirrors the production code so the tests validate the real logic.
 */
function renderItemWithStrip(item: { prompt: string }, idx: number): string {
  const cleanPrompt = stripLeadingInboundMetadata(item.prompt);
  return `---\nQueued #${idx + 1}\n${cleanPrompt}`.trim();
}

// ---------------------------------------------------------------------------
// Core metadata-stripping tests
// ---------------------------------------------------------------------------

describe("collect-mode prompt: metadata stripping (issue #30405)", () => {
  it("does not include Conversation info block in the assembled collect prompt", () => {
    const items = [
      { prompt: makeQueuedPrompt("What time is it?", CONV_INFO_BLOCK) },
      { prompt: makeQueuedPrompt("Any updates?", CONV_INFO_BLOCK) },
    ];

    const prompt = buildCollectPrompt({
      title: "[Queued messages while agent was busy]",
      items,
      renderItem: renderItemWithStrip,
    });

    expect(prompt).not.toContain("Conversation info (untrusted metadata):");
    expect(prompt).not.toContain('"message_id"');
    expect(prompt).not.toContain('"sender_id"');
    expect(prompt).toContain("What time is it?");
    expect(prompt).toContain("Any updates?");
  });

  it("does not include Sender metadata block in the assembled collect prompt", () => {
    const items = [
      {
        prompt: makeQueuedPrompt("Hello there!", CONV_INFO_BLOCK, SENDER_BLOCK),
      },
    ];

    const prompt = buildCollectPrompt({
      title: "[Queued messages while agent was busy]",
      items,
      renderItem: renderItemWithStrip,
    });

    expect(prompt).not.toContain("Sender (untrusted metadata):");
    expect(prompt).not.toContain('"label": "Alice"');
    expect(prompt).toContain("Hello there!");
  });

  it("does not include Thread starter block in the assembled collect prompt", () => {
    const items = [
      { prompt: makeQueuedPrompt("Follow-up question", CONV_INFO_BLOCK, THREAD_STARTER_BLOCK) },
    ];

    const prompt = buildCollectPrompt({
      title: "[Queued messages while agent was busy]",
      items,
      renderItem: renderItemWithStrip,
    });

    expect(prompt).not.toContain("Thread starter (untrusted, for context):");
    expect(prompt).not.toContain('"body": "Starting a discussion about cats"');
    expect(prompt).toContain("Follow-up question");
  });

  it("does not include Forwarded message context block in the assembled collect prompt", () => {
    const items = [{ prompt: makeQueuedPrompt("See above", CONV_INFO_BLOCK, FORWARDED_BLOCK) }];

    const prompt = buildCollectPrompt({
      title: "[Queued messages while agent was busy]",
      items,
      renderItem: renderItemWithStrip,
    });

    expect(prompt).not.toContain("Forwarded message context (untrusted metadata):");
    expect(prompt).not.toContain('"from": "Bob"');
    expect(prompt).toContain("See above");
  });

  it("strips all metadata block types from all queued items in a multi-message batch", () => {
    const items = [
      { prompt: makeQueuedPrompt("First message", CONV_INFO_BLOCK, SENDER_BLOCK) },
      { prompt: makeQueuedPrompt("Second message", CONV_INFO_BLOCK, SENDER_BLOCK) },
      { prompt: makeQueuedPrompt("Third message", CONV_INFO_BLOCK) },
    ];

    const prompt = buildCollectPrompt({
      title: "[Queued messages while agent was busy]",
      items,
      renderItem: renderItemWithStrip,
    });

    // No metadata sentinel should appear anywhere
    expect(prompt).not.toContain("Conversation info (untrusted metadata):");
    expect(prompt).not.toContain("Sender (untrusted metadata):");
    expect(prompt).not.toContain('"message_id"');
    expect(prompt).not.toContain('"sender_id"');
    expect(prompt).not.toContain('"label": "Alice"');

    // User content must survive
    expect(prompt).toContain("First message");
    expect(prompt).toContain("Second message");
    expect(prompt).toContain("Third message");

    // Queue markers must be present
    expect(prompt).toContain("Queued #1");
    expect(prompt).toContain("Queued #2");
    expect(prompt).toContain("Queued #3");
  });

  it("preserves prompt text that has no metadata blocks unchanged", () => {
    const items = [{ prompt: "Just a plain user message" }, { prompt: "Another plain message" }];

    const prompt = buildCollectPrompt({
      title: "[Queued messages while agent was busy]",
      items,
      renderItem: renderItemWithStrip,
    });

    expect(prompt).toContain("Just a plain user message");
    expect(prompt).toContain("Another plain message");
  });

  it("collect prompt title is preserved in the assembled output", () => {
    const items = [{ prompt: makeQueuedPrompt("Hi", CONV_INFO_BLOCK) }];

    const prompt = buildCollectPrompt({
      title: "[Queued messages while agent was busy]",
      items,
      renderItem: renderItemWithStrip,
    });

    expect(prompt).toContain("[Queued messages while agent was busy]");
  });

  it("includes optional summary line when present", () => {
    const items = [{ prompt: makeQueuedPrompt("A message", CONV_INFO_BLOCK) }];

    const prompt = buildCollectPrompt({
      title: "[Queued messages while agent was busy]",
      items,
      summary: "[Queue overflow] Dropped 2 messages due to cap.",
      renderItem: renderItemWithStrip,
    });

    expect(prompt).toContain("[Queue overflow] Dropped 2 messages due to cap.");
    expect(prompt).not.toContain("Conversation info (untrusted metadata):");
  });

  it("handles a prompt that is only metadata blocks with no user text", () => {
    const items = [{ prompt: makeQueuedPrompt("", CONV_INFO_BLOCK, SENDER_BLOCK) }];

    const prompt = buildCollectPrompt({
      title: "[Queued messages while agent was busy]",
      items,
      renderItem: renderItemWithStrip,
    });

    expect(prompt).not.toContain("Conversation info (untrusted metadata):");
    expect(prompt).not.toContain("Sender (untrusted metadata):");
  });

  it("Queued #N marker appears before user content, not metadata", () => {
    const items = [{ prompt: makeQueuedPrompt("actual user text", CONV_INFO_BLOCK, SENDER_BLOCK) }];

    const prompt = buildCollectPrompt({
      title: "[Queued messages while agent was busy]",
      items,
      renderItem: renderItemWithStrip,
    });

    const queuedMarkerIdx = prompt.indexOf("Queued #1");
    const userTextIdx = prompt.indexOf("actual user text");
    const convInfoIdx = prompt.indexOf("Conversation info");

    expect(queuedMarkerIdx).toBeGreaterThanOrEqual(0);
    expect(userTextIdx).toBeGreaterThanOrEqual(0);
    expect(convInfoIdx).toBe(-1); // stripped entirely
    // Queue marker appears before user text
    expect(queuedMarkerIdx).toBeLessThan(userTextIdx);
  });
});
