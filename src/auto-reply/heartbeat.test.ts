/** Tests heartbeat prompt and token helpers. */
import { describe, expect, it } from "vitest";
import { isCronScratchEffectivelyEmpty } from "../cron/scratch-contract.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  HEARTBEAT_RESPONSE_TOOL_PROMPT,
  isHeartbeatAcknowledgementText,
  resolveHeartbeatPromptForResponseTool,
  stripHeartbeatToken,
} from "./heartbeat.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "./tokens.js";

function createSkippedHeartbeatOutcome() {
  return {
    shouldSkip: true,
    text: "",
    didStrip: true,
  };
}

describe("stripHeartbeatToken", () => {
  it("skips empty or token-only replies", () => {
    expect(stripHeartbeatToken(undefined, { mode: "heartbeat" })).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: false,
    });
    expect(stripHeartbeatToken("  ", { mode: "heartbeat" })).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: false,
    });
    expect(stripHeartbeatToken(HEARTBEAT_TOKEN, { mode: "heartbeat" })).toEqual(
      createSkippedHeartbeatOutcome(),
    );
  });

  it("drops heartbeats with small junk in heartbeat mode", () => {
    expect(stripHeartbeatToken("HEARTBEAT_OK 🦞", { mode: "heartbeat" })).toEqual(
      createSkippedHeartbeatOutcome(),
    );
    expect(stripHeartbeatToken(`🦞 ${HEARTBEAT_TOKEN}`, { mode: "heartbeat" })).toEqual(
      createSkippedHeartbeatOutcome(),
    );
  });

  it("keeps heartbeat replies when remaining content exceeds threshold", () => {
    const long = "A".repeat(DEFAULT_HEARTBEAT_ACK_MAX_CHARS + 1);
    expect(stripHeartbeatToken(`${long} ${HEARTBEAT_TOKEN}`, { mode: "heartbeat" })).toEqual({
      shouldSkip: false,
      text: long,
      didStrip: true,
    });
  });

  it("strips token at edges for normal messages", () => {
    expect(stripHeartbeatToken(`${HEARTBEAT_TOKEN} hello`, { mode: "message" })).toEqual({
      shouldSkip: false,
      text: "hello",
      didStrip: true,
    });
    expect(stripHeartbeatToken(`hello ${HEARTBEAT_TOKEN}`, { mode: "message" })).toEqual({
      shouldSkip: false,
      text: "hello",
      didStrip: true,
    });
  });

  it("does not touch token in the middle", () => {
    expect(
      stripHeartbeatToken(`hello ${HEARTBEAT_TOKEN} there`, {
        mode: "message",
      }),
    ).toEqual({
      shouldSkip: false,
      text: `hello ${HEARTBEAT_TOKEN} there`,
      didStrip: false,
    });
  });

  it("strips HTML-wrapped heartbeat tokens", () => {
    expect(stripHeartbeatToken(`<b>${HEARTBEAT_TOKEN}</b>`, { mode: "heartbeat" })).toEqual(
      createSkippedHeartbeatOutcome(),
    );
  });

  it("strips markdown-wrapped heartbeat tokens", () => {
    expect(stripHeartbeatToken(`**${HEARTBEAT_TOKEN}**`, { mode: "heartbeat" })).toEqual(
      createSkippedHeartbeatOutcome(),
    );
  });

  it("removes markup-wrapped token and keeps trailing content", () => {
    expect(
      stripHeartbeatToken(`<code>${HEARTBEAT_TOKEN}</code> all good`, {
        mode: "message",
      }),
    ).toEqual({
      shouldSkip: false,
      text: "all good",
      didStrip: true,
    });
  });

  it("strips trailing punctuation only when directly after the token", () => {
    expect(stripHeartbeatToken(`${HEARTBEAT_TOKEN}.`, { mode: "heartbeat" })).toEqual(
      createSkippedHeartbeatOutcome(),
    );
    expect(stripHeartbeatToken(`${HEARTBEAT_TOKEN}!!!`, { mode: "heartbeat" })).toEqual(
      createSkippedHeartbeatOutcome(),
    );
    expect(stripHeartbeatToken(`${HEARTBEAT_TOKEN}---`, { mode: "heartbeat" })).toEqual(
      createSkippedHeartbeatOutcome(),
    );
  });

  it("strips a sentence-ending token and keeps trailing punctuation", () => {
    expect(
      stripHeartbeatToken(`I should not respond ${HEARTBEAT_TOKEN}.`, {
        mode: "message",
      }),
    ).toEqual({
      shouldSkip: false,
      text: `I should not respond.`,
      didStrip: true,
    });
  });

  it("strips sentence-ending token with emphasis punctuation in heartbeat mode", () => {
    expect(
      stripHeartbeatToken(
        `There is nothing todo, so i should respond with ${HEARTBEAT_TOKEN} !!!`,
        {
          mode: "heartbeat",
        },
      ),
    ).toEqual(createSkippedHeartbeatOutcome());
  });

  it("preserves trailing punctuation on text before the token", () => {
    expect(stripHeartbeatToken(`All clear. ${HEARTBEAT_TOKEN}`, { mode: "message" })).toEqual({
      shouldSkip: false,
      text: "All clear.",
      didStrip: true,
    });
  });
});

