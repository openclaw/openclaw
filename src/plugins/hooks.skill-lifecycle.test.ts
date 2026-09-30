import { describe, expect, it, vi } from "vitest";
import type { PluginHookSkillChangedEvent, PluginHookSkillContext } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

const ctx: PluginHookSkillContext = {
  workspaceDir: "/tmp/openclaw-workspace",
  agentId: "main",
};

describe("skill lifecycle hooks", () => {
  it("dispatches committed skill changes as observation hooks", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const registry = createMockPluginRegistry([
      { hookName: "skill_changed", pluginId: "first", handler: first },
      { hookName: "skill_changed", pluginId: "second", handler: second },
    ]);
    const event: PluginHookSkillChangedEvent = {
      action: "removed",
      source: "clawhub",
      occurredAt: "2026-07-29T00:00:00.000Z",
      before: {
        name: "Demo Skill",
        skillKey: "demo-skill",
        skillFile: "/workspace/skills/demo-skill/SKILL.md",
        skillDir: "/workspace/skills/demo-skill",
        source: "clawhub",
        revision: {
          contentSha256: "sha256:content",
          treeSha256: "sha256:tree",
          sourceVersion: "1.2.3",
        },
      },
    };

    await createHookRunner(registry).runSkillChanged(event, ctx);

    const observed = first.mock.calls[0]?.[0] as PluginHookSkillChangedEvent;
    expect(observed).not.toBe(event);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.before)).toBe(true);
    expect(first).toHaveBeenCalledWith(observed, ctx);
    expect(second).toHaveBeenCalledWith(observed, ctx);
  });
});
