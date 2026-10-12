import { describe, expect, it, vi } from "vitest";
import type { SkillStatusReport } from "../../api/types.ts";
import {
  createRuntimeConfigCapability,
  type RuntimeConfigCapability,
} from "../../lib/config/runtime-config-capability.ts";
import { createSkill } from "../skills/view.test-support.ts";
import { clearAgentSkillFilter, createAgentSkillActions } from "./skills.ts";

describe("createAgentSkillActions", () => {
  it("snapshots reported skills without learned Workshop skills on the first toggle", () => {
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [
        createSkill({ name: "github", source: "openclaw-bundled" }),
        createSkill({ name: "weather", source: "openclaw-managed" }),
        createSkill({ name: "actual-budget-operations", source: "openclaw-workshop" }),
      ],
    };
    const runtimeConfig = createRuntimeConfigCapability({
      snapshot: { client: null, phase: "offline", sessionKey: "main" },
      subscribe: () => () => undefined,
    });

    try {
      const actions = createAgentSkillActions({
        getRuntimeConfig: () => runtimeConfig,
        getReport: () => report,
        canUpdate: () => true,
      });
      actions.onToggle("main", "weather", false);

      expect(runtimeConfig.state.configForm).toEqual({
        agents: { entries: { main: { skills: ["github"] } } },
      });
    } finally {
      runtimeConfig.dispose();
    }
  });
});

describe("clearAgentSkillFilter", () => {
  it("deletes the authored allowlist through an explicit config patch", async () => {
    const patch = vi.fn(async () => true);
    const runtimeConfig = {
      agentEntry: vi.fn(() => ({
        path: ["agents", "entries", "Research"],
        entry: { skills: ["coding-agent"] },
      })),
      patch,
    } as unknown as RuntimeConfigCapability;

    await expect(clearAgentSkillFilter(runtimeConfig, "research")).resolves.toBe(true);

    expect(patch).toHaveBeenCalledWith({
      raw: {
        agents: {
          entries: {
            Research: { skills: null },
          },
        },
      },
      note: "Reset agent skills to inherited defaults",
      replacePaths: ["agents.entries.Research.skills"],
      canDispatch: expect.any(Function),
    });
  });

  it("does not queue a patch after its caller becomes stale", async () => {
    const patch = vi.fn(async () => true);
    const runtimeConfig = {
      agentEntry: vi.fn(() => ({
        path: ["agents", "entries", "main"],
        entry: { skills: ["coding-agent"] },
      })),
      patch,
    } as unknown as RuntimeConfigCapability;

    await expect(clearAgentSkillFilter(runtimeConfig, "main", () => false)).resolves.toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });
});
