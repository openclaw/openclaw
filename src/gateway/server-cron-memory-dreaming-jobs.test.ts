import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { reconcileOrphanedMemoryDreamingJobs } from "./server-cron-memory-dreaming-jobs.js";

function job(overrides: Partial<CronJob> & { id: string }): CronJob {
  return {
    name: "unrelated",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "cron", expr: "15 1 * * *", tz: "Europe/Berlin" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
    ...overrides,
  } as CronJob;
}

const managedPromotion = job({
  id: "promotion",
  declarationKey: "memory-core:memory-dreaming-promotion",
  name: "Memory Dreaming Promotion",
  description: "[managed-by=memory-core.short-term-promotion] Promote weighted short-term recalls",
  payload: { kind: "agentTurn", message: "__openclaw_memory_core_short_term_promotion_dream__" },
});
// Pre-declaration-key job identified by name + tag only.
const legacyPromotion = job({
  id: "legacy-promotion",
  name: "Memory Dreaming Promotion",
  description: "[managed-by=memory-core.short-term-promotion] older build",
});
const legacyLightPhase = job({
  id: "legacy-light",
  name: "Memory Light Dreaming",
  payload: { kind: "systemEvent", text: "__openclaw_memory_core_light_sleep__" },
});
const pluginOwnJob = job({ id: "plugin-rem", name: "PLUR1BUS rem-dream (main)" });
// A second canonical row, as a duplicate declaration would leave behind.
const managedDuplicate = job({ ...managedPromotion, id: "promotion-duplicate" });
// Same display name as memory-core's job, but not memory-core's.
const lookalike = job({ id: "lookalike", name: "Memory Dreaming Promotion", description: "mine" });

function thirdPartyOwner(
  dreamingEnabled: boolean | undefined,
  plugins: Record<string, unknown> = {},
  memoryCoreEntry: Record<string, unknown> = {},
  ownerEntry: Record<string, unknown> = {},
): OpenClawConfig {
  return {
    plugins: {
      ...plugins,
      slots: { memory: "memory-lancedb-namespaced" },
      entries: {
        "memory-core": memoryCoreEntry,
        "memory-lancedb-namespaced": {
          ...ownerEntry,
          config: dreamingEnabled === undefined ? {} : { dreaming: { enabled: dreamingEnabled } },
        },
      },
    },
  } as OpenClawConfig;
}

// The manifests the loader admitted against: both are memory-kind plugins.
const manifestRegistry = {
  plugins: [
    createPluginManifestRecordFixture({ id: "memory-core", kind: "memory" }),
    createPluginManifestRecordFixture({
      id: "memory-lancedb-namespaced",
      kind: "memory",
      origin: "global",
    }),
  ],
  diagnostics: [],
};

function fakeCron(jobs: CronJob[]) {
  const store = new Map(jobs.map((entry) => [entry.id, entry]));
  return {
    store,
    list: vi.fn(async () => [...store.values()]),
    remove: vi.fn(async (id: string) => ({ ok: true as const, removed: store.delete(id) })),
  };
}

const logger = { warn: vi.fn(), info: vi.fn() };

