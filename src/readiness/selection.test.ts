import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import { buildRuntimeReadiness } from "./conditions.js";
import { createSelectedReadinessResolver } from "./selection.js";

function pluginCriterion(): PluginReadinessCriterionRegistration {
  return {
    id: "plugin.storage.backend",
    pluginId: "storage",
    source: "/plugins/storage/index.js",
    criterion: {
      id: "backend",
      description: "Reports storage backend availability.",
      check: vi.fn(() => ({
        status: "False" as const,
        reason: "StorageUnavailable",
        message: "Storage is unavailable.",
      })),
    },
  };
}

describe("createSelectedReadinessResolver", () => {
  it("does no provider work when no criteria are selected", async () => {
    const criterion = pluginCriterion();
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({ config: {}, registry: { readinessCriteria: [criterion] } }),
    ).resolves.toEqual({ conditions: [], subjects: [] });
    expect(criterion.criterion.check).not.toHaveBeenCalled();
  });

  it("promotes only operator-selected plugin criteria to required", async () => {
    const criterion = pluginCriterion();
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: {
          gateway: {
            readiness: {
              requiredCriteria: ["plugin.storage.backend"],
              advisoryCriteria: ["plugin.storage.backend"],
            },
          },
        },
        registry: { readinessCriteria: [criterion] },
      }),
    ).resolves.toMatchObject({
      conditions: [
        expect.objectContaining({
          type: "plugin.storage.backend",
          status: "False",
          requirement: "required",
          reason: "StorageUnavailable",
        }),
      ],
    });
  });

  it("maps the core selector id to its canonical condition type", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "openclaw-selected-readiness-"));
    const resolve = createSelectedReadinessResolver();

    try {
      await expect(
        resolve({
          config: {
            agents: { defaults: { workspace } },
            gateway: { readiness: { requiredCriteria: ["openclaw.workspace-writable"] } },
          },
          registry: { readinessCriteria: [] },
        }),
      ).resolves.toMatchObject({
        conditions: [
          expect.objectContaining({
            type: "WorkspaceWritable",
            status: "True",
            requirement: "required",
          }),
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed for an unregistered required criterion", async () => {
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: { gateway: { readiness: { requiredCriteria: ["plugin.missing.backend"] } } },
        registry: { readinessCriteria: [] },
      }),
    ).resolves.toMatchObject({
      conditions: [
        expect.objectContaining({
          type: "plugin.missing.backend",
          status: "Unknown",
          requirement: "required",
          reason: "CriterionNotRegistered",
        }),
      ],
    });
  });

  it("keeps a removed and re-added required criterion unknown until retired work settles", async () => {
    type Check = PluginReadinessCriterionRegistration["criterion"]["check"];
    type Result = Awaited<ReturnType<Check>>;
    const criterion = pluginCriterion();
    let settle: (() => void) | undefined;
    criterion.criterion.check = vi.fn<Check>(
      () =>
        new Promise<Result>((resolve) => {
          settle = () => resolve({ status: "True", reason: "RetiredReady", message: "Ready." });
        }),
    );
    const resolve = createSelectedReadinessResolver();
    const config = { gateway: { readiness: { requiredCriteria: [criterion.id] } } };
    const first = resolve({ config, registry: { readinessCriteria: [criterion] } });
    try {
      await vi.waitFor(() => expect(settle).toBeTypeOf("function"));
      const removed = await resolve({ config, registry: { readinessCriteria: [] } });
      expect(removed.conditions[0]?.reason).toBe("CriterionNotRegistered");
      const replacement = pluginCriterion();
      const independent = pluginCriterion();
      independent.id = "plugin.other.backend";
      independent.pluginId = "other";
      independent.criterion.check = vi.fn<Check>(() => ({
        status: "True",
        reason: "IndependentReady",
        message: "Ready.",
      }));
      const params = {
        config: {
          gateway: { readiness: { requiredCriteria: [replacement.id, independent.id] } },
        },
        registry: { readinessCriteria: [replacement, independent] },
      };
      const pending = await resolve(params);
      expect(replacement.criterion.check).not.toHaveBeenCalled();
      expect(independent.criterion.check).toHaveBeenCalledTimes(1);
      expect(pending.conditions[0]).toMatchObject({
        status: "Unknown",
        requirement: "required",
        reason: "CriterionPreviousEvaluationPending",
      });
      expect(
        buildRuntimeReadiness({
          configLoaded: true,
          gateway: "responding",
          plugins: { errors: [] },
          additionalConditions: pending.conditions,
          additionalSubjects: pending.subjects,
        }),
      ).toMatchObject({ ready: false });
      settle?.();
      await first;
      const fresh = await resolve(params);
      expect(replacement.criterion.check).toHaveBeenCalledTimes(1);
      expect(fresh.conditions[0]?.reason).toBe("StorageUnavailable");
    } finally {
      settle?.();
      await first;
    }
  });
});
