// System prompt config tests cover config-to-prompt parameter resolution through
// the canonical agent prompt facade.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as ttsSettings from "../tts/tts-settings.js";
import { buildConfiguredAgentSystemPrompt } from "./system-prompt-config.js";
import * as systemPrompt from "./system-prompt.js";

vi.mock("../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

function buildPrompt(config: OpenClawConfig, agentId = "main", sessionKey?: string): string {
  return buildConfiguredAgentSystemPrompt({
    config,
    agentId,
    workspaceDir: "/tmp/openclaw",
    toolNames: ["sessions_spawn", "subagents"],
    runtimeInfo: { sessionKey },
  });
}

describe("buildConfiguredAgentSystemPrompt", () => {
  it.each(["minimal", "none"] as const)(
    "skips full-only preparation in %s mode and refreshes the next full prompt",
    (promptMode) => {
      const hint = vi
        .spyOn(ttsSettings, "buildTtsSystemPromptHint")
        .mockReturnValue("Fixture first voice guidance.");
      const models = { "fixture/model": { alias: "Before" } };
      const params = {
        config: { agents: { defaults: { models } } },
        workspaceDir: "/tmp/openclaw",
        includeMemorySection: false,
      };
      try {
        const full = buildConfiguredAgentSystemPrompt(params);
        expect(full).toContain("- Before: fixture/model");
        expect(full).toContain("Fixture first voice guidance.");
        hint.mockClear();
        const reduced = buildConfiguredAgentSystemPrompt({ ...params, promptMode });
        expect(hint).not.toHaveBeenCalled();
        expect(reduced).not.toContain("## Model Aliases");
        expect(reduced).not.toContain("## Voice (TTS)");
        expect(buildConfiguredAgentSystemPrompt(params)).toBe(full);

        models["fixture/model"].alias = "After";
        hint.mockReturnValue("Fixture current voice guidance.");
        hint.mockClear();
        expect(buildConfiguredAgentSystemPrompt({ ...params, promptMode })).toBe(reduced);
        expect(hint).not.toHaveBeenCalled();
        const refreshed = buildConfiguredAgentSystemPrompt(params);
        expect(refreshed).toContain("- After: fixture/model");
        expect(refreshed).not.toContain("- Before: fixture/model");
        expect(refreshed).toContain("Fixture current voice guidance.");
        expect(refreshed).not.toContain("Fixture first voice guidance.");
      } finally {
        hint.mockRestore();
      }
    },
  );

  it.each([
    { name: "absent", config: undefined },
    { name: "empty", config: {} },
    {
      name: "retired hash",
      config: {
        commands: { ownerDisplay: "hash", ownerDisplaySecret: "retired-secret" },
      } as OpenClawConfig,
    },
    {
      name: "retired raw",
      config: {
        commands: { ownerDisplay: "raw", ownerDisplaySecret: "retired-secret" },
      } as OpenClawConfig,
    },
  ])("preserves owner display semantics with $name config", ({ config }) => {
    const render = vi.spyOn(systemPrompt, "buildAgentSystemPrompt");
    try {
      const prompt = buildConfiguredAgentSystemPrompt({
        config,
        workspaceDir: "/tmp/openclaw",
        ownerNumbers: ["owner-a"],
        ownerDisplay: "hash",
        ownerDisplaySecret: "caller-secret", // pragma: allowlist secret
      });

      expect(render).toHaveBeenCalledTimes(1);
      const renderParams = render.mock.calls[0]?.[0];
      expect(Object.hasOwn(renderParams ?? {}, "ownerDisplay")).toBe(true);
      expect(Object.hasOwn(renderParams ?? {}, "ownerDisplaySecret")).toBe(true);
      expect(renderParams?.ownerDisplay).toBe(config ? "raw" : "hash");
      expect(renderParams?.ownerDisplaySecret).toBe(config ? undefined : "caller-secret");
      expect(prompt).toMatch(
        config
          ? /Allowlisted senders: owner-a\. Allowlisted != owner\./
          : /Allowlisted senders: [a-f0-9]{12}\. Allowlisted != owner\./,
      );
    } finally {
      render.mockRestore();
    }
  });

  it.each([
    {
      name: "prefers delegation in the canonical main session",
      config: {} satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      expected: true,
    },
    {
      name: "suggests delegation outside the canonical main session",
      config: {} satisfies OpenClawConfig,
      sessionKey: "agent:main:slack:channel:C01234567",
      expected: false,
    },
    {
      name: "recognizes a custom canonical main key",
      config: { session: { mainKey: "inbox" } } satisfies OpenClawConfig,
      sessionKey: "agent:main:inbox",
      expected: true,
    },
    {
      name: "recognizes the global-scope canonical main key",
      config: { session: { scope: "global" } } satisfies OpenClawConfig,
      sessionKey: "global",
      expected: true,
    },
    {
      name: "suggests delegation without a render session key",
      config: {} satisfies OpenClawConfig,
      sessionKey: undefined,
      expected: false,
    },
    {
      name: "honors explicit prefer outside the canonical main session",
      config: {
        agents: { defaults: { subagents: { delegationMode: "prefer" } } },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:dashboard:project",
      expected: true,
    },
    {
      name: "honors explicit suggest in the canonical main session",
      config: {
        agents: { defaults: { subagents: { delegationMode: "suggest" } } },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      expected: false,
    },
  ])("$name", ({ config, sessionKey, expected }) => {
    const prompt = buildPrompt(config, "main", sessionKey);
    expect(prompt.includes("## Delegation")).toBe(expected);
    expect(prompt.includes("- Subagents: `sessions_spawn`")).toBe(!expected);
  });

  it("inherits default sub-agent delegation mode", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "prefer",
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(buildPrompt(config)).toContain("## Delegation");
  });

  it("lets per-agent sub-agent delegation mode override defaults", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "suggest",
          },
        },
        list: [
          {
            id: "coordinator",
            subagents: {
              delegationMode: "prefer",
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(buildPrompt(config, "coordinator")).toContain("## Delegation");
  });

  it("applies config-backed prompt parameters through the canonical facade", () => {
    const prompt = buildConfiguredAgentSystemPrompt({
      config: {
        agents: {
          defaults: {
            subagents: {
              delegationMode: "prefer",
            },
          },
        },
      },
      agentId: "main",
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents"],
    });

    expect(prompt).toContain("## Delegation");
  });
});
