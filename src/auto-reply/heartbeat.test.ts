import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_RESPONSE_TOOL_PROMPT,
  isHeartbeatAcknowledgementText,
  isHeartbeatContentEffectivelyEmpty,
  resolveHeartbeatPromptForResponseTool,
  stripHeartbeatToken,
} from "./heartbeat.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "./tokens.js";

function expectStripped(
  input: string | undefined,
  mode: "message" | "heartbeat",
  shouldSkip: boolean,
  text: string,
  didStrip: boolean,
) {
  expect(stripHeartbeatToken(input, { mode })).toEqual({ shouldSkip, text, didStrip });
}

describe("stripHeartbeatToken", () => {
  it("skips empty or token-only replies", () => {
    expectStripped(undefined, "heartbeat", true, "", false);
    expectStripped("  ", "heartbeat", true, "", false);
    expectStripped(HEARTBEAT_TOKEN, "heartbeat", true, "", true);
  });

  it.each([
    [`hello ${HEARTBEAT_TOKEN} there`, `hello ${HEARTBEAT_TOKEN} there`, false],
    [`<code>${HEARTBEAT_TOKEN}</code> all good`, "all good", true],
    [`I should not respond ${HEARTBEAT_TOKEN}.`, "I should not respond.", true],
  ] as const)("preserves content around the token in %s", (input, text, didStrip) => {
    expectStripped(input, "message", false, text, didStrip);
  });
});

describe("isHeartbeatAcknowledgementText", () => {
  it.each([undefined, "HEARTBEAT_OK", "HEARTBEAT_OK all good"])(
    "recognizes %s as a quiet acknowledgement",
    (text) => {
      expect(isHeartbeatAcknowledgementText(text)).toBe(true);
    },
  );

  it("preserves substantive replies and the legacy acknowledgement length limit", () => {
    expect(isHeartbeatAcknowledgementText("NO_REPLY")).toBe(false);
    expect(isHeartbeatAcknowledgementText("NO_REPLY: actual reminder")).toBe(false);
    expect(isHeartbeatAcknowledgementText("HEARTBEAT_OK all good", 0)).toBe(false);
  });

  it.each(["NO_R", "no_r", "NO_RE", " No_R ", "no_repl"])(
    "treats a truncated silent token %s as a quiet acknowledgement (#170158)",
    (text) => {
      expect(isHeartbeatAcknowledgementText(text)).toBe(false);
      expect(isHeartbeatAcknowledgementText(text, undefined, true)).toBe(true);
      expectStripped(text, "message", false, text.trim(), false);
    },
  );

  it.each(["no_", "no_r.", "NO_RESP", "No", "No.", "NO", "NO_REPLY: actual reminder"])(
    "keeps ordinary short replies like %s substantive on heartbeats",
    (text) => {
      expect(isHeartbeatAcknowledgementText(text, undefined, true)).toBe(false);
    },
  );
});

describe("isHeartbeatContentEffectivelyEmpty", () => {
  it.each([
    undefined,
    null,
    "Reminder <!-- not scaffolding -->",
    "```markdown\n# Keep this scratch empty when you want to skip.\n\n- Check email\n```\n",
  ])("keeps missing or substantive scratch: %j", (content) => {
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(false);
  });

  it.each([
    "# Header\n# Another comment",
    "## Subheader\n### Another",
    "<!-- Template -->",
    "<!--\nHeartbeat template.\nKeep quiet.\n-->",
    "<!--\ntasks:\n  - name: inbox\n    interval: 30m\n    prompt: Check inbox\n-->",
    "<!-- One --> <!-- Two -->",
    "<!-- One -->\n# Header",
  ])("ignores scaffolding: %j", (content) => {
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(true);
  });
});

describe("resolveHeartbeatPromptForResponseTool", () => {
  const custom = "Check the deployment queue and only interrupt the user for blockers.";
  it.each([undefined, custom])("preserves custom prompts and the tool contract: %s", (input) => {
    const prompt = resolveHeartbeatPromptForResponseTool(input);
    if (input) {
      expect(prompt).toContain("Check the deployment queue");
    } else {
      expect(prompt).toBe(HEARTBEAT_RESPONSE_TOOL_PROMPT);
      expect(prompt).not.toContain(HEARTBEAT_TOKEN);
    }
    for (const text of [
      "heartbeat_respond",
      "notify=false",
      `${SILENT_REPLY_TOKEN} when nothing needs the user's attention`,
      "only the alert text",
    ]) {
      expect(prompt).toContain(text);
    }
  });
});
