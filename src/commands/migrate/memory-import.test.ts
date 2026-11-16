import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";
import { planProviderMemoryImport, withMemoryMigrationOffers } from "./memory-import.js";

const mocks = vi.hoisted(() => ({
  providers: [] as MigrationProviderPlugin[],
  runMigrationApply: vi.fn(),
}));
// Offer shaping is under test; owner selection, plugin loading and the apply writer
// are covered by the wizard owner test and the migrate apply tests.
vi.mock("../../plugins/migration-provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/migration-provider-runtime.js")>()),
  withPluginMigrationProviders: async (
    _params: unknown,
    run: (providers: MigrationProviderPlugin[]) => Promise<unknown>,
  ) => await run(mocks.providers),
}));
vi.mock("./apply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./apply.js")>()),
  runMigrationApply: mocks.runMigrationApply,
}));

const tempRoots: string[] = [];

async function makeSourceDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "memory-import-test-")));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function memoryPlan(sourceDir: string, ids: string[]): Promise<MigrationPlan> {
  const items = await Promise.all(
    ids.map(async (id, index) => {
      // Duplicate ids still resolve to distinct real files so the dedupe check,
      // not a missing-file error, is what rejects them.
      const source = path.join(sourceDir, `${id}-${index}.md`);
      await fs.writeFile(source, `# ${id}\n`);
      return {
        id,
        kind: "memory" as const,
        action: "copy" as const,
        status: "planned" as const,
        source,
        target: `/target/${id}-${index}.md`,
      };
    }),
  );
  return {
    providerId: "test",
    source: sourceDir,
    summary: {
      total: items.length,
      planned: items.length,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items,
  };
}

function stubProvider(plan: MigrationPlan): MigrationProviderPlugin {
  return {
    id: "test",
    label: "Test",
    supportedItemKinds: ["memory"],
    detect: () => ({ found: true, source: plan.source }),
    plan: () => plan,
    apply: () => ({ ...plan, summary: plan.summary }),
  };
}

const config = {} as OpenClawConfig;

describe("planProviderMemoryImport memory-only shaping", () => {
  it("rejects a plan with duplicate memory item ids", async () => {
    const dir = await makeSourceDir();
    await expect(
      planProviderMemoryImport({
        provider: stubProvider(await memoryPlan(dir, ["same-id", "same-id"])),
        config,
        agentId: "main",
      }),
    ).rejects.toThrow('duplicate memory migration item id "same-id"');
  });

  it("accepts a plan with unique memory item ids", async () => {
    const dir = await makeSourceDir();
    const { plan } = await planProviderMemoryImport({
      provider: stubProvider(await memoryPlan(dir, ["memory-a", "memory-b"])),
      config,
      agentId: "main",
    });
    expect(plan.items.map((item) => item.id)).toEqual(["memory-a", "memory-b"]);
  });
});

describe("withMemoryMigrationOffers", () => {
  it("offers only planned items, skips sources with only imported items, and applies exact ids", async () => {
    const dir = await makeSourceDir();
    const codexPlan = await memoryPlan(dir, ["memory:one", "memory:two", "memory:old"]);
    codexPlan.items[2] = { ...codexPlan.items[2]!, status: "conflict" };
    const claudePlan = await memoryPlan(dir, ["memory:imported"]);
    claudePlan.items[0] = { ...claudePlan.items[0]!, status: "conflict" };
    mocks.providers = [
      { ...stubProvider(codexPlan), id: "codex", label: "Codex" },
      { ...stubProvider(claudePlan), id: "claude", label: "Claude" },
    ];
    mocks.runMigrationApply.mockResolvedValue({ ...codexPlan, summary: codexPlan.summary });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never };

    const offers = await withMemoryMigrationOffers(
      { config, agentId: "main", runtime },
      async (planned) => planned,
    );

    expect(
      offers.map(({ providerId, plannedIds, conflicts }) => ({
        providerId,
        plannedIds,
        conflicts,
      })),
    ).toEqual([{ providerId: "codex", plannedIds: ["memory:one", "memory:two"], conflicts: 1 }]);
    await offers[0]!.apply();
    expect(mocks.runMigrationApply).toHaveBeenCalledOnce();
    const [{ providerId, opts }] = mocks.runMigrationApply.mock.calls[0]!;
    expect(providerId).toBe("codex");
    expect(opts).toMatchObject({ itemIds: ["memory:one", "memory:two"], targetAgentId: "main" });
    expect(opts.preflightPlan.items.map((item: { id: string }) => item.id)).toEqual([
      "memory:one",
      "memory:two",
      "memory:old",
    ]);
  });
});
