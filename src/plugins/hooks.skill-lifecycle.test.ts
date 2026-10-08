import { describe, expect, it, vi } from "vitest";
import type {
  PluginHookSkillProposalEvaluateEvent,
  PluginHookSkillProposalChangedEvent,
} from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { PluginHookBeforeInstallEvent } from "./types.js";

const ctx = { workspaceDir: "/tmp/openclaw-workspace", agentId: "main" };
const event: PluginHookSkillProposalEvaluateEvent = {
  proposal: { id: "proposal-1", kind: "update", revision: "v2", revisionSha256: "sha256:revision" },
  skill: { name: "Demo", skillKey: "demo", description: "Proposal evaluation" },
  candidate: {
    skillMd: {
      path: "SKILL.md",
      content: "demo",
      encoding: "utf8",
      sha256: "sha256:candidate",
      sizeBytes: 4,
    },
    files: [],
    treeSha256: "sha256:tree",
  },
  reason: "revised",
};

describe("skill lifecycle hooks", () => {
  it("collects every evaluator in priority order with package and registration attribution", async () => {
    const result = {
      summary: "candidate regressed",
      decision: "block" as const,
      decisionReason: "score below baseline",
    };
    const high = vi.fn((observed: PluginHookSkillProposalEvaluateEvent) => {
      expect(observed).not.toBe(event);
      expect(Object.isFrozen(observed)).toBe(true);
      expect(Object.isFrozen(observed.candidate)).toBe(true);
      expect(Object.isFrozen(observed.candidate.skillMd)).toBe(true);
      expect(() => {
        observed.candidate.skillMd.content = "mutated";
      }).toThrow();
      return result;
    });
    const low = vi.fn((observed: PluginHookSkillProposalEvaluateEvent) => {
      expect(observed.candidate.skillMd.content).toBe("demo");
    });
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(...["low", "high"].map((id) => createPluginRecord({ id })));
    registry.typedHooks.push(
      {
        hookName: "skill_proposal_evaluate",
        pluginId: "low",
        source: "test",
        priority: 10,
        handler: low,
      },
      {
        hookName: "skill_proposal_evaluate",
        pluginId: "high",
        source: "test",
        priority: 100,
        registrationId: "regression-score",
        handler: high,
      },
    );
    const plugin = registry.plugins.find((entry) => entry.id === "high")!;
    plugin.packageVersion = "2.1.0";
    plugin.version = "runtime-override";
    await expect(createHookRunner(registry).runSkillProposalEvaluate(event, ctx)).resolves.toEqual([
      {
        evaluatorId: "regression-score",
        pluginId: "high",
        pluginVersion: "2.1.0",
        status: "completed",
        result,
      },
      { evaluatorId: "low", pluginId: "low", status: "skipped" },
    ]);
    expect(high).toHaveBeenCalledOnce();
    expect(low).toHaveBeenCalledOnce();
  });

  it("returns failures and timeouts as sanitized, attributed outcomes", async () => {
    vi.useFakeTimers();
    try {
      const logger = { error: vi.fn(), warn: vi.fn() };
      const registry = createMockPluginRegistry([
        {
          hookName: "skill_proposal_evaluate",
          pluginId: "throws",
          priority: 100,
          handler: () => {
            throw new Error("scanner unavailable\nprivate detail");
          },
        },
        {
          hookName: "skill_proposal_evaluate",
          pluginId: "hangs",
          priority: 50,
          timeoutMs: 1,
          handler: () => new Promise<void>(() => {}),
        },
      ]);
      const run = createHookRunner(registry, { logger }).runSkillProposalEvaluate(event, ctx);
      await vi.advanceTimersByTimeAsync(1);
      await expect(run).resolves.toEqual([
        {
          evaluatorId: "throws",
          pluginId: "throws",
          status: "error",
          error: "scanner unavailable",
        },
        { evaluatorId: "hangs", pluginId: "hangs", status: "error", error: "timed out after 1ms" },
      ]);
      expect(logger.error).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes proposal observations so handlers cannot erase blocking outcomes", async () => {
    const changed: PluginHookSkillProposalChangedEvent = {
      eventId: "event-1",
      sequence: 1,
      action: "evaluation_completed",
      occurredAt: "2026-07-29T00:00:00.000Z",
      proposal: {
        ...event.proposal,
        status: "pending",
        skillName: "Demo",
        skillKey: "demo",
        skillFile: "/workspace/skills/demo/SKILL.md",
      },
      evaluations: [
        {
          evaluatorId: "policy",
          pluginId: "policy-plugin",
          status: "completed",
          result: { decision: "block", decisionReason: "Policy denied the candidate." },
        },
      ],
    };
    const first = vi.fn((observed: PluginHookSkillProposalChangedEvent) => {
      expect(observed).not.toBe(changed);
      expect(Object.isFrozen(observed)).toBe(true);
      expect(Object.isFrozen(observed.evaluations)).toBe(true);
      expect(Object.isFrozen(observed.evaluations?.[0])).toBe(true);
      expect(() => {
        Array.prototype.pop.call(observed.evaluations);
      }).toThrow();
    });
    const second = vi.fn((observed: PluginHookSkillProposalChangedEvent) => {
      expect(observed.evaluations).toEqual(changed.evaluations);
    });
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push(
      ...[first, second].map((handler) => ({
        pluginId: "test",
        hookName: "skill_proposal_changed" as const,
        source: "test",
        handler,
      })),
    );
    await createHookRunner(registry, { catchErrors: false }).runSkillProposalChanged(changed, ctx);
    expect(changed.evaluations).toHaveLength(1);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});

const installEvent: PluginHookBeforeInstallEvent = {
  targetName: "demo-skill",
  targetType: "skill",
  sourcePath: "/tmp/demo-skill",
  sourcePathKind: "directory",
  origin: "openclaw-workspace",
  request: { kind: "skill-install", mode: "install" },
  builtinScan: { status: "ok", scannedFiles: 1, critical: 0, warn: 0, info: 0, findings: [] },
  skill: { installId: "deps" },
};
it("preserves findings in priority order and stops at the first install blocker", async () => {
  const first = {
    ruleId: "first",
    severity: "warn",
    file: "a.ts",
    line: 1,
    message: "first finding",
  } as const;
  const blocked = {
    ruleId: "blocker",
    severity: "critical",
    file: "block.ts",
    line: 3,
    message: "blocked finding",
  } as const;
  const skipped = vi.fn(() => ({ findings: [first] }));
  const runner = createHookRunner(
    createMockPluginRegistry([
      { hookName: "before_install", priority: 0, handler: skipped },
      {
        hookName: "before_install",
        priority: 50,
        handler: () => ({ findings: [blocked], block: true, blockReason: "policy blocked" }),
      },
      { hookName: "before_install", priority: 100, handler: () => ({ findings: [first] }) },
    ]),
  );
  await expect(
    runner.runBeforeInstall(installEvent, {
      origin: "openclaw-workspace",
      targetType: "skill",
      requestKind: "skill-install",
    }),
  ).resolves.toEqual({ findings: [first, blocked], block: true, blockReason: "policy blocked" });
  expect(skipped).not.toHaveBeenCalled();
});