describe("when memory-core's dreaming jobs count as orphaned", () => {
  async function inventoried(cfg: OpenClawConfig): Promise<boolean> {
    const cron = fakeCron([managedPromotion]);
    await reconcileOrphanedMemoryDreamingJobs({
      cron: cron as never,
      cfg,
      logger,
      manifestRegistry,
    });
    return cron.list.mock.calls.length > 0;
  }

  it("only while a third-party slot owner has dreaming turned off", async () => {
    expect(await inventoried(thirdPartyOwner(false))).toBe(true);
    // The loader activates memory-core as sidecar here; it reconciles its own jobs.
    expect(await inventoried(thirdPartyOwner(true))).toBe(false);
    // Dreaming defaults to enabled, so an unset flag also keeps the sidecar.
    expect(await inventoried(thirdPartyOwner(undefined))).toBe(false);
  });

  it("whenever the loader refuses memory-core as sidecar, not only on the dreaming flag", async () => {
    // Dreaming stays on in all three; memory-core is unloaded anyway.
    expect(await inventoried(thirdPartyOwner(true, {}, { enabled: false }))).toBe(true);
    expect(await inventoried(thirdPartyOwner(true, { deny: ["memory-core"] }))).toBe(true);
    expect(await inventoried(thirdPartyOwner(true, { enabled: false }))).toBe(true);
    // The slot owner itself disabled: the loader refuses the sidecar beside it.
    expect(await inventoried(thirdPartyOwner(true, {}, {}, { enabled: false }))).toBe(true);
  });

  it("never without the manifests the loader decided against", async () => {
    const cron = fakeCron([managedPromotion]);
    await reconcileOrphanedMemoryDreamingJobs({
      cron: cron as never,
      cfg: thirdPartyOwner(false),
      logger,
      manifestRegistry: undefined,
    });
    expect(cron.list).not.toHaveBeenCalled();
  });

  it("never while memory-core owns the memory slot", async () => {
    expect(await inventoried({} as OpenClawConfig)).toBe(false);
    expect(
      await inventoried({
        plugins: {
          slots: { memory: "memory-core" },
          entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
        },
      } as OpenClawConfig),
    ).toBe(false);
  });
});

describe("reconcileOrphanedMemoryDreamingJobs", () => {
  it("removes only memory-core's canonical job once the sidecar is unloaded", async () => {
    const cron = fakeCron([
      managedPromotion,
      legacyPromotion,
      legacyLightPhase,
      pluginOwnJob,
      lookalike,
    ]);

    const result = await reconcileOrphanedMemoryDreamingJobs({
      cron: cron as never,
      cfg: thirdPartyOwner(false),
      logger,
      manifestRegistry,
    });

    expect(result).toEqual({ ok: true });
    // Historical rows are Doctor's to repair (openclaw doctor --fix); runtime
    // reconciliation leaves them exactly as memory-core's own disabled branch does.
    expect([...cron.store.keys()].toSorted()).toEqual([
      "legacy-light",
      "legacy-promotion",
      "lookalike",
      "plugin-rem",
    ]);
    expect(cron.list).toHaveBeenCalledWith({ includeDisabled: true });
  });

  it("does not touch the job while memory-core runs as sidecar and owns it", async () => {
    const cron = fakeCron([managedPromotion]);

    await reconcileOrphanedMemoryDreamingJobs({
      cron: cron as never,
      cfg: thirdPartyOwner(true),
      logger,
      manifestRegistry,
    });

    expect(cron.list).not.toHaveBeenCalled();
    expect(cron.store.has("promotion")).toBe(true);
  });

  it("reports an unconverged pass so the gateway retries", async () => {
    const listFails = fakeCron([managedPromotion]);
    listFails.list.mockRejectedValueOnce(new Error("store busy"));
    await expect(
      reconcileOrphanedMemoryDreamingJobs({
        cron: listFails as never,
        cfg: thirdPartyOwner(false),
        logger,
        manifestRegistry,
      }),
    ).resolves.toEqual({ ok: false });

    const removeFails = fakeCron([managedPromotion, managedDuplicate]);
    removeFails.remove.mockRejectedValueOnce(new Error("locked"));
    await expect(
      reconcileOrphanedMemoryDreamingJobs({
        cron: removeFails as never,
        cfg: thirdPartyOwner(false),
        logger,
        manifestRegistry,
      }),
    ).resolves.toEqual({ ok: false });
    // One failure does not stop the remaining canonical rows from being removed.
    expect(removeFails.remove).toHaveBeenCalledTimes(2);
  });

  it("stops at a superseded config via the commit guard", async () => {
    const cron = fakeCron([managedPromotion]);
    const superseded = new Error("superseded");
    const commitGuard = vi.fn(() => {
      throw superseded;
    });

    await expect(
      reconcileOrphanedMemoryDreamingJobs({
        cron: cron as never,
        cfg: thirdPartyOwner(false),
        logger,
        manifestRegistry,
        commitGuard,
      }),
    ).rejects.toBe(superseded);
    expect(cron.remove).not.toHaveBeenCalled();
  });
});
