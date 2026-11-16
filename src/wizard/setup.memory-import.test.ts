import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  MigrationApplyResult,
  MigrationPlan,
  MigrationProviderPlugin,
} from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";

const mocks = vi.hoisted(() => ({
  providers: [] as MigrationProviderPlugin[],
  requestOwner: vi.fn(),
  online: false,
  controller: new AbortController(),
  planProviderMemoryImport: vi.fn(),
  applyProviderMemoryImport: vi.fn(),
}));

vi.mock("../cli/local-state-owner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/local-state-owner.js")>()),
  runWithLocalStateOwner: async (p: {
    runLocal: () => Promise<unknown>;
    onForeignOwner: (s: {
      requestOwner: typeof mocks.requestOwner;
      signal: AbortSignal;
    }) => Promise<unknown>;
  }) =>
    mocks.online
      ? p.onForeignOwner({ requestOwner: mocks.requestOwner, signal: mocks.controller.signal })
      : p.runLocal(),
}));

vi.mock("../commands/migrate/memory-import.js", () => ({
  withMemoryMigrationProviders: async (
    _config: OpenClawConfig,
    run: (providers: MigrationProviderPlugin[]) => Promise<unknown>,
  ) => await run(mocks.providers),
  planProviderMemoryImport: mocks.planProviderMemoryImport,
  applyProviderMemoryImport: mocks.applyProviderMemoryImport,
}));

import { runSetupMemoryImportStep } from "./setup.memory-import.js";

const config: OpenClawConfig = {
  agents: {
    defaults: { workspace: "/tmp/openclaw-memory-step" },
    entries: { main: {} },
  },
};

function runtime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never };
}

function provider(id: string, label = id): MigrationProviderPlugin {
  return {
    id,
    label,
    supportedItemKinds: ["memory"],
    plan: vi.fn(),
    apply: vi.fn(),
  };
}

function planFor(
  providerId: string,
  options: { planned?: string[]; conflicts?: string[] } = {},
): MigrationPlan {
  const planned = options.planned ?? [`memory:${providerId}:one`];
  const conflicts = options.conflicts ?? [];
  const items: MigrationPlan["items"] = [
    ...planned.map((id) => ({
      id,
      kind: "memory" as const,
      action: "copy" as const,
      status: "planned" as const,
      source: `/source/${providerId}/${id}.md`,
      target: `/tmp/openclaw-memory-step/memory/imports/${providerId}/${id}.md`,
    })),
    ...conflicts.map((id) => ({
      id,
      kind: "memory" as const,
      action: "copy" as const,
      status: "conflict" as const,
      source: `/source/${providerId}/${id}.md`,
      target: `/tmp/openclaw-memory-step/memory/imports/${providerId}/${id}.md`,
    })),
  ];
  return {
    providerId,
    source: `/source/${providerId}`,
    target: "/tmp/openclaw-memory-step",
    items,
    summary: {
      total: items.length,
      planned: planned.length,
      migrated: 0,
      skipped: 0,
      conflicts: conflicts.length,
      errors: 0,
      sensitive: 0,
    },
  };
}

function applied(plan: MigrationPlan): MigrationApplyResult {
  return {
    ...plan,
    items: plan.items.map((item) => ({ ...item, status: "migrated" as const })),
    summary: {
      ...plan.summary,
      planned: 0,
      migrated: plan.summary.planned,
      skipped: plan.summary.conflicts,
      conflicts: 0,
    },
  };
}

