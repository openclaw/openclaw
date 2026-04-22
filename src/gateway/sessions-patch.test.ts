import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { ErrorCodes } from "./protocol/index.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

const SUBAGENT_MODEL = "synthetic/hf:moonshotai/Kimi-K2.5";
const KIMI_SUBAGENT_KEY = "agent:kimi:subagent:child";
const MAIN_SESSION_KEY = "agent:main:main";
const EMPTY_CFG = {} as OpenClawConfig;

type ApplySessionsPatchArgs = Parameters<typeof applySessionsPatchToStore>[0];

async function runPatch(params: {
  patch: ApplySessionsPatchArgs["patch"];
  store?: Record<string, SessionEntry>;
  cfg?: OpenClawConfig;
  storeKey?: string;
  loadGatewayModelCatalog?: ApplySessionsPatchArgs["loadGatewayModelCatalog"];
}) {
  return applySessionsPatchToStore({
    cfg: params.cfg ?? EMPTY_CFG,
    store: params.store ?? {},
    storeKey: params.storeKey ?? MAIN_SESSION_KEY,
    patch: params.patch,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
  });
}

function expectPatchOk(
  result: Awaited<ReturnType<typeof applySessionsPatchToStore>>,
): SessionEntry {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.entry;
}

function expectPatchError(
  result: Awaited<ReturnType<typeof applySessionsPatchToStore>>,
  message: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected patch failure containing: ${message}`);
  }
  expect(result.error.message).toContain(message);
}

async function applySubagentModelPatch(cfg: OpenClawConfig) {
  return expectPatchOk(
    await runPatch({
      cfg,
      storeKey: KIMI_SUBAGENT_KEY,
      patch: {
        key: KIMI_SUBAGENT_KEY,
        model: SUBAGENT_MODEL,
      },
      loadGatewayModelCatalog: async () => [
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "sonnet" },
        { provider: "synthetic", id: "hf:moonshotai/Kimi-K2.5", name: "kimi" },
      ],
    }),
  );
}

function makeKimiSubagentCfg(params: {
  agentPrimaryModel?: string;
  agentSubagentModel?: string;
  defaultsSubagentModel?: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6" },
        subagents: params.defaultsSubagentModel
          ? { model: params.defaultsSubagentModel }
          : undefined,
        models: {
          "anthropic/claude-sonnet-4-6": { alias: "default" },
        },
      },
      list: [
        {
          id: "kimi",
          model: params.agentPrimaryModel ? { primary: params.agentPrimaryModel } : undefined,
          subagents: params.agentSubagentModel ? { model: params.agentSubagentModel } : undefined,
        },
      ],
    },
  } as OpenClawConfig;
}

function createAllowlistedAnthropicModelCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4" },
        models: {
          "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
        },
      },
    },
  } as OpenClawConfig;
}

describe("gateway sessions patch", () => {
  test("persists thinkingLevel=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, thinkingLevel: "off" },
      }),
    );
    expect(entry.thinkingLevel).toBe("off");
  });

  test("clears thinkingLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { thinkingLevel: "low" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, thinkingLevel: null },
      }),
    );
    expect(entry.thinkingLevel).toBeUndefined();
  });

  test("persists reasoningLevel=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, reasoningLevel: "off" },
      }),
    );
    expect(entry.reasoningLevel).toBe("off");
  });

  test("clears reasoningLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { reasoningLevel: "stream" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, reasoningLevel: null },
      }),
    );
    expect(entry.reasoningLevel).toBeUndefined();
  });

  test("persists fastMode=false (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, fastMode: false },
      }),
    );
    expect(entry.fastMode).toBe(false);
  });

  test("persists fastMode=true", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, fastMode: true },
      }),
    );
    expect(entry.fastMode).toBe(true);
  });

  test("clears fastMode when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { fastMode: true } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, fastMode: null },
      }),
    );
    expect(entry.fastMode).toBeUndefined();
  });

  test("persists elevatedLevel=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, elevatedLevel: "off" },
      }),
    );
    expect(entry.elevatedLevel).toBe("off");
  });

  test("persists elevatedLevel=on", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, elevatedLevel: "on" },
      }),
    );
    expect(entry.elevatedLevel).toBe("on");
  });

  test("clears elevatedLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { elevatedLevel: "off" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, elevatedLevel: null },
      }),
    );
    expect(entry.elevatedLevel).toBeUndefined();
  });

  test("rejects invalid elevatedLevel values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, elevatedLevel: "maybe" },
    });
    expectPatchError(result, "invalid elevatedLevel");
  });

  test("clears auth overrides when model patch changes", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess",
        updatedAt: 1,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
        authProfileOverride: "anthropic:default",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 3,
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, model: "anthropic/claude-sonnet-4-6" },
        loadGatewayModelCatalog: async () => [
          { provider: "anthropic", id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
        ],
      }),
    );
    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
    expect(entry.authProfileOverride).toBeUndefined();
    expect(entry.authProfileOverrideSource).toBeUndefined();
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  test("marks explicit model patches as pending live model switches", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        sessionId: "sess-live",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        cfg: createAllowlistedAnthropicModelCfg(),
        patch: { key: MAIN_SESSION_KEY, model: "anthropic/claude-sonnet-4-6" },
        loadGatewayModelCatalog: async () => [
          { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
          { provider: "anthropic", id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
        ],
      }),
    );

    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
    expect(entry.liveModelSwitchPending).toBe(true);
  });

  test("marks model reset patches as pending live model switches", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        sessionId: "sess-live-reset",
        updatedAt: 1,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        cfg: createAllowlistedAnthropicModelCfg(),
        patch: { key: MAIN_SESSION_KEY, model: null },
      }),
    );

    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.liveModelSwitchPending).toBe(true);
  });

  test.each([
    {
      name: "accepts explicit allowlisted provider/model refs from sessions.patch",
      catalog: [
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.5" },
      ],
    },
    {
      name: "accepts explicit allowlisted refs absent from bundled catalog",
      catalog: [
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.5" },
        { provider: "openai", id: "gpt-5.4", name: "GPT-5.2" },
      ],
    },
  ])("$name", async ({ catalog }) => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: createAllowlistedAnthropicModelCfg(),
        patch: { key: MAIN_SESSION_KEY, model: "anthropic/claude-sonnet-4-6" },
        loadGatewayModelCatalog: async () => catalog,
      }),
    );
    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
  });

  test("sets spawnDepth for subagent sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:subagent:child",
        patch: { key: "agent:main:subagent:child", spawnDepth: 2 },
      }),
    );
    expect(entry.spawnDepth).toBe(2);
  });

  test("sets spawnedBy for ACP sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:acp:child",
        patch: {
          key: "agent:main:acp:child",
          spawnedBy: "agent:main:main",
        },
      }),
    );
    expect(entry.spawnedBy).toBe("agent:main:main");
  });

  test("sets spawnedWorkspaceDir for subagent sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:subagent:child",
        patch: {
          key: "agent:main:subagent:child",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
        },
      }),
    );
    expect(entry.spawnedWorkspaceDir).toBe("/tmp/subagent-workspace");
  });

  test("sets spawnDepth for ACP sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:acp:child",
        patch: { key: "agent:main:acp:child", spawnDepth: 2 },
      }),
    );
    expect(entry.spawnDepth).toBe(2);
  });

  test("rejects spawnDepth on non-subagent sessions", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, spawnDepth: 1 },
    });
    expectPatchError(result, "spawnDepth is only supported");
  });

  test("rejects spawnedWorkspaceDir on non-subagent sessions", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, spawnedWorkspaceDir: "/tmp/nope" },
    });
    expectPatchError(result, "spawnedWorkspaceDir is only supported");
  });

  test("normalizes exec/send/group patches", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: {
          key: MAIN_SESSION_KEY,
          execHost: " AUTO ",
          execSecurity: " ALLOWLIST ",
          execAsk: " ON-MISS ",
          execNode: " worker-1 ",
          sendPolicy: "DENY" as unknown as "allow",
          groupActivation: "Always" as unknown as "mention",
        },
      }),
    );
    expect(entry.execHost).toBe("auto");
    expect(entry.execSecurity).toBe("allowlist");
    expect(entry.execAsk).toBe("on-miss");
    expect(entry.execNode).toBe("worker-1");
    expect(entry.sendPolicy).toBe("deny");
    expect(entry.groupActivation).toBe("always");
  });

  test("rejects invalid execHost values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, execHost: "edge" },
    });
    expectPatchError(result, "invalid execHost");
  });

  test("rejects invalid sendPolicy values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, sendPolicy: "ask" as unknown as "allow" },
    });
    expectPatchError(result, "invalid sendPolicy");
  });

  test("rejects invalid groupActivation values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, groupActivation: "never" as unknown as "mention" },
    });
    expectPatchError(result, "invalid groupActivation");
  });

  test("allows target agent own model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      agentPrimaryModel: "synthetic/hf:moonshotai/Kimi-K2.5",
    });

    const entry = await applySubagentModelPatch(cfg);
    // Selected model matches the target agent default, so no override is stored.
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
  });

  test("allows target agent subagents.model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      agentPrimaryModel: "anthropic/claude-sonnet-4-6",
      agentSubagentModel: SUBAGENT_MODEL,
    });

    const entry = await applySubagentModelPatch(cfg);
    expect(entry.providerOverride).toBe("synthetic");
    expect(entry.modelOverride).toBe("hf:moonshotai/Kimi-K2.5");
  });

  test("allows global defaults.subagents.model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      defaultsSubagentModel: SUBAGENT_MODEL,
    });

    const entry = await applySubagentModelPatch(cfg);
    expect(entry.providerOverride).toBe("synthetic");
    expect(entry.modelOverride).toBe("hf:moonshotai/Kimi-K2.5");
  });
});

describe("PR-10 plan auto-mode patch routing", () => {
  // All paths require the planMode feature gate to be on.
  function planModeEnabledCfg(): OpenClawConfig {
    return {
      agents: { defaults: { planMode: { enabled: true } } },
    } as unknown as OpenClawConfig;
  }

  test("rejects planApproval action='auto' when feature gate is OFF", async () => {
    const result = await runPatch({
      patch: {
        key: MAIN_SESSION_KEY,
        planApproval: { action: "auto", autoEnabled: true },
      },
      // EMPTY_CFG → planMode.enabled !== true.
    });
    expectPatchError(result, "plan mode is disabled");
  });

  test("rejects action='auto' patches missing autoEnabled (deep-dive validation)", async () => {
    // Pre-fix: a patch with `action: "auto"` and no `autoEnabled` was
    // silently coerced to `false` and disabled auto-approve. Post-fix:
    // the handler returns an explicit validation error so the caller
    // can correct the malformed patch instead of debugging a phantom
    // toggle-off.
    const result = await runPatch({
      cfg: planModeEnabledCfg(),
      patch: {
        key: MAIN_SESSION_KEY,
        planApproval: { action: "auto" } as unknown as never,
      },
    });
    expectPatchError(result, "autoEnabled");
  });

  test("toggles autoApprove ON when no planMode entry exists yet (pre-arms)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: planModeEnabledCfg(),
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval: { action: "auto", autoEnabled: true },
        },
      }),
    );
    // Pre-arming: planMode entry materialized as mode:"normal" with the
    // flag set, so the next enter_plan_mode preserves it.
    expect(entry.planMode?.mode).toBe("normal");
    expect(entry.planMode?.autoApprove).toBe(true);
  });

  test("toggles autoApprove ON when an active plan-mode session exists", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        planMode: {
          mode: "plan",
          approval: "none",
          rejectionCount: 0,
          updatedAt: 1,
        },
      } as unknown as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        cfg: planModeEnabledCfg(),
        store,
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval: { action: "auto", autoEnabled: true },
        },
      }),
    );
    expect(entry.planMode?.mode).toBe("plan"); // unchanged
    expect(entry.planMode?.autoApprove).toBe(true);
  });

  test("toggles autoApprove OFF without disturbing an active plan-mode session", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        planMode: {
          mode: "plan",
          approval: "pending",
          approvalId: "abc",
          rejectionCount: 0,
          updatedAt: 1,
          autoApprove: true,
        },
      } as unknown as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        cfg: planModeEnabledCfg(),
        store,
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval: { action: "auto", autoEnabled: false },
        },
      }),
    );
    expect(entry.planMode?.mode).toBe("plan");
    expect(entry.planMode?.approval).toBe("pending");
    expect(entry.planMode?.approvalId).toBe("abc");
    expect(entry.planMode?.autoApprove).toBe(false);
  });

  test("preserves autoApprove across approve transition (mode → normal)", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        planMode: {
          mode: "plan",
          approval: "pending",
          approvalId: "abc",
          rejectionCount: 0,
          updatedAt: 1,
          autoApprove: true,
        },
      } as unknown as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        cfg: planModeEnabledCfg(),
        store,
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval: { action: "approve", approvalId: "abc" },
        },
      }),
    );
    // Approve transitions mode → normal; the autoApprove flag must survive
    // so the NEXT enter_plan_mode in the same session also auto-approves.
    expect(entry.planMode?.mode).toBe("normal");
    expect(entry.planMode?.autoApprove).toBe(true);
  });

  test("PR-12 Bug A1: nudgeJobIds dropped from carry-forward planMode entry on approve+autoApprove (was leaked before)", async () => {
    // Prior bug: every approve/reject/edit cycle left scheduled
    // nudge crons orphaned because the planApproval branch only
    // deleted/rewrote `planMode` without calling cleanupPlanNudges
    // first. Fix: capture the ids BEFORE the rewrite, and the carry-
    // forward entry must NOT include them — they were just cancelled
    // and the next enter_plan_mode schedules fresh ones.
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        planMode: {
          mode: "plan",
          approval: "pending",
          approvalId: "leak-test",
          rejectionCount: 0,
          updatedAt: 1,
          autoApprove: true,
          nudgeJobIds: ["plan-nudge:10min:foo", "plan-nudge:30min:foo", "plan-nudge:60min:foo"],
        },
      } as unknown as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        cfg: planModeEnabledCfg(),
        store,
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval: { action: "approve", approvalId: "leak-test" },
        },
      }),
    );
    expect(entry.planMode?.mode).toBe("normal");
    expect(entry.planMode?.autoApprove).toBe(true);
    expect(entry.planMode?.nudgeJobIds).toBeUndefined();
  });

  test("clears planMode entry on approve when autoApprove is unset", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        planMode: {
          mode: "plan",
          approval: "pending",
          approvalId: "abc",
          rejectionCount: 0,
          updatedAt: 1,
        },
      } as unknown as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        cfg: planModeEnabledCfg(),
        store,
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval: { action: "approve", approvalId: "abc" },
        },
      }),
    );
    // No autoApprove flag → planMode is cleared entirely (matches the
    // pre-PR-10 behavior).
    expect(entry.planMode).toBeUndefined();
  });

  test("rejects answer action without an answer string", async () => {
    const result = await runPatch({
      cfg: planModeEnabledCfg(),
      patch: {
        key: MAIN_SESSION_KEY,
        planApproval: { action: "answer", answer: "" } as unknown as never,
      },
    });
    expectPatchError(result, "answer");
  });

  test("Bug B (C1 follow-up): approve/edit/reject on a session with no planMode returns PLAN_APPROVAL_EXPIRED", async () => {
    // Covers the stale-card case where the session has already
    // exited plan mode by any route (/plan off, another channel
    // resolved it, approval timeout, or state lost to compaction).
    // The UI branches on this code to auto-dismiss the card instead
    // of leaving the user stuck with a "nothing happened" click.
    const cases: Array<ApplySessionsPatchArgs["patch"]["planApproval"]> = [
      { action: "approve", approvalId: "stale-id" },
      { action: "edit", approvalId: "stale-id" },
      { action: "reject", approvalId: "stale-id", feedback: "n/a" },
    ];
    for (const planApproval of cases) {
      const result = await runPatch({
        cfg: planModeEnabledCfg(),
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval,
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected failure");
      }
      expect(result.error.code).toBe(ErrorCodes.PLAN_APPROVAL_EXPIRED);
      expect(result.error.message).toContain("active plan-mode session");
    }
  });

  test("M3 fix: pre-arming `/plan auto on` then `/plan on` carries autoApprove forward", async () => {
    // Step 1: user runs /plan auto on while not in plan mode. Server
    // materializes a `mode: "normal"` placeholder with autoApprove=true.
    const armed = expectPatchOk(
      await runPatch({
        cfg: planModeEnabledCfg(),
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval: { action: "auto", autoEnabled: true },
        },
      }),
    );
    expect(armed.planMode?.mode).toBe("normal");
    expect(armed.planMode?.autoApprove).toBe(true);

    // Step 2: user runs /plan on. Without the M3 fix this branch
    // creates a fresh planMode entry that drops autoApprove. WITH the
    // fix, the existing autoApprove flag is carried forward into the
    // new plan-mode entry so the very first plan submission auto-
    // approves as the user expects.
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: armed,
    };
    const planned = expectPatchOk(
      await runPatch({
        cfg: planModeEnabledCfg(),
        store,
        patch: { key: MAIN_SESSION_KEY, planMode: "plan" },
      }),
    );
    expect(planned.planMode?.mode).toBe("plan");
    expect(planned.planMode?.approval).toBe("none");
    expect(planned.planMode?.autoApprove).toBe(true);
  });

  test("M3: /plan on without prior pre-arm does NOT add autoApprove", async () => {
    // Sanity check: the carry-forward only fires when the prior entry
    // had autoApprove=true. A bare /plan on starts with autoApprove
    // unset (never entered the truthy branch).
    const planned = expectPatchOk(
      await runPatch({
        cfg: planModeEnabledCfg(),
        patch: { key: MAIN_SESSION_KEY, planMode: "plan" },
      }),
    );
    expect(planned.planMode?.mode).toBe("plan");
    expect(planned.planMode?.autoApprove).toBeUndefined();
  });

  test("fresh /plan on clears stale approval grace and pending interaction", async () => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: planModeEnabledCfg(),
        store: {
          [MAIN_SESSION_KEY]: {
            sessionId: "sess-1",
            updatedAt: 1,
            recentlyApprovedAt: Date.now(),
            recentlyApprovedCycleId: "old-cycle",
            pendingInteraction: {
              kind: "plan",
              approvalId: "old-approval",
              title: "Old plan",
              createdAt: 1,
              status: "pending",
              cycleId: "old-cycle",
            },
          } as SessionEntry,
        },
        patch: { key: MAIN_SESSION_KEY, planMode: "plan" },
      }),
    );
    expect(entry.planMode?.mode).toBe("plan");
    expect(entry.planMode?.cycleId).toBeTruthy();
    expect(entry.recentlyApprovedAt).toBeUndefined();
    expect(entry.recentlyApprovedCycleId).toBeUndefined();
    expect(entry.pendingInteraction).toBeUndefined();
  });

  test("accepts answer action with matching pendingInteraction ids", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        planMode: {
          mode: "plan",
          approval: "none",
          rejectionCount: 0,
          cycleId: "cycle-1",
          updatedAt: 1,
        },
        pendingInteraction: {
          kind: "question",
          approvalId: "q-toolcall-123",
          questionId: "q-123",
          title: "Agent has a question",
          prompt: "Pick one",
          options: ["Option A", "Option B"],
          allowFreetext: false,
          createdAt: 1,
          status: "pending",
          cycleId: "cycle-1",
        },
      } as unknown as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        cfg: planModeEnabledCfg(),
        store,
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval: {
            action: "answer",
            answer: "Option A",
            approvalId: "q-toolcall-123",
            questionId: "q-123",
          },
        },
      }),
    );
    // No planMode state change — the runtime injects [QUESTION_ANSWER]
    // separately via pendingAgentInjections (asserted below).
    expect(entry.planMode?.mode).toBe("plan");
    expect(entry.planMode?.approval).toBe("none");
    // Nuclear-fix-stack integration (cherry-pick of 11d72adf9b): the
    // answer branch now enqueues into the typed
    // `pendingAgentInjections` queue (with id-dedup via
    // `appendToInjectionQueue`) instead of writing the legacy scalar
    // `pendingAgentInjection`. Assert the queue entry has the right
    // shape: kind=question_answer, approvalId matches, text carries
    // the [QUESTION_ANSWER]: marker.
    const queue = entry.pendingAgentInjections ?? [];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      kind: "question_answer",
      approvalId: "q-toolcall-123",
      id: "question-answer-q-toolcall-123",
      text: "[QUESTION_ANSWER]: Option A",
    });
    expect(entry.pendingInteraction).toBeUndefined();
    expect(entry.pendingQuestionApprovalId).toBeUndefined();
    expect(entry.pendingQuestionOptions).toBeUndefined();
    expect(entry.pendingQuestionAllowFreetext).toBeUndefined();
  });

  test("rejects answer action with questionId mismatch", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        planMode: {
          mode: "plan",
          approval: "none",
          rejectionCount: 0,
          cycleId: "cycle-1",
          updatedAt: 1,
        },
        pendingInteraction: {
          kind: "question",
          approvalId: "q-toolcall-123",
          questionId: "q-123",
          title: "Agent has a question",
          prompt: "Pick one",
          options: ["Option A", "Option B"],
          allowFreetext: false,
          createdAt: 1,
          status: "pending",
          cycleId: "cycle-1",
        },
      } as unknown as SessionEntry,
    };
    const result = await runPatch({
      cfg: planModeEnabledCfg(),
      store,
      patch: {
        key: MAIN_SESSION_KEY,
        planApproval: {
          action: "answer",
          answer: "Option A",
          approvalId: "q-toolcall-123",
          questionId: "q-stale",
        },
      },
    });
    expectPatchError(result, "questionId mismatch");
  });

  test("rejects answer action with no pending question (Codex P1 review #68939)", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        planMode: {
          mode: "plan",
          approval: "none",
          rejectionCount: 0,
          updatedAt: 1,
        },
        // pendingQuestionApprovalId is intentionally absent.
      } as unknown as SessionEntry,
    };
    const result = await runPatch({
      cfg: planModeEnabledCfg(),
      store,
      patch: {
        key: MAIN_SESSION_KEY,
        planApproval: { action: "answer", answer: "Option A", approvalId: "q-stale-456" },
      },
    });
    expectPatchError(result, "no pending ask_user_question");
  });

  test("rejects answer action with approvalId mismatch (Codex P1 review #68939)", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        planMode: {
          mode: "plan",
          approval: "none",
          rejectionCount: 0,
          updatedAt: 1,
        },
        pendingQuestionApprovalId: "q-current-789",
      } as unknown as SessionEntry,
    };
    const result = await runPatch({
      cfg: planModeEnabledCfg(),
      store,
      patch: {
        key: MAIN_SESSION_KEY,
        planApproval: { action: "answer", answer: "Option A", approvalId: "q-stale-456" },
      },
    });
    expectPatchError(result, "approvalId mismatch");
  });

  // R5 (C1 follow-up): multi-channel approval dedup.
  // The gateway applies a sessions.patch serially against the
  // SessionEntry store, so "concurrent" webchat + Telegram writes
  // degrade to back-to-back serial writes. The second write sees
  // the post-first-write state and MUST reject with
  // PLAN_APPROVAL_EXPIRED so operators don't end up with two
  // synthetic [PLAN_DECISION] injections landing on the agent's
  // next turn. This pins the serialization contract.
  describe("R5: multi-channel approval dedup (C1 follow-up)", () => {
    const APPROVAL_ID = "plan-approval-multi-channel";

    function makePendingStore(): Record<string, SessionEntry> {
      return {
        [MAIN_SESSION_KEY]: {
          planMode: {
            mode: "plan",
            approval: "pending",
            approvalId: APPROVAL_ID,
            rejectionCount: 0,
            updatedAt: 1,
          },
        } as unknown as SessionEntry,
      };
    }

    test("two approve writes from different channels: first wins, second returns PLAN_APPROVAL_EXPIRED", async () => {
      const store = makePendingStore();
      // Webchat approve lands first.
      const webResult = await runPatch({
        cfg: planModeEnabledCfg(),
        store,
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval: { action: "approve", approvalId: APPROVAL_ID },
        },
      });
      const webEntry = expectPatchOk(webResult);
      // Approve transitions planMode → normal, clears the pending
      // approvalId. Without autoApprove the entry is gone entirely.
      expect(webEntry.planMode).toBeUndefined();

      // Now simulate Telegram's /plan accept arriving a few ms
      // later against the mutated store. No planMode state → must
      // error with PLAN_APPROVAL_EXPIRED (Bug B code).
      const telegramResult = await runPatch({
        cfg: planModeEnabledCfg(),
        store,
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval: { action: "approve", approvalId: APPROVAL_ID },
        },
      });
      expect(telegramResult.ok).toBe(false);
      if (telegramResult.ok) {
        throw new Error("expected failure on second approve");
      }
      expect(telegramResult.error.code).toBe(ErrorCodes.PLAN_APPROVAL_EXPIRED);
    });

    test("approve (web) then reject (telegram) on same approvalId: reject also rejected (not double-applied)", async () => {
      const store = makePendingStore();
      expectPatchOk(
        await runPatch({
          cfg: planModeEnabledCfg(),
          store,
          patch: {
            key: MAIN_SESSION_KEY,
            planApproval: { action: "approve", approvalId: APPROVAL_ID },
          },
        }),
      );
      const secondResult = await runPatch({
        cfg: planModeEnabledCfg(),
        store,
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval: { action: "reject", approvalId: APPROVAL_ID, feedback: "no" },
        },
      });
      expect(secondResult.ok).toBe(false);
      if (secondResult.ok) {
        throw new Error("expected failure on reject-after-approve");
      }
      expect(secondResult.error.code).toBe(ErrorCodes.PLAN_APPROVAL_EXPIRED);
    });

    test("two writes with different approvalIds against same pending approval: first matches, second stale-id rejected", async () => {
      // Ensures the stale-approvalId branch (resolvePlanApproval
      // no-op) is still the right fail mode when the second write
      // is issued against a pending state that has already moved
      // to a NEW approvalId. Differentiates "session expired" from
      // "your approvalId was left behind by a newer plan cycle".
      const store: Record<string, SessionEntry> = {
        [MAIN_SESSION_KEY]: {
          planMode: {
            mode: "plan",
            approval: "pending",
            approvalId: "current-approval-v2",
            rejectionCount: 0,
            updatedAt: 1,
            autoApprove: true, // keep the session in plan mode for the 2nd write
          },
        } as unknown as SessionEntry,
      };
      // First write against the CURRENT approvalId — succeeds.
      expectPatchOk(
        await runPatch({
          cfg: planModeEnabledCfg(),
          store,
          patch: {
            key: MAIN_SESSION_KEY,
            planApproval: { action: "approve", approvalId: "current-approval-v2" },
          },
        }),
      );
      // Second write using a STALE approvalId from a prior cycle
      // (symbolically from a slow Telegram delivery). planMode is
      // now normal (autoApprove carried forward), so the second
      // write hits "requires a pending approval".
      const staleResult = await runPatch({
        cfg: planModeEnabledCfg(),
        store,
        patch: {
          key: MAIN_SESSION_KEY,
          planApproval: { action: "approve", approvalId: "older-stale-v1" },
        },
      });
      expect(staleResult.ok).toBe(false);
      if (staleResult.ok) {
        throw new Error("expected failure on stale-approvalId");
      }
      // Pending-check fires because planMode still exists (auto carries
      // forward) but approval is no longer "pending".
      expect(staleResult.error.message).toContain("pending approval");
    });
  });
});
