import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_AGENT_MANIFESTS,
  CAPABILITY_AGENT_PROFILES,
  capabilityManifestForProfile,
  mergeCapabilityAgents,
  runCapabilityAgentProfileCli,
} from "../../scripts/agents/capability-agent-profile.mjs";
import { AgentEntrySchema } from "../../src/config/zod-schema.agent-runtime.js";

describe("capability agent profile", () => {
  it("defines the first three world-class capability adapter agents", () => {
    expect(CAPABILITY_AGENT_PROFILES.map((profile) => profile.id)).toEqual([
      "research_agent",
      "browser_ops_agent",
      "security_bouncer_agent",
    ]);
    expect(CAPABILITY_AGENT_PROFILES[0]?.params.ticketTypes).toContain("web_research");
    expect(CAPABILITY_AGENT_PROFILES.every((profile) => profile.contextInjection === "never")).toBe(
      true,
    );
    expect(CAPABILITY_AGENT_PROFILES[1]?.skills).toContain("visual-web-overlay");
    expect(CAPABILITY_AGENT_PROFILES[2]?.skills).toContain("security-triage");
    expect(CAPABILITY_AGENT_MANIFESTS.map((manifest) => manifest.id)).toEqual([
      "research_agent",
      "browser_ops_agent",
      "security_bouncer_agent",
    ]);
    expect(capabilityManifestForProfile(CAPABILITY_AGENT_PROFILES[0])).toMatchObject({
      runtime: "native-openclaw",
      schemaVersion: "agent-os.capability.v1",
      ticketTypes: expect.arrayContaining(["research", "web_research"]),
    });
  });

  it("merges capability agents without deleting existing agent state", () => {
    const result = mergeCapabilityAgents({
      agents: {
        list: [
          { id: "main", workspace: "/workspace/main" },
          {
            id: "research_agent",
            model: "nvidia/test-model",
            params: { custom: true },
            systemPromptOverride: "legacy unsupported field",
            workspace: "/workspace/research",
          },
        ],
      },
    });

    const research = result.config.agents.list.find((entry) => entry.id === "research_agent");
    expect(result.config.agents.list.map((entry) => entry.id)).toEqual([
      "main",
      "research_agent",
      "browser_ops_agent",
      "security_bouncer_agent",
    ]);
    expect(research?.workspace).toBe("/workspace/research");
    expect(research?.model).toBe("nvidia/test-model");
    expect(research?.description).toContain("research");
    expect(research?.contextInjection).toBe("never");
    expect(research?.params.custom).toBe(true);
    expect(research?.params.capabilityFamily).toBe("research");
    expect(research).not.toHaveProperty("systemPromptOverride");
    expect(research?.params.agentOsCapability).toMatchObject({
      id: "research_agent",
      schemaVersion: "agent-os.capability.v1",
    });
    for (const entry of result.config.agents.list.filter((item) => item.id.endsWith("_agent"))) {
      expect(AgentEntrySchema.safeParse(entry).success).toBe(true);
    }
  });

  it("applies profiles to a config file and leaves a backup", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-capability-profile-"));
    const configPath = path.join(dir, "openclaw.json");
    try {
      writeFileSync(configPath, `${JSON.stringify({ agents: { list: [{ id: "main" }] } })}\n`);

      expect(runCapabilityAgentProfileCli(["apply", "--config", configPath])).toBe(0);

      const updated = JSON.parse(readFileSync(configPath, "utf8"));
      expect(updated.agents.list.map((entry: { id: string }) => entry.id)).toEqual([
        "main",
        "research_agent",
        "browser_ops_agent",
        "security_bouncer_agent",
      ]);
      expect(
        updated.agents.list.every(
          (entry: { id: string; params?: { agentOsCapability?: { schemaVersion?: string } } }) =>
            entry.id === "main" ||
            entry.params?.agentOsCapability?.schemaVersion === "agent-os.capability.v1",
        ),
      ).toBe(true);
      expect(readFileSync(`${configPath}.capability-agents.bak`, "utf8")).toContain('"main"');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