describe("isHeartbeatAcknowledgementText", () => {
  it.each([undefined, "NO_REPLY", "HEARTBEAT_OK", "HEARTBEAT_OK all good"])(
    "recognizes %s as a quiet acknowledgement",
    (text) => {
      expect(isHeartbeatAcknowledgementText(text)).toBe(true);
    },
  );

  it("preserves substantive replies and the legacy acknowledgement length limit", () => {
    expect(isHeartbeatAcknowledgementText("NO_REPLY: actual reminder")).toBe(false);
    expect(isHeartbeatAcknowledgementText("HEARTBEAT_OK all good", 0)).toBe(false);
  });
});

describe("isCronScratchEffectivelyEmpty", () => {
  it("returns false for missing scratch so the monitor can still run", () => {
    expect(isCronScratchEffectivelyEmpty(undefined)).toBe(false);
  });

  it("returns true for whitespace only", () => {
    expect(isCronScratchEffectivelyEmpty("   ")).toBe(true);
    expect(isCronScratchEffectivelyEmpty("\n\n\n")).toBe(true);
    expect(isCronScratchEffectivelyEmpty("  \n  \n  ")).toBe(true);
    expect(isCronScratchEffectivelyEmpty("\t\t")).toBe(true);
  });

  it("returns true for comments only", () => {
    expect(isCronScratchEffectivelyEmpty("# Header\n# Another comment")).toBe(true);
    expect(isCronScratchEffectivelyEmpty("## Subheader\n### Another")).toBe(true);
    expect(
      isCronScratchEffectivelyEmpty(
        "<!-- Heartbeat template; comments-only content prevents scheduled heartbeat API calls. -->",
      ),
    ).toBe(true);
    expect(
      isCronScratchEffectivelyEmpty(`<!--
Heartbeat template.
Keep this comment-only scratch quiet.
-->`),
    ).toBe(true);
    expect(
      isCronScratchEffectivelyEmpty(`<!--
tasks:
  - name: inbox
    interval: 30m
    prompt: Check inbox
-->`),
    ).toBe(true);
    expect(isCronScratchEffectivelyEmpty("<!-- One --> <!-- Two -->")).toBe(true);
    expect(isCronScratchEffectivelyEmpty("<!-- One -->\n# Header")).toBe(true);
    expect(isCronScratchEffectivelyEmpty("Reminder <!-- not scaffolding -->")).toBe(false);
  });

  it("returns false when a template includes plain instructional prose", () => {
    const defaultTemplate = `# Heartbeat scratch

Keep this scratch empty unless you want a tiny checklist. Keep it small.
    `;
    expect(isCronScratchEffectivelyEmpty(defaultTemplate)).toBe(false);
  });

  it("returns true for fenced monitor scratch without actionable content", () => {
    const content = `# Heartbeat scratch

\`\`\`markdown
# Keep this scratch empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`
`;
    expect(isCronScratchEffectivelyEmpty(content)).toBe(true);
  });

  it("returns false when fenced heartbeat content includes a real task", () => {
    const content = `\`\`\`markdown
# Keep this scratch empty when you want to skip.

- Check email
\`\`\`
`;
    expect(isCronScratchEffectivelyEmpty(content)).toBe(false);
  });

  it("returns false when actionable content exists", () => {
    expect(isCronScratchEffectivelyEmpty("- Check email")).toBe(false);
    expect(isCronScratchEffectivelyEmpty("# Heartbeat scratch\n- Task 1")).toBe(false);
    expect(isCronScratchEffectivelyEmpty("Remind me to call mom")).toBe(false);
  });
});

describe("resolveHeartbeatPromptForResponseTool", () => {
  it("uses the structured heartbeat response tool instead of the legacy ok token", () => {
    const prompt = resolveHeartbeatPromptForResponseTool();

    expect(prompt).toBe(HEARTBEAT_RESPONSE_TOOL_PROMPT);
    expect(prompt).toContain("heartbeat_respond");
    expect(prompt).toContain("notify=false");
    expect(prompt).toContain(`${SILENT_REPLY_TOKEN} when nothing needs the user's attention`);
    expect(prompt).toContain("only the alert text");
    expect(prompt).not.toContain(HEARTBEAT_TOKEN);
  });

  it("keeps custom heartbeat prompts intact and appends the tool-mode contract", () => {
    const prompt = resolveHeartbeatPromptForResponseTool(
      "Check the deployment queue and only interrupt the user for blockers.",
    );

    expect(prompt).toContain("Check the deployment queue");
    expect(prompt).toContain("heartbeat_respond");
    expect(prompt).toContain("notify=false");
    expect(prompt).toContain(`${SILENT_REPLY_TOKEN} when nothing needs the user's attention`);
    expect(prompt).toContain("only the alert text");
  });
});
