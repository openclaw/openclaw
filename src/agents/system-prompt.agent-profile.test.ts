// Agent Profile prompt narrowing: compact prompts and the listed-skills ceiling.
import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const SKILLS =
  "<available_skills>\n  <skill>\n    <name>demo</name>\n    <location>/skills/demo/SKILL.md</location>\n  </skill>\n</available_skills>";

function renderPrompt(params: Partial<Parameters<typeof buildAgentSystemPrompt>[0]> = {}) {
  return buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw", ...params });
}

describe("buildAgentSystemPrompt with an Agent Profile", () => {
  it("compact keeps reply, owner and channel guidance and drops reference sections", () => {
    const params = {
      runtimeInfo: { channel: "telegram" },
      ownerNumbers: ["+123"],
      skillsPrompt: SKILLS,
      toolNames: ["message", "read", "exec"],
      docsPath: "/tmp/openclaw/docs",
      extraSystemPrompt: "Group details",
    };
    const full = renderPrompt(params);
    const compact = renderPrompt({ ...params, agentProfilePrompt: { compact: true } });

    for (const kept of [
      "## Authorized Senders",
      "## Silent Replies",
      "## Messaging",
      "## Conversation Context",
      "<name>demo</name>",
    ]) {
      expect(compact).toContain(kept);
    }
    expect(full).toContain("## Documentation");
    expect(compact).not.toContain("## Documentation");
    expect(compact).not.toContain("## Subagent Context");
    expect(compact.length).toBeLessThan(full.length);
  });

  it("lists no skills under a zero ceiling only while skills stay searchable", () => {
    const searchable = renderPrompt({
      agentProfilePrompt: { maxListedSkills: 0 },
      skillsPrompt: SKILLS,
      toolNames: ["read", "skills_search"],
    });
    expect(searchable).toContain("No skill entries are listed in this prompt.");
    expect(searchable).not.toContain("<name>demo</name>");

    const notSearchable = renderPrompt({
      agentProfilePrompt: { maxListedSkills: 0 },
      skillsPrompt: SKILLS,
      toolNames: ["read"],
    });
    expect(notSearchable).toContain("<name>demo</name>");
  });

  it("keeps compact and full prompts apart in the shared stable-prefix cache", () => {
    const params = { toolNames: ["read", "exec"], workspaceNotes: ["cache-identity"] };
    const compact = renderPrompt({ ...params, agentProfilePrompt: { compact: true } });
    const full = renderPrompt(params);
    expect(compact).not.toContain("## Execution Bias");
    expect(full).toContain("## Execution Bias");
  });
});
