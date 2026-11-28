import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { MemoryMigrationOffer } from "../commands/migrate/memory-import.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";
import { runSetupMemoryImportStep } from "./setup.memory-import.js";

const mocks = vi.hoisted(() => ({ offers: [] as MemoryMigrationOffer[] }));
// The offer owner separately proves local/Gateway planning and apply.
vi.mock("../commands/migrate/memory-import.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/migrate/memory-import.js")>()),
  withMemoryMigrationOffers: async (
    _params: unknown,
    run: (offers: MemoryMigrationOffer[]) => Promise<unknown>,
  ) => await run(mocks.offers),
}));
const config = {
  agents: { defaults: { workspace: "/tmp/openclaw-memory-step" }, entries: { main: {} } },
};
const runtime = (): RuntimeEnv => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() as never });
function offer(id: string, label: string, count = 1): MemoryMigrationOffer {
  return {
    providerId: id,
    label,
    source: `/source/${id}`,
    target: "/tmp/openclaw-memory-step",
    plannedIds: Array.from({ length: count }, (_, i) => `${id}:${i}`),
    conflicts: 0,
    apply: vi.fn(async () => ({
      summary: {
        total: count,
        planned: 0,
        migrated: count,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
    })),
  };
}
describe("runSetupMemoryImportStep", () => {
  beforeEach(() => {
    mocks.offers = [];
  });
  it("shows no prompts when there are no offers", async () => {
    const prompter = createWizardPrompter();
    expect(await runSetupMemoryImportStep({ config, prompter, runtime: runtime() })).toEqual({
      status: "nothing-to-import",
      providers: [],
    });
    expect(prompter.note).not.toHaveBeenCalled();
    expect(prompter.confirm).not.toHaveBeenCalled();
  });
  it("respects a declined import and shows the memory-scoped retry hint", async () => {
    const source = offer("codex", "Codex");
    source.conflicts = 2;
    mocks.offers = [source];
    const prompter = createWizardPrompter();
    expect(await runSetupMemoryImportStep({ config, prompter, runtime: runtime() })).toEqual({
      status: "skipped",
      providers: [],
    });
    expect(source.apply).not.toHaveBeenCalled();
    const notes = JSON.stringify(vi.mocked(prompter.note).mock.calls);
    expect(notes).toContain("Memory import page");
    expect(notes).toContain("2 already imported");
    expect(notes).not.toContain("openclaw migrate");
  });
  it("applies only selected offers", async () => {
    const codex = offer("codex", "Codex", 2);
    const claude = offer("claude", "Claude");
    mocks.offers = [codex, claude];
    const multiselect = vi.fn(async () => ["codex"]) as WizardPrompter["multiselect"];
    const prompter = createWizardPrompter({ confirm: async () => true, multiselect });
    expect(await runSetupMemoryImportStep({ config, prompter, runtime: runtime() })).toEqual({
      status: "completed",
      providers: [{ providerId: "codex", label: "Codex", migrated: 2, skipped: 0 }],
    });
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          { value: "codex", label: "Codex", hint: "/source/codex" },
          { value: "claude", label: "Claude", hint: "/source/claude" },
        ],
        initialValues: ["codex", "claude"],
      }),
    );
    expect(codex.apply).toHaveBeenCalledOnce();
    expect(claude.apply).not.toHaveBeenCalled();
  });
  it("records a confirmed outcome before rendering can fail", async () => {
    mocks.offers = [offer("codex", "Codex")];
    const onProviderOutcome = vi.fn();
    const prompter = createWizardPrompter({
      confirm: async () => true,
      progress: () => ({
        update: vi.fn(),
        stop: () => {
          throw new Error("progress renderer failed");
        },
      }),
    });
    await expect(
      runSetupMemoryImportStep({ config, prompter, runtime: runtime(), onProviderOutcome }),
    ).rejects.toThrow("progress renderer failed");
    expect(onProviderOutcome).toHaveBeenCalledWith({
      providerId: "codex",
      label: "Codex",
      migrated: 1,
      skipped: 0,
    });
  });
  it("continues after an indeterminate apply failure and checks authority before each apply", async () => {
    const codex = offer("codex", "Codex");
    const claude = offer("claude", "Claude");
    mocks.offers = [codex, claude];
    const order: string[] = [];
    vi.mocked(codex.apply).mockImplementation(async () => {
      order.push("Codex");
      throw new Error("copy unavailable");
    });
    const applyClaude = claude.apply;
    claude.apply = async () => {
      order.push("Claude");
      return applyClaude();
    };
    const prompter = createWizardPrompter({
      confirm: async () => true,
      multiselect: async ({ options }) => options.map((option) => option.value),
    });
    const result = await runSetupMemoryImportStep({
      config,
      prompter,
      runtime: runtime(),
      beforeApply: async () => {
        order.push("guard");
      },
    });
    expect(order).toEqual(["guard", "Codex", "guard", "Claude"]);
    expect(result.providers).toEqual([
      {
        providerId: "codex",
        label: "Codex",
        failure: "copy unavailable",
        copiesIndeterminate: true,
      },
      { providerId: "claude", label: "Claude", migrated: 1, skipped: 0 },
    ]);
    expect(JSON.stringify(vi.mocked(prompter.note).mock.calls)).toContain("copy unavailable");
  });
});
