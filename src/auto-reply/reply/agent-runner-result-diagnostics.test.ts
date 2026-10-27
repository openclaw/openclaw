import { describe, expect, it } from "vitest";
import { buildReplyDiagnosticsPayload } from "./agent-runner-result-diagnostics.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";
import { createMockFollowupRun } from "./test-helpers.js";

async function renderPromptSegments(prompt: string) {
  const payload = await buildReplyDiagnosticsPayload({
    activeSessionEntry: undefined,
    followupRun: createMockFollowupRun({
      run: { sessionId: "", traceAuthorized: true, traceLevelOverride: "raw" },
    }),
    accounting: {
      runResult: { meta: { durationMs: 0 } },
      providerUsed: "synthetic",
      modelUsed: "synthetic",
      contextTokensUsed: 1000,
    },
    userText: prompt,
  });
  return payload?.text?.split("🔎 Prompt Segments:\n~~~text\n")[1]?.split("\n~~~")[0];
}

describe("raw reply diagnostic prompt segments", () => {
  const context = "Context:\n<attachment>\nimg\n</attachment>";
  const metadata = `${markInboundContextLabel("Conversation info:")}\n\`\`\`json\n{}\n\`\`\``;

  it.each([
    { name: "Context block at EOF", block: context, trailing: "", key: "attachment" },
    {
      name: "Context block with trailing empty lines",
      block: context,
      trailing: "\n\n",
      key: "attachment",
    },
    { name: "metadata fence at EOF", block: metadata, trailing: "", key: "conversation_metadata" },
    {
      name: "metadata fence with trailing empty lines",
      block: metadata,
      trailing: "\n\n",
      key: "conversation_metadata",
    },
  ])("attributes $name without user content", async ({ block, trailing, key }) => {
    expect(await renderPromptSegments(block + trailing)).toBe(
      `${key}=${block.length} chars\ntotalPromptText=${block.length + trailing.length} chars`,
    );
  });

  it("keeps user content after consecutive context and metadata blocks", async () => {
    const prompt = `${context}\n\n${metadata}\n\nHello`;
    expect(await renderPromptSegments(prompt)).toBe(
      `attachment=${context.length} chars\nconversation_metadata=${metadata.length} chars\nuser_message=6 chars\ntotalPromptText=${prompt.length} chars`,
    );
  });
});