describe("runSetupMemoryImportStep", () => {
  beforeEach(() => {
    mocks.providers = [];
    mocks.online = false;
    mocks.controller = new AbortController();
    mocks.requestOwner.mockReset();
    mocks.planProviderMemoryImport.mockReset();
    mocks.applyProviderMemoryImport.mockReset();
  });

  it("shows no prompts when no memory providers are available", async () => {
    const prompter = createWizardPrompter();

    const outcome = await runSetupMemoryImportStep({ config, prompter, runtime: runtime() });

    expect(outcome).toEqual({ status: "nothing-to-import", providers: [] });
    expect(prompter.note).not.toHaveBeenCalled();
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("shows no prompts when providers have no planned memory items", async () => {
    const codex = provider("codex", "Codex");
    mocks.providers = [codex];
    mocks.planProviderMemoryImport.mockResolvedValue({
      detection: { found: true, source: "/source/codex" },
      plan: planFor("codex", { planned: [], conflicts: ["memory:existing"] }),
    });
    const prompter = createWizardPrompter();

    const outcome = await runSetupMemoryImportStep({ config, prompter, runtime: runtime() });

    expect(outcome).toEqual({ status: "nothing-to-import", providers: [] });
    expect(prompter.note).not.toHaveBeenCalled();
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("does not apply when a single-provider import is declined", async () => {
    const codex = provider("codex", "Codex");
    mocks.providers = [codex];
    mocks.planProviderMemoryImport.mockResolvedValue({
      detection: { found: true, source: "/source/codex" },
      plan: planFor("codex", { conflicts: ["memory:old-one", "memory:old-two"] }),
    });
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => false) });

    const outcome = await runSetupMemoryImportStep({ config, prompter, runtime: runtime() });

    expect(outcome).toEqual({ status: "skipped", providers: [] });
    expect(mocks.applyProviderMemoryImport).not.toHaveBeenCalled();
    expect(prompter.multiselect).not.toHaveBeenCalled();
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    // The skip hint must not suggest `openclaw migrate <id>`: that command runs
    // the full provider migration, not a memory-only retry.
    expect(notes).toContain("Memory import page");
    expect(notes).not.toContain("openclaw migrate");
    expect(notes).toContain("2 already imported");
  });

  it("applies only the selected providers with exact planned item ids", async () => {
    const codex = provider("codex", "Codex");
    const claude = provider("claude", "Claude");
    const codexPlan = planFor("codex", { planned: ["memory:codex:one", "memory:codex:two"] });
    const claudePlan = planFor("claude");
    mocks.providers = [codex, claude];
    mocks.planProviderMemoryImport.mockImplementation(async ({ provider: selectedProvider }) => {
      const plan = selectedProvider.id === "codex" ? codexPlan : claudePlan;
      return { detection: { found: true, source: plan.source }, plan };
    });
    mocks.applyProviderMemoryImport.mockImplementation(async ({ preflightPlan }) =>
      applied(preflightPlan),
    );
    const multiselect = vi.fn(async () => ["codex"]) as WizardPrompter["multiselect"];
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true),
      multiselect,
      disableBackNavigation: vi.fn(),
    });

    const outcome = await runSetupMemoryImportStep({ config, prompter, runtime: runtime() });

    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ initialValues: ["codex", "claude"] }),
    );
    expect(mocks.applyProviderMemoryImport).toHaveBeenCalledOnce();
    expect(mocks.applyProviderMemoryImport).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: codex,
        agentId: "main",
        itemIds: ["memory:codex:one", "memory:codex:two"],
        preflightPlan: codexPlan,
      }),
    );
    expect(outcome).toEqual({
      status: "completed",
      providers: [{ providerId: "codex", label: "Codex", migrated: 2, skipped: 0 }],
    });
  });

  it("preserves a confirmed outcome when later rendering fails", async () => {
    const codex = provider("codex", "Codex");
    mocks.providers = [codex];
    mocks.planProviderMemoryImport.mockResolvedValue({
      detection: { found: true, source: "/source/codex" },
      plan: planFor("codex"),
    });
    mocks.applyProviderMemoryImport.mockImplementation(async ({ preflightPlan }) =>
      applied(preflightPlan),
    );
    const onProviderOutcome = vi.fn();
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true),
      progress: vi.fn(() => ({
        update: vi.fn(),
        stop: () => {
          throw new Error("progress renderer failed");
        },
      })),
    });

    await expect(
      runSetupMemoryImportStep({
        config,
        prompter,
        runtime: runtime(),
        onProviderOutcome,
      }),
    ).rejects.toThrow("progress renderer failed");

    expect(onProviderOutcome).toHaveBeenCalledWith({
      providerId: "codex",
      label: "Codex",
      migrated: 1,
      skipped: 0,
    });
  });

  it("continues applying remaining providers after one fails", async () => {
    const codex = provider("codex", "Codex");
    const claude = provider("claude", "Claude");
    mocks.providers = [codex, claude];
    mocks.planProviderMemoryImport.mockImplementation(async ({ provider: selectedProvider }) => {
      const plan = planFor(selectedProvider.id);
      return { detection: { found: true, source: plan.source }, plan };
    });
    const order: string[] = [];
    const beforeApply = vi.fn(async () => {
      order.push("guard");
    });
    mocks.applyProviderMemoryImport.mockImplementation(async ({ preflightPlan }) => {
      order.push(`apply:${preflightPlan.providerId}`);
      if (preflightPlan.providerId === "codex") {
        throw new Error("copy unavailable");
      }
      return applied(preflightPlan);
    });
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true),
      multiselect: vi.fn(async () => ["codex", "claude"]) as WizardPrompter["multiselect"],
    });

    const outcome = await runSetupMemoryImportStep({
      config,
      prompter,
      runtime: runtime(),
      beforeApply,
    });

    expect(mocks.applyProviderMemoryImport).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["guard", "apply:codex", "guard", "apply:claude"]);
    expect(outcome.providers).toEqual([
      {
        providerId: "codex",
        label: "Codex",
        failure: "copy unavailable",
        copiesIndeterminate: true,
      },
      { providerId: "claude", label: "Claude", migrated: 1, skipped: 0 },
    ]);
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("copy unavailable");
    expect(notes).toContain("Claude: 1 migrated");
  });
  it("retries an uncertain Gateway copy with the same receipt and does not copy twice", async () => {
    mocks.online = true;
    const plan = planFor("claude");
    const receipts = new Map<string, MigrationApplyResult>();
    let copies = 0;
    let disconnect = true;
    mocks.requestOwner.mockImplementation(async (method, params) => {
      if (method === "migrations.memory.plan") {
        return {
          agentId: "main",
          workspace: "/final-workspace",
          providers: [
            {
              ...plan,
              providerId: "claude",
              label: "Claude",
              found: true,
              planFingerprint: "a".repeat(64),
            },
          ],
        };
      }
      if (params.planFingerprint !== "a".repeat(64)) {
        throw new Error("unreviewed plan");
      }
      if (!receipts.has(params.idempotencyKey)) {
        copies++;
        receipts.set(params.idempotencyKey, applied(plan));
      }
      if (disconnect) {
        disconnect = false;
        throw new Error("connection lost after copy");
      }
      return receipts.get(params.idempotencyKey);
    });
    const prompter = createWizardPrompter(
      { confirm: vi.fn(async () => true) },
      { selectValues: ["retry"] },
    );
    expect(await runSetupMemoryImportStep({ config, prompter, runtime: runtime() })).toEqual({
      status: "completed",
      providers: [{ providerId: "claude", label: "Claude", migrated: 1, skipped: 0 }],
    });
    expect(copies).toBe(1);
    expect(JSON.stringify(vi.mocked(prompter.note).mock.calls)).toContain(
      "connection lost after copy",
    );
    expect(mocks.applyProviderMemoryImport).not.toHaveBeenCalled();
  });

  it("offers retry or skip after a Gateway discovery failure without offline fallback", async () => {
    mocks.online = true;
    mocks.requestOwner.mockRejectedValue(new Error("Gateway temporarily unavailable"));
    const prompter = createWizardPrompter({}, { selectValues: ["retry", "skip"] });
    expect(await runSetupMemoryImportStep({ config, prompter, runtime: runtime() })).toEqual({
      status: "skipped",
      providers: [],
    });
    expect(prompter.select).toHaveBeenCalledTimes(2);
    expect(mocks.planProviderMemoryImport).not.toHaveBeenCalled();
    expect(mocks.applyProviderMemoryImport).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(prompter.note).mock.calls)).toContain(
      "Gateway temporarily unavailable",
    );
  });

  it("does not recover from a hosted authority rejection as a copy failure", async () => {
    mocks.providers = [provider("claude")];
    mocks.planProviderMemoryImport.mockResolvedValue({ plan: planFor("claude") });
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => true) });
    await expect(
      runSetupMemoryImportStep({
        config,
        prompter,
        runtime: runtime(),
        beforeApply: async () => {
          throw new Error("setup replaced");
        },
      }),
    ).rejects.toThrow("setup replaced");
    expect(mocks.applyProviderMemoryImport).not.toHaveBeenCalled();
    expect(prompter.select).not.toHaveBeenCalled();
  });
  it.each(["abort", "prompt", "guard"])(
    "retains possible copies when %s interrupts recovery",
    async (interruption) => {
      mocks.online = true;
      const plan = planFor("claude");
      mocks.requestOwner.mockImplementation(async (method) => {
        if (method === "migrations.memory.plan") {
          return {
            workspace: "/final",
            providers: [
              {
                ...plan,
                providerId: "claude",
                label: "Claude",
                found: true,
                planFingerprint: "a".repeat(64),
              },
            ],
          };
        }
        if (interruption === "abort") {
          mocks.controller.abort(new Error("connection aborted"));
        }
        throw new Error("connection lost after copy");
      });
      const onProviderOutcome = vi.fn();
      let guardCalls = 0;
      const prompter = createWizardPrompter({
        confirm: vi.fn(async () => true),
        select: vi.fn(async () => {
          if (interruption === "prompt") {
            throw new Error("recovery cancelled");
          }
          return "retry";
        }) as WizardPrompter["select"],
      });
      await expect(
        runSetupMemoryImportStep({
          config,
          prompter,
          runtime: runtime(),
          onProviderOutcome,
          beforeApply: async () => {
            if (++guardCalls > 1) {
              throw new Error("setup replaced");
            }
          },
        }),
      ).rejects.toThrow(
        interruption === "abort"
          ? "connection aborted"
          : interruption === "prompt"
            ? "recovery cancelled"
            : "setup replaced",
      );
      expect(onProviderOutcome).toHaveBeenCalledExactlyOnceWith({
        providerId: "claude",
        label: "Claude",
        failure: "connection lost after copy",
        copiesIndeterminate: true,
      });
    },
  );

  it("imports a healthy source when another source cannot be planned", async () => {
    mocks.online = true;
    const plan = planFor("claude");
    mocks.requestOwner.mockImplementation(async (method) =>
      method === "migrations.memory.plan"
        ? {
            workspace: "/final",
            providers: [
              {
                ...plan,
                providerId: "codex",
                label: "Codex",
                found: false,
                error: "source unreadable",
                items: [],
              },
              {
                ...plan,
                providerId: "claude",
                label: "Claude",
                found: true,
                planFingerprint: "a".repeat(64),
              },
            ],
          }
        : applied(plan),
    );
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => true) });
    expect(await runSetupMemoryImportStep({ config, prompter, runtime: runtime() })).toEqual({
      status: "completed",
      providers: [{ providerId: "claude", label: "Claude", migrated: 1, skipped: 0 }],
    });
    expect(JSON.stringify(vi.mocked(prompter.note).mock.calls)).toContain("source unreadable");
    expect(prompter.select).not.toHaveBeenCalled();
  });
});
