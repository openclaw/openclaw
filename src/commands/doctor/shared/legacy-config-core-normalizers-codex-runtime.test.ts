import { describe, expect, it } from "vitest";
import { normalizeLegacyRuntimeModelRefs } from "./legacy-config-core-normalizers.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

describe("normalizeLegacyRuntimeModelRefs - codex runtime preservation (#78499)", () => {
  it("should NOT rewrite model refs when agent already has agentRuntime.id: codex", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "my-codex-agent",
            agentRuntime: { id: "codex" },
            model: { primary: "codex/gpt-5.5" },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const changes: string[] = [];
    const result = normalizeLegacyRuntimeModelRefs(cfg, changes);

    // Model should remain untouched
    const agent = (result.agents as any).list[0];
    expect(agent.model.primary).toBe("codex/gpt-5.5");
    expect(changes).toHaveLength(0);
  });

  it("should NOT rewrite model refs when agent has agentRuntime.id: claude-cli", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "my-claude-agent",
            agentRuntime: { id: "claude-cli" },
            model: { primary: "claude-cli/claude-sonnet-4-20250514" },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const changes: string[] = [];
    const result = normalizeLegacyRuntimeModelRefs(cfg, changes);

    const agent = (result.agents as any).list[0];
    expect(agent.model.primary).toBe("claude-cli/claude-sonnet-4-20250514");
    expect(changes).toHaveLength(0);
  });

  it("should still rewrite model refs when agent has NO agentRuntime set", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "legacy-agent",
            model: { primary: "codex/gpt-5.5" },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const changes: string[] = [];
    const result = normalizeLegacyRuntimeModelRefs(cfg, changes);

    const agent = (result.agents as any).list[0];
    expect(agent.model.primary).toBe("openai/gpt-5.5");
    expect(agent.agentRuntime.id).toBe("codex");
    expect(changes.length).toBeGreaterThan(0);
  });

  it("should still rewrite when agentRuntime.id is auto", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "auto-agent",
            agentRuntime: { id: "auto" },
            model: { primary: "codex/gpt-5.5" },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const changes: string[] = [];
    const result = normalizeLegacyRuntimeModelRefs(cfg, changes);

    const agent = (result.agents as any).list[0];
    expect(agent.model.primary).toBe("openai/gpt-5.5");
  });
});
